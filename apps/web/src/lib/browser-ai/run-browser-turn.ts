import type { ModelSettings } from "../ai-models";
import { loadEditorAsset } from "../editor-asset";
import type { BrowserKeyProvider } from "./key-store";
import {
  runNativeTurn,
  type NativeObservation,
  type NativePermission,
} from "./native-turn";
import { browserTurnModel } from "./pi-turn-model";
import { browserWebTools } from "./web-tools";

/*
 * Runs one API-key request in this page. The server only hands out the job
 * (with a job-scoped capability) and records its start, heartbeat, editor
 * calls and result; the model and every editor call run here.
 */

export interface BrowserJob {
  jobId: string;
  sessionId: string;
  turnId: string;
  capability: string;
  requestText: string;
  permissionMode: NativePermission["mode"];
  modelSettings?: ModelSettings;
  initialObservation?: NativeObservation;
  conversationHistory?: Array<{
    request: string;
    response: string | null;
    status: "completed" | "failed" | "cancelled";
  }>;
}

interface TaskRecord {
  id: string;
  request: Record<string, unknown>;
  status: "completed" | "failed";
  result: unknown;
  error: string | null;
}

const ASSET_OPERATIONS = new Set([
  "insert_image",
  "replace_image",
  "insert_media",
  "replace_media",
]);
const HEARTBEAT_MS = 15_000;
// Longer than an observed edit batch (p90 17 s) with headroom for a slow machine.
const EDITOR_CALL_TIMEOUT_MS = 120_000;

export async function runBrowserTurn(
  job: BrowserJob,
  deps: {
    documentId: string;
    provider: BrowserKeyProvider;
    apiKey: string;
    /** Sends one operation to the open editor and waits for its answer. */
    callEditor: (
      request: Record<string, unknown>,
      timeoutMs: number,
      transfer?: Transferable[],
    ) => Promise<unknown>;
    /** Shows what the AI is looking at while the request runs. */
    onObservation: (taskId: string, observation: NativeObservation) => void;
    onText: (delta: string) => void;
    onThinking: (delta: string) => void;
    onTool: (label: string) => void;
    signal: AbortSignal;
  },
): Promise<void> {
  const executionToken = crypto.randomUUID();
  const post = async (path: "tools" | "callback", body: object) => {
    const response = await fetch(`/api/native/jobs/${job.jobId}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${job.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jobId: job.jobId,
        sessionId: job.sessionId,
        executionToken,
        ...body,
      }),
      cache: "no-store",
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  };
  // Background tabs may run timers only once a minute, so every editor call
  // also renews the job's lease when the last renewal is getting old.
  let lastBeat = Date.now();
  const beat = () => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    post("tools", { operation: "heartbeat" }).catch(() => undefined);
  };
  const records: TaskRecord[] = [];
  const host = {
    async call(request: Record<string, unknown>) {
      const id = crypto.randomUUID();
      const record: TaskRecord = {
        id,
        request,
        status: "failed",
        result: null,
        error: null,
      };
      records.push(record);
      try {
        let message = request;
        const transfer: Transferable[] = [];
        if (ASSET_OPERATIONS.has(String(request.operation))) {
          const asset = await loadEditorAsset(
            deps.documentId,
            String(request.assetId ?? ""),
          );
          message = {
            ...request,
            mediaType: asset.mediaType,
            fileName: asset.fileName,
            assetBytes: asset.bytes,
          };
          transfer.push(asset.bytes);
        }
        const observation = (await deps.callEditor(
          message,
          EDITOR_CALL_TIMEOUT_MS,
          transfer,
        )) as NativeObservation;
        record.status = "completed";
        // Screenshots stay in this page; the record keeps which slide each showed.
        record.result = {
          ...observation,
          images: (observation.images ?? []).map(({ slideIndex }) => ({
            slideIndex,
          })),
        };
        deps.onObservation(id, observation);
        return observation;
      } catch (error) {
        record.error =
          error instanceof Error
            ? error.message
            : "native_document_operation_failed";
        throw error;
      } finally {
        beat();
      }
    },
  };

  await post("tools", { operation: "start" });
  const heartbeat = setInterval(beat, HEARTBEAT_MS / 3);
  try {
    // Same rule as the AI worker: the page's latest observation when it sent
    // one, otherwise a fresh look; a selection request with nothing selected
    // covers the active slide instead.
    const initial =
      job.initialObservation && typeof job.initialObservation === "object"
        ? job.initialObservation
        : await host.call({ operation: "observe" });
    const selected = Array.isArray(initial.selectedElementIds)
      ? (initial.selectedElementIds as string[])
      : [];
    const mode =
      job.permissionMode === "selection" && selected.length === 0
        ? ("slides" as const)
        : job.permissionMode;
    const result = await runNativeTurn(
      browserTurnModel(deps.provider, deps.apiKey),
      {
        requestText: job.requestText,
        conversationHistory: job.conversationHistory,
        modelSettings: job.modelSettings,
        permission: {
          mode,
          slideIndexes: mode === "slides" ? [initial.activeSlide] : [],
          elementIds: mode === "selection" ? selected : [],
        },
        host,
        web: browserWebTools,
        initialObservation: initial,
        signal: deps.signal,
        onText: deps.onText,
        onThinking: deps.onThinking,
        onTool: deps.onTool,
      },
    );
    await post("tools", { operation: "record_tasks", tasks: records });
    await post("callback", {
      status: "succeeded",
      mode: "native",
      result: { ...result, executionToken },
    });
  } catch (error) {
    // A cancelled request was already closed by the server.
    if (deps.signal.aborted) return;
    await post("tools", { operation: "record_tasks", tasks: records }).catch(
      () => undefined,
    );
    await post("callback", {
      status: "failed",
      error: error instanceof Error ? error.message : "native_worker_failed",
    }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}
