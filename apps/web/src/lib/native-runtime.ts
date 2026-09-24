import { randomUUID } from "node:crypto";

import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type {
  ElementGraph,
  PackageChangeBudgetReport,
  Session,
  WorkerCallback,
} from "./models";
import {
  anthropicModels,
  geminiModels,
  openAiModels,
  openRouterModels,
  parseModelSettings,
  supportsSettings,
  type AvailableModel,
} from "./ai-models";
import { callAiAccount, enqueueWorkerJob } from "./workers";
import { saveImageAsset } from "./image-assets";
import { getJsonObject, storageNamespace } from "./storage";
import { internalAppBaseUrl, publicAppBaseUrl } from "./runtime-urls";
import {
  boundedNativeConversationHistory,
  NATIVE_HISTORY_TURN_LIMIT,
  type NativeConversationTurn,
} from "./native-conversation";
import { signNativeConnectorToken } from "./native-connector-token";
import { aiConnectorConfig } from "./ai-connector-config";
import { getAccountProviders, getActiveProviderKey } from "./provider-keys";
import { loadTurnSummary } from "./native-turn-summary";
import {
  jobRedeliverySeconds,
  NATIVE_AGENT_LEASE_SECONDS,
} from "./job-delivery";

type PermissionMode = "read_only" | "selection" | "slides" | "document";

// Editor tasks must outlive their real execution time: an expired task that
// still completes in the editor changes the document outside the AI turn's
// review. Observed edit_batch p90 was 17s (max 20s) on the managed editor;
// the AI worker waits up to 120s for a task.
export const NATIVE_TASK_TTL_SECONDS = 120;

const KEY_PROVIDERS = new Set([
  "openai_api",
  "anthropic_api",
  "gemini_api",
  "openrouter_api",
  "custom_api",
]);

// Provider API keys are attached only to the copy handed to a worker or to the
// user's connector. Stored jobs keep no key, so the jobs table, its backups and
// redelivery never hold a usable credential.
async function withProviderKey(
  payload: Record<string, unknown>,
  accountId: string,
): Promise<Record<string, unknown>> {
  const provider = (payload.modelSettings as { provider?: unknown } | undefined)
    ?.provider;
  if (typeof provider !== "string" || !KEY_PROVIDERS.has(provider))
    return payload;
  const apiKey = await getActiveProviderKey(accountId, provider);
  if (!apiKey) throw new HttpError(400, "provider_key_missing");
  return { ...payload, apiKey };
}

async function ownedSession(
  session: Session,
  documentId: string,
  sessionId?: string,
  includeFailed = false,
) {
  await ensureSchema();
  const [row] = await db()`
    select s.*, coalesce(working.graph_object,current.graph_object) as graph_object from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    join spellbook_versions current on current.id=d.current_version_id
    left join spellbook_versions working on working.id=s.working_version_id
    where s.document_id=${documentId} and s.account_id=${session.accountId}
      and (${sessionId ?? null}::uuid is null or s.id=${sessionId ?? null})
      and (s.status in ('active','validating') or (${includeFailed} and s.status='failed'))
      and s.expires_at > now()
  `;
  if (!row) throw new HttpError(409, "native_session_not_active");
  return row;
}

export async function nativeModels(session: Session, documentId?: string) {
  if (documentId) await ownedSession(session, documentId);
  let workerModels: AvailableModel[] = [];
  try {
    const res = (await callAiAccount("/internal/models", session.email)) as {
      models?: AvailableModel[];
    };
    if (Array.isArray(res?.models)) workerModels = res.models;
  } catch {}

  const customProviders = await getAccountProviders(session.accountId);
  const models: AvailableModel[] = [...workerModels];
  if (customProviders.some((p) => p.provider === "gemini_api")) {
    models.push(...geminiModels());
  }
  if (customProviders.some((p) => p.provider === "openai_api")) {
    models.push(...openAiModels());
  }
  if (customProviders.some((p) => p.provider === "anthropic_api")) {
    models.push(...anthropicModels());
  }
  if (customProviders.some((p) => p.provider === "openrouter_api")) {
    models.push(...openRouterModels());
  }
  return { models };
}

export async function submitNativeTurn(
  session: Session,
  documentId: string,
  input: {
    text?: unknown;
    permission?: unknown;
    modelSettings?: unknown;
    execution?: unknown;
    initialObservation?: unknown;
  },
) {
  const native = await ownedSession(session, documentId);
  if (native.status !== "active")
    throw new HttpError(409, "native_save_validation_in_progress");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 2_000)
    throw new HttpError(400, "invalid_native_request");
  const permission = input.permission as PermissionMode;
  if (!["read_only", "selection", "slides", "document"].includes(permission))
    throw new HttpError(400, "invalid_native_permission");
  const modelSettings = parseModelSettings(input.modelSettings);
  const execution = aiConnectorConfig().mode;
  if (input.execution !== undefined && input.execution !== execution)
    throw new HttpError(400, "invalid_native_execution");
  if (!native.graph_object)
    throw new HttpError(409, "native_document_context_not_ready");
  let effectiveModelSettings = modelSettings;

  if (!effectiveModelSettings?.provider) {
    const customProviders = await getAccountProviders(session.accountId);
    const activeCustom = customProviders.find((p) => p.isActive);
    if (activeCustom) {
      const defaultModel =
        activeCustom.provider === "gemini_api"
          ? "gemini-3.8-flash"
          : activeCustom.provider === "openai_api"
            ? "gpt-4o"
            : activeCustom.provider === "anthropic_api"
              ? "claude-3-7-sonnet-20250219"
              : activeCustom.provider === "openrouter_api"
                ? "deepseek/deepseek-chat"
                : "default";
      effectiveModelSettings = {
        provider: activeCustom.provider as any,
        model: defaultModel,
        effort: "medium",
      };
    }
  }

  if (effectiveModelSettings && execution === "internal") {
    const catalog = await nativeModels(session, documentId);
    if (!supportsSettings(catalog.models, effectiveModelSettings))
      throw new HttpError(400, "selected_model_unavailable");
  }
  let apiKey: string | null = null;
  if (
    effectiveModelSettings?.provider &&
    KEY_PROVIDERS.has(effectiveModelSettings.provider)
  ) {
    apiKey = await getActiveProviderKey(
      session.accountId,
      effectiveModelSettings.provider,
    );
    if (!apiKey) {
      throw new HttpError(
        400,
        `${effectiveModelSettings.provider} API 키가 설정되지 않았습니다. 설정에서 API 키를 등록해 주세요.`,
      );
    }
  }
  const jobId = randomUUID();
  const turnId = randomUUID();
  const basePayload = {
    jobId,
    sessionId: native.id,
    turnId,
    email: session.email,
    storageNamespace: storageNamespace(),
    baseGraphObject: native.graph_object,
    mode: "native",
    requestText: text,
    permissionMode: permission,
    execution,
    ...(input.initialObservation
      ? { initialObservation: input.initialObservation }
      : {}),
    ...(effectiveModelSettings
      ? { modelSettings: effectiveModelSettings }
      : {}),
  };
  const publicBase = execution === "local" ? publicAppBaseUrl() : null;
  const baseJobPayload = {
    ...basePayload,
    callbackUrl:
      execution === "local"
        ? `${publicBase}/api/native/jobs/${jobId}/callback`
        : `${internalAppBaseUrl()}/api/internal/jobs/callback`,
    toolUrl:
      execution === "local"
        ? `${publicBase}/api/native/jobs/${jobId}/tools`
        : `${internalAppBaseUrl()}/api/internal/native/tools`,
  };
  let payload: typeof baseJobPayload & {
    conversationHistory?: NativeConversationTurn[];
  } = baseJobPayload;
  await db().begin(async (sql) => {
    await sql`select id from spellbook_native_sessions where id=${native.id} for update`;
    const [active] = await sql`
      select id from spellbook_native_turns where session_id=${native.id}
        and status in ('queued','running') for update
    `;
    if (active) {
      await sql`update spellbook_native_turns set status='cancelled', updated_at=now() where id=${active.id}`;
      if (active.job_id) {
        await sql`update spellbook_jobs set status='failed', error='cancelled_by_new_turn', updated_at=now() where id=${active.job_id} and status in ('queued','running')`;
      }
      await sql`insert into spellbook_native_events (session_id, turn_id, event_type, payload)
        values (${native.id}, ${active.id}, 'done', ${sql.json({ text: "새 요청으로 인해 이전 작업을 중단했습니다.", status: "cancelled", changed: false, reviewed: false })})`;
    }
    const history = boundedNativeConversationHistory(
      await sql`
        select request_text, assistant_text, status
        from spellbook_native_turns
        where session_id=${native.id}
          and status in ('completed','failed','cancelled')
        order by created_at desc limit ${NATIVE_HISTORY_TURN_LIMIT}
      `,
    );
    payload = history.length
      ? { ...baseJobPayload, conversationHistory: history }
      : baseJobPayload;
    await sql`
      insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload)
      values (${jobId},'native_turn',${documentId},${native.working_version_id},'queued',${sql.json(payload as any)})
    `;
    await sql`
      insert into spellbook_native_turns
        (id,session_id,document_id,account_id,job_id,request_text,permission_mode,model_settings,status)
      values (${turnId},${native.id},${documentId},${session.accountId},${jobId},${text},${permission},${modelSettings ? sql.json(modelSettings as any) : null},'queued')
    `;
    await sql`
      insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${native.id},${turnId},'start',${sql.json({ text, permission, turnId })})
    `;
  });
  const deliverable = apiKey ? { ...payload, apiKey } : payload;
  if (execution === "local")
    return {
      accepted: true,
      turnId,
      localJob: localConnectorJob(
        deliverable,
        session.accountId,
        native.expires_at,
      ),
    };
  try {
    await enqueueWorkerJob(jobId, "ai", "/internal/jobs/native", deliverable);
    await db()`update spellbook_jobs set dispatched_at=now() where id=${jobId}`;
  } catch (descobrir) {
    const error =
      descobrir instanceof Error ? descobrir.message : "dispatch_failed";
    await failNativeTurn(jobId, error);
    throw new HttpError(503, "native_ai_unavailable");
  }
  return { accepted: true, turnId };
}

export async function nativeSessionSignalId(
  session: Session,
  documentId: string,
): Promise<string> {
  return (await ownedSession(session, documentId, undefined, true)).id;
}

export async function pollNativeSession(
  session: Session,
  documentId: string,
  after: number,
) {
  const native = await ownedSession(session, documentId, undefined, true);
  if (!Number.isSafeInteger(after) || after < 0)
    throw new HttpError(400, "invalid_event_cursor");
  await failInterruptedNativeTurn(native.id, documentId);
  const retryAfterSeconds = jobRedeliverySeconds();
  const pending = await db()`select id,job_type,payload from spellbook_jobs
    where document_id=${documentId} and status='queued'
      and (dispatched_at is null or dispatched_at < now() - ${retryAfterSeconds} * interval '1 second')
      and job_type in ('native_turn','scan_render')
      and (job_type <> 'native_turn' or payload->>'execution' is distinct from 'local')
    order by created_at limit 2`;
  for (const job of pending) {
    const target = job.job_type === "native_turn" ? "ai" : "document";
    const path =
      job.job_type === "native_turn"
        ? "/internal/jobs/native"
        : "/internal/jobs/scan-render";
    try {
      await enqueueWorkerJob(
        job.id,
        target,
        path,
        job.job_type === "native_turn"
          ? await withProviderKey(job.payload, native.account_id)
          : job.payload,
      );
      await db()`update spellbook_jobs set dispatched_at=now(),error=null,updated_at=now()
        where id=${job.id} and status='queued'
          and (dispatched_at is null or dispatched_at < now() - ${retryAfterSeconds} * interval '1 second')`;
    } catch (error) {
      await db()`update spellbook_jobs set error=${error instanceof Error ? error.message : "dispatch_failed"},updated_at=now()
        where id=${job.id} and status='queued'`;
    }
  }
  await db()`update spellbook_native_tasks set status='expired', updated_at=now()
    where session_id=${native.id} and status in ('queued','delivered') and expires_at <= now()`;
  const task = await db().begin(async (sql) => {
    const [candidate] = await sql`
      select id, request from spellbook_native_tasks
      where session_id=${native.id} and expires_at > now()
        and (status='queued' or (status='delivered' and delivered_at < now() - interval '8 seconds'))
      order by created_at limit 1 for update skip locked
    `;
    if (!candidate) return null;
    await sql`update spellbook_native_tasks set status='delivered', delivered_at=now(),
      delivery_count=delivery_count+1, updated_at=now() where id=${candidate.id}`;
    return { id: candidate.id, request: candidate.request };
  });
  const events = await db()`
    select id::text, event_type as type, payload, turn_id::text as turn_id, created_at
    from spellbook_native_events where session_id=${native.id} and id>${after}
    order by spellbook_native_events.id limit 200
  `;
  const [localPending] = await db()`
    select payload from spellbook_jobs
    where document_id=${documentId} and job_type='native_turn'
      and status='queued' and dispatched_at is null
      and payload->>'execution'='local'
      and payload->>'sessionId'=${native.id}
    order by created_at limit 1
  `;
  let localJob: ReturnType<typeof localConnectorJob> | null = null;
  if (localPending) {
    try {
      localJob = localConnectorJob(
        await withProviderKey(localPending.payload, native.account_id),
        native.account_id,
        native.expires_at,
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await failNativeTurn(String(localPending.payload.jobId), error.message);
    }
  }
  return {
    task,
    localJob,
    events: events.map((event) => ({
      id: Number(event.id),
      type: event.type,
      turnId: event.turn_id ?? undefined,
      at: new Date(event.created_at).toISOString(),
      ...event.payload,
    })),
    session: {
      status: native.status,
      saveRevision: native.save_revision,
      error: native.last_error,
      workingVersionId: native.working_version_id,
      editorLocked: Boolean(
        native.wopi_lock &&
          (!native.lock_expires_at ||
            new Date(native.lock_expires_at).getTime() > Date.now()),
      ),
    },
  };
}

/**
 * Session state without consuming events or tasks. Used while the editor is
 * closed (e.g. before a restore) to learn when the editor released its lock.
 */
export async function nativeSessionState(session: Session, documentId: string) {
  const native = await ownedSession(session, documentId, undefined, true);
  return {
    status: native.status as string,
    saveRevision: native.save_revision as number,
    workingVersionId: native.working_version_id as string,
    editorLocked: Boolean(
      native.wopi_lock &&
        (!native.lock_expires_at ||
          new Date(native.lock_expires_at).getTime() > Date.now()),
    ),
  };
}

const INTERRUPTED_NATIVE_TURN_MESSAGE =
  "AI 작업 연결이 중단되었습니다. 현재 슬라이드와 변경 내용을 확인한 뒤 다시 요청하세요.";

async function failInterruptedNativeTurn(
  sessionId: string,
  documentId: string,
): Promise<void> {
  await db().begin(async (sql) => {
    const [stale] = await sql`
      select j.id, t.id as turn_id, t.session_id
      from spellbook_jobs j
      join spellbook_native_turns t on t.job_id=j.id
      where j.document_id=${documentId} and j.job_type='native_turn'
        and j.status='running' and t.status='running'
        and t.session_id=${sessionId}
        and coalesce(j.heartbeat_at,j.dispatched_at,j.created_at)
          < now() - ${NATIVE_AGENT_LEASE_SECONDS} * interval '1 second'
      order by j.created_at
      limit 1 for update of j,t skip locked
    `;
    if (!stale) return;
    const [claimed] = await sql`
      update spellbook_jobs set status='failed',error='native_agent_interrupted',updated_at=now()
      where id=${stale.id} and status='running'
        and coalesce(heartbeat_at,dispatched_at,created_at)
          < now() - ${NATIVE_AGENT_LEASE_SECONDS} * interval '1 second'
      returning id
    `;
    if (!claimed) return;
    await sql`
      update spellbook_native_turns set status='failed',last_error=${INTERRUPTED_NATIVE_TURN_MESSAGE},updated_at=now()
      where id=${stale.turn_id} and status='running'
    `;
    await sql`
      update spellbook_native_tasks set status='expired',error='native_agent_interrupted',updated_at=now()
      where turn_id=${stale.turn_id} and status in ('queued','delivered')
    `;
    const summary = await storeTurnSummary(sql, stale.turn_id);
    await sql`
      insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${stale.session_id},${stale.turn_id},'error',${sql.json({ error: summary?.failure?.message ?? INTERRUPTED_NATIVE_TURN_MESSAGE, summary } as never)})
    `;
  });
}

function validObservation(value: unknown): boolean {
  const item = value as Record<string, unknown> | null;
  if (
    !item ||
    item.unit !== "1/100mm" ||
    !Array.isArray(item.slides) ||
    item.slides.length > 500
  )
    return false;
  if (
    !Array.isArray(item.selectedElementIds) ||
    !Number.isInteger(item.activeSlide) ||
    !Array.isArray(item.changedSlideIndexes) ||
    item.changedSlideIndexes.some(
      (index) => !Number.isSafeInteger(index) || Number(index) < 0,
    ) ||
    typeof item.visualEvidenceComplete !== "boolean"
  )
    return false;
  if (!Array.isArray(item.images) || item.images.length > 10) return false;
  return item.images.every((image) => {
    const candidate = image as Record<string, unknown>;
    if (!Number.isInteger(candidate.slideIndex)) return false;
    const base64 = candidate.pngBase64;
    if (typeof base64 === "string") {
      if (
        base64.length === 0 ||
        base64.length > 16_000_000 ||
        base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      )
        return false;
      const decoded = Buffer.from(base64, "base64");
      return (
        decoded.length >= 8 &&
        decoded.length <= 12_000_000 &&
        decoded
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    }
    if (
      !Array.isArray(candidate.pngBytes) ||
      candidate.pngBytes.length < 8 ||
      candidate.pngBytes.length > 12_000_000 ||
      !candidate.pngBytes.every(
        (byte) => Number.isInteger(byte) && byte >= -128 && byte <= 255,
      )
    )
      return false;
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) =>
        ((candidate.pngBytes as number[])[index]! & 255) === byte,
    );
  });
}

export async function completeNativeTask(
  session: Session,
  documentId: string,
  input: { id?: unknown; value?: unknown; error?: unknown },
) {
  const native = await ownedSession(session, documentId);
  if (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id))
    throw new HttpError(400, "invalid_native_task");
  const error =
    typeof input.error === "string" ? input.error.slice(0, 1_000) : null;
  if (!error && !validObservation(input.value))
    throw new HttpError(400, "invalid_native_result");
  const value = error
    ? null
    : {
        ...(input.value as Record<string, unknown>),
        assets: await db()`
          select id as "assetId", file_name as "fileName", content_type as "contentType",
            case when content_type like 'image/%' then 'image' else 'media' end as kind,
            width, height
          from spellbook_assets where document_id=${native.document_id}
          order by created_at desc limit 100
        `,
      };
  const [updated] = await db()`
    update spellbook_native_tasks set status=${error ? "failed" : "completed"},
      result=${error ? null : db().json(value as never)}, error=${error}, updated_at=now()
    where id=${input.id} and session_id=${native.id} and status in ('queued','delivered')
      and expires_at > now() returning id
  `;
  if (!updated) {
    const [existing] = await db()`
      select status from spellbook_native_tasks where id=${input.id} and session_id=${native.id}
    `;
    if (existing?.status === "completed") return { ok: true };
    throw new HttpError(409, "native_task_inactive");
  }
  if (value)
    await recordEditorEngine(
      native.editor_mode,
      (value as { engine?: unknown }).engine,
    );
  return { ok: true };
}

/**
 * What the running editor engine can do, as its own observations report it.
 * The import summary uses it to say what AI cannot change in a file before
 * the file is opened. One row per editor mode; written only when it changes.
 */
async function recordEditorEngine(editorMode: unknown, engine: unknown) {
  const facts = engine as {
    patchLevel?: unknown;
    supportedOperations?: unknown;
  } | null;
  if (
    (editorMode !== "wopi" && editorMode !== "browser") ||
    !facts ||
    !Array.isArray(facts.supportedOperations)
  )
    return;
  const operations = facts.supportedOperations
    .filter(
      (operation): operation is string =>
        typeof operation === "string" && operation.length <= 64,
    )
    .slice(0, 500)
    .sort();
  const patchLevel =
    typeof facts.patchLevel === "string" ? facts.patchLevel.slice(0, 64) : null;
  await db()`
    insert into spellbook_editor_engines (editor_mode, patch_level, supported_operations, seen_at)
    values (${editorMode}, ${patchLevel}, ${db().json(operations)}, now())
    on conflict (editor_mode) do update set
      patch_level=excluded.patch_level, supported_operations=excluded.supported_operations, seen_at=now()
    where spellbook_editor_engines.patch_level is distinct from excluded.patch_level
      or spellbook_editor_engines.supported_operations is distinct from excluded.supported_operations
  `.catch(() => undefined);
}

export async function cancelNativeTurn(session: Session, documentId: string) {
  const native = await ownedSession(session, documentId);
  const [turn] =
    await db()`select job_id from spellbook_native_turns where session_id=${native.id}
    and status in ('queued','running') order by created_at desc limit 1`;
  if (!turn) throw new HttpError(409, "no_active_native_turn");
  await db().begin(async (sql) => {
    await sql`update spellbook_native_turns set status='cancelled', last_error='사용자가 작업을 중단했습니다.', updated_at=now() where job_id=${turn.job_id}`;
    await sql`update spellbook_jobs set status='failed', error='user_cancelled', updated_at=now() where id=${turn.job_id} and status in ('queued','running')`;
    await sql`update spellbook_native_tasks set status='expired', error='user_cancelled', updated_at=now() where turn_id=(select id from spellbook_native_turns where job_id=${turn.job_id}) and status in ('queued','delivered')`;
    const [cancelled] =
      await sql`select id from spellbook_native_turns where job_id=${turn.job_id}`;
    const summary = cancelled
      ? await storeTurnSummary(sql, cancelled.id)
      : null;
    await sql`insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      select session_id,id,'error',${sql.json({ error: "작업을 중단했습니다.", summary } as never)} from spellbook_native_turns where job_id=${turn.job_id}`;
  });
  return { ok: true };
}

export async function executeNativeTool(input: Record<string, unknown>) {
  await ensureSchema();
  const jobId = typeof input.jobId === "string" ? input.jobId : "";
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const executionToken =
    typeof input.executionToken === "string" ? input.executionToken : "";
  if (!jobId || !sessionId || !executionToken || executionToken.length > 100)
    throw new HttpError(400, "invalid_native_tool_identity");
  if (input.operation === "start") {
    const [claimed] =
      await db()`update spellbook_jobs set status='running', execution_token=${executionToken}, heartbeat_at=now(), dispatched_at=coalesce(dispatched_at,now()), updated_at=now()
      where id=${jobId} and job_type='native_turn' and status in ('queued','running')
        and (execution_token is null or execution_token=${executionToken} or heartbeat_at < now() - ${NATIVE_AGENT_LEASE_SECONDS} * interval '1 second')
        and payload->>'sessionId'=${sessionId} returning id`;
    if (!claimed) throw new HttpError(409, "native_agent_already_running");
    await db()`update spellbook_native_turns set status='running', updated_at=now() where job_id=${jobId} and status='queued'`;
    return { accepted: true };
  }
  const [lease] =
    await db()`update spellbook_jobs set heartbeat_at=now() where id=${jobId}
    and job_type='native_turn' and status='running' and execution_token=${executionToken}
    and payload->>'sessionId'=${sessionId} returning payload`;
  if (!lease) throw new HttpError(409, "native_agent_lease_lost");
  const turnId = lease.payload.turnId as string;
  if (input.operation === "heartbeat") return { accepted: true };
  if (input.operation === "asset_create") {
    const mediaType = input.mediaType;
    const encoded = typeof input.data === "string" ? input.data : "";
    if (
      !["image/png", "image/jpeg"].includes(String(mediaType)) ||
      !encoded ||
      encoded.length > 6_700_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new HttpError(400, "invalid_generated_image");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 5_000_000)
      throw new HttpError(400, "invalid_generated_image");
    const [context] = await db()`
      select s.document_id, s.account_id, t.permission_mode
      from spellbook_native_sessions s
      join spellbook_native_turns t on t.id=${turnId} and t.session_id=s.id
      where s.id=${sessionId} and s.status in ('active','validating')
        and s.expires_at > now()
    `;
    if (!context) throw new HttpError(409, "native_session_not_active");
    if (!["slides", "document"].includes(context.permission_mode))
      throw new HttpError(403, "outside_edit_permission");
    const extension = mediaType === "image/png" ? "png" : "jpg";
    return saveImageAsset(
      context.account_id,
      context.document_id,
      bytes,
      `AI 생성 이미지.${extension}`,
    );
  }
  if (input.operation === "task_create") {
    if (!input.request || typeof input.request !== "object")
      throw new HttpError(400, "invalid_native_request");
    const serialized = JSON.stringify(input.request);
    if (serialized.length > 5_000_000)
      throw new HttpError(400, "native_request_too_large");
    const id = randomUUID();
    const [created] = await db()`
      insert into spellbook_native_tasks
        (id,session_id,turn_id,request,status,save_revision_at_create,expires_at)
      select ${id},s.id,${turnId},${db().json(input.request as never)},'queued',s.save_revision,now()+${NATIVE_TASK_TTL_SECONDS} * interval '1 second'
      from spellbook_native_sessions s
      join spellbook_native_turns t on t.id=${turnId} and t.session_id=s.id
      where s.id=${sessionId} and s.status='active' and s.expires_at > now()
        and t.status='running'
      for update of s
      returning id
    `;
    if (!created) throw new HttpError(409, "native_session_not_active");
    return { taskId: id };
  }
  if (input.operation === "task_status") {
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const [task] =
      await db()`select status,result,error from spellbook_native_tasks
      where id=${taskId} and session_id=${sessionId} and turn_id=${turnId}`;
    if (!task) throw new HttpError(404, "native_task_not_found");
    return task;
  }
  if (input.operation === "event") {
    const type = input.type;
    const value = typeof input.value === "string" ? input.value : "";
    if (
      !["delta", "tool", "thinking"].includes(String(type)) ||
      value.length > 4_000
    )
      throw new HttpError(400, "invalid_native_event");
    await db()`insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${sessionId},${turnId},${String(type)},${db().json({ [type === "delta" ? "delta" : type === "thinking" ? "thinking" : "label"]: value })})`;
    return { accepted: true };
  }
  throw new HttpError(400, "invalid_native_tool_operation");
}

function localConnectorJob(
  payload: Record<string, unknown>,
  accountId: string,
  sessionExpiresAt: Date | string,
): Record<string, unknown> & {
  jobId: string;
  sessionId: string;
  toolUrl: string;
  callbackUrl: string;
  capability: string;
} {
  const jobId = String(payload.jobId ?? "");
  const sessionId = String(payload.sessionId ?? "");
  const toolUrl = String(payload.toolUrl ?? "");
  const callbackUrl = String(payload.callbackUrl ?? "");
  const sessionExpiry = new Date(sessionExpiresAt).getTime();
  const expiresAt = Math.min(Date.now() + 30 * 60 * 1000, sessionExpiry);
  if (
    !/^[0-9a-f-]{36}$/i.test(jobId) ||
    !/^[0-9a-f-]{36}$/i.test(sessionId) ||
    !toolUrl ||
    !callbackUrl ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw new HttpError(409, "native_connector_job_inactive");
  return {
    ...payload,
    jobId,
    sessionId,
    toolUrl,
    callbackUrl,
    capability: signNativeConnectorToken({
      version: 1,
      jobId,
      sessionId,
      accountId,
      expiresAt,
    }),
  };
}

export async function completeNativeTurn(
  job: Record<string, any>,
  callback: WorkerCallback,
) {
  const result = callback.result as Record<string, unknown> | undefined;
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  const changed = result?.changed as boolean;
  const reviewed = result?.reviewed as boolean;
  const executionToken =
    typeof result?.executionToken === "string" ? result.executionToken : "";
  if (
    !text ||
    text.length > 8_000 ||
    typeof changed !== "boolean" ||
    typeof reviewed !== "boolean" ||
    !executionToken
  )
    throw new Error("invalid_native_completion");
  await db().begin(async (sql) => {
    const [claimed] =
      await sql`update spellbook_jobs set status='succeeded', outputs=${sql.json(callback as any)}, updated_at=now()
      where id=${job.id} and status in ('queued','running') and execution_token=${executionToken} returning id`;
    if (!claimed) return;
    const [turn] =
      await sql`update spellbook_native_turns set status='completed', assistant_text=${text},
      changed=${changed}, reviewed=${reviewed}, updated_at=now() where job_id=${job.id} returning id,session_id`;
    const summary = await storeTurnSummary(sql, turn.id);
    await sql`insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${turn.session_id},${turn.id},'done',${sql.json({ text, changed, reviewed, status: typeof result?.status === "string" ? result.status : "completed", turnId: turn.id, summary } as never)})`;
  });
}

export async function failNativeTurn(jobId: string, error: string) {
  await db().begin(async (sql) => {
    const [turn] =
      await sql`update spellbook_native_turns set status='failed', last_error=${error.slice(0, 1_000)}, updated_at=now()
      where job_id=${jobId} and status in ('queued','running') returning id,session_id`;
    await sql`update spellbook_jobs set status='failed',error=${error.slice(0, 1_000)},updated_at=now()
      where id=${jobId} and status in ('queued','running')`;
    if (turn) {
      const summary = await storeTurnSummary(sql, turn.id);
      const errorMessage =
        summary?.failure?.message ||
        error ||
        "AI가 요청을 끝내지 못했어요. 다시 요청해 주세요.";
      await sql`insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${turn.session_id},${turn.id},'error',${sql.json({ error: errorMessage, turnId: turn.id, summary } as never)})`;
    }
  });
}

/**
 * Computes the result-card summary from the turn's editor records and stores
 * it. The screenshots the AI looked at are kept only while the request runs:
 * the page that relayed them keeps its own copies, and after a reload the
 * card shows the saved versions' previews instead.
 */
async function storeTurnSummary(sql: any, turnId: string) {
  const summary = await loadTurnSummary(sql, turnId);
  if (summary)
    await sql`update spellbook_native_turns set summary=${sql.json(summary as never)} where id=${turnId}`;
  await sql`
    update spellbook_native_tasks set result = result - 'images'
    where turn_id=${turnId} and result is not null and jsonb_typeof(result->'images') is not null
  `;
  return summary;
}

/**
 * Records that the person undid a request in the editor (its own undo
 * history, checked there against the request's before/after states). Only
 * the latest request of the session can be undone this way; the next save
 * is labelled as that undo.
 */
export async function markNativeUndo(
  session: Session,
  documentId: string,
  turnId: unknown,
) {
  if (typeof turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(turnId))
    throw new HttpError(400, "invalid_native_turn");
  const native = await ownedSession(session, documentId);
  return db().begin(async (sql) => {
    await sql`select id from spellbook_native_sessions where id=${native.id} for update`;
    const [latest] = await sql`
      select id, status, changed, undone_at from spellbook_native_turns
      where session_id=${native.id} order by created_at desc limit 1
    `;
    if (!latest || latest.id !== turnId)
      throw new HttpError(409, "undo_not_latest_request");
    if (latest.status !== "completed" || !latest.changed)
      throw new HttpError(409, "undo_nothing_changed");
    if (latest.undone_at)
      return { turnId, undoneAt: new Date(latest.undone_at).toISOString() };
    const [marked] = await sql`
      update spellbook_native_turns set undone_at=now(), updated_at=now()
      where id=${turnId} returning undone_at
    `;
    await sql`
      update spellbook_native_sessions set pending_undo_turn_id=${turnId}, pending_undo_at=now(), updated_at=now()
      where id=${native.id}
    `;
    await sql`
      insert into spellbook_native_events (session_id,turn_id,event_type,payload)
      values (${native.id},${turnId},'undone',${sql.json({ turnId })})
    `;
    return { turnId, undoneAt: new Date(marked.undone_at).toISOString() };
  });
}

export async function completeNativeScan(
  job: Record<string, any>,
  callback: WorkerCallback,
) {
  const outputs = callback.outputs;
  if (
    !outputs?.graphObject ||
    !outputs.validationObject ||
    !outputs.documentSha256 ||
    !outputs.slideCount
  )
    throw new NativeScanValidationError("native_scan_outputs_missing");
  const expectedValidationObject = `${job.payload.outputPrefix}/validation.json`;
  if (outputs.validationObject !== expectedValidationObject)
    throw new NativeScanValidationError(
      "native_scan_validation_identity_mismatch",
    );
  const [graph, validation] = await Promise.all([
    getJsonObject<ElementGraph>(outputs.graphObject),
    getJsonObject<PackageChangeBudgetReport>(outputs.validationObject),
  ]);
  if (
    validation.valid !== true ||
    validation.candidateDocumentSha256 !== outputs.documentSha256 ||
    graph.documentSha256 !== outputs.documentSha256 ||
    !graph.slides.length ||
    graph.slides.some((slide) => !slide.previewObject)
  )
    throw new NativeScanValidationError("native_scan_validation_failed");
  const graphObject = outputs.graphObject;
  const scanObject = outputs.scanObject ?? null;
  const validationObject = outputs.validationObject;
  const documentSha256 = outputs.documentSha256;
  const slideCount = outputs.slideCount;
  await db().begin(async (sql) => {
    const [claimed] =
      await sql`update spellbook_jobs set status='succeeded',outputs=${sql.json(callback as never)},updated_at=now()
      where id=${job.id} and status in ('queued','running') returning id`;
    if (!claimed) return;
    await sql`update spellbook_versions set status='ready',graph_object=${graphObject},scan_object=${scanObject},validation_object=${validationObject},
      document_sha256=${documentSha256},slide_count=${slideCount} where id=${job.version_id}`;
    const [session] =
      await sql`update spellbook_native_sessions set status='active',last_error=null,updated_at=now()
      where id=${job.payload.nativeSessionId} and working_version_id=${job.version_id}
      returning document_id,working_version_id`;
    if (session) {
      await sql`update spellbook_documents set current_version_id=${session.working_version_id},status='ready',last_error=null,updated_at=now()
        where id=${session.document_id}`;
    }
  });
}

export class NativeScanValidationError extends Error {}

export async function failNativeScan(
  job: Record<string, any>,
  error: string,
  callback?: WorkerCallback,
) {
  const expectedValidationObject = `${job.payload.outputPrefix}/validation.json`;
  const validationObject =
    callback?.outputs?.validationObject === expectedValidationObject
      ? expectedValidationObject
      : null;
  await db().begin(async (sql) => {
    await sql`update spellbook_jobs set status='failed',error=${error.slice(0, 1_000)},updated_at=now()
      where id=${job.id} and status in ('queued','running')`;
    await sql`update spellbook_versions set status='failed',kind='abandoned',validation_object=coalesce(${validationObject},validation_object) where id=${job.version_id} and status='processing'`;
    await sql`update spellbook_native_sessions set status='failed',last_error=${error.slice(0, 1_000)},updated_at=now()
      where id=${job.payload.nativeSessionId} and working_version_id=${job.version_id}`;
  });
}
