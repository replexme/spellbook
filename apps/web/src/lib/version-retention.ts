import { db } from "./db";
import { accountPrefix, deletePrefix } from "./storage";
import { AUTOSAVE_VERSIONS_KEPT } from "./storage-quota";
import { measureDocumentStorage } from "./storage-usage";
// Bounded work per save, so one save never waits on a large backlog.
const PRUNE_PER_RUN = 25;
const DELETIONS_PER_RUN = 50;
// A failed save check leaves a file nobody can open; remove it after this.
const FAILED_SAVE_GRACE = "1 hour";

/**
 * Keeps a document's storage bounded after it changes: removes automatic
 * saves beyond the newest AUTOSAVE_VERSIONS_KEPT and failed save attempts,
 * deletes their files, and re-measures what the document keeps.
 *
 * Never removed: the imported original, the current and open versions,
 * versions an AI request produced or started from, restore results and the
 * versions they restored, and anything an edit request or other row points
 * at. Rows go first, in one transaction that also records the folders to
 * delete, so nothing ever points at a missing file; the files follow.
 */
export async function maintainDocumentStorage(
  accountId: string,
  documentId: string,
): Promise<{ pruned: number; bytes: number }> {
  const pruned = await pruneVersions(accountId, documentId);
  await flushStorageDeletions(documentId);
  const bytes = await measureDocumentStorage(accountId, documentId);
  return { pruned, bytes };
}

async function pruneVersions(
  accountId: string,
  documentId: string,
): Promise<number> {
  return db().begin(async (sql) => {
    const [document] = await sql`
      select id from spellbook_documents
      where id=${documentId} and account_id=${accountId} for update
    `;
    if (!document) return 0;
    const candidates = await sql`
      with protected as (
        select current_version_id as id from spellbook_documents where id=${documentId}
        union select original_version_id from spellbook_documents where id=${documentId}
        union select working_version_id from spellbook_native_sessions where document_id=${documentId}
        union select restored_from_version_id from spellbook_versions where document_id=${documentId}
        union select version_id from spellbook_jobs where document_id=${documentId} and job_type <> 'scan_render'
        union select base_version_id from spellbook_edit_requests where document_id=${documentId}
        union select candidate_version_id from spellbook_edit_requests where document_id=${documentId}
        union select input_version_id from spellbook_edit_requests where document_id=${documentId}
      ),
      saves as (
        select v.id, v.created_at, v.status, v.kind,
          row_number() over (
            partition by (v.status = 'ready') order by v.created_at desc
          ) as newest
        from spellbook_versions v
        join lateral (
          select payload from spellbook_jobs
          where version_id=v.id and job_type='scan_render'
          order by created_at desc limit 1
        ) scan on true
        where v.document_id=${documentId}
          and v.restored_from_version_id is null
          and v.undone_turn_id is null
          and scan.payload ? 'nativeSessionId'
          and coalesce(scan.payload->>'changeOrigin', 'human') <> 'ai'
          and jsonb_array_length(coalesce(scan.payload->'changeTaskIds', '[]'::jsonb)) = 0
          and (
            (v.kind = 'approved' and v.status = 'ready')
            or (v.kind = 'abandoned' and v.status = 'failed'
              and v.created_at < now() - ${FAILED_SAVE_GRACE}::interval)
          )
      )
      select id from saves
      where (status <> 'ready' or newest > ${AUTOSAVE_VERSIONS_KEPT})
        and id not in (select id from protected where id is not null)
      order by created_at
      limit ${PRUNE_PER_RUN}
    `;
    const prefix = accountPrefix(accountId, documentId);
    for (const { id } of candidates) {
      // Keep the lineage readable: children of a removed save point at its parent.
      await sql`
        update spellbook_versions set parent_version_id=(
          select parent_version_id from spellbook_versions where id=${id}
        ) where parent_version_id=${id}
      `;
      await sql`delete from spellbook_jobs where version_id=${id} and job_type='scan_render'`;
      await sql`delete from spellbook_versions where id=${id}`;
      const folder = `${prefix}/versions/${id}/`;
      // Files another kept row still names stay; only the row goes.
      const [shared] = await sql`
        select 1 from spellbook_versions
        where document_id=${documentId} and (
          starts_with(document_object, ${folder})
          or starts_with(coalesce(graph_object, ''), ${folder})
          or starts_with(coalesce(scan_object, ''), ${folder})
          or starts_with(coalesce(validation_object, ''), ${folder})
        ) limit 1
      `;
      if (!shared)
        await sql`
          insert into spellbook_storage_deletions (account_id, document_id, prefix)
          values (${accountId}, ${documentId}, ${folder})
        `;
    }
    if (candidates.length)
      await sql`
        insert into spellbook_events (document_id, event_type, payload)
        values (${documentId}, 'versions_pruned', ${sql.json({ count: candidates.length })})
      `;
    return candidates.length;
  });
}

/** Deletes the recorded folders of removed versions, then their records. */
export async function flushStorageDeletions(documentId: string): Promise<void> {
  const pending = await db()`
    select id, prefix from spellbook_storage_deletions
    where document_id=${documentId} order by id limit ${DELETIONS_PER_RUN}
  `;
  for (const row of pending) {
    await deletePrefix(row.prefix);
    await db()`delete from spellbook_storage_deletions where id=${row.id}`;
  }
}
