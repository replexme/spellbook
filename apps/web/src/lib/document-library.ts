import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type {
  ElementGraph,
  PackageChangeBudgetReport,
  Session,
} from "./models";
import { deleteDocumentObjects, getJsonObject } from "./storage";
import { assetUrl, isUuid, previewUrl } from "./document-history";
import { aiEditLimits, type EditorEngineFacts } from "./ai-edit-limits";
import { configuredEditorMode } from "./editor-mode";
import type { DocumentSummary, LibraryDocument } from "./history-types";

export type { DocumentSummary, LibraryDocument };

function requireDocumentId(documentId: string) {
  if (!isUuid(documentId)) throw new HttpError(404, "document_not_found");
}

/** Files for the home screen, most recently touched first. */
export async function listLibrary(
  session: Session,
): Promise<LibraryDocument[]> {
  await ensureSchema();
  const rows = await db()`
    select d.id, d.file_name, d.format_id, d.status, d.last_error, d.failure_code, d.created_at,
      greatest(d.updated_at, coalesce(v.created_at, d.updated_at)) as updated_at,
      v.slide_count, v.graph_object, v.status as version_status
    from spellbook_documents d
    left join spellbook_native_sessions s on s.document_id=d.id and s.account_id=d.account_id
    left join spellbook_versions sv on sv.id=s.working_version_id and sv.status='ready'
    left join spellbook_versions v on v.id=coalesce(sv.id, d.current_version_id)
    where d.account_id=${session.accountId}
    order by greatest(d.updated_at, coalesce(v.created_at, d.updated_at)) desc
    limit 500
  `;
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    formatId: row.format_id,
    status: row.status,
    lastError: row.last_error,
    failureCode: row.failure_code ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    slideCount: row.slide_count ?? null,
    coverUrl:
      row.version_status === "ready" ? previewUrl(row.graph_object, 0) : null,
  }));
}

const invalidName = /[\\/:*?"<>|\u0000-\u001f]/g;

export async function renameDocument(
  session: Session,
  documentId: string,
  requested: unknown,
) {
  requireDocumentId(documentId);
  if (typeof requested !== "string")
    throw new HttpError(400, "invalid_file_name");
  let name = requested.replace(invalidName, " ").replace(/\s+/g, " ").trim();
  if (!name) throw new HttpError(400, "invalid_file_name");
  if (!/\.pptx$/i.test(name)) name = `${name}.pptx`;
  if (name.length > 180) throw new HttpError(400, "file_name_too_long");
  await ensureSchema();
  const [updated] = await db()`
    update spellbook_documents set file_name=${name}, updated_at=now()
    where id=${documentId} and account_id=${session.accountId}
    returning id, file_name
  `;
  if (!updated) throw new HttpError(404, "document_not_found");
  return { id: updated.id, fileName: updated.file_name };
}

/** Removes the document, its versions and history, and its stored files. */
export async function deleteDocument(session: Session, documentId: string) {
  requireDocumentId(documentId);
  await ensureSchema();
  const [owned] = await db()`
    select id from spellbook_documents
    where id=${documentId} and account_id=${session.accountId}
  `;
  if (!owned) throw new HttpError(404, "document_not_found");
  // Files first: if removing them fails, the document stays listed and the
  // person can delete it again instead of leaving files nobody can see.
  await deleteDocumentObjects(session.accountId, documentId);
  await db()`
    delete from spellbook_documents
    where id=${documentId} and account_id=${session.accountId}
  `;
  return { deleted: true };
}

/** What the import summary, opening preview and download dialog show. */
export async function documentSummary(
  session: Session,
  documentId: string,
): Promise<DocumentSummary> {
  requireDocumentId(documentId);
  await ensureSchema();
  const [row] = await db()`
    select d.id, d.file_name, d.status, d.last_error, d.failure_code,
      v.id as version_id, v.created_at as version_created_at, v.slide_count, v.document_bytes,
      v.graph_object, v.validation_object, v.status as version_status,
      scan.payload->>'changeOrigin' as change_origin
    from spellbook_documents d
    left join spellbook_native_sessions s on s.document_id=d.id and s.account_id=d.account_id
    left join spellbook_versions sv on sv.id=s.working_version_id and sv.status='ready'
    left join spellbook_versions v on v.id=coalesce(sv.id, d.current_version_id)
    left join lateral (
      select payload from spellbook_jobs where version_id=v.id and job_type='scan_render'
      order by created_at desc limit 1
    ) scan on true
    where d.id=${documentId} and d.account_id=${session.accountId}
  `;
  if (!row) throw new HttpError(404, "document_not_found");
  const ready = row.version_status === "ready" && row.graph_object;
  const graph = ready
    ? await getJsonObject<ElementGraph>(row.graph_object).catch(() => null)
    : null;
  const validation = row.validation_object
    ? await getJsonObject<PackageChangeBudgetReport>(
        row.validation_object,
      ).catch(() => null)
    : null;
  const [engineRow] = await db()`
    select patch_level, supported_operations from spellbook_editor_engines
    where editor_mode=${configuredEditorMode()}
  `;
  const engine: EditorEngineFacts | null = engineRow
    ? {
        patchLevel: engineRow.patch_level ?? null,
        supportedOperations: Array.isArray(engineRow.supported_operations)
          ? engineRow.supported_operations
          : [],
      }
    : null;
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    lastError: row.last_error,
    failureCode: row.failure_code ?? null,
    version: row.version_id
      ? {
          id: row.version_id,
          createdAt: new Date(row.version_created_at).toISOString(),
          slideCount: row.slide_count ?? null,
          rendered: Boolean(
            graph?.slides.length &&
              graph.slides.every((slide) => slide.previewObject),
          ),
          origin:
            row.change_origin === "ai" || row.change_origin === "human"
              ? row.change_origin
              : null,
          changeCheck: validation ? validation.valid === true : null,
          bytes:
            row.document_bytes === null || row.document_bytes === undefined
              ? null
              : Number(row.document_bytes),
        }
      : null,
    // Only slides the server actually rendered get an image.
    previews: [...(graph?.slides ?? [])]
      .sort((a, b) => a.slideIndex - b.slideIndex)
      .slice(0, 200)
      .map((slide) =>
        slide.previewObject ? assetUrl(slide.previewObject) : null,
      ),
    fonts: {
      inventoryAvailable: graph?.fontInventoryAvailable ?? null,
      missing: graph?.missingFonts ?? [],
      substitutions: graph?.fontSubstitutions ?? [],
    },
    // graphicKind/externalData are newer graph fields; older graphs lack them.
    aiLimits: graph
      ? aiEditLimits(
          graph.slides as unknown as Parameters<typeof aiEditLimits>[0],
          engine,
        )
      : [],
    aiEngineKnown: engine !== null,
  };
}
