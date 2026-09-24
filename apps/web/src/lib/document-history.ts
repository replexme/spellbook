import { randomUUID } from "node:crypto";
import type { ModelSettings } from "./ai-models";

import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type { Session } from "./models";
import { loadTurnSummary, type TurnSummary } from "./native-turn-summary";
import type {
  TurnHistoryItem,
  VersionHistoryItem,
  VersionOrigin,
} from "./history-types";

export type { TurnHistoryItem, VersionHistoryItem, VersionOrigin };

/** Authenticated URL for a stored object owned by the session's account. */
export function assetUrl(objectName: string) {
  return `/api/assets?object=${encodeURIComponent(objectName)}`;
}

/** Preview image key for a slide of a rendered version (0-based index). */
export function previewObject(
  graphObject: string | null | undefined,
  slideIndex: number,
) {
  if (!graphObject || !graphObject.endsWith("/element-graph.json")) return null;
  const prefix = graphObject.slice(0, -"/element-graph.json".length);
  return `${prefix}/slides/slide-${slideIndex + 1}.png`;
}

export function previewUrl(
  graphObject: string | null | undefined,
  slideIndex: number,
) {
  const object = previewObject(graphObject, slideIndex);
  return object ? assetUrl(object) : null;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function ownedDocument(session: Session, documentId: string) {
  if (!isUuid(documentId)) throw new HttpError(404, "document_not_found");
  await ensureSchema();
  const [document] = await db()`
    select id, file_name, current_version_id, original_version_id, status
    from spellbook_documents where id=${documentId} and account_id=${session.accountId}
  `;
  if (!document) throw new HttpError(404, "document_not_found");
  return document;
}

/** Every native AI request on this document, oldest first, with its result card. */
export async function listNativeTurns(
  session: Session,
  documentId: string,
): Promise<TurnHistoryItem[]> {
  await ownedDocument(session, documentId);
  const turns = await db()`
    select t.id, t.request_text, t.permission_mode, t.status, t.assistant_text,
      t.created_at, t.updated_at, t.summary, t.undone_at, t.model_settings,
      j.version_id as before_version_id
    from spellbook_native_turns t
    join spellbook_jobs j on j.id=t.job_id
    where t.document_id=${documentId} and t.account_id=${session.accountId}
    order by t.created_at
    limit 200
  `;
  const afterVersions = new Map<string, string>();
  if (turns.length) {
    const rows = await db()`
      select k.turn_id, j.version_id, j.created_at
      from spellbook_jobs j
      join spellbook_versions v on v.id=j.version_id and v.status='ready'
      join lateral jsonb_array_elements_text(coalesce(j.payload->'changeTaskIds','[]'::jsonb)) as task(id) on true
      join spellbook_native_tasks k on k.id::text=task.id
      where j.document_id=${documentId} and j.job_type='scan_render'
      order by j.created_at
    `;
    for (const row of rows)
      if (!afterVersions.has(row.turn_id))
        afterVersions.set(row.turn_id, row.version_id);
  }
  // Saved-version previews stand in for the AI's own screenshots, which are
  // kept only while a request runs.
  const versionIds = [
    ...new Set(
      turns
        .flatMap((turn) => [turn.before_version_id, afterVersions.get(turn.id)])
        .filter(Boolean),
    ),
  ] as string[];
  const graphs = new Map<string, string | null>();
  if (versionIds.length) {
    const rows = await db()`
      select id, graph_object from spellbook_versions
      where id = any(${versionIds}) and document_id=${documentId} and status='ready'
    `;
    for (const row of rows) graphs.set(row.id, row.graph_object);
  }
  const items: TurnHistoryItem[] = [];
  for (const turn of turns) {
    let summary = (turn.summary as TurnSummary | null) ?? null;
    if (!summary && !["queued", "running"].includes(turn.status)) {
      summary = await loadTurnSummary(db() as never, turn.id);
      if (summary)
        await db()`update spellbook_native_turns set summary=${db().json(summary as never)} where id=${turn.id} and summary is null`;
    }
    const beforeGraph = turn.before_version_id
      ? graphs.get(turn.before_version_id)
      : null;
    const afterVersionId = afterVersions.get(turn.id) ?? null;
    const afterGraph = afterVersionId ? graphs.get(afterVersionId) : null;
    const slideCount = summary?.slideCount;
    const savedPreviews = (summary?.changedSlides ?? []).map((slideIndex) => ({
      slideIndex,
      before:
        slideCount?.before === null ||
        slideIndex < (slideCount?.before ?? Infinity)
          ? previewUrl(beforeGraph, slideIndex)
          : null,
      after:
        slideCount?.after === null ||
        slideIndex < (slideCount?.after ?? Infinity)
          ? previewUrl(afterGraph, slideIndex)
          : null,
    }));
    items.push({
      id: turn.id,
      requestText: turn.request_text,
      permissionMode: turn.permission_mode,
      status: turn.status,
      assistantText: turn.assistant_text,
      createdAt: new Date(turn.created_at).toISOString(),
      updatedAt: new Date(turn.updated_at).toISOString(),
      summary,
      beforeVersionId: turn.before_version_id ?? null,
      afterVersionId,
      savedPreviews,
      undoneAt: turn.undone_at ? new Date(turn.undone_at).toISOString() : null,
      modelSettings: (turn.model_settings as ModelSettings | null) ?? null,
    });
  }
  return items;
}

/** Saved versions, newest first. The imported original is always last. */
export async function listVersions(
  session: Session,
  documentId: string,
): Promise<{ currentVersionId: string; versions: VersionHistoryItem[] }> {
  const document = await ownedDocument(session, documentId);
  const [native] = await db()`
    select working_version_id from spellbook_native_sessions
    where document_id=${documentId} and account_id=${session.accountId}
  `;
  const currentVersionId: string =
    native?.working_version_id ?? document.current_version_id;
  const rows = await db()`
    select v.id, v.parent_version_id, v.kind, v.created_at, v.slide_count, v.graph_object,
      v.restored_from_version_id, v.editor_modified, v.document_bytes, v.undone_turn_id,
      scan.payload->>'changeOrigin' as change_origin,
      coalesce(scan.payload->'changeTaskIds','[]'::jsonb) as change_task_ids,
      legacy.id as legacy_edit_id, legacy.request_text as legacy_request
    from spellbook_versions v
    left join lateral (
      select payload from spellbook_jobs
      where version_id=v.id and job_type='scan_render' order by created_at desc limit 1
    ) scan on true
    left join spellbook_edit_requests legacy on legacy.candidate_version_id=v.id and legacy.status='approved'
    where v.document_id=${documentId} and v.kind in ('original','approved') and v.status='ready'
    order by v.created_at desc
    limit 300
  `;
  const taskIds = [
    ...new Set(rows.flatMap((row) => row.change_task_ids as string[])),
  ];
  const turnByTask = new Map<string, { id: string; requestText: string }>();
  if (taskIds.length) {
    const turns = await db()`
      select k.id::text as task_id, t.id, t.request_text
      from spellbook_native_tasks k join spellbook_native_turns t on t.id=k.turn_id
      where k.id::text = any(${taskIds}) and t.document_id=${documentId}
    `;
    for (const row of turns)
      turnByTask.set(row.task_id, {
        id: row.id,
        requestText: row.request_text,
      });
  }
  const undoneIds = [
    ...new Set(rows.map((row) => row.undone_turn_id).filter(Boolean)),
  ] as string[];
  const undoneTurns = new Map<string, { id: string; requestText: string }>();
  if (undoneIds.length) {
    const turns = await db()`
      select id, request_text from spellbook_native_turns
      where id = any(${undoneIds}) and document_id=${documentId}
    `;
    for (const row of turns)
      undoneTurns.set(row.id, { id: row.id, requestText: row.request_text });
  }
  const versions = rows.map((row) => {
    const undone = row.undone_turn_id
      ? (undoneTurns.get(row.undone_turn_id) ?? null)
      : null;
    const turn =
      undone ??
      (row.change_task_ids as string[])
        .map((id) => turnByTask.get(id))
        .find(Boolean) ??
      (row.legacy_edit_id
        ? { id: row.legacy_edit_id, requestText: row.legacy_request }
        : null);
    const origin: VersionOrigin =
      row.kind === "original"
        ? "original"
        : row.restored_from_version_id
          ? "restored"
          : undone
            ? "undone"
            : row.change_origin === "ai" || turn
              ? "ai"
              : row.editor_modified === false
                ? "system"
                : "manual";
    const count = Math.min(Number(row.slide_count ?? 0), 4);
    return {
      id: row.id,
      parentVersionId: row.parent_version_id,
      origin,
      createdAt: new Date(row.created_at).toISOString(),
      slideCount: row.slide_count ?? null,
      current: row.id === currentVersionId,
      turn: turn ?? null,
      restoredFrom: row.restored_from_version_id ?? null,
      previews: Array.from({ length: count }, (_, index) =>
        previewUrl(row.graph_object, index),
      ),
      bytes:
        row.document_bytes === null || row.document_bytes === undefined
          ? null
          : Number(row.document_bytes),
    } satisfies VersionHistoryItem;
  });
  return { currentVersionId, versions };
}

/**
 * Makes an earlier version current by adding a new version with the same
 * bytes. Nothing is deleted; the replaced state stays in history. The WOPI
 * lock is cleared so an editor still holding the old document cannot save
 * over the restored one.
 */
export async function restoreVersion(
  session: Session,
  documentId: string,
  versionId: string,
): Promise<{ versionId: string; restoredFrom: string }> {
  await ownedDocument(session, documentId);
  if (!isUuid(versionId)) throw new HttpError(400, "invalid_version");
  return db().begin(async (sql) => {
    const [document] = await sql`
      select id, current_version_id from spellbook_documents
      where id=${documentId} and account_id=${session.accountId} for update
    `;
    if (!document) throw new HttpError(404, "document_not_found");
    const [target] = await sql`
      select * from spellbook_versions
      where id=${versionId} and document_id=${documentId}
        and kind in ('original','approved') and status='ready'
    `;
    if (!target) throw new HttpError(404, "version_not_found");
    const [native] = await sql`
      select * from spellbook_native_sessions
      where document_id=${documentId} and account_id=${session.accountId} for update
    `;
    if (native?.status === "validating")
      throw new HttpError(409, "document_save_in_progress");
    if (native) {
      const [running] = await sql`
        select id from spellbook_native_turns
        where session_id=${native.id} and status in ('queued','running') limit 1
      `;
      if (running) throw new HttpError(409, "native_turn_already_running");
    }
    const workingVersionId =
      native?.working_version_id ?? document.current_version_id;
    const restoredId = randomUUID();
    await sql`
      insert into spellbook_versions
        (id,document_id,parent_version_id,kind,status,document_object,graph_object,
         scan_object,validation_object,document_sha256,slide_count,restored_from_version_id,
         document_bytes)
      values (${restoredId},${documentId},${workingVersionId},'approved','ready',
        ${target.document_object},${target.graph_object},${target.scan_object},
        ${target.validation_object},${target.document_sha256},${target.slide_count},${versionId},
        ${target.document_bytes ?? null})
    `;
    if (native) {
      await sql`
        update spellbook_native_sessions set working_version_id=${restoredId},
          working_sha256=${target.document_sha256}, status='active', last_error=null,
          wopi_lock=null, lock_updated_at=null, lock_expires_at=null,
          save_revision=save_revision+1, updated_at=now()
        where id=${native.id}
      `;
      await sql`
        insert into spellbook_native_events (session_id,turn_id,event_type,payload)
        values (${native.id},null,'restored',${sql.json({ versionId: restoredId, restoredFrom: versionId })})
      `;
    }
    await sql`
      update spellbook_documents set current_version_id=${restoredId}, status='ready',
        last_error=null, updated_at=now()
      where id=${documentId}
    `;
    return { versionId: restoredId, restoredFrom: versionId };
  });
}
