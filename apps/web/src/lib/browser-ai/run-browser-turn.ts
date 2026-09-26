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
 * (with a job-scoped capability) and records its start, heartbeat, each
 * editor call and the result; the model and every editor call run here.
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

const ASSET_OPERATIONS = new Set([
  "insert_image",
  "replace_image",
  "insert_media",
  "replace_media",
]);
const HEARTBEAT_MS = 15_000;
// Longer than an observed edit batch (p90 17 s) with headroom for a slow machine.
const EDITOR_CALL_TIMEOUT_MS = 300_000;

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
  const withoutPixels = (observation: NativeObservation) => ({
    ...observation,
    // Screenshots stay in this page; the record keeps which slide each showed.
    images: (observation.images ?? []).map(({ slideIndex }) => ({
      slideIndex,
    })),
  });
  const host = {
    /** Records an observation this page already has, without asking the editor. */
    async record(
      request: Record<string, unknown>,
      observation: NativeObservation,
    ) {
      const taskId = crypto.randomUUID();
      await post("tools", { operation: "task_begin", taskId, request });
      deps.onObservation(taskId, observation);
      await post("tools", {
        operation: "task_end",
        taskId,
        status: "completed",
        result: withoutPixels(observation),
      });
      return observation;
    },
    async call(request: Record<string, unknown>) {
      if (deps.signal.aborted) throw new Error("cancelled");
      const taskId = crypto.randomUUID();
      // Recorded before the editor sees it: an edit that lands while the page
      // closes or the request stops is still known, and holds the save.
      await post("tools", { operation: "task_begin", taskId, request });
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
        deps.onObservation(taskId, observation);
        await post("tools", {
          operation: "task_end",
          taskId,
          status: "completed",
          result: withoutPixels(observation),
        }).catch(() => undefined);
        return observation;
      } catch (error) {
        await post("tools", {
          operation: "task_end",
          taskId,
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "native_document_operation_failed",
        }).catch(() => undefined);
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
    // The page's view is recorded as this request's first look, so the
    // result card knows the state before the edit and can undo exactly it.
    const initial =
      job.initialObservation && typeof job.initialObservation === "object"
        ? await host.record(
            { operation: "observe", detailSlideIndex: null },
            job.initialObservation,
          )
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
    await post("callback", {
      status: "succeeded",
      mode: "native",
      result: { ...result, executionToken },
    });
  } catch (error) {
    // A cancelled request was already closed by the server.
    if (deps.signal.aborted) return;
    await post("callback", {
      status: "failed",
      error: error instanceof Error ? error.message : "native_worker_failed",
    }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}
