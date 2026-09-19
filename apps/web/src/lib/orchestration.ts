import { createHash, randomUUID } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";

import editSchema from "../../../../contracts/edit-command.schema.json";
import { editContractErrors } from "./edit-contract-errors";
import {
  accountPrefix,
  storageNamespace,
  getJsonObject,
  getObject,
  putObject,
} from "./storage";
import { db, ensureSchema } from "./db";
import type {
  EditCommandBatch,
  ElementGraph,
  Session,
  WorkerCallback,
} from "./models";
import { HttpError } from "./http";
import {
  permissionForGraph,
  validatePermission,
  type AiPermission,
} from "./ai-permissions";
import {
  EditValidationError,
  selectedPreviews,
  validateCommandTargets,
} from "./edit-scope";
import { callAiAccount, enqueueWorkerJob, type WorkerTarget } from "./workers";
import {
  parseModelSettings,
  supportsSettings,
  type AvailableModel,
  type ModelSettings,
} from "./ai-models";
import {
  completeNativeScan,
  completeNativeTurn,
  failNativeScan,
  failNativeTurn,
  NativeScanValidationError,
} from "./native-runtime";
import {
  availableDocumentFormatForFile,
  currentPresentationFormat,
} from "./document-formats";
import { internalAppBaseUrl } from "./runtime-urls";
import { jobRedeliverySeconds } from "./job-delivery";

const Ajv2020Constructor = Ajv2020 as unknown as typeof import("ajv").default;
const validateEditBatch = new Ajv2020Constructor({
  allErrors: true,
  strict: true,
}).compile(editSchema);
interface Dispatch {
  jobId: string;
  target: WorkerTarget;
  path: string;
  payload: Record<string, unknown>;
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

export async function uploadDocument(
  session: Session,
  file: File,
): Promise<{ id: string }> {
  await ensureSchema();
  // Reason codes; the product UI turns each into a sentence and a fix.
  const format = availableDocumentFormatForFile(file.name);
  if (!format) throw new HttpError(400, "unsupported_format");
  if (file.size <= 0) throw new HttpError(400, "empty_file");
  if (file.size > format.maxBytes) throw new HttpError(400, "file_too_large");
  const data = Buffer.from(await file.arrayBuffer());
  if (data[0] !== 0x50 || data[1] !== 0x4b)
    throw new HttpError(
      400,
      // OLE compound files: password-protected OOXML or a renamed legacy .ppt.
      data.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
        ? "encrypted_or_legacy_file"
        : "invalid_package",
    );

  const documentId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  const prefix = accountPrefix(session.accountId, documentId);
  const documentObject = `${prefix}/versions/${versionId}/document.pptx`;
  const outputPrefix = `${prefix}/versions/${versionId}/render`;
  await putObject(documentObject, data, format.mimeTypes[0]!);
  const dispatch: Dispatch = {
    jobId,
    target: "document",
    path: "/internal/jobs/scan-render",
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
      values (${documentId}, ${session.accountId}, ${file.name}, ${format.id}, 'processing', ${versionId}, ${versionId})
    `;
    await transaction`
      insert into spellbook_versions (id, document_id, kind, status, document_object, document_bytes)
      values (${versionId}, ${documentId}, 'original', 'processing', ${documentObject}, ${data.length})
    `;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, status, payload)
      values (${jobId}, 'scan_render', ${documentId}, ${versionId}, 'queued', ${transaction.json(jsonValue(dispatch.payload))})
    `;
    await addEvent(transaction, documentId, "document_uploaded", {
      fileName: file.name,
      formatId: format.id,
      versionId,
    });
  });
  await dispatchOrFail(dispatch, documentId).catch(() => undefined);
  return { id: documentId };
}

export async function documentDetail(
  session: Session,
  documentId: string,
  knownRevision?: string,
) {
  await ensureSchema();
  const documents = await db()`
    select d.*, v.graph_object, v.document_object, v.document_sha256, v.slide_count
    from spellbook_documents d
    join spellbook_versions v on v.id = d.current_version_id
    where d.id = ${documentId} and d.account_id = ${session.accountId}
    limit 1
  `;
  const document = documents[0];
  if (!document) throw new HttpError(404, "document_not_found");
  if (["processing", "editing"].includes(document.status))
    await dispatchPendingJobs(documentId).catch(() => undefined);
  const edits = await db()`
    select e.*, coalesce(v.graph_object, (select rendered.graph_object from spellbook_jobs pj join spellbook_versions rendered on rendered.id = pj.version_id where pj.edit_request_id = e.id and pj.job_type = 'patch_render' and rendered.status = 'ready' order by rendered.created_at desc limit 1)) as candidate_graph_object, v.validation_object as candidate_validation_object,
      input.graph_object as input_graph_object,
      (select pj.payload->>'execution' from spellbook_jobs pj where pj.edit_request_id=e.id order by pj.created_at limit 1) as execution,
      (select pj.payload->'modelSettings' from spellbook_jobs pj where pj.edit_request_id=e.id and pj.job_type='ai_plan' order by pj.created_at limit 1) as model_settings
    from spellbook_edit_requests e
    left join spellbook_versions v on v.id = e.candidate_version_id
    left join spellbook_versions input on input.id = e.input_version_id
    where e.document_id = ${documentId}
    order by e.created_at desc
  `;
  const versions = await db()`
    select id, parent_version_id, kind, status, created_at
    from spellbook_versions
    where document_id = ${documentId} and kind in ('original','approved') and status = 'ready'
    order by created_at desc
  `;
  const revision = `"${createHash("sha256")
    .update(
      JSON.stringify([
        document.id,
        document.current_version_id,
        document.updated_at,
        document.status,
        document.graph_object,
        edits.map((edit) => [
          edit.id,
          edit.updated_at,
          edit.status,
          edit.candidate_graph_object,
        ]),
        versions.map((version) => [version.id, version.kind, version.status]),
      ]),
    )
    .digest("hex")}"`;
  if (knownRevision === revision)
    return { notModified: true as const, revision };
  const graph = document.graph_object
    ? await getJsonObject<ElementGraph>(document.graph_object)
    : null;
  const latestEdit =
    document.status === "candidate_ready"
      ? (edits.find((edit) => edit.status === "candidate_ready") ?? edits[0])
      : edits[0];
  const candidateGraph =
    latestEdit?.candidate_graph_object &&
    ["candidate_ready", "reviewing", "patching"].includes(latestEdit.status)
      ? await getJsonObject<ElementGraph>(latestEdit.candidate_graph_object)
      : document.status === "editing" &&
          latestEdit?.parent_edit_request_id &&
          latestEdit?.input_graph_object
        ? await getJsonObject<ElementGraph>(latestEdit.input_graph_object)
        : null;
  return {
    revision,
    id: document.id,
    fileName: document.file_name,
    status: document.status,
    lastError: document.last_error,
    currentVersionId: document.current_version_id,
    aiPermission: permissionForGraph(
      document.ai_permission,
      candidateGraph ?? graph,
    ),
    documentSha256: document.document_sha256,
    slideCount: document.slide_count,
    graph,
    candidateGraph,
    latestEdit: latestEdit ? mapEdit(latestEdit) : null,
    history: edits.map(mapEdit),
    versions: versions.map((version) => ({
      id: version.id,
      parentVersionId: version.parent_version_id,
      kind: version.kind,
      status: version.status,
      createdAt: version.created_at,
    })),
  };
}

/** Explicit owner edits use the native patch pipeline, never an AI turn.
 * A ready approved version is required: direct edits must not implicitly approve an AI candidate. */
export async function createManualEdit(
  session: Session,
  documentId: string,
  input: {
    requestId: string;
    baseVersionId: string;
    command: unknown;
  },
): Promise<{ editRequestId: string }> {
  await ensureSchema();
  if (
    !/^[0-9a-f-]{36}$/i.test(input.requestId ?? "") ||
    !/^[0-9a-f-]{36}$/i.test(input.baseVersionId ?? "")
  )
    throw new HttpError(400, "invalid_manual_request");
  if (!validateEditBatch(input.command))
    throw new HttpError(
      400,
      `invalid_edit_command: ${editContractErrors(input.command, validateEditBatch.errors)}`,
    );
  const command = input.command as unknown as EditCommandBatch;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.baseVersionId, command]))
    .digest("hex");
  const [source] =
    await db()`select d.current_version_id, d.status, v.document_object, v.graph_object, v.document_sha256
    from spellbook_documents d join spellbook_versions v on v.id=d.current_version_id
    where d.id=${documentId} and d.account_id=${session.accountId}`;
  if (!source) throw new HttpError(404, "document_not_found");
  const findPrior = async (sql: any) => {
    const [prior] =
      await sql`select j.edit_request_id, j.payload->>'fingerprint' as fingerprint from spellbook_jobs j
      where j.document_id=${documentId} and j.payload->>'manualRequestId'=${input.requestId}`;
    if (prior && prior.fingerprint !== fingerprint)
      throw new HttpError(409, "manual_request_id_reused");
    return prior;
  };
  const prior = await findPrior(db());
  if (prior) return { editRequestId: prior.edit_request_id };
  if (
    source.status !== "ready" ||
    source.current_version_id !== input.baseVersionId ||
    source.document_sha256 !== command.baseDocumentSha256
  )
    throw new HttpError(
      409,
      "문서가 변경되었거나 처리 중입니다. 현재 작업을 완료하고 다시 불러오세요.",
    );
  const graph = await getJsonObject<ElementGraph>(source.graph_object);
  try {
    validateCommandTargets(
      command,
      graph,
      [],
      graph.slides.map((s) => s.slideIndex),
      true,
    );
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "invalid_edit_target",
    );
  }
  const assetObjects = await commandAssetObjects(documentId, command);
  const editRequestId = randomUUID(),
    versionId = randomUUID(),
    jobId = randomUUID();
  const prefix = accountPrefix(session.accountId, documentId);
  const payload = {
    jobId,
    callbackUrl: callbackUrl(),
    storageNamespace: storageNamespace(),
    formatId: currentPresentationFormat.id,
    execution: "manual",
    manualRequestId: input.requestId,
    fingerprint,
    inputObject: source.document_object,
    outputDocumentObject: `${prefix}/versions/${versionId}/document.pptx`,
    outputPrefix: `${prefix}/versions/${versionId}/render`,
    command,
    assetObjects,
  };
  const result = await db().begin(async (transaction) => {
    const locked = await lockDocument(
      transaction,
      documentId,
      session.accountId,
    );
    const duplicate = await findPrior(transaction);
    if (duplicate)
      return { editRequestId: duplicate.edit_request_id, created: false };
    if (
      locked.status !== "ready" ||
      locked.current_version_id !== input.baseVersionId
    )
      throw new HttpError(409, "document_changed");
    await transaction`insert into spellbook_versions (id, document_id, parent_version_id, kind, status, document_object)
      values (${versionId}, ${documentId}, ${input.baseVersionId}, 'candidate', 'processing', ${payload.outputDocumentObject})`;
    await transaction`insert into spellbook_edit_requests (id, document_id, account_id, base_version_id, input_version_id, candidate_version_id, request_text, status)
      values (${editRequestId}, ${documentId}, ${session.accountId}, ${input.baseVersionId}, ${input.baseVersionId}, ${versionId}, ${`직접 편집 · ${command.summary}`}, 'patching')`;
    await transaction`insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload)
      values (${jobId}, 'patch_render', ${documentId}, ${versionId}, ${editRequestId}, 'queued', ${transaction.json(jsonValue(payload))})`;
    await transaction`insert into spellbook_messages (document_id, edit_request_id, source_key, role, content, status)
      values (${documentId}, ${editRequestId}, 'manual', 'tool', ${`직접 편집 · ${command.summary} · 저장 중`}, 'streaming')`;
    await transaction`update spellbook_documents set status='editing', last_error=null, updated_at=now() where id=${documentId}`;
    await addEvent(transaction, documentId, "manual_edit_requested", {
      editRequestId,
      versionId,
    });
    return { editRequestId, created: true };
  });
  if (result.created)
    await dispatchOrFail(
      {
        jobId,
        target: "document",
        path: "/internal/jobs/patch-render",
        payload,
      },
      documentId,
      editRequestId,
    ).catch(() => undefined);
  return { editRequestId: result.editRequestId };
}

async function commandAssetObjects(
  documentId: string,
  command: EditCommandBatch,
) {
  const ids = [
    ...new Set(
      command.commands
        .filter(
          (item) => item.op === "add_image" || item.op === "replace_image",
        )
        .map((item) => String(item.assetId)),
    ),
  ];
  const assets = ids.length
    ? await db()`select id, object_name from spellbook_assets where document_id=${documentId} and id::text in ${db()(ids)}`
    : [];
  if (assets.length !== ids.length)
    throw new HttpError(400, "image_asset_not_in_document");
  return Object.fromEntries(
    assets.map((asset) => [asset.id, asset.object_name]),
  );
}

export async function createEdit(
  session: Session,
  documentId: string,
  input: {
    requestText: string;
    selectedElementIds: string[];
    selectedSlideIndexes: number[];
    baseCandidateEditId?: string;
    modelSettings?: ModelSettings;
  },
): Promise<{ editRequestId: string }> {
  await ensureSchema();
  const requestText = input.requestText.trim();
  if (!requestText || requestText.length > 2_000)
    throw new HttpError(
      400,
      "A request between 1 and 2,000 characters is required.",
    );
  if (
    input.selectedElementIds.length > 50 ||
    input.selectedSlideIndexes.length > 10
  )
    throw new HttpError(
      400,
      "Select at most 50 elements or 10 slides per request.",
    );
  if (
    input.selectedElementIds.length === 0 &&
    input.selectedSlideIndexes.length === 0
  ) {
    throw new HttpError(400, "Select at least one element or slide.");
  }
  const rows = await db()`
    select d.current_version_id, d.status, v.graph_object, v.document_sha256
    from spellbook_documents d
    join spellbook_versions v on v.id = d.current_version_id
    where d.id = ${documentId} and d.account_id = ${session.accountId}
    limit 1
  `;
  const current = rows[0];
  if (!current) throw new HttpError(404, "document_not_found");
  if (current.status !== "ready" && current.status !== "candidate_ready")
    throw new HttpError(409, "document_not_ready");
  let inputVersionId = current.current_version_id;
  if (input.baseCandidateEditId) {
    const candidates = await db()`
      select v.id, v.graph_object, v.document_sha256 from spellbook_edit_requests e
      join spellbook_versions v on v.id = e.candidate_version_id
      where e.id = ${input.baseCandidateEditId} and e.document_id = ${documentId}
        and e.account_id = ${session.accountId} and e.status = 'candidate_ready'
        and e.base_version_id = ${current.current_version_id} and v.status = 'ready'
    `;
    if (current.status !== "candidate_ready" || !candidates[0])
      throw new HttpError(409, "candidate_not_ready");
    inputVersionId = candidates[0].id;
    current.graph_object = candidates[0].graph_object;
    current.document_sha256 = candidates[0].document_sha256;
  }
  if (!current.graph_object || !current.document_sha256)
    throw new HttpError(409, "document_graph_not_ready");
  const graph = await getJsonObject<ElementGraph>(current.graph_object);
  validateSelection(
    graph,
    input.selectedElementIds,
    input.selectedSlideIndexes,
  );
  const previews = selectedPreviews(
    graph,
    input.selectedSlideIndexes,
    input.selectedElementIds,
  );
  const modelSettings = parseModelSettings(input.modelSettings);
  if (modelSettings) {
    const catalog = (await callAiAccount(
      "/internal/models",
      session.email,
    )) as { models: AvailableModel[] };
    if (!supportsSettings(catalog.models, modelSettings))
      throw new HttpError(
        400,
        "선택한 모델 설정을 사용할 수 없습니다. 모델 목록을 새로고침하세요.",
      );
  }
  const editRequestId = randomUUID();
  const jobId = randomUUID();
  const previousTurns = await db()`
    select request_text, assistant_message, result_summary, status,
      coalesce(input_version_id, base_version_id) as input_version_id
    from spellbook_edit_requests where document_id = ${documentId} and account_id = ${session.accountId}
    order by created_at desc limit 20
  `;
  const previousMessages =
    await db()`select role, content, status from spellbook_messages where document_id = ${documentId} and status not in ('queued','delivering','not_delivered','delivery_unknown') order by id desc limit 60`;
  const payload = {
    jobId,
    callbackUrl: callbackUrl(),
    mode: "plan",
    execution: "agent",
    ...(modelSettings ? { modelSettings } : {}),
    conversational: true,
    conversationHistory: previousMessages.length
      ? previousMessages.reverse().map((message) => ({
          request: message.role === "user" ? message.content : "",
          response: message.role !== "user" ? message.content : null,
          status: message.status,
        }))
      : previousTurns.reverse().map((turn) => ({
          request: turn.request_text,
          response: turn.result_summary ?? turn.assistant_message ?? null,
          status: turn.status,
          inputVersionId: turn.input_version_id,
        })),
    email: session.email,
    storageNamespace: storageNamespace(),
    requestText,
    selectedElementIds: input.selectedElementIds,
    selectedSlideIndexes: input.selectedSlideIndexes,
    baseGraphObject: current.graph_object,
    basePreviewObjects: previews,
  };
  const dispatch: Dispatch = {
    jobId,
    target: "ai",
    path: "/internal/jobs/edit",
    payload,
  };
  await db().begin(async (transaction) => {
    const locked = await lockDocument(
      transaction,
      documentId,
      session.accountId,
    );
    if (
      locked.current_version_id !== current.current_version_id ||
      !["ready", "candidate_ready"].includes(locked.status)
    )
      throw new HttpError(409, "document_changed");
    if (input.baseCandidateEditId) {
      const candidates =
        await transaction`select id from spellbook_edit_requests
        where id = ${input.baseCandidateEditId} and document_id = ${documentId}
          and status = 'candidate_ready' and candidate_version_id = ${inputVersionId}`;
      if (!candidates[0]) throw new HttpError(409, "candidate_changed");
    }
    await abandonReadyCandidates(transaction, documentId);
    await transaction`
      insert into spellbook_edit_requests (
        id, document_id, account_id, base_version_id, input_version_id, parent_edit_request_id, request_text, selected_element_ids, selected_slide_indexes, status
      ) values (
        ${editRequestId}, ${documentId}, ${session.accountId}, ${current.current_version_id}, ${inputVersionId}, ${input.baseCandidateEditId ?? null}, ${requestText},
        ${transaction.json(input.selectedElementIds)}, ${transaction.json(input.selectedSlideIndexes)}, 'planning'
      )
    `;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload)
      values (${jobId}, 'ai_plan', ${documentId}, ${inputVersionId}, ${editRequestId}, 'queued', ${transaction.json(jsonValue(payload))})
    `;
    await transaction`insert into spellbook_messages (document_id, edit_request_id, source_key, role, content, status) values (${documentId}, ${editRequestId}, 'request', 'user', ${requestText}, 'completed')`;
    await transaction`update spellbook_documents set status = 'editing', last_error = null, updated_at = now() where id = ${documentId}`;
    await addEvent(transaction, documentId, "edit_requested", {
      editRequestId,
      requestText,
    });
  });
  await dispatchOrFail(dispatch, documentId, editRequestId).catch(
    () => undefined,
  );
  return { editRequestId };
}

export async function handleWorkerCallback(
  callback: WorkerCallback,
): Promise<void> {
  await ensureSchema();
  const jobs =
    await db()`select * from spellbook_jobs where id = ${callback.jobId} limit 1`;
  const job = jobs[0];
  if (!job || job.status === "failed") return;
  if (job.status === "succeeded") {
    // A prior callback may have committed its successor before the process died.
    await dispatchPendingJobs(job.document_id);
    return;
  }
  if (callback.status === "failed") {
    if (job.job_type === "native_turn") {
      await failNativeTurn(job.id, callback.error ?? "native_worker_failed");
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
  let dispatch: Dispatch | null = null;
  try {
    if (job.job_type === "scan_render")
      dispatch = job.payload?.nativeSessionId
        ? (await completeNativeScan(job, callback), null)
        : await completeScan(job, callback);
    else if (job.job_type === "native_turn") {
      await completeNativeTurn(job, callback);
      dispatch = null;
    } else if (job.job_type === "ai_plan")
      dispatch = await completePlan(job, callback);
    else if (job.job_type === "patch_render")
      dispatch = await completePatch(job, callback);
    else if (job.job_type === "ai_review")
      dispatch = await completeReview(job, callback);
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
    if (!(error instanceof EditValidationError)) throw error;
    await markJobFailure(job, error.message);
    return;
  }
  if (dispatch)
    await dispatchOrFail(
      dispatch,
      job.document_id,
      job.edit_request_id ?? undefined,
    );
}

export async function approveCandidate(
  session: Session,
  documentId: string,
  editRequestId: string,
): Promise<void> {
  await ensureSchema();
  await db().begin(async (transaction) => {
    const locked = await lockDocument(
      transaction,
      documentId,
      session.accountId,
    );
    const rows = await transaction`
      select e.candidate_version_id from spellbook_edit_requests e
      join spellbook_versions v on v.id = e.candidate_version_id
      where e.id = ${editRequestId} and e.document_id = ${documentId}
        and e.account_id = ${session.accountId} and e.status = 'candidate_ready'
        and e.base_version_id = ${locked.current_version_id}
        and v.document_id = ${documentId} and v.parent_version_id = e.base_version_id and v.status = 'ready'
      limit 1
    `;
    const edit = rows[0];
    if (locked.status !== "candidate_ready" || !edit?.candidate_version_id)
      throw new HttpError(409, "candidate_not_ready");
    await transaction`update spellbook_versions set kind = 'approved' where id = ${edit.candidate_version_id}`;
    await transaction`update spellbook_edit_requests set status = 'approved', updated_at = now() where id = ${editRequestId}`;
    await abandonReadyCandidates(transaction, documentId);
    await transaction`
      update spellbook_documents set current_version_id = ${edit.candidate_version_id}, status = 'ready', updated_at = now()
      where id = ${documentId}
    `;
    await addEvent(transaction, documentId, "candidate_approved", {
      editRequestId,
      versionId: edit.candidate_version_id,
    });
  });
}

export async function rejectCandidate(
  session: Session,
  documentId: string,
  editRequestId: string,
): Promise<void> {
  await ensureSchema();
  const result = await db().begin(async (transaction) => {
    const locked = await lockDocument(
      transaction,
      documentId,
      session.accountId,
    );
    if (locked.status !== "candidate_ready") return false;
    const rows = await transaction`
      update spellbook_edit_requests e set status = 'rejected', updated_at = now()
      from spellbook_documents d
      where e.id = ${editRequestId} and e.document_id = ${documentId} and e.account_id = ${session.accountId}
        and d.id = e.document_id and d.account_id = ${session.accountId} and e.status = 'candidate_ready'
        and e.base_version_id = ${locked.current_version_id}
      returning e.candidate_version_id
    `;
    if (!rows[0]) return false;
    if (rows[0].candidate_version_id) {
      await transaction`update spellbook_versions set kind = 'abandoned' where id = ${rows[0].candidate_version_id}`;
    }
    await transaction`update spellbook_documents set status = 'ready', updated_at = now() where id = ${documentId}`;
    await addEvent(transaction, documentId, "candidate_rejected", {
      editRequestId,
    });
    return true;
  });
  if (!result) throw new HttpError(409, "candidate_not_ready");
}

export async function undoDocument(
  session: Session,
  documentId: string,
): Promise<void> {
  await ensureSchema();
  await db().begin(async (transaction) => {
    const locked = await lockDocument(
      transaction,
      documentId,
      session.accountId,
    );
    if (!["ready", "candidate_ready"].includes(locked.status))
      throw new HttpError(409, "document_not_ready");
    const rows = await transaction`
      select parent_version_id from spellbook_versions
      where id = ${locked.current_version_id} and document_id = ${documentId} and status = 'ready'
    `;
    const current = rows[0];
    if (!current?.parent_version_id)
      throw new HttpError(409, "no_previous_version");
    await abandonReadyCandidates(transaction, documentId);
    await transaction`update spellbook_documents set current_version_id = ${current.parent_version_id}, status = 'ready', updated_at = now() where id = ${documentId}`;
    await addEvent(transaction, documentId, "version_undone", {
      from: locked.current_version_id,
      to: current.parent_version_id,
    });
  });
}

async function lockDocument(
  transaction: any,
  documentId: string,
  accountId: string,
) {
  const rows = await transaction`
    select current_version_id, status, ai_permission from spellbook_documents
    where id = ${documentId} and account_id = ${accountId} for update
  `;
  if (!rows[0]) throw new HttpError(404, "document_not_found");
  return rows[0];
}

async function abandonReadyCandidates(transaction: any, documentId: string) {
  await transaction`
    update spellbook_versions set kind = 'abandoned'
    where id in (select candidate_version_id from spellbook_edit_requests
      where document_id = ${documentId} and status = 'candidate_ready')
  `;
  await transaction`
    update spellbook_edit_requests set status = 'rejected', updated_at = now()
    where document_id = ${documentId} and status = 'candidate_ready'
  `;
}

export async function downloadCurrent(
  session: Session,
  documentId: string,
  source: "current" | "original" | "candidate" = "current",
): Promise<{ name: string; data: Buffer }> {
  await ensureSchema();
  if (source === "original") {
    const rows =
      await db()`select d.file_name, v.document_object from spellbook_documents d
      join spellbook_versions v on v.id = d.original_version_id and v.document_id = d.id
      where d.id = ${documentId} and d.account_id = ${session.accountId} limit 1`;
    if (!rows[0]) throw new HttpError(404, "document_not_found");
    return {
      name: `원본-${rows[0].file_name}`,
      data: await getObject(rows[0].document_object),
    };
  }
  if (source === "candidate") {
    const rows =
      await db()`select d.file_name, v.document_object from spellbook_documents d
      join spellbook_edit_requests e on e.document_id = d.id and e.base_version_id = d.current_version_id
      join spellbook_versions v on v.id = e.candidate_version_id and v.document_id = d.id
      where d.id = ${documentId} and d.account_id = ${session.accountId}
        and e.status = 'candidate_ready' and v.status = 'ready'
      order by e.created_at desc limit 1`;
    if (!rows[0]) throw new HttpError(409, "candidate_not_ready");
    return {
      name: `미승인후보-${rows[0].file_name}`,
      data: await getObject(rows[0].document_object),
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
  return { name: row.file_name, data: await getObject(row.document_object) };
}

async function completeScan(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<null> {
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
  return null;
}

async function completePlan(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<Dispatch | null> {
  if (job.payload?.execution === "agent")
    return completeAgentTurn(job, callback);
  const result = callback.result as Record<string, unknown> | undefined;
  const conversational = !!result && Object.hasOwn(result, "edit");
  const message = conversational ? result!.message : null;
  if (
    conversational &&
    (typeof message !== "string" || !message.trim() || message.length > 4000)
  )
    throw new EditValidationError("Invalid assistant response.");
  const command = (
    conversational ? result!.edit : result
  ) as EditCommandBatch | null;
  const rows = await db()`
    select e.*, v.document_object, v.graph_object, v.document_sha256
    from spellbook_edit_requests e join spellbook_versions v on v.id = coalesce(e.input_version_id, e.base_version_id)
    where e.id = ${job.edit_request_id} limit 1
  `;
  const edit = rows[0];
  if (!edit) throw new EditValidationError("Conversation turn not found.");
  if (conversational && command === null) {
    await db().begin(async (transaction) => {
      if (!(await claimJob(transaction, job.id, callback))) return;
      await transaction`update spellbook_edit_requests set status = 'answered', assistant_message = ${message as string}, updated_at = now() where id = ${edit.id}`;
      await transaction`update spellbook_documents set status = 'ready', updated_at = now() where id = ${edit.document_id}`;
      await restoreRefinementInput(transaction, edit.id, edit.document_id);
      await addEvent(transaction, edit.document_id, "conversation_answered", {
        editRequestId: edit.id,
      });
    });
    return null;
  }
  if (!validateEditBatch(command))
    throw new EditValidationError(
      `Invalid AI edit batch: ${JSON.stringify(validateEditBatch.errors)}`,
    );
  if (
    !edit?.graph_object ||
    command!.baseDocumentSha256 !== edit.document_sha256
  )
    throw new EditValidationError(
      "AI command targets the wrong document version.",
    );
  const graph = await getJsonObject<ElementGraph>(edit.graph_object);
  validateCommandTargets(
    command!,
    graph,
    asStringArray(edit.selected_element_ids),
    asNumberArray(edit.selected_slide_indexes),
  );
  const candidateVersionId = randomUUID();
  const patchJobId = randomUUID();
  const prefix = accountPrefix(edit.account_id, edit.document_id);
  const documentObject = `${prefix}/versions/${candidateVersionId}/document.pptx`;
  const outputPrefix = `${prefix}/versions/${candidateVersionId}/render`;
  const payload = {
    jobId: patchJobId,
    callbackUrl: callbackUrl(),
    storageNamespace: storageNamespace(),
    formatId: currentPresentationFormat.id,
    inputObject: edit.document_object,
    outputDocumentObject: documentObject,
    outputPrefix,
    command,
  };
  let claimed = false;
  await db().begin(async (transaction) => {
    claimed = await claimJob(transaction, job.id, callback);
    if (!claimed) return;
    if (typeof message === "string")
      await transaction`update spellbook_edit_requests set assistant_message = ${message} where id = ${edit.id}`;
    await transaction`
      insert into spellbook_versions (id, document_id, parent_version_id, kind, status, document_object)
      values (${candidateVersionId}, ${edit.document_id}, ${edit.base_version_id}, 'candidate', 'processing', ${documentObject})
    `;
    await transaction`
      update spellbook_edit_requests set candidate_version_id = ${candidateVersionId}, status = 'patching', ai_attempts = 1, updated_at = now()
      where id = ${edit.id}
    `;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload)
      values (${patchJobId}, 'patch_render', ${edit.document_id}, ${candidateVersionId}, ${edit.id}, 'queued', ${transaction.json(jsonValue(payload))})
    `;
    await addEvent(transaction, edit.document_id, "ai_plan_ready", {
      editRequestId: edit.id,
      summary: command!.summary,
    });
  });
  return claimed
    ? {
        jobId: patchJobId,
        target: "document",
        path: "/internal/jobs/patch-render",
        payload,
      }
    : null;
}

async function agentContext(jobId: string) {
  const [row] = await db()`
    select e.*, j.status as job_status, j.payload as agent_payload, j.execution_token,
      d.current_version_id, d.status as document_status, d.ai_permission,
      v.id as working_version_id, v.status as working_status, v.graph_object, v.validation_object, v.document_object
    from spellbook_jobs j join spellbook_edit_requests e on e.id = j.edit_request_id
    join spellbook_documents d on d.id = e.document_id and d.account_id = e.account_id
    join spellbook_versions v on v.id = coalesce(e.candidate_version_id, e.input_version_id, e.base_version_id) and v.document_id = e.document_id
    where j.id = ${jobId} and j.job_type = 'ai_plan'
  `;
  if (
    !row ||
    row.agent_payload?.execution !== "agent" ||
    !["queued", "running"].includes(row.job_status) ||
    !["planning", "patching", "reviewing"].includes(row.status) ||
    row.document_status !== "editing" ||
    row.current_version_id !== row.base_version_id
  )
    throw new HttpError(409, "agent_turn_inactive");
  return row;
}

// Internal worker boundary: the model never supplies account/document IDs or object paths.
export async function executeAgentTool(input: {
  jobId: string;
  executionToken?: string;
  operation: string;
  callId?: string;
  command?: unknown;
  message?: string;
  itemId?: string;
  role?: string;
  status?: string;
  revision?: number;
  messageId?: string;
  permission?: unknown;
}) {
  await ensureSchema();
  const edit = await agentContext(input.jobId);
  if (!input.executionToken || input.executionToken.length > 100)
    throw new HttpError(400, "invalid_execution_token");
  if (input.operation === "start") {
    const rows =
      await db()`update spellbook_jobs set execution_token = ${input.executionToken}, heartbeat_at = now()
      where id = ${input.jobId} and status in ('queued','running') and (execution_token is null or execution_token = ${input.executionToken} or heartbeat_at < now() - interval '60 seconds') returning id`;
    if (!rows[0]) throw new HttpError(409, "agent_already_running");
    return { status: "accepted" };
  }
  const lease =
    await db()`update spellbook_jobs set heartbeat_at = now() where id = ${input.jobId} and execution_token = ${input.executionToken} and status in ('queued','running') returning id`;
  if (!lease[0]) throw new HttpError(409, "agent_lease_lost");
  if (input.operation === "request_permission") {
    if (
      !edit.graph_object ||
      !input.callId ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 1000
    )
      throw new HttpError(400, "invalid_permission_request");
    const graph = await getJsonObject<ElementGraph>(edit.graph_object);
    const permission = validatePermission(
      input.permission,
      graph.slides.length,
    );
    const [request] =
      await db()`insert into spellbook_messages (document_id, edit_request_id, source_key, role, content, status, metadata) select ${edit.document_id}, ${edit.id}, ${`permission-request:${input.callId}`}, 'tool', ${input.message}, 'permission_pending', ${db().json({ permission: { ...permission } })} from spellbook_jobs where id = ${input.jobId} and execution_token = ${input.executionToken} and status in ('queued','running') on conflict (edit_request_id, source_key) do update set source_key = excluded.source_key returning id::text`;
    if (!request) throw new HttpError(409, "agent_turn_inactive");
    return { messageId: request.id };
  }
  if (input.operation === "permission_status") {
    const [request] =
      await db()`select status from spellbook_messages where id::text = ${input.messageId ?? ""} and edit_request_id = ${edit.id} and source_key like 'permission-request:%'`;
    if (!request) throw new HttpError(404, "permission_request_not_found");
    return { status: request.status, permission: edit.ai_permission };
  }
  if (input.operation === "inbox") {
    const messages =
      await db()`update spellbook_messages set status = 'delivering', updated_at = now() where edit_request_id = ${edit.id} and role = 'user' and status = 'queued' and exists (select 1 from spellbook_jobs where id = ${input.jobId} and execution_token = ${input.executionToken} and status in ('queued','running')) returning id::text, content`;
    return {
      messages: messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)),
    };
  }
  if (input.operation === "ack") {
    if (
      !input.messageId ||
      !["accepted", "not_delivered", "delivery_unknown"].includes(
        input.status ?? "",
      )
    )
      throw new HttpError(400, "invalid_message_ack");
    await db()`update spellbook_messages set status = ${input.status!}, updated_at = now() where id::text = ${input.messageId} and edit_request_id = ${edit.id} and status = 'delivering'`;
    return { status: "accepted" };
  }
  if (input.operation === "event") {
    if (typeof input.message !== "string" || input.message.length > 4000)
      throw new HttpError(400, "invalid_agent_event");
    if (input.itemId) {
      if (
        input.itemId.length > 200 ||
        !["assistant", "tool"].includes(input.role ?? "") ||
        !["streaming", "completed", "failed"].includes(input.status ?? "") ||
        !Number.isSafeInteger(input.revision) ||
        input.revision! < 0
      )
        throw new HttpError(400, "invalid_agent_event");
      await db()`insert into spellbook_messages (document_id, edit_request_id, source_key, role, content, status, revision)
        select ${edit.document_id}, ${edit.id}, ${input.itemId}, ${input.role!}, ${input.message}, ${input.status!}, ${input.revision!}
        from spellbook_jobs where id = ${input.jobId} and execution_token = ${input.executionToken} and status in ('queued','running')
        on conflict (edit_request_id, source_key) do update set content = excluded.content, status = excluded.status, revision = excluded.revision, updated_at = now()
        where spellbook_messages.revision < excluded.revision`;
    } else {
      await db()`update spellbook_edit_requests set assistant_message = ${input.message}, updated_at = now() where id = ${edit.id} and status in ('planning','patching','reviewing')`;
    }
    return { status: "accepted" };
  }
  if (input.operation === "observe") {
    await dispatchPendingJobs(edit.document_id);
    const patches =
      await db()`select payload->'command' as command from spellbook_jobs where edit_request_id = ${edit.id} and job_type = 'patch_render'`;
    const structureChanged = patches.some((patch) =>
      (patch.command as EditCommandBatch).commands.some((command) =>
        ["add_slide", "duplicate_slide", "delete_slide", "move_slide"].includes(
          String(command.op),
        ),
      ),
    );
    const permissionGraph =
      edit.graph_object &&
      (structureChanged || (edit.ai_permission as AiPermission).slidePartUris)
        ? await getJsonObject<ElementGraph>(edit.graph_object)
        : null;
    const changedSlideIndexes =
      structureChanged && permissionGraph
        ? permissionGraph.slides.map((slide) => slide.slideIndex)
        : [
            ...new Set(
              patches.flatMap((patch) => commandSlideIndexes(patch.command)),
            ),
          ];
    return {
      status: edit.working_status,
      versionId: edit.working_version_id,
      candidateVersionId: edit.candidate_version_id,
      graphObject: edit.graph_object,
      validationObject: edit.validation_object,
      permission: permissionForGraph(edit.ai_permission, permissionGraph),
      changedSlideIndexes,
      structureChanged,
      assets:
        await db()`select id as "assetId", file_name as "fileName", width, height from spellbook_assets where document_id = ${edit.document_id} order by created_at`,
    };
  }
  if (input.operation !== "edit" || !input.callId || input.callId.length > 200)
    throw new HttpError(400, "invalid_agent_tool");
  // A replay after network loss must return the already committed tool operation.
  const [prior] =
    await db()`select id, version_id from spellbook_jobs where edit_request_id = ${edit.id} and payload->>'agentCallId' = ${input.callId}`;
  if (prior) return { status: "processing", versionId: prior.version_id };
  if (edit.working_status !== "ready" || !edit.graph_object)
    throw new HttpError(409, "candidate_rendering");
  if (!validateEditBatch(input.command)) {
    const details = editContractErrors(input.command, validateEditBatch.errors);
    console.warn("invalid_edit_command", details);
    throw new HttpError(400, `invalid_edit_command: ${details}`);
  }
  const command = input.command as unknown as EditCommandBatch;
  const graph = await getJsonObject<ElementGraph>(edit.graph_object);
  if (command.baseDocumentSha256 !== graph.documentSha256)
    throw new HttpError(409, "agent_version_changed");
  const versionId = randomUUID(),
    patchJobId = randomUUID();
  const prefix = accountPrefix(edit.account_id, edit.document_id);
  const assetObjects = await commandAssetObjects(edit.document_id, command);
  const payload = {
    jobId: patchJobId,
    callbackUrl: callbackUrl(),
    storageNamespace: storageNamespace(),
    formatId: currentPresentationFormat.id,
    inputObject: edit.document_object,
    outputDocumentObject: `${prefix}/versions/${versionId}/document.pptx`,
    outputPrefix: `${prefix}/versions/${versionId}/render`,
    command,
    agentJobId: input.jobId,
    agentCallId: input.callId,
    assetObjects,
  };
  await db().begin(async (transaction) => {
    const document = await lockDocument(
      transaction,
      edit.document_id,
      edit.account_id,
    );
    const [current] =
      await transaction`select e.*, j.status as job_status, j.execution_token from spellbook_edit_requests e join spellbook_jobs j on j.edit_request_id = e.id where e.id = ${edit.id} and j.id = ${input.jobId} for update of e, j`;
    if (
      document.status !== "editing" ||
      document.current_version_id !== edit.base_version_id ||
      !current ||
      !["planning", "reviewing"].includes(current.status) ||
      !["queued", "running"].includes(current.job_status) ||
      current.execution_token !== input.executionToken ||
      (current.candidate_version_id ??
        current.input_version_id ??
        current.base_version_id) !== edit.working_version_id
    )
      throw new HttpError(409, "agent_version_changed");
    const permission = document.ai_permission as AiPermission;
    if (permission.mode === "read_only")
      throw new HttpError(403, "ai_edit_permission_required");
    // Bind numbered grants to stable package identities, never to shifted positions.
    const [scopeVersion] =
      await transaction`select graph_object from spellbook_versions where id = ${permission.mode === "selection" ? (edit.input_version_id ?? edit.base_version_id) : edit.base_version_id}`;
    const scopeGraph = scopeVersion?.graph_object
      ? await getJsonObject<ElementGraph>(scopeVersion.graph_object)
      : graph;
    const grantedParts =
      permission.mode === "slides" && permission.slidePartUris
        ? permission.slidePartUris
        : scopeGraph.slides
            .filter((slide) =>
              (permission.mode === "slides"
                ? permission.slideIndexes
                : asNumberArray(edit.selected_slide_indexes)
              ).includes(slide.slideIndex),
            )
            .map((slide) => slide.partUri);
    validateCommandTargets(
      command,
      graph,
      permission.mode === "selection"
        ? asStringArray(edit.selected_element_ids)
        : [],
      permission.mode === "document"
        ? graph.slides.map((slide) => slide.slideIndex)
        : graph.slides
            .filter((slide) => grantedParts.includes(slide.partUri))
            .map((slide) => slide.slideIndex),
      permission.mode === "document",
    );
    if (current.candidate_version_id)
      await transaction`update spellbook_versions set kind = 'abandoned' where id = ${current.candidate_version_id}`;
    await transaction`insert into spellbook_versions (id, document_id, parent_version_id, kind, status, document_object) values (${versionId}, ${edit.document_id}, ${edit.base_version_id}, 'candidate', 'processing', ${payload.outputDocumentObject})`;
    await transaction`update spellbook_edit_requests set candidate_version_id = ${versionId}, status = 'patching', ai_attempts = ai_attempts + 1, updated_at = now() where id = ${edit.id}`;
    await transaction`insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload) values (${patchJobId}, 'patch_render', ${edit.document_id}, ${versionId}, ${edit.id}, 'queued', ${transaction.json(jsonValue(payload))})`;
    await addEvent(transaction, edit.document_id, "agent_edit_started", {
      editRequestId: edit.id,
      versionId,
    });
  });
  await dispatchOrFail(
    {
      jobId: patchJobId,
      target: "document",
      path: "/internal/jobs/patch-render",
      payload,
    },
    edit.document_id,
    edit.id,
  ).catch(() => undefined);
  return { status: "processing", versionId };
}

function commandSlideIndexes(command: EditCommandBatch): number[] {
  return command.commands.flatMap((command) =>
    command.targets
      ? (command.targets as Array<{ slideIndex: number }>).map(
          (target) => target.slideIndex,
        )
      : command.target
        ? [(command.target as { slideIndex: number }).slideIndex]
        : typeof command.slideIndex === "number"
          ? [command.slideIndex]
          : [],
  );
}

async function completeAgentTurn(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<null> {
  const edit = await agentContext(job.id);
  const result = callback.result as {
    executionToken?: string;
    message?: string;
    candidateVersionId?: string | null;
    approved?: boolean;
    problems?: string[];
  };
  if (edit.execution_token && result?.executionToken !== edit.execution_token)
    throw new HttpError(409, "agent_lease_lost");
  if (
    typeof result?.message !== "string" ||
    !result.message.trim() ||
    result.message.length > 4000 ||
    !Array.isArray(result.problems) ||
    !result.problems.every((problem) => typeof problem === "string") ||
    typeof result.approved !== "boolean" ||
    result.candidateVersionId !== edit.candidate_version_id
  )
    throw new EditValidationError(
      "Invalid agent completion or stale candidate.",
    );
  const hasCandidate = !!edit.candidate_version_id;
  if (
    hasCandidate &&
    (edit.working_status !== "ready" || !edit.validation_object)
  )
    throw new EditValidationError("Agent finished before rendering completed.");
  if (hasCandidate) {
    const validation = await getJsonObject<{ valid: boolean }>(
      edit.validation_object,
    );
    if (!validation.valid || (result.approved && result.problems.length))
      throw new EditValidationError(
        "Agent approval contradicts document validation.",
      );
  }
  await db().begin(async (transaction) => {
    await lockDocument(transaction, edit.document_id, edit.account_id);
    if (!(await claimJob(transaction, job.id, callback, result.executionToken)))
      return;
    const status = !hasCandidate
      ? "answered"
      : result.approved
        ? "candidate_ready"
        : "failed";
    await transaction`update spellbook_edit_requests set status = ${status}, assistant_message = ${result.message!}, result_summary = ${hasCandidate ? result.message! : null}, last_error = ${status === "failed" ? result.problems!.join(" ") || "Visual review rejected the candidate." : null}, updated_at = now() where id = ${edit.id}`;
    await transaction`update spellbook_documents set status = ${status === "candidate_ready" ? "candidate_ready" : "ready"}, updated_at = now() where id = ${edit.document_id}`;
    await transaction`update spellbook_messages set status = case when status = 'delivering' then 'delivery_unknown' else 'not_delivered' end, updated_at = now() where edit_request_id = ${edit.id} and role = 'user' and status in ('queued','delivering')`;
    await transaction`update spellbook_messages set status = 'completed', updated_at = now() where edit_request_id = ${edit.id} and status = 'streaming'`;
    await transaction`insert into spellbook_messages (document_id, edit_request_id, source_key, role, content, status)
      select ${edit.document_id}, ${edit.id}, 'final', 'assistant', ${result.message!}, 'completed'
      where not exists (select 1 from spellbook_messages where edit_request_id = ${edit.id} and role = 'assistant' and content = ${result.message!})
      on conflict (edit_request_id, source_key) do nothing`;
    if (status !== "candidate_ready")
      await restoreRefinementInput(transaction, edit.id, edit.document_id);
    await addEvent(transaction, edit.document_id, "agent_turn_completed", {
      editRequestId: edit.id,
      status,
    });
  });
  return null;
}

async function completePatch(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<Dispatch | null> {
  const outputs = callback.outputs;
  if (
    !outputs?.graphObject ||
    !outputs.validationObject ||
    !outputs.documentObject
  ) {
    throw new Error("Patch callback is missing required outputs.");
  }
  const graphObject = outputs.graphObject;
  const validationObject = outputs.validationObject;
  const documentObject = outputs.documentObject;
  if (job.payload?.execution === "manual") {
    const validation = await getJsonObject<{ valid: boolean }>(
      validationObject,
    );
    const graph = await getJsonObject<ElementGraph>(graphObject);
    if (
      validation.valid !== true ||
      graph.documentSha256 !== outputs.documentSha256 ||
      !graph.slides.length ||
      graph.slides.some((slide) => !slide.previewObject)
    )
      throw new Error("Manual edit validation or rendering failed.");
    await db().begin(async (transaction) => {
      const [document] =
        await transaction`select current_version_id, status from spellbook_documents where id=${job.document_id} for update`;
      const [edit] =
        await transaction`select base_version_id, candidate_version_id, status from spellbook_edit_requests where id=${job.edit_request_id}`;
      const [currentJob] =
        await transaction`select status from spellbook_jobs where id=${job.id}`;
      if (!["queued", "running"].includes(currentJob?.status)) return;
      if (
        document.status !== "editing" ||
        document.current_version_id !== edit.base_version_id ||
        edit.candidate_version_id !== job.version_id ||
        edit.status !== "patching"
      )
        throw new Error("Manual edit version changed.");
      if (!(await claimJob(transaction, job.id, callback))) return;
      await transaction`update spellbook_versions set kind='approved', status='ready', graph_object=${graphObject}, validation_object=${validationObject}, document_sha256=${outputs.documentSha256}, slide_count=${outputs.slideCount}, document_object=${documentObject} where id=${job.version_id}`;
      await transaction`update spellbook_edit_requests set status='approved', result_summary='직접 편집 저장 완료 · 파일 구조 검사 및 재렌더링 완료 · AI 시각 검증 없음', updated_at=now() where id=${job.edit_request_id}`;
      await transaction`update spellbook_messages set content=${`직접 편집 저장 완료 · ${job.payload.command.summary}`}, status='completed', updated_at=now() where edit_request_id=${job.edit_request_id} and source_key='manual'`;
      await transaction`update spellbook_documents set current_version_id=${job.version_id}, status='ready', last_error=null, updated_at=now() where id=${job.document_id}`;
      await addEvent(transaction, job.document_id, "manual_edit_saved", {
        versionId: job.version_id,
      });
    });
    return null;
  }
  if (job.payload?.agentJobId) {
    await db().begin(async (transaction) => {
      if (!(await claimJob(transaction, job.id, callback))) return;
      await transaction`update spellbook_versions set status = 'ready', graph_object = ${graphObject}, validation_object = ${validationObject}, document_sha256 = ${outputs.documentSha256}, slide_count = ${outputs.slideCount}, document_object = ${documentObject} where id = ${job.version_id}`;
      await transaction`update spellbook_edit_requests set status = 'reviewing', updated_at = now() where id = ${job.edit_request_id} and status = 'patching' and candidate_version_id = ${job.version_id}`;
      await addEvent(transaction, job.document_id, "agent_candidate_rendered", {
        versionId: job.version_id,
      });
    });
    return null;
  }
  const rows = await db()`
    select e.*, base.graph_object as base_graph_object, candidate.id as candidate_id
    from spellbook_edit_requests e
    join spellbook_versions base on base.id = coalesce(e.input_version_id, e.base_version_id)
    join spellbook_versions candidate on candidate.id = e.candidate_version_id
    where e.id = ${job.edit_request_id} limit 1
  `;
  const edit = rows[0];
  if (!edit) throw new Error("Edit request not found.");
  const baseGraph = await getJsonObject<ElementGraph>(edit.base_graph_object);
  const candidateGraph = await getJsonObject<ElementGraph>(graphObject);
  const selectedIds = asStringArray(edit.selected_element_ids);
  const slideIndexes = asNumberArray(edit.selected_slide_indexes);
  const reviewJobId = randomUUID();
  const [planJob] =
    await db()`select payload from spellbook_jobs where edit_request_id = ${edit.id} and job_type = 'ai_plan' order by created_at asc limit 1`;
  const payload = {
    jobId: reviewJobId,
    callbackUrl: callbackUrl(),
    mode: "review",
    conversationHistory: planJob?.payload?.conversationHistory ?? [],
    email: await accountEmail(edit.account_id),
    storageNamespace: storageNamespace(),
    requestText: edit.request_text,
    selectedElementIds: selectedIds,
    selectedSlideIndexes: slideIndexes,
    baseGraphObject: edit.base_graph_object,
    basePreviewObjects: selectedPreviews(baseGraph, slideIndexes, selectedIds),
    candidateGraphObject: graphObject,
    candidatePreviewObjects: selectedPreviews(
      candidateGraph,
      slideIndexes,
      selectedIds,
    ),
    validationObject,
  };
  let claimed = false;
  await db().begin(async (transaction) => {
    claimed = await claimJob(transaction, job.id, callback);
    if (!claimed) return;
    await transaction`
      update spellbook_versions set status = 'ready', graph_object = ${graphObject},
        validation_object = ${validationObject}, document_sha256 = ${outputs.documentSha256},
        slide_count = ${outputs.slideCount}, document_object = ${documentObject}
      where id = ${job.version_id}
    `;
    await transaction`update spellbook_edit_requests set status = 'reviewing', updated_at = now() where id = ${edit.id}`;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload)
      values (${reviewJobId}, 'ai_review', ${edit.document_id}, ${job.version_id}, ${edit.id}, 'queued', ${transaction.json(jsonValue(payload))})
    `;
    await addEvent(transaction, edit.document_id, "candidate_rendered", {
      editRequestId: edit.id,
      versionId: job.version_id,
    });
  });
  return claimed
    ? { jobId: reviewJobId, target: "ai", path: "/internal/jobs/edit", payload }
    : null;
}

async function completeReview(
  job: Record<string, any>,
  callback: WorkerCallback,
): Promise<Dispatch | null> {
  const review = callback.result as {
    approved?: boolean;
    summary?: string;
    problems?: string[];
    revisedCommand?: EditCommandBatch | null;
  };
  const rows = await db()`
    select e.*, base.document_object as base_document_object, base.graph_object as base_graph_object, base.document_sha256
    from spellbook_edit_requests e join spellbook_versions base on base.id = coalesce(e.input_version_id, e.base_version_id)
    where e.id = ${job.edit_request_id} limit 1
  `;
  const edit = rows[0];
  if (!edit) throw new Error("Edit request not found.");
  if (review.approved === true) {
    await db().begin(async (transaction) => {
      if (!(await claimJob(transaction, job.id, callback))) return;
      await transaction`
        update spellbook_edit_requests set status = 'candidate_ready', result_summary = ${review.summary ?? "검증 통과"}, updated_at = now()
        where id = ${edit.id}
      `;
      await transaction`update spellbook_documents set status = 'candidate_ready', updated_at = now() where id = ${edit.document_id}`;
      await addEvent(transaction, edit.document_id, "candidate_review_passed", {
        editRequestId: edit.id,
        summary: review.summary,
      });
    });
    return null;
  }

  if (!review.revisedCommand || edit.ai_attempts >= 2) {
    await db().begin(async (transaction) => {
      if (!(await claimJob(transaction, job.id, callback))) return;
      await transaction`
        update spellbook_edit_requests set status = 'failed', result_summary = ${review.summary ?? null},
          last_error = ${review.problems?.join(" ") || "Visual review rejected the candidate."}, updated_at = now()
        where id = ${edit.id}
      `;
      await transaction`update spellbook_documents set status = 'ready', updated_at = now() where id = ${edit.document_id}`;
      await restoreRefinementInput(transaction, edit.id, edit.document_id);
      await addEvent(transaction, edit.document_id, "candidate_review_failed", {
        editRequestId: edit.id,
        problems: review.problems ?? [],
      });
    });
    return null;
  }

  if (
    !validateEditBatch(review.revisedCommand) ||
    review.revisedCommand.baseDocumentSha256 !== edit.document_sha256
  ) {
    throw new EditValidationError(
      "AI review returned an invalid revised command.",
    );
  }
  const graph = await getJsonObject<ElementGraph>(edit.base_graph_object);
  validateCommandTargets(
    review.revisedCommand,
    graph,
    asStringArray(edit.selected_element_ids),
    asNumberArray(edit.selected_slide_indexes),
  );
  const candidateVersionId = randomUUID();
  const patchJobId = randomUUID();
  const prefix = accountPrefix(edit.account_id, edit.document_id);
  const documentObject = `${prefix}/versions/${candidateVersionId}/document.pptx`;
  const outputPrefix = `${prefix}/versions/${candidateVersionId}/render`;
  const payload = {
    jobId: patchJobId,
    callbackUrl: callbackUrl(),
    storageNamespace: storageNamespace(),
    formatId: currentPresentationFormat.id,
    inputObject: edit.base_document_object,
    outputDocumentObject: documentObject,
    outputPrefix,
    command: review.revisedCommand,
  };
  let claimed = false;
  await db().begin(async (transaction) => {
    claimed = await claimJob(transaction, job.id, callback);
    if (!claimed) return;
    await transaction`update spellbook_versions set kind = 'abandoned' where id = ${edit.candidate_version_id}`;
    await transaction`
      insert into spellbook_versions (id, document_id, parent_version_id, kind, status, document_object)
      values (${candidateVersionId}, ${edit.document_id}, ${edit.base_version_id}, 'candidate', 'processing', ${documentObject})
    `;
    await transaction`
      update spellbook_edit_requests set candidate_version_id = ${candidateVersionId}, status = 'patching',
        ai_attempts = ai_attempts + 1, result_summary = ${review.summary ?? null}, updated_at = now()
      where id = ${edit.id}
    `;
    await transaction`
      insert into spellbook_jobs (id, job_type, document_id, version_id, edit_request_id, status, payload)
      values (${patchJobId}, 'patch_render', ${edit.document_id}, ${candidateVersionId}, ${edit.id}, 'queued', ${transaction.json(jsonValue(payload))})
    `;
    await addEvent(transaction, edit.document_id, "candidate_auto_revision", {
      editRequestId: edit.id,
      problems: review.problems ?? [],
    });
  });
  return claimed
    ? {
        jobId: patchJobId,
        target: "document",
        path: "/internal/jobs/patch-render",
        payload,
      }
    : null;
}

async function claimJob(
  transaction: any,
  jobId: string,
  callback: WorkerCallback,
  executionToken?: string,
): Promise<boolean> {
  const token = executionToken ?? null;
  const rows = await transaction`
    update spellbook_jobs set status = 'succeeded', outputs = ${transaction.json(jsonValue(callback))}, updated_at = now()
    where id = ${jobId} and status in ('queued','running') and (${token}::text is null or execution_token = ${token}) returning id
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

async function markJobFailure(
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
    // AI jobs reference input versions. Only unfinished render outputs can fail.
    if (
      job.version_id &&
      (job.job_type === "scan_render" || job.job_type === "patch_render")
    )
      await transaction`update spellbook_versions set status = 'failed' where id = ${job.version_id} and status = 'processing' and kind in ('original', 'candidate')`;
    if (job.edit_request_id) {
      await transaction`update spellbook_messages set status = 'permission_cancelled', updated_at = now() where edit_request_id = ${job.edit_request_id} and status = 'permission_pending'`;
      await transaction`update spellbook_messages set status = case when role = 'user' and status = 'delivering' then 'delivery_unknown' when role = 'user' then 'not_delivered' else 'interrupted' end, updated_at = now() where edit_request_id = ${job.edit_request_id} and status in ('queued','delivering','streaming')`;
      // Stop every unfinished stage of this turn together. A late child callback
      // must not resurrect a cancelled edit or overwrite a newer document state.
      await transaction`update spellbook_jobs set status = 'failed', error = ${error}, updated_at = now() where edit_request_id = ${job.edit_request_id} and status in ('queued','running')`;
      await transaction`update spellbook_versions set status = 'failed' where id in (select version_id from spellbook_jobs where edit_request_id = ${job.edit_request_id} and job_type = 'patch_render') and status = 'processing' and kind = 'candidate'`;
      await transaction`update spellbook_edit_requests set status = 'failed', last_error = ${error}, updated_at = now() where id = ${job.edit_request_id}`;
    }
    await transaction`update spellbook_documents set status = ${job.job_type === "scan_render" ? "failed" : "ready"}, last_error = ${error}, updated_at = now() where id = ${job.document_id}`;
    if (job.job_type === "scan_render")
      await transaction`update spellbook_documents set failure_code = ${code} where id = ${job.document_id}`;
    if (job.edit_request_id)
      await restoreRefinementInput(
        transaction,
        job.edit_request_id,
        job.document_id,
      );
    await addEvent(transaction, job.document_id, "job_failed", {
      jobId: job.id,
      jobType: job.job_type,
      error,
    });
  });
}

export async function cancelDocumentTurn(
  session: Session,
  documentId: string,
): Promise<void> {
  await ensureSchema();
  const [job] =
    await db()`select j.* from spellbook_jobs j join spellbook_documents d on d.id = j.document_id
    where d.id = ${documentId} and d.account_id = ${session.accountId} and d.status = 'editing'
      and j.status in ('queued','running') and j.edit_request_id is not null order by j.created_at asc limit 1`;
  if (!job) throw new HttpError(409, "no_active_turn");
  await markJobFailure(
    job,
    "사용자가 작업을 중단했습니다. 승인본은 변경되지 않았습니다.",
  );
}

async function restoreRefinementInput(
  transaction: any,
  editId: string,
  documentId: string,
): Promise<void> {
  const parents = await transaction`
    select parent.id, parent.candidate_version_id from spellbook_edit_requests failed
    join spellbook_edit_requests parent on parent.id = failed.parent_edit_request_id
    join spellbook_documents d on d.id = failed.document_id
    join spellbook_versions v on v.id = parent.candidate_version_id
    where failed.id = ${editId} and failed.document_id = ${documentId}
      and failed.status in ('failed', 'answered') and parent.status = 'rejected'
      and parent.document_id = failed.document_id and parent.base_version_id = d.current_version_id
      and v.id = failed.input_version_id and v.status = 'ready'
  `;
  if (!parents[0]) return;
  await transaction`update spellbook_edit_requests set status = 'candidate_ready', updated_at = now() where id = ${parents[0].id}`;
  await transaction`update spellbook_versions set kind = 'candidate' where id = ${parents[0].candidate_version_id}`;
  await transaction`update spellbook_documents set status = 'candidate_ready', updated_at = now() where id = ${documentId}`;
}

async function dispatchOrFail(
  dispatch: Dispatch,
  documentId: string,
  editRequestId?: string,
): Promise<void> {
  try {
    await enqueueWorkerJob(
      dispatch.jobId,
      dispatch.target,
      dispatch.path,
      dispatch.payload,
    );
    await db()`update spellbook_jobs set dispatched_at = now(), error = null where id = ${dispatch.jobId}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "dispatch_failed";
    // Dispatch failure is recoverable, not a failed edit or failed document.
    await db()`update spellbook_jobs set error = ${message}, updated_at = now()
      where id = ${dispatch.jobId} and status = 'queued'`;
    throw error;
  }
}

async function dispatchPendingJobs(documentId: string): Promise<void> {
  const retryAfterSeconds = jobRedeliverySeconds();
  const jobs =
    await db()`select * from spellbook_jobs where document_id = ${documentId}
    and status = 'queued'
    and (dispatched_at is null or dispatched_at < now() - ${retryAfterSeconds} * interval '1 second')
    order by created_at limit 4`;
  for (const job of jobs) {
    const isDocument =
      job.job_type === "scan_render" || job.job_type === "patch_render";
    await dispatchOrFail(
      {
        jobId: job.id,
        target: isDocument ? "document" : "ai",
        path: isDocument
          ? job.job_type === "scan_render"
            ? "/internal/jobs/scan-render"
            : "/internal/jobs/patch-render"
          : job.job_type === "native_turn"
            ? "/internal/jobs/native"
            : "/internal/jobs/edit",
        payload: job.payload,
      },
      documentId,
      job.edit_request_id ?? undefined,
    );
  }
}

function validateSelection(
  graph: ElementGraph,
  selectedIds: string[],
  slideIndexes: number[],
): void {
  const slideSet = new Set(graph.slides.map((slide) => slide.slideIndex));
  if (
    slideIndexes.some(
      (index) => !Number.isInteger(index) || !slideSet.has(index),
    )
  )
    throw new HttpError(400, "invalid_slide_selection");
  const elementMap = new Map(
    graph.slides.flatMap((slide) =>
      slide.elements.map((element) => [element.elementId, element] as const),
    ),
  );
  for (const id of selectedIds) {
    const element = elementMap.get(id);
    if (!element) throw new HttpError(400, "invalid_element_selection");
    if (!element.editable)
      throw new HttpError(
        400,
        element.unsupportedReason ?? "element_not_editable",
      );
  }
}

function mapEdit(row: Record<string, any>) {
  return {
    execution: row.execution ?? "agent",
    modelSettings: row.model_settings ?? null,
    id: row.id,
    requestText: row.request_text,
    selectedElementIds: asStringArray(row.selected_element_ids),
    selectedSlideIndexes: asNumberArray(row.selected_slide_indexes),
    parentEditRequestId: row.parent_edit_request_id ?? null,
    status: row.status,
    candidateVersionId: row.candidate_version_id,
    aiAttempts: row.ai_attempts,
    resultSummary: row.result_summary,
    assistantMessage: row.assistant_message ?? null,
    inputVersionId: row.input_version_id ?? row.base_version_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function callbackUrl(): string {
  return `${internalAppBaseUrl()}/api/internal/jobs/callback`;
}

async function accountEmail(accountId: string): Promise<string> {
  const rows =
    await db()`select payload->>'email' as email from spellbook_jobs where payload->>'email' is not null and document_id in (select id from spellbook_documents where account_id = ${accountId}) order by created_at desc limit 1`;
  if (rows[0]?.email) return rows[0].email;
  const localEmail = process.env.SPELLBOOK_LOCAL_EMAIL;
  if (localEmail) return localEmail.trim().toLowerCase();
  throw new Error("Unable to resolve the local account email for AI review.");
}

async function addEvent(
  transaction: any,
  documentId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await transaction`insert into spellbook_events (document_id, event_type, payload) values (${documentId}, ${type}, ${transaction.json(jsonValue(payload))})`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : [];
}

function jsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}
