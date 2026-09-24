import { createHash, randomUUID } from "node:crypto";

import { currentPresentationFormat } from "./document-formats";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type { Session } from "./models";
import { publicAppBaseUrl } from "./runtime-urls";
import { accountPrefix, deleteObject, getObject, putObject } from "./storage";
import { dispatchNativeSave, stageNativeSave } from "./native-save-stage";
import {
  aiConnectorConfig,
  type AiConnectorConfig,
} from "./ai-connector-config";

const browserSessionMs = 6 * 60 * 60 * 1000;

export interface BrowserDocumentLaunch {
  editorKind: "browser";
  documentId: string;
  fileName: string;
  editorUrl: string;
  accessToken: "";
  revision: string;
  expiresAt: number;
  apiBase: string;
  contentApiBase: string;
  maxBytes: number;
  aiConnector: AiConnectorConfig;
}

export function browserOfficeWorkspaceUrl(): string {
  const workspace = new URL("workspace", browserOfficeBase());
  workspace.searchParams.set("hostOrigin", publicAppBaseUrl());
  return workspace.toString();
}

/** The browser editor's open-source notice, when the editor is configured. */
export function browserOfficeLicensesUrl(): string | null {
  if (!process.env.SPELLBOOK_BROWSER_OFFICE_URL?.trim()) return null;
  return new URL("licenses", browserOfficeBase()).toString();
}

function browserOfficeBase(): URL {
  const configured = process.env.SPELLBOOK_BROWSER_OFFICE_URL?.trim();
  if (!configured) throw new HttpError(503, "browser_office_not_configured");
  const base = new URL(
    configured.endsWith("/") ? configured : `${configured}/`,
  );
  const loopback =
    base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1");
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !["http:", "https:"].includes(base.protocol) ||
    (process.env.NODE_ENV === "production" &&
      base.protocol !== "https:" &&
      !loopback)
  )
    throw new Error("SPELLBOOK_BROWSER_OFFICE_URL is invalid.");
  return base;
}

export async function createBrowserDocumentLaunch(
  session: Session,
  documentId: string,
): Promise<BrowserDocumentLaunch> {
  const editorUrl = browserOfficeWorkspaceUrl();
  await ensureSchema();
  const expiresAt = Date.now() + browserSessionMs;
  const document = await db().begin(async (sql) => {
    const [current] = await sql`
      select d.id,d.file_name,d.status,d.format_id,d.current_version_id,
        v.document_sha256,v.status as version_status
      from spellbook_documents d
      join spellbook_versions v on v.id=d.current_version_id
      where d.id=${documentId} and d.account_id=${session.accountId}
      for update of d
    `;
    if (!current) throw new HttpError(404, "document_not_found");
    if (current.format_id !== currentPresentationFormat.id)
      throw new HttpError(409, "format_editor_not_available");
    if (current.status === "candidate_ready")
      throw new HttpError(409, "candidate_review_required");
    if (current.status === "failed" || current.version_status === "failed")
      throw new HttpError(422, "document_processing_failed");
    if (current.status !== "ready" || current.version_status !== "ready")
      throw new HttpError(409, "document_processing");
    if (!current.document_sha256)
      throw new HttpError(409, "document_context_not_ready");

    await sql`
      update spellbook_native_sessions set
        wopi_lock=null,lock_updated_at=null,lock_expires_at=null,updated_at=now()
      where document_id=${documentId} and account_id=${session.accountId}
        and wopi_lock is not null
        and coalesce(lock_expires_at,lock_updated_at + interval '30 minutes') <= now()
    `;

    const [existing] = await sql`
      select * from spellbook_native_sessions
      where document_id=${documentId} and account_id=${session.accountId}
      for update
    `;
    if (existing?.wopi_lock)
      throw new HttpError(409, "office_editor_save_required");
    if (existing?.status === "validating")
      throw new HttpError(409, "document_processing");
    if (existing) {
      await sql`
        update spellbook_native_sessions set
          account_email=${session.email}, editor_mode='browser',
          working_version_id=${current.current_version_id},
          working_sha256=${current.document_sha256}, status='active',
          wopi_lock=null, lock_updated_at=null, lock_expires_at=null, last_error=null,
          expires_at=${new Date(expiresAt)}, last_seen_at=now(), updated_at=now()
        where id=${existing.id}
      `;
    } else {
      await sql`
        insert into spellbook_native_sessions
          (id,document_id,account_id,account_email,working_version_id,working_sha256,editor_mode,status,expires_at)
        values (${randomUUID()},${documentId},${session.accountId},${session.email},${current.current_version_id},${current.document_sha256},'browser','active',${new Date(expiresAt)})
      `;
    }
    return current;
  });
  return {
    editorKind: "browser",
    documentId,
    fileName: document.file_name,
    editorUrl,
    accessToken: "",
    revision: browserRevision(
      document.current_version_id,
      document.document_sha256,
    ),
    expiresAt,
    apiBase: `/api/documents/${documentId}/native`,
    contentApiBase: `/api/documents/${documentId}/browser`,
    maxBytes: currentPresentationFormat.maxBytes,
    aiConnector: aiConnectorConfig(),
  };
}

export async function getBrowserDocument(
  session: Session,
  documentId: string,
): Promise<{ fileName: string; revision: string; data: Buffer }> {
  await ensureSchema();
  const [row] = await db()`
    select d.file_name,s.working_version_id,s.working_sha256,v.document_object
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions v on v.id=s.working_version_id and v.status='ready'
    where s.document_id=${documentId} and s.account_id=${session.accountId}
      and s.editor_mode='browser' and s.status='active' and s.expires_at > now()
  `;
  if (!row) throw new HttpError(409, "browser_session_not_active");
  return {
    fileName: row.file_name,
    revision: browserRevision(row.working_version_id, row.working_sha256),
    data: await getObject(row.document_object),
  };
}

export async function saveBrowserDocument(
  session: Session,
  documentId: string,
  request: Request,
): Promise<{ revision: string; unchanged: boolean }> {
  await ensureSchema();
  requireBrowserOrigin(request);
  const expectedRevision = request.headers.get("if-match") ?? "";
  if (!expectedRevision) throw new HttpError(428, "browser_revision_required");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > currentPresentationFormat.maxBytes)
    throw new HttpError(413, "document_too_large");
  const data = Buffer.from(await request.arrayBuffer());
  if (
    !data.length ||
    data.length > currentPresentationFormat.maxBytes ||
    data[0] !== 0x50 ||
    data[1] !== 0x4b
  )
    throw new HttpError(400, "invalid_document_package");
  const digest = createHash("sha256").update(data).digest("hex");
  const [current] = await db()`
    select s.id,s.working_version_id,s.working_sha256,s.status,s.wopi_lock,
      current.document_object as preservation_object
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions current on current.id=d.current_version_id and current.status='ready'
    where s.document_id=${documentId} and s.account_id=${session.accountId}
      and s.editor_mode='browser' and s.expires_at > now()
  `;
  if (!current) throw new HttpError(409, "browser_session_not_active");
  if (current.wopi_lock)
    throw new HttpError(409, "office_editor_save_required");
  if (current.status !== "active")
    throw new HttpError(409, "document_processing");
  const currentRevision = browserRevision(
    current.working_version_id,
    current.working_sha256,
  );
  if (expectedRevision !== currentRevision)
    throw new HttpError(412, "browser_revision_changed");
  if (digest === current.working_sha256) {
    await db().begin(async (sql) => {
      const [locked] = await sql`
        select working_version_id,working_sha256,status,editor_mode,wopi_lock
        from spellbook_native_sessions where id=${current.id} for update
      `;
      if (
        !locked ||
        locked.editor_mode !== "browser" ||
        locked.status !== "active" ||
        locked.wopi_lock
      )
        throw new HttpError(409, "browser_session_changed");
      if (
        browserRevision(locked.working_version_id, locked.working_sha256) !==
        expectedRevision
      )
        throw new HttpError(412, "browser_revision_changed");
      await sql`
        update spellbook_native_sessions set last_seen_at=now(),updated_at=now()
        where id=${current.id}
      `;
    });
    return { revision: currentRevision, unchanged: true };
  }

  const versionId = randomUUID();
  const jobId = randomUUID();
  const prefix = accountPrefix(session.accountId, documentId);
  const object = `${prefix}/versions/${versionId}/document.pptx`;
  const outputPrefix = `${prefix}/versions/${versionId}/render`;
  await putObject(object, data, currentPresentationFormat.mimeTypes[0]!);
  let payload: Record<string, unknown>;
  try {
    await db().begin(async (sql) => {
      const [locked] = await sql`
        select working_version_id,working_sha256,status,wopi_lock,editor_mode,save_revision
        from spellbook_native_sessions where id=${current.id} for update
      `;
      if (!locked || locked.editor_mode !== "browser")
        throw new HttpError(409, "browser_session_changed");
      if (locked.status !== "active" || locked.wopi_lock)
        throw new HttpError(409, "browser_session_changed");
      if (
        browserRevision(locked.working_version_id, locked.working_sha256) !==
        expectedRevision
      )
        throw new HttpError(412, "browser_revision_changed");
      payload = await stageNativeSave(sql, {
        sessionId: current.id,
        documentId,
        parentVersionId: locked.working_version_id,
        versionId,
        jobId,
        object,
        outputPrefix,
        digest,
        preservationObject: current.preservation_object,
        saveRevision: locked.save_revision,
        bytes: data.length,
      });
    });
  } catch (error) {
    await deleteObject(object).catch(() => undefined);
    throw error;
  }
  await dispatchNativeSave(jobId, payload!);
  return {
    revision: browserRevision(versionId, digest),
    unchanged: false,
  };
}

export function browserRevision(versionId: string, digest: string): string {
  if (!versionId || !/^[0-9a-f]{64}$/iu.test(digest ?? ""))
    throw new HttpError(409, "document_context_not_ready");
  return `"${versionId}:${digest.toLowerCase()}"`;
}

export function requireBrowserOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== publicAppBaseUrl())
    throw new HttpError(403, "invalid_browser_origin");
}
