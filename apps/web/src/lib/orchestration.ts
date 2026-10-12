import { randomUUID } from "node:crypto";

import {
  accountPrefix,
  deleteObject,
  directReadUrl,
  directWriteTarget,
  moveObject,
  objectHead,
  storageNamespace,
  getObject,
  putObject,
} from "./storage";
import { signClaims, verifiedClaims } from "./signed-claims";
import { db, ensureSchema } from "./db";
import type { Session, WorkerCallback } from "./models";
import { HttpError } from "./http";
import {
  enqueueWorkerJob,
  type WorkerLane,
  type WorkerTarget,
} from "./workers";
import {
  completeNativeScan,
  completeNativeTurn,
  failNativeScan,
  failNativeTurn,
  recordNativeTurnUsage,
  NativeScanValidationError,
} from "./native-runtime";
import {
  availableDocumentFormatForFile,
  documentFormat,
  documentFormatOf,
  documentFormats,
  browserViewFormatIds,
  contentTypeForName,
  type DocumentFormat,
} from "./document-formats";
import { blankDocument } from "./blank-documents";
import { internalAppBaseUrl } from "./runtime-urls";
import { retryableFailure } from "./upload-reasons";
import { incomingObjectName } from "./incoming-objects";
import {
  assertStorageAvailable,
  measureDocumentStorage,
} from "./storage-usage";
import { maintainDocumentStorage } from "./version-retention";
import {
  documentJobRecovery,
  documentJobRecoveryPolicy,
  jobRedeliverySeconds,
  STALE_JOB_FAILURE_CODE,
} from "./job-delivery";

interface Dispatch {
  jobId: string;
  target: WorkerTarget;
  path: string;
  payload: Record<string, unknown>;
  lane?: WorkerLane;
}

export async function listDocuments(session: Session) {
  await ensureSchema();
  const rows = await db()`
    select id, file_name, format_id, status, last_error, created_at, updated_at
    from spellbook_documents
    where account_id = ${session.accountId}
    order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    formatId: row.format_id,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** The document format for an upload, or the reason code it is refused. */
function uploadFormat(fileName: string, size: number): DocumentFormat {
  // Reason codes; the product UI turns each into a sentence and a fix.
  const format = availableDocumentFormatForFile(fileName);
  if (!format) throw new HttpError(400, "unsupported_format");
  if (size <= 0) throw new HttpError(400, "empty_file");
  if (size > format.maxBytes) throw new HttpError(400, "file_too_large");
  return format;
}

/** Office files are ZIP packages; refuse anything else before processing. */
function packageProblem(head: Buffer): string | null {
  if (head[0] === 0x50 && head[1] === 0x4b) return null;
  // OLE compound files: password-protected OOXML or a renamed legacy .ppt.
  return head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    ? "encrypted_or_legacy_file"
    : "invalid_package";
}

function uploadObjects(
  session: Session,
  documentId: string,
  versionId: string,
  format: DocumentFormat,
) {
  const prefix = accountPrefix(session.accountId, documentId);
  const documentObject = `${prefix}/versions/${versionId}/document${format.extensions[0]}`;
  return {
    documentObject,
    // The browser writes here first; a bucket rule removes what is never
    // completed (INCOMING_SUFFIX), and completion moves it into place.
    incomingObject: incomingObjectName(documentObject),
    outputPrefix: `${prefix}/versions/${versionId}/render`,
  };
}

/** Records a stored upload as a new document and starts its processing. */
async function registerUpload(
  session: Session,
  upload: {
    documentId: string;
    versionId: string;
    fileName: string;
    format: DocumentFormat;
    bytes: number;
  },
): Promise<{ id: string }> {
  const { documentId, versionId, fileName, format, bytes } = upload;
  const jobId = randomUUID();
  const { documentObject, outputPrefix } = uploadObjects(
    session,
    documentId,
    versionId,
    format,
  );
  const dispatch: Dispatch = {
    jobId,
    target: "document",
    path: "/internal/jobs/scan-render",
    lane: "upload",
    payload: {
      jobId,
      callbackUrl: callbackUrl(),
      storageNamespace: storageNamespace(),
      formatId: format.id,
      inputObject: documentObject,
      outputPrefix,
    },
  };
  const sql = db();
  await sql.begin(async (transaction) => {
    await transaction`
      insert into spellbook_documents (id, account_id, file_name, format_id, status, original_version_id, current_version_id)
      values (${documentId}, ${session.accountId}, ${fileName}, ${format.id}, 'processing', ${versionId}, ${versionId})
    `;
    await transaction`
      insert into spellbook_versions (id, document_id, kind, status, document_object, document_bytes)
      values (${versionId}, ${documentId}, 'original', 'processing', ${documentObject}, ${bytes})
    `;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, status, payload)
      values (${jobId}, 'scan_render', ${documentId}, ${versionId}, 'queued', ${transaction.json(jsonValue(dispatch.payload))})
    `;
    await addEvent(transaction, documentId, "document_uploaded", {
      fileName,
      formatId: format.id,
      versionId,
    });
  });
  await dispatchOrFail(dispatch).catch(() => undefined);
  return { id: documentId };
}

/** A new, empty document of a format the browser view opens, processed like an upload. */
export async function createBlankDocument(
  session: Session,
  formatId: unknown,
): Promise<{ id: string }> {
  const format = documentFormats().find((f) => f.id === formatId);
  const blank = format && browserViewFormatIds.includes(format.id) ? blankDocument(format.id) : null;
  if (!format || !blank) throw new HttpError(400, "unsupported_format");
  await ensureSchema();
  await assertStorageAvailable(session, {
    newDocument: true,
    addingBytes: blank.bytes.length,
  });
  const documentId = randomUUID();
  const versionId = randomUUID();
  const { documentObject } = uploadObjects(session, documentId, versionId, format);
  await putObject(documentObject, blank.bytes, format.mimeTypes[0]!);
  return registerUpload(session, {
    documentId,
    versionId,
    fileName: blank.fileName,
    format,
    bytes: blank.bytes.length,
  });
}

export async function uploadDocument(
  session: Session,
  file: File,
): Promise<{ id: string }> {
  await ensureSchema();
  const format = uploadFormat(file.name, file.size);
  await assertStorageAvailable(session, {
    newDocument: true,
    addingBytes: file.size,
  });
  const data = Buffer.from(await file.arrayBuffer());
  const problem = packageProblem(data);
  if (problem) throw new HttpError(400, problem);
  const documentId = randomUUID();
  const versionId = randomUUID();
  const { documentObject } = uploadObjects(session, documentId, versionId, format);
  await putObject(documentObject, data, format.mimeTypes[0]!);
  return registerUpload(session, {
    documentId,
    versionId,
    fileName: file.name,
    format,
    bytes: data.length,
  });
}

const UPLOAD_TOKEN_DOMAIN = "spellbook-direct-upload-v1";
const UPLOAD_TOKEN_SECONDS = 15 * 60;

interface UploadClaims {
  version: 1;
  accountId: string;
  documentId: string;
  versionId: string;
  fileName: string;
  formatId: string;
  size: number;
  expiresAt: number;
}

/**
 * Starts an upload that goes from the browser straight to storage. Returns
 * direct: false when the store cannot take one; the page then posts the file.
 */
export async function startDirectUpload(
  session: Session,
  input: { fileName?: unknown; size?: unknown },
) {
  const fileName = typeof input.fileName === "string" ? input.fileName : "";
  const size = typeof input.size === "number" ? input.size : 0;
  if (!fileName || fileName.length > 255 || !Number.isSafeInteger(size))
    throw new HttpError(400, "invalid_upload");
  const format = uploadFormat(fileName, size);
  await ensureSchema();
  await assertStorageAvailable(session, {
    newDocument: true,
    addingBytes: size,
  });
  const documentId = randomUUID();
  const versionId = randomUUID();
  const { incomingObject } = uploadObjects(session, documentId, versionId, format);
  const target = await directWriteTarget(
    incomingObject,
    format.mimeTypes[0]!,
    format.maxBytes,
  );
  if (!target) return { direct: false as const };
  const claims: UploadClaims = {
    version: 1,
    accountId: session.accountId,
    documentId,
    versionId,
    fileName,
    formatId: format.id,
    size,
    expiresAt: Date.now() + UPLOAD_TOKEN_SECONDS * 1000,
  };
  return {
    direct: true as const,
    url: target.url,
    headers: target.headers,
    token: signClaims(UPLOAD_TOKEN_DOMAIN, claims),
  };
}

/** Checks what the browser stored and records it as a new document. */
export async function completeDirectUpload(session: Session, token: unknown) {
  await ensureSchema();
  const claims =
    typeof token === "string"
      ? (verifiedClaims(UPLOAD_TOKEN_DOMAIN, token) as UploadClaims | null)
      : null;
  if (
    !claims ||
    claims.version !== 1 ||
    claims.accountId !== session.accountId ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Date.now()
  )
    throw new HttpError(400, "invalid_upload");
  const [existing] = await db()`
    select id from spellbook_documents
    where id=${claims.documentId} and account_id=${session.accountId}
  `;
  if (existing) return { id: String(existing.id) };
  const format = documentFormat(claims.formatId as DocumentFormat["id"]);
  const { documentObject, incomingObject } = uploadObjects(
    session,
    claims.documentId,
    claims.versionId,
    format,
  );
  // A retried completion finds the file already moved into place.
  const incoming = await objectHead(incomingObject, 4);
  const stored = incoming ?? (await objectHead(documentObject, 4));
  if (!stored) throw new HttpError(409, "upload_not_found");
  const problem =
    stored.size !== claims.size
      ? "upload_incomplete"
      : stored.size > format.maxBytes
        ? "file_too_large"
        : packageProblem(stored.head);
  if (problem) {
    await deleteObject(incoming ? incomingObject : documentObject).catch(
      () => undefined,
    );
    throw new HttpError(400, problem);
  }
  if (incoming) await moveObject(incomingObject, documentObject);
  return registerUpload(session, {
    documentId: claims.documentId,
    versionId: claims.versionId,
    fileName: claims.fileName,
    format,
    bytes: stored.size,
  });
}

export async function handleWorkerCallback(
  callback: WorkerCallback,
): Promise<void> {
  await ensureSchema();
  const jobs =
    await db()`select * from spellbook_jobs where id = ${callback.jobId} limit 1`;
  const job = jobs[0];
  // What the AI used counts even for a request the person already stopped.
  if (job?.job_type === "native_turn" && job.status === "failed")
    await recordNativeTurnUsage(
      job.id,
      (callback.result as { modelInput?: unknown } | undefined)?.modelInput,
    );
  if (!job || job.status === "failed") return;
  if (job.status === "succeeded") {
    // A repeated callback: send any of this document's jobs still waiting.
    await dispatchPendingJobs(job.document_id);
    return;
  }
  if (callback.status === "failed") {
    if (job.job_type === "native_turn") {
      await failNativeTurn(
        job.id,
        callback.error ?? "native_worker_failed",
        (callback.result as { modelInput?: unknown } | undefined)?.modelInput,
      );
      return;
    }
    if (job.job_type === "scan_render" && job.payload?.nativeSessionId) {
      await failNativeScan(
        job,
        callback.error ?? "native_save_validation_failed",
        callback,
      );
      return;
    }
    await markJobFailure(
      job,
      callback.error ?? "worker_failed",
      workerErrorCode(callback),
    );
    return;
  }
  try {
    if (job.job_type === "scan_render") {
      if (job.payload?.nativeSessionId) await completeNativeScan(job, callback);
      else await completeScan(job, callback);
    } else if (job.job_type === "native_turn")
      await completeNativeTurn(job, callback);
    else throw new Error(`Unknown job type '${job.job_type}'.`);
  } catch (error) {
    if (
      error instanceof NativeScanValidationError &&
      job.job_type === "scan_render" &&
      job.payload?.nativeSessionId
    ) {
      await failNativeScan(job, error.message, callback);
      return;
    }
    throw error;
  }
  if (job.job_type === "scan_render") await maintainAfterScan(job);
}

/**
 * After a file check: a save may have pushed old automatic saves past the
 * kept number, and a new import needs its size measured. Storage upkeep
 * never fails the check that already succeeded.
 */
async function maintainAfterScan(job: Record<string, any>): Promise<void> {
  try {
    const [document] =
      await db()`select account_id from spellbook_documents where id = ${job.document_id}`;
    if (!document) return;
    if (job.payload?.nativeSessionId)
      await maintainDocumentStorage(document.account_id, job.document_id);
    else await measureDocumentStorage(document.account_id, job.document_id);
  } catch (error) {
    console.error(
      JSON.stringify({
        eventType: "document_storage_maintenance_failed",
        documentId: job.document_id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Which stored file a download serves, and the name the person gets. */
async function downloadSource(
  session: Session,
  documentId: string,
  source: "current" | "original",
): Promise<{ name: string; objectName: string }> {
  await ensureSchema();
  if (source === "original") {
    const rows =
      await db()`select d.file_name, v.document_object from spellbook_documents d
      join spellbook_versions v on v.id = d.original_version_id and v.document_id = d.id
      where d.id = ${documentId} and d.account_id = ${session.accountId} limit 1`;
    if (!rows[0]) throw new HttpError(404, "document_not_found");
    return {
      name: `원본-${rows[0].file_name}`,
      objectName: rows[0].document_object,
    };
  }
  const rows = await db()`
    select d.file_name, v.document_object from spellbook_documents d
    join spellbook_versions v on v.id = d.current_version_id
    where d.id = ${documentId} and d.account_id = ${session.accountId} and v.status = 'ready'
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new HttpError(404, "document_not_found");
  return { name: row.file_name, objectName: row.document_object };
}

export async function downloadCurrent(
  session: Session,
  documentId: string,
  source: "current" | "original" = "current",
): Promise<{ name: string; data: Buffer }> {
  const file = await downloadSource(session, documentId, source);
  return { name: file.name, data: await getObject(file.objectName) };
}

/**
 * A signed link that lets the browser download straight from storage, or
 * null when the store has none and the file must pass through the app.
 */
export async function directDownloadUrl(
  session: Session,
  documentId: string,
  source: "current" | "original",
): Promise<string | null> {
  const file = await downloadSource(session, documentId, source);
  return directReadUrl(file.objectName, { fileName: file.name, contentType: contentTypeForName(file.name) });
}

async function completeScan(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<void> {
  const outputs = callback.outputs;
  if (!outputs) throw new Error("Document worker callback has no outputs.");
  await db().begin(async (transaction) => {
    const claimed = await claimJob(transaction, job.id, callback);
    if (!claimed) return;
    await transaction`
      update spellbook_versions set status = 'ready', graph_object = ${outputs.graphObject},
        scan_object = ${outputs.scanObject ?? null}, document_sha256 = ${outputs.documentSha256},
        slide_count = ${outputs.slideCount}
      where id = ${job.version_id}
    `;
    await transaction`
      update spellbook_documents set status = 'ready', last_error = null, updated_at = now()
      where id = ${job.document_id}
    `;
    await addEvent(transaction, job.document_id, "document_ready", {
      versionId: job.version_id,
      slideCount: outputs.slideCount,
    });
  });
}

async function claimJob(
  transaction: any,
  jobId: string,
  callback: WorkerCallback,
): Promise<boolean> {
  const rows = await transaction`
    update spellbook_jobs set status = 'succeeded', outputs = ${transaction.json(jsonValue(callback))}, updated_at = now()
    where id = ${jobId} and status in ('queued','running') returning id
  `;
  return rows.length > 0;
}

/**
 * The document worker's reason code for a failed job ("encrypted_or_legacy_file",
 * "invalid_package", ...). Read defensively: older workers send none.
 */
function workerErrorCode(callback: WorkerCallback): string | null {
  const code = (callback as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && /^[a-z][a-z_]{2,63}$/.test(code)
    ? code
    : null;
}

export async function markJobFailure(
  job: Record<string, any>,
  error: string,
  code: string | null = null,
): Promise<void> {
  await db().begin(async (transaction) => {
    await transaction`select id from spellbook_documents where id = ${job.document_id} for update`;
    const rows = await transaction`
      update spellbook_jobs set status = 'failed', error = ${error}, updated_at = now()
      where id = ${job.id} and status in ('queued','running') returning id
    `;
    if (!rows[0]) return;
    // Only an unfinished file check's version can fail.
    if (job.version_id && job.job_type === "scan_render")
      await transaction`update spellbook_versions set status = 'failed' where id = ${job.version_id} and status = 'processing' and kind in ('original', 'candidate')`;
    await transaction`update spellbook_documents set status = ${job.job_type === "scan_render" ? "failed" : "ready"}, last_error = ${error}, updated_at = now() where id = ${job.document_id}`;
    if (job.job_type === "scan_render")
      await transaction`update spellbook_documents set failure_code = ${code} where id = ${job.document_id}`;
    await addEvent(transaction, job.document_id, "job_failed", {
      jobId: job.id,
      jobType: job.job_type,
      error,
    });
  });
}

async function dispatchOrFail(dispatch: Dispatch): Promise<void> {
  try {
    await enqueueWorkerJob(
      dispatch.jobId,
      dispatch.target,
      dispatch.path,
      dispatch.payload,
      { lane: dispatch.lane },
    );
    await db()`update spellbook_jobs set dispatched_at = now(), error = null,
      delivery_count = greatest(delivery_count, 1) where id = ${dispatch.jobId}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "dispatch_failed";
    // Dispatch failure is recoverable, not a failed document.
    await db()`update spellbook_jobs set error = ${message}, updated_at = now()
      where id = ${dispatch.jobId} and status = 'queued'`;
    throw error;
  }
}

function documentJobRoute(job: Record<string, any>): {
  path: string;
  lane: WorkerLane;
} {
  return {
    path: "/internal/jobs/scan-render",
    lane: job.payload?.nativeSessionId ? "save" : "upload",
  };
}

async function dispatchPendingJobs(documentId: string): Promise<void> {
  const retryAfterSeconds = jobRedeliverySeconds();
  // AI jobs are re-sent on a short lease. A document job is re-sent only if
  // it never reached its queue: once delivered, it may still be rendering,
  // and recoverStaleDocumentJobs decides when it is lost.
  const jobs =
    await db()`select * from spellbook_jobs where document_id = ${documentId}
    and status = 'queued'
    and (
      (job_type = 'scan_render' and dispatched_at is null)
      or (job_type = 'native_turn'
        and (dispatched_at is null or dispatched_at < now() - ${retryAfterSeconds} * interval '1 second'))
    )
    order by created_at limit 4`;
  for (const job of jobs) {
    const isDocument = job.job_type === "scan_render";
    await dispatchOrFail({
      jobId: job.id,
      target: isDocument ? "document" : "ai",
      path: isDocument ? documentJobRoute(job).path : "/internal/jobs/native",
      lane: isDocument ? documentJobRoute(job).lane : undefined,
      payload: job.payload,
    });
  }
}

// Each browser poll may ask; one check per document per instance is enough.
const RECOVERY_CHECK_MS = 10_000;
const recoveryChecks = new Map<string, number>();

/**
 * Makes sure every unfinished document job either finishes or visibly
 * fails. A job that never reached its queue, or whose delivery was lost, is
 * sent again; one that has waited too long fails with a reason code the
 * page explains and offers a retry for. Called from the requests a waiting
 * page actually makes (status polls, summaries, the file list).
 */
export async function recoverStaleDocumentJobs(scope: {
  accountId: string;
  documentId?: string;
}): Promise<void> {
  // A page load must never fail because recovery could not run this time.
  await recoverStaleJobs(scope).catch((error) =>
    console.error(
      JSON.stringify({
        eventType: "document_job_recovery_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}

async function recoverStaleJobs(scope: {
  accountId: string;
  documentId?: string;
}): Promise<void> {
  if (
    scope.documentId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      scope.documentId,
    )
  )
    return;
  const key = `${scope.accountId}\u0000${scope.documentId ?? ""}`;
  const now = Date.now();
  if ((recoveryChecks.get(key) ?? 0) > now) return;
  if (recoveryChecks.size >= 10_000) recoveryChecks.clear();
  recoveryChecks.set(key, now + RECOVERY_CHECK_MS);
  await ensureSchema();
  const policy = documentJobRecoveryPolicy();
  const documentId = scope.documentId ?? null;
  const jobs = await db()`
    select j.*, now() as db_now from spellbook_jobs j
    join spellbook_documents d on d.id = j.document_id
    where d.account_id = ${scope.accountId}
      and (${documentId}::uuid is null or j.document_id = ${documentId}::uuid)
      and j.status = 'queued' and j.job_type = 'scan_render'
      and (
        j.created_at < now() - ${policy.maxAgeSeconds} * interval '1 second'
        or (j.dispatched_at is null and j.updated_at < now() - ${policy.retrySeconds} * interval '1 second')
        or j.dispatched_at < now() - ${policy.attemptSeconds} * interval '1 second'
      )
    order by j.created_at limit 5`;
  for (const job of jobs) {
    const action = documentJobRecovery(
      {
        createdAt: new Date(job.created_at),
        updatedAt: new Date(job.updated_at),
        dispatchedAt: job.dispatched_at ? new Date(job.dispatched_at) : null,
        deliveryCount: Number(job.delivery_count ?? 0),
      },
      new Date(job.db_now),
      policy,
    );
    if (action === "fail") await failStaleJob(job);
    else if (action === "redeliver") await redeliverDocumentJob(job);
  }
}

async function redeliverDocumentJob(job: Record<string, any>): Promise<void> {
  // The delivery count is the claim: two pollers cannot both send it again.
  const [claimed] = await db()`
    update spellbook_jobs set dispatched_at = now(), delivery_count = delivery_count + 1,
      error = null, updated_at = now()
    where id = ${job.id} and status = 'queued' and delivery_count = ${Number(job.delivery_count ?? 0)}
    returning delivery_count`;
  if (!claimed) return;
  const route = documentJobRoute(job);
  console.warn(
    JSON.stringify({
      eventType: "document_job_redelivered",
      jobId: job.id,
      jobType: job.job_type,
      delivery: claimed.delivery_count,
    }),
  );
  try {
    await enqueueWorkerJob(job.id, "document", route.path, job.payload, {
      attempt: Number(claimed.delivery_count),
      lane: route.lane,
    });
  } catch (error) {
    await db()`update spellbook_jobs set dispatched_at = null,
      error = ${error instanceof Error ? error.message : "dispatch_failed"}, updated_at = now()
      where id = ${job.id} and status = 'queued' and delivery_count = ${claimed.delivery_count}`;
  }
}

async function failStaleJob(job: Record<string, any>): Promise<void> {
  console.error(
    JSON.stringify({
      eventType: "document_job_stale_failed",
      jobId: job.id,
      jobType: job.job_type,
      documentId: job.document_id,
      deliveries: Number(job.delivery_count ?? 0),
    }),
  );
  if (job.job_type === "scan_render" && job.payload?.nativeSessionId) {
    await failNativeScan(job, STALE_JOB_FAILURE_CODE);
    return;
  }
  await markJobFailure(
    job,
    "처리 시간이 너무 오래 걸려 작업을 멈췄어요.",
    STALE_JOB_FAILURE_CODE,
  );
}

/**
 * Checks an imported file again after its first check failed for a reason
 * that may pass on retry. The stored original is reused; nothing is
 * uploaded again.
 */
export async function retryDocumentProcessing(
  session: Session,
  documentId: string,
): Promise<{ id: string }> {
  await ensureSchema();
  const jobId = randomUUID();
  const dispatch = await db().begin(async (transaction) => {
    const [document] = await transaction`
      select d.id, d.status, d.failure_code, d.format_id, d.original_version_id, d.current_version_id,
        v.document_object, v.status as version_status
      from spellbook_documents d
      join spellbook_versions v on v.id = d.original_version_id and v.document_id = d.id
      where d.id = ${documentId} and d.account_id = ${session.accountId}
      for update of d
    `;
    if (!document) throw new HttpError(404, "document_not_found");
    if (
      document.status !== "failed" ||
      document.current_version_id !== document.original_version_id ||
      document.version_status !== "failed"
    )
      throw new HttpError(409, "document_not_retryable");
    if (!retryableFailure(document.failure_code))
      throw new HttpError(409, "document_not_retryable");
    const { outputPrefix } = uploadObjects(
      session,
      documentId,
      document.original_version_id,
      documentFormatOf(document.format_id),
    );
    // A fresh output folder: the failed attempt's stored result belongs to
    // the old job and must not answer for this one.
    const payload = {
      jobId,
      callbackUrl: callbackUrl(),
      storageNamespace: storageNamespace(),
      formatId: document.format_id,
      inputObject: document.document_object,
      outputPrefix: `${outputPrefix}-${jobId}`,
    };
    await transaction`update spellbook_versions set status = 'processing' where id = ${document.original_version_id}`;
    await transaction`update spellbook_documents set status = 'processing', last_error = null, failure_code = null, updated_at = now() where id = ${documentId}`;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, status, payload)
      values (${jobId}, 'scan_render', ${documentId}, ${document.original_version_id}, 'queued', ${transaction.json(jsonValue(payload))})
    `;
    await addEvent(transaction, documentId, "document_retry_requested", {
      versionId: document.original_version_id,
    });
    return {
      jobId,
      target: "document",
      path: "/internal/jobs/scan-render",
      lane: "upload",
      payload,
    } satisfies Dispatch;
  });
  await dispatchOrFail(dispatch).catch(() => undefined);
  return { id: documentId };
}

function callbackUrl(): string {
  return `${internalAppBaseUrl()}/api/internal/jobs/callback`;
}

async function addEvent(
  transaction: any,
  documentId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await transaction`insert into spellbook_events (document_id, event_type, payload) values (${documentId}, ${type}, ${transaction.json(jsonValue(payload))})`;
}

function jsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}
