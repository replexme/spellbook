import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type { Session } from "./models";
import { accountPrefix, deleteObject, getObject, putObject } from "./storage";
import { dispatchNativeSave, stageNativeSave } from "./native-save-stage";
import { signWopiToken, verifyWopiToken, type WopiClaims } from "./wopi-token";
import { currentPresentationFormat } from "./document-formats";
import { wopiLockConflict, type WopiMutation } from "./wopi-lock-policy";
import { internalAppBaseUrl } from "./runtime-urls";
import {
  aiConnectorConfig,
  type AiConnectorConfig,
} from "./ai-connector-config";
import {
  parseWopiProofKeys,
  rawQueryParameter,
  verifyWopiProof,
  type WopiProofKeys,
} from "./wopi-proof";

const SESSION_MS = 6 * 60 * 60 * 1000;
const OFFICE_DISCOVERY_TIMEOUT_MS = 75_000;
const OFFICE_DISCOVERY_CACHE_MS = 12 * 60 * 60 * 1000;
const OFFICE_WARM_TIMEOUT_MS = 150_000;

export interface NativeLaunch {
  editorKind: "wopi";
  documentId: string;
  fileName: string;
  editorUrl: string;
  accessToken: string;
  expiresAt: number;
  apiBase: string;
  aiConnector: AiConnectorConfig;
}

function publicUrl(): string {
  const value = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (!value) throw new Error("NEXT_PUBLIC_APP_URL is required.");
  return value;
}

function officeBase(): string {
  const value = process.env.SPELLBOOK_OFFICE_EDITOR_URL?.replace(/\/+$/, "");
  if (!value) throw new Error("SPELLBOOK_OFFICE_EDITOR_URL is required.");
  return value;
}

function officeInternalBase(): string {
  return (
    process.env.SPELLBOOK_OFFICE_EDITOR_INTERNAL_URL?.replace(/\/+$/, "") ??
    officeBase()
  );
}

interface OfficeDiscovery {
  actionUrl: string;
  proofKeys: WopiProofKeys | null;
}

export function createOfficeDiscoveryClient(
  fetcher: typeof fetch = fetch,
  timeoutMs = OFFICE_DISCOVERY_TIMEOUT_MS,
) {
  let cache: {
    base: string;
    expiresAt: number;
    discovery: OfficeDiscovery;
  } | null = null;
  let pending: {
    base: string;
    promise: Promise<OfficeDiscovery>;
  } | null = null;

  const resolve = async (base: string): Promise<OfficeDiscovery> => {
    if (cache?.base === base && cache.expiresAt > Date.now())
      return cache.discovery;
    if (pending?.base === base) return pending.promise;

    const promise = (async () => {
      let response: Response;
      try {
        response = await fetcher(`${base}/hosting/discovery`, {
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // A zero-instance Collabora service can need tens of seconds to start.
        // Treat an unavailable discovery endpoint as a retryable launch state,
        // not as a corrupt document or a permanent editor failure.
        throw new HttpError(503, "office_editor_starting");
      }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500)
          throw new HttpError(503, "office_editor_starting");
        throw new Error(`office_discovery_failed:${response.status}`);
      }
      const xml = await response.text();
      const actionUrl = parsePptxEditorActionUrl(xml);
      if (new URL(actionUrl).origin !== new URL(base).origin)
        throw new Error("office_discovery_origin_mismatch");
      const proofKeys = /<proof-key\b/i.test(xml)
        ? parseWopiProofKeys(xml)
        : null;
      const discovery = { actionUrl, proofKeys };
      cache = {
        base,
        expiresAt: Date.now() + OFFICE_DISCOVERY_CACHE_MS,
        discovery,
      };
      return discovery;
    })();

    pending = { base, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  };

  return {
    resolve,
    invalidate(base: string) {
      if (cache?.base === base) cache = null;
    },
  };
}

export function createOfficeDiscoveryResolver(
  fetcher: typeof fetch = fetch,
  timeoutMs = OFFICE_DISCOVERY_TIMEOUT_MS,
) {
  const client = createOfficeDiscoveryClient(fetcher, timeoutMs);
  return async (base: string): Promise<string> =>
    (await client.resolve(base)).actionUrl;
}

const officeDiscoveryClient = createOfficeDiscoveryClient();

async function editorActionUrl(): Promise<string> {
  const publicBase = officeBase();
  const configured = process.env.SPELLBOOK_OFFICE_EDITOR_ACTION_URL?.trim();
  if (configured) return validateOfficeEditorActionUrl(configured, publicBase);
  const internalBase = officeInternalBase();
  const discovered = (await officeDiscoveryClient.resolve(internalBase))
    .actionUrl;
  const parsed = new URL(discovered);
  const publicOrigin = new URL(publicBase);
  parsed.protocol = publicOrigin.protocol;
  parsed.host = publicOrigin.host;
  return validateOfficeEditorActionUrl(parsed.toString(), publicBase);
}

export function validateOfficeEditorActionUrl(
  actionUrl: string,
  base: string,
): string {
  const parsed = new URL(actionUrl);
  if (parsed.origin !== new URL(base).origin)
    throw new Error("office_discovery_origin_mismatch");
  if (!parsed.pathname.endsWith("/cool.html"))
    throw new Error("office_editor_action_url_invalid");
  return actionUrl;
}

export async function warmOfficeEditor(
  fetcher: typeof fetch = fetch,
  timeoutMs = OFFICE_WARM_TIMEOUT_MS,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${officeInternalBase()}/readyz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(503, "office_editor_starting");
  }
  if (!response.ok) throw new HttpError(503, "office_editor_starting");
}

export function parsePptxEditorActionUrl(xml: string): string {
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/gi)) {
    if (
      xmlAttribute(app[1], "name")?.toLowerCase() !==
      currentPresentationFormat.editor.wopiApp
    )
      continue;
    for (const action of app[2].matchAll(/<action\b([^>]*)\/?\s*>/gi)) {
      const attributes = action[1];
      if (
        xmlAttribute(attributes, "ext")?.toLowerCase() ===
          currentPresentationFormat.extensions[0]!.slice(1) &&
        xmlAttribute(attributes, "name")?.toLowerCase() ===
          currentPresentationFormat.editor.wopiAction
      ) {
        const url = xmlAttribute(attributes, "urlsrc");
        if (url) return url.replaceAll("&amp;", "&");
      }
    }
  }
  throw new Error("office_pptx_editor_not_discovered");
}

function xmlAttribute(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`, "i"),
  )?.[1];
}

export function buildPptxEditorUrl(
  actionUrl: string,
  wopiSource: string,
): string {
  const url = new URL(actionUrl);
  url.searchParams.set("lang", "ko-KR");
  url.searchParams.set("ui", "ko-KR");
  url.searchParams.set("rs", "ko-KR");
  url.searchParams.set("WOPISrc", wopiSource);
  return url.toString();
}

export async function createNativeLaunch(
  session: Session,
  documentId: string,
): Promise<NativeLaunch> {
  await ensureSchema();
  const expiresAt = Date.now() + SESSION_MS;
  const row = (await db().begin(async (sql) => {
    const [document] = await sql`
      select d.id, d.file_name, d.format_id, d.current_version_id, d.status,
        v.document_sha256, v.status as version_status
      from spellbook_documents d left join spellbook_versions v on v.id=d.current_version_id
      where d.id=${documentId} and d.account_id=${session.accountId}
      for update of d
    `;
    if (!document) throw new HttpError(404, "document_not_found");
    if (document.format_id !== currentPresentationFormat.id)
      throw new HttpError(409, "format_editor_not_available");
    if (document.status === "failed" || document.version_status === "failed")
      throw new HttpError(422, "document_processing_failed");
    if (
      !["ready", "candidate_ready"].includes(document.status) ||
      document.version_status !== "ready"
    )
      throw new HttpError(409, "document_processing");
    if (document.status === "candidate_ready") {
      await sql`update spellbook_versions set kind='abandoned' where id in
        (select candidate_version_id from spellbook_edit_requests where document_id=${documentId} and status='candidate_ready')`;
      await sql`update spellbook_edit_requests set status='rejected',updated_at=now()
        where document_id=${documentId} and status='candidate_ready'`;
      await sql`update spellbook_documents set status='ready',updated_at=now() where id=${documentId}`;
    }
    const [existing] = await sql`
      select * from spellbook_native_sessions
      where document_id=${documentId} and account_id=${session.accountId}
      for update
    `;
    if (existing) {
      if (
        existing.editor_mode === "browser" &&
        existing.status === "validating"
      )
        throw new HttpError(409, "document_processing");
      const reusable =
        new Date(existing.expires_at).getTime() > Date.now() &&
        ["active", "validating"].includes(existing.status);
      const [updated] = await sql`
        update spellbook_native_sessions set
          account_email=${session.email},
          editor_mode='wopi',
          working_version_id=${reusable ? existing.working_version_id : document.current_version_id},
          working_sha256=${reusable ? existing.working_sha256 : document.document_sha256},
          status=${reusable ? existing.status : "active"},
          wopi_lock=${reusable ? existing.wopi_lock : null},
          lock_updated_at=${reusable ? existing.lock_updated_at : null},
          lock_expires_at=${reusable ? existing.lock_expires_at : null},
          expires_at=${new Date(expiresAt)}, last_seen_at=now(), updated_at=now(),
          last_error=${reusable ? existing.last_error : null}
        where id=${existing.id}
        returning id, working_version_id
      `;
      return { ...document, ...updated };
    }
    const id = randomUUID();
    await sql`
      insert into spellbook_native_sessions
        (id,document_id,account_id,account_email,working_version_id,working_sha256,editor_mode,status,expires_at)
      values (${id},${documentId},${session.accountId},${session.email},${document.current_version_id},${document.document_sha256},'wopi','active',${new Date(expiresAt)})
    `;
    return { ...document, id, working_version_id: document.current_version_id };
  })) as Record<string, any>;
  const token = signWopiToken({
    version: 1,
    sessionId: row.id,
    documentId,
    accountId: session.accountId,
    expiresAt,
  });
  const wopiSource = `${internalAppBaseUrl()}/api/wopi/files/${documentId}`;
  const editorUrl = await editorActionUrl();
  return {
    editorKind: "wopi",
    documentId,
    fileName: row.file_name,
    editorUrl: buildPptxEditorUrl(editorUrl, wopiSource),
    accessToken: token,
    expiresAt,
    apiBase: `/api/documents/${documentId}/native`,
    aiConnector: aiConnectorConfig(),
  };
}

export async function requireWopi(
  request: Request,
  documentId: string,
): Promise<
  WopiClaims & {
    fileName: string;
    documentObject: string;
    preservationObject: string;
    versionId: string;
    lock: string | null;
  }
> {
  const token = new URL(request.url).searchParams.get("access_token") ?? "";
  let claims: WopiClaims;
  try {
    claims = verifyWopiToken(token, documentId);
  } catch {
    throw new HttpError(401, "invalid_wopi_token");
  }
  await requireValidWopiProof(request);
  await ensureSchema();
  await expireWopiLock(claims.sessionId);
  const [row] = await db()`
    select s.id, s.wopi_lock, s.working_version_id, d.file_name,
      coalesce(working.document_object,current.document_object) as document_object,
      current.document_object as preservation_object,
      coalesce(working.id,current.id) as version_id
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions current on current.id=d.current_version_id and current.status='ready'
    left join spellbook_versions working on working.id=s.working_version_id and working.status in ('processing','ready')
    where s.id=${claims.sessionId} and s.document_id=${documentId}
      and s.account_id=${claims.accountId} and s.status in ('active','validating') and s.expires_at > now()
      and s.editor_mode='wopi'
  `;
  if (!row) throw new HttpError(401, "expired_wopi_session");
  await db()`update spellbook_native_sessions set last_seen_at=now() where id=${claims.sessionId}`;
  return {
    ...claims,
    fileName: row.file_name,
    documentObject: row.document_object,
    preservationObject: row.preservation_object,
    versionId: row.version_id,
    lock: row.wopi_lock,
  };
}

async function requireValidWopiProof(request: Request): Promise<void> {
  const configured =
    process.env.SPELLBOOK_WOPI_PROOF_MODE?.trim().toLowerCase();
  const mode =
    configured ||
    (process.env.NODE_ENV === "production" ? "required" : "disabled");
  if (mode === "disabled") return;
  if (mode !== "required") throw new HttpError(500, "invalid_wopi_proof_mode");

  const accessToken = rawQueryParameter(request.url, "access_token") ?? "";
  const receivedUrl = new URL(request.url);
  const signedUrl = new URL(internalAppBaseUrl());
  signedUrl.pathname = receivedUrl.pathname;
  signedUrl.search = receivedUrl.search;
  const input = {
    accessToken,
    requestUrl: signedUrl.toString(),
    timestamp: request.headers.get("x-wopi-timestamp") ?? "",
    proof: request.headers.get("x-wopi-proof") ?? "",
    oldProof: request.headers.get("x-wopi-proofold") ?? "",
  };
  const base = officeInternalBase();
  let discovery: OfficeDiscovery;
  try {
    discovery = await officeDiscoveryClient.resolve(base);
  } catch {
    throw new HttpError(500, "wopi_proof_discovery_unavailable");
  }
  let match = discovery.proofKeys
    ? verifyWopiProof(input, discovery.proofKeys)
    : null;
  if (!match) {
    officeDiscoveryClient.invalidate(base);
    try {
      discovery = await officeDiscoveryClient.resolve(base);
    } catch {
      throw new HttpError(500, "wopi_proof_discovery_unavailable");
    }
    match = discovery.proofKeys
      ? verifyWopiProof(input, discovery.proofKeys)
      : null;
  }
  if (!match) throw new HttpError(500, "invalid_wopi_proof");
  if (match !== "current-proof-current-key")
    officeDiscoveryClient.invalidate(base);
}

export async function wopiCheckFileInfo(request: Request, documentId: string) {
  const context = await requireWopi(request, documentId);
  const data = await getObject(context.documentObject);
  const base = publicUrl();
  return {
    BaseFileName: context.fileName,
    OwnerId: context.accountId,
    Size: data.length,
    UserId: context.accountId,
    UserFriendlyName: "Spellbook 사용자",
    UserPreferredLanguage: "ko-KR",
    Version: context.versionId,
    UserCanWrite: true,
    ReadOnly: false,
    SupportsLocks: true,
    SupportsGetLock: true,
    SupportsExtendedLockLength: true,
    SupportsUpdate: true,
    PostMessageOrigin: base,
  };
}

export async function wopiGetFile(request: Request, documentId: string) {
  const context = await requireWopi(request, documentId);
  return getObject(context.documentObject);
}

export async function wopiGetAsset(
  request: Request,
  documentId: string,
  assetId: string,
) {
  await requireWopi(request, documentId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      assetId,
    )
  )
    throw new HttpError(404, "asset_not_found");
  const [asset] = await db()`
    select object_name, content_type from spellbook_assets
    where id=${assetId} and document_id=${documentId}
  `;
  if (!asset) throw new HttpError(404, "asset_not_found");
  return {
    data: await getObject(asset.object_name),
    contentType: asset.content_type as string,
  };
}

export async function wopiLock(
  request: Request,
  documentId: string,
): Promise<{ status: number; lock?: string }> {
  const context = await requireWopi(request, documentId);
  const operation = request.headers.get("x-wopi-override")?.toUpperCase();
  const given = request.headers.get("x-wopi-lock") ?? "";
  if (
    !operation ||
    !["LOCK", "REFRESH_LOCK", "UNLOCK", "GET_LOCK"].includes(operation)
  )
    throw new HttpError(400, "unsupported_wopi_operation");
  if (operation !== "GET_LOCK" && !validWopiLock(given))
    throw new HttpError(400, "invalid_wopi_lock");
  const oldLock = request.headers.get("x-wopi-oldlock");
  if (oldLock !== null && !validWopiLock(oldLock))
    throw new HttpError(400, "invalid_wopi_old_lock");
  const changesLock = operation === "LOCK" || operation === "REFRESH_LOCK";
  const lockSeconds = changesLock ? wopiLockSeconds(request) : null;
  return db().begin(async (sql) => {
    await expireWopiLock(context.sessionId, sql);
    const [session] =
      await sql`select wopi_lock from spellbook_native_sessions where id=${context.sessionId} for update`;
    const current = session?.wopi_lock as string | null;
    if (operation === "GET_LOCK") return { status: 200, lock: current ?? "" };
    const conflict = wopiLockConflict(operation as WopiMutation, current, given, oldLock);
    if (conflict !== null) return { status: 409, lock: conflict };
    if (operation === "UNLOCK") {
      await sql`update spellbook_native_sessions set wopi_lock=null, lock_updated_at=null, lock_expires_at=null, updated_at=now() where id=${context.sessionId}`;
      return { status: 200 };
    }
    if (operation === "LOCK" || operation === "REFRESH_LOCK") {
      await sql`update spellbook_native_sessions set wopi_lock=${given}, lock_updated_at=now(), lock_expires_at=now() + ${lockSeconds} * interval '1 second', updated_at=now() where id=${context.sessionId}`;
      return { status: 200 };
    }
    return { status: 400 };
  });
}

async function expireWopiLock(
  sessionId: string,
  sql: Sql | TransactionSql = db(),
): Promise<void> {
  await sql`
    update spellbook_native_sessions set
      wopi_lock=null,lock_updated_at=null,lock_expires_at=null,updated_at=now()
    where id=${sessionId} and wopi_lock is not null
      and coalesce(lock_expires_at,lock_updated_at + interval '30 minutes') <= now()
  `;
}

function validWopiLock(value: string): boolean {
  return /^[\x20-\x7e]{1,1024}$/u.test(value);
}

function wopiLockSeconds(request: Request): number {
  const value = request.headers.get("x-wopi-lockexpirationtimeout");
  if (value === null) return 30 * 60;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 60 * 60)
    throw new HttpError(400, "invalid_wopi_lock_timeout");
  return seconds;
}

export async function wopiPutFile(
  request: Request,
  documentId: string,
): Promise<{ version: string; unchanged: boolean }> {
  const context = await requireWopi(request, documentId);
  const given = request.headers.get("x-wopi-lock") ?? "";
  if (!context.lock || context.lock !== given)
    throw new WopiLockConflict(context.lock ?? "");
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
  const unchangedVersion = await db().begin(async (sql) => {
    await expireWopiLock(context.sessionId, sql);
    const [current] =
      await sql`select working_sha256,working_version_id,wopi_lock from spellbook_native_sessions where id=${context.sessionId} for update`;
    if (!current?.wopi_lock || current.wopi_lock !== given)
      throw new WopiLockConflict(current?.wopi_lock ?? "");
    if (current.working_sha256 !== digest) return null;
    await sql`update spellbook_native_sessions set last_seen_at=now(),updated_at=now() where id=${context.sessionId}`;
    return current.working_version_id as string;
  });
  if (unchangedVersion) return { version: unchangedVersion, unchanged: true };

  const versionId = randomUUID();
  const jobId = randomUUID();
  const prefix = accountPrefix(context.accountId, documentId);
  const object = `${prefix}/versions/${versionId}/document.pptx`;
  const outputPrefix = `${prefix}/versions/${versionId}/render`;
  await putObject(object, data, currentPresentationFormat.mimeTypes[0]!);
  let payload: Record<string, unknown>;
  try {
    await db().begin(async (sql) => {
      await expireWopiLock(context.sessionId, sql);
      const [session] =
        await sql`select working_version_id,wopi_lock,save_revision from spellbook_native_sessions where id=${context.sessionId} for update`;
      if (!session?.wopi_lock || session.wopi_lock !== given)
        throw new WopiLockConflict(session?.wopi_lock ?? "");
      if (session.working_version_id !== context.versionId)
        throw new HttpError(409, "wopi_session_changed");
      payload = await stageNativeSave(sql, {
        sessionId: context.sessionId,
        documentId,
        parentVersionId: session.working_version_id,
        versionId,
        jobId,
        object,
        outputPrefix,
        digest,
        preservationObject: context.preservationObject,
        saveRevision: session.save_revision,
        editorModified: modifiedByUser(request),
        bytes: data.length,
      });
    });
  } catch (error) {
    await deleteObject(object).catch(() => undefined);
    throw error;
  }
  await dispatchNativeSave(jobId, payload!);
  return { version: versionId, unchanged: false };
}

/**
 * Collabora states whether a person changed the document since the last
 * save. A forced save of an unchanged document (the AI baseline) says false.
 */
function modifiedByUser(request: Request): boolean | null {
  const value =
    request.headers.get("x-cool-wopi-ismodifiedbyuser") ??
    request.headers.get("x-lool-wopi-ismodifiedbyuser");
  return value === "true" ? true : value === "false" ? false : null;
}

export class WopiLockConflict extends Error {
  constructor(readonly lock: string) {
    super("wopi_lock_mismatch");
  }
}
