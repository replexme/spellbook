import { createHash, randomUUID } from "node:crypto";

import { browserViewFormatIds, documentFormatOf, type DocumentFormatId } from "./document-formats";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type { Session } from "./models";
import { publicAppBaseUrl } from "./runtime-urls";
import {
  accountPrefix,
  deleteObject,
  directReadUrl,
  directWriteTarget,
  getObject,
  moveObject,
  objectDigest,
  putObject,
} from "./storage";
import { signClaims, verifiedClaims } from "./signed-claims";
import { loadNativeSaveChangePolicy } from "./native-change-budget";
import { incomingObjectName } from "./incoming-objects";
import { assertStorageAvailable } from "./storage-usage";
import { dispatchNativeSave, stageNativeSave } from "./native-save-stage";
import {
  aiConnectorConfig,
  type AiConnectorConfig,
} from "./ai-connector-config";

const browserSessionMs = 6 * 60 * 60 * 1000;

export interface BrowserDocumentLaunch {
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

/** Static local editing sends no document bytes to this application's API. */
export function browserOfficeLocalUrl(): string {
  return new URL("local", browserOfficeBase()).toString();
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
    if (!browserViewFormatIds.includes(current.format_id as DocumentFormatId))
      throw new HttpError(409, "format_editor_not_available");
    if (current.status === "candidate_ready")
      throw new HttpError(409, "candidate_review_required");
    if (current.status === "failed" || current.version_status === "failed")
      throw new HttpError(422, "document_processing_failed");
    if (current.status !== "ready" || current.version_status !== "ready")
      throw new HttpError(409, "document_processing");
    if (!current.document_sha256)
      throw new HttpError(409, "document_context_not_ready");

    const [existing] = await sql`
      select * from spellbook_native_sessions
      where document_id=${documentId} and account_id=${session.accountId}
      for update
    `;
    if (existing?.status === "validating")
      throw new HttpError(409, "document_processing");
    if (existing) {
      // The editor reopens the stored file, so AI edits that were never saved
      // are gone with the old page. Start a new save window (as restoring a
      // version does) so those edits no longer count against the next save;
      // never while an AI request is still running.
      await sql`
        update spellbook_native_sessions s set
          account_email=${session.email}, editor_mode='browser',
          working_version_id=${current.current_version_id},
          working_sha256=${current.document_sha256}, status='active',
          last_error=null,
          save_revision = s.save_revision + case when exists (
              select 1 from spellbook_native_tasks task
              where task.session_id=s.id and task.save_revision_at_create=s.save_revision
                and task.request->>'operation' <> 'observe'
            ) and not exists (
              select 1 from spellbook_native_turns turn
              where turn.session_id=s.id and turn.status in ('queued','running')
            ) then 1 else 0 end,
          expires_at=${new Date(expiresAt)}, last_seen_at=now(), updated_at=now()
        where s.id=${existing.id}
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
    maxBytes: documentFormatOf(document.format_id).maxBytes,
    aiConnector: aiConnectorConfig(),
  };
}

export async function getBrowserDocument(
  session: Session,
  documentId: string,
): Promise<{ fileName: string; revision: string; data: Buffer }> {
  await ensureSchema();
  const [row] = await db()`
    select d.file_name,d.format_id,s.working_version_id,s.working_sha256,v.document_object
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
  const format = await sessionFormat(session, documentId);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > format.maxBytes)
    throw new HttpError(413, "document_too_large");
  const data = Buffer.from(await request.arrayBuffer());
  if (
    !data.length ||
    data.length > format.maxBytes ||
    data[0] !== 0x50 ||
    data[1] !== 0x4b
  )
    throw new HttpError(400, "invalid_document_package");
  return acceptBrowserSave(session, documentId, expectedRevision, {
    versionId: randomUUID(),
    digest: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    store: (object) =>
      putObject(object, data, format.mimeTypes[0]!),
    discard: async () => undefined,
    humanConfirmed:
      request.headers.get("x-spellbook-save-intent") === "human_confirmed",
  });
}

/**
 * The editor's file, as a short-lived link to read it straight from
 * storage. url is null when the store has none; the page then reads
 * GET .../contents, which passes the file through the app.
 */
export async function browserDocumentSource(
  session: Session,
  documentId: string,
): Promise<{
  revision: string;
  bytes: number | null;
  url: string | null;
}> {
  await ensureSchema();
  const [row] = await db()`
    select d.file_name,d.format_id,s.working_version_id,s.working_sha256,v.document_object,v.document_bytes
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions v on v.id=s.working_version_id and v.status='ready'
    where s.document_id=${documentId} and s.account_id=${session.accountId}
      and s.editor_mode='browser' and s.status='active' and s.expires_at > now()
  `;
  if (!row) throw new HttpError(409, "browser_session_not_active");
  return {
    revision: browserRevision(row.working_version_id, row.working_sha256),
    bytes: row.document_bytes === null ? null : Number(row.document_bytes),
    url: await directReadUrl(row.document_object, {
      fileName: row.file_name,
      contentType: documentFormatOf(row.format_id).mimeTypes[0]!,
    }),
  };
}

const BROWSER_SAVE_TOKEN_DOMAIN = "spellbook-browser-save-v1";
const BROWSER_SAVE_TOKEN_SECONDS = 10 * 60;

interface BrowserSaveClaims {
  version: 1;
  accountId: string;
  documentId: string;
  versionId: string;
  expectedRevision: string;
  size: number;
  expiresAt: number;
  humanConfirmed?: boolean;
}

/**
 * Starts a save that goes from the browser straight to storage, so a large
 * file never passes through the app. Returns direct: false when the store
 * cannot take one; the page then PUTs .../contents.
 */
export async function startBrowserSave(
  session: Session,
  documentId: string,
  request: Request,
): Promise<
  | { direct: false }
  | {
      direct: true;
      url: string;
      headers: Record<string, string>;
      token: string;
    }
> {
  await ensureSchema();
  requireBrowserOrigin(request);
  const expectedRevision = request.headers.get("if-match") ?? "";
  if (!expectedRevision) throw new HttpError(428, "browser_revision_required");
  const body = (await request.json().catch(() => ({}))) as { size?: unknown };
  const size = typeof body.size === "number" ? body.size : 0;
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new HttpError(400, "invalid_document_package");
  const current = await activeBrowserSession(session, documentId);
  const format = documentFormatOf(current.format_id);
  if (size > format.maxBytes)
    throw new HttpError(413, "document_too_large");
  if (
    browserRevision(current.working_version_id, current.working_sha256) !==
    expectedRevision
  )
    throw new HttpError(412, "browser_revision_changed");
  const versionId = randomUUID();
  const humanConfirmed =
    request.headers.get("x-spellbook-save-intent") === "human_confirmed";
  // Reject pending review before uploading a file that cannot become a version.
  await requireSavePolicy(current.id, current.save_revision, humanConfirmed);
  const target = await directWriteTarget(
    incomingObjectName(savedObjects(session, documentId, versionId, format.id).object),
    format.mimeTypes[0]!,
    format.maxBytes,
  );
  if (!target) return { direct: false };
  const claims: BrowserSaveClaims = {
    version: 1,
    accountId: session.accountId,
    documentId,
    versionId,
    expectedRevision,
    size,
    expiresAt: Date.now() + BROWSER_SAVE_TOKEN_SECONDS * 1000,
    humanConfirmed,
  };
  return {
    direct: true,
    url: target.url,
    headers: target.headers,
    token: signClaims(BROWSER_SAVE_TOKEN_DOMAIN, claims),
  };
}

/**
 * Checks the file the browser stored and saves it with the same checks as
 * a PUT: the session revision, size, package signature and a SHA-256 read
 * from storage itself, never from the browser.
 */
export async function completeBrowserSave(
  session: Session,
  documentId: string,
  request: Request,
): Promise<{ revision: string; unchanged: boolean }> {
  await ensureSchema();
  requireBrowserOrigin(request);
  const body = (await request.json().catch(() => ({}))) as {
    token?: unknown;
  };
  const claims =
    typeof body.token === "string"
      ? (verifiedClaims(
          BROWSER_SAVE_TOKEN_DOMAIN,
          body.token,
        ) as BrowserSaveClaims | null)
      : null;
  if (
    !claims ||
    claims.version !== 1 ||
    claims.accountId !== session.accountId ||
    claims.documentId !== documentId ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Date.now()
  )
    throw new HttpError(400, "invalid_browser_save");
  const format = await sessionFormat(session, documentId);
  const incoming = incomingObjectName(
    savedObjects(session, documentId, claims.versionId, format.id).object,
  );
  const stored = await objectDigest(incoming, 2);
  if (!stored) throw new HttpError(409, "upload_not_found");
  if (
    stored.size !== claims.size ||
    stored.size > format.maxBytes ||
    stored.head[0] !== 0x50 ||
    stored.head[1] !== 0x4b
  ) {
    await deleteObject(incoming).catch(() => undefined);
    throw new HttpError(400, "invalid_document_package");
  }
  return acceptBrowserSave(session, documentId, claims.expectedRevision, {
    versionId: claims.versionId,
    digest: stored.sha256,
    bytes: stored.size,
    store: (object) => moveObject(incoming, object),
    discard: () => deleteObject(incoming),
    humanConfirmed: claims.humanConfirmed === true,
  });
}

/** The format of an owned document (the size limit and stored type of its saves). */
async function sessionFormat(session: Session, documentId: string) {
  const [row] = await db()`
    select format_id from spellbook_documents
    where id=${documentId} and account_id=${session.accountId}
  `;
  if (!row) throw new HttpError(404, "document_not_found");
  return documentFormatOf(row.format_id);
}

function savedObjects(session: Session, documentId: string, versionId: string, formatId: string) {
  const prefix = accountPrefix(session.accountId, documentId);
  return {
    object: `${prefix}/versions/${versionId}/document${documentFormatOf(formatId).extensions[0]}`,
    outputPrefix: `${prefix}/versions/${versionId}/render`,
  };
}

async function activeBrowserSession(session: Session, documentId: string) {
  const [current] = await db()`
    select s.id,s.working_version_id,s.working_sha256,s.status,s.save_revision,
      d.format_id,current.document_object as preservation_object
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions current on current.id=d.current_version_id and current.status='ready'
    where s.document_id=${documentId} and s.account_id=${session.accountId}
      and s.editor_mode='browser' and s.expires_at > now()
  `;
  if (!current) throw new HttpError(409, "browser_session_not_active");
  if (current.status !== "active")
    throw new HttpError(409, "document_processing");
  return current;
}

/** One saved file, wherever its bytes came from, becomes a checked version. */
async function acceptBrowserSave(
  session: Session,
  documentId: string,
  expectedRevision: string,
  file: {
    versionId: string;
    digest: string;
    bytes: number;
    /** Puts the bytes at the version's object name. */
    store: (object: string) => Promise<void>;
    /** Drops bytes that turned out not to be needed. */
    discard: () => Promise<void>;
    humanConfirmed?: boolean;
  },
): Promise<{ revision: string; unchanged: boolean }> {
  const { digest } = file;
  const current = await activeBrowserSession(session, documentId);
  const currentRevision = browserRevision(
    current.working_version_id,
    current.working_sha256,
  );
  if (expectedRevision !== currentRevision)
    throw new HttpError(412, "browser_revision_changed");
  if (digest === current.working_sha256) {
    await db().begin(async (sql) => {
      const [locked] = await sql`
        select working_version_id,working_sha256,status,editor_mode
        from spellbook_native_sessions where id=${current.id} for update
      `;
      if (
        !locked ||
        locked.editor_mode !== "browser" ||
        locked.status !== "active"
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
    await file.discard().catch(() => undefined);
    return { revision: currentRevision, unchanged: true };
  }

  try {
    await requireSavePolicy(
      current.id,
      current.save_revision,
      file.humanConfirmed === true,
    );
  } catch (error) {
    await file.discard().catch(() => undefined);
    throw error;
  }

  // An unchanged save always succeeds; a new version must fit the plan.
  try {
    await assertStorageAvailable(session, { addingBytes: file.bytes });
  } catch (error) {
    await file.discard().catch(() => undefined);
    throw error;
  }
  const versionId = file.versionId;
  const jobId = randomUUID();
  const { object, outputPrefix } = savedObjects(session, documentId, versionId, current.format_id);
  await file.store(object);
  let payload: Record<string, unknown>;
  try {
    await db().begin(async (sql) => {
      const [locked] = await sql`
        select working_version_id,working_sha256,status,editor_mode,save_revision
        from spellbook_native_sessions where id=${current.id} for update
      `;
      if (!locked || locked.editor_mode !== "browser")
        throw new HttpError(409, "browser_session_changed");
      if (locked.status !== "active")
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
        formatId: documentFormatOf(current.format_id).id,
        saveRevision: locked.save_revision,
        bytes: file.bytes,
        humanConfirmed: file.humanConfirmed === true,
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

async function requireSavePolicy(
  sessionId: string,
  saveRevision: number,
  humanConfirmed: boolean,
) {
  try {
    await loadNativeSaveChangePolicy(
      db(),
      sessionId,
      saveRevision,
      humanConfirmed,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "native_ai_change_review_pending"
    )
      throw new HttpError(409, error.message);
    throw error;
  }
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
