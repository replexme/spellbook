import { boundedConversationHistory } from "../../../contracts/native-turn-policy.cjs";
import { randomUUID } from "node:crypto";
import {
  runNativeTurn,
  type NativeObservation,
  type NativePermission,
} from "./native-agent.js";
import type { AgentTurnClient } from "./app-server-client.js";
import type { ModelSettings } from "../../../contracts/ai-models.js";

type Task = { id: string; request: Record<string, unknown> };
type Turn = {
  owner: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  tasks: Map<
    string,
    {
      task: Task;
      resolve: (value: NativeObservation) => void;
      reject: (error: Error) => void;
    }
  >;
  events: Array<{ type: string; text: string }>;
  result: unknown;
  done: boolean;
  expires: number;
};
// Document data lives only in a bounded, paired local turn. There is no remote
// callback, document upload, persistent job store, or arbitrary-code endpoint.
export class LocalNativeTurns {
  private turns = new Map<string, Turn>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  constructor(
    private client: (settings?: ModelSettings) => Promise<AgentTurnClient>,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5000);
    this.cleanupTimer.unref();
  }
  start(owner: string, body: Record<string, unknown>) {
    this.cleanup();
    if (
      this.turns.size >= 8 ||
      [...this.turns.values()].some((t) => t.owner === owner && !t.done)
    )
      throw Error("local_turn_limit");
    if (
      typeof body.requestText !== "string" ||
      !body.requestText.trim() ||
      body.requestText.length > 2000 ||
      !["read_only", "selection", "slides", "document"].includes(
        String(body.permissionMode),
      )
    )
      throw Error("invalid_local_turn");
    const settings = body.modelSettings as ModelSettings | undefined;
    if (
      settings &&
      (!["codex", "claude_code"].includes(settings.provider ?? "codex") ||
        typeof settings.model !== "string" ||
        settings.model.length > 200)
    )
      throw Error("invalid_local_model");
    const id = randomUUID(),
      controller = new AbortController();
    const turn: Turn = {
      owner,
      controller,
      timer: setTimeout(() => this.cancel(owner, id), 600000),
      tasks: new Map(),
      events: [],
      result: null,
      done: false,
      expires: Date.now() + 660000,
    };
    this.turns.set(id, turn);
    const call = (request: Record<string, unknown>, signal: AbortSignal) =>
      new Promise<NativeObservation>((resolve, reject) => {
        if (signal.aborted) return reject(Error("local_turn_cancelled"));
        if (turn.tasks.size >= 8) return reject(Error("local_task_limit"));
        const taskId = randomUUID(),
          task = { id: taskId, request };
        const finish = (value: NativeObservation) => {
          signal.removeEventListener("abort", abort);
          turn.tasks.delete(taskId);
          resolve(value);
        };
        const fail = (error: Error) => {
          signal.removeEventListener("abort", abort);
          turn.tasks.delete(taskId);
          reject(error);
        };
        const abort = () => fail(Error("local_turn_cancelled"));
        turn.tasks.set(taskId, { task, resolve: finish, reject: fail });
        signal.addEventListener("abort", abort, { once: true });
      });
    const emit = (type: string, text: string) => {
      if (turn.events.length >= 1000 || text.length > 100000)
        throw Error("local_event_limit");
      turn.events.push({ type, text });
    };
    void (async () => {
      try {
        const initial = await call({ operation: "observe" }, controller.signal);
        if (
          !initial ||
          !Array.isArray(initial.selectedElementIds) ||
          !Number.isSafeInteger(initial.activeSlide) ||
          !Array.isArray(initial.slides)
        )
          throw Error("invalid_local_observation");
        const mode =
          body.permissionMode === "selection" &&
          !initial.selectedElementIds.length
            ? "slides"
            : (body.permissionMode as NativePermission["mode"]);
        const permission: NativePermission = {
          mode,
          slideIndexes: mode === "slides" ? [initial.activeSlide] : [],
          elementIds: mode === "selection" ? initial.selectedElementIds : [],
        };
        const client = await this.client(
          body.modelSettings as ModelSettings | undefined,
        );
        turn.result = await runNativeTurn(client, {
          requestText: body.requestText as string,
          documentScope:
            typeof body.documentScope === "string" ? body.documentScope : "",
          activeGoal: body.activeGoal as
            | import("../../../contracts/native-goal.cjs").ActiveGoal
            | null,
          permission,
          conversationHistory: boundedConversationHistory(
            body.conversationHistory,
          ),
          host: {
            call,
            createImage: async (image, signal) => {
              if (image.bytes.length > 5_000_000)
                throw Error("generated_image_too_large");
              const assetId = randomUUID();
              const receipt = await call(
                {
                  operation: "register_generated_asset",
                  assetId,
                  mediaType: image.mediaType,
                  base64: image.bytes.toString("base64"),
                },
                signal,
              );
              if (
                (receipt as unknown as { assetId: string }).assetId !== assetId
              )
                throw Error("generated_asset_receipt_mismatch");
              return { assetId };
            },
          },
          initialObservation: initial,
          modelSettings: body.modelSettings as ModelSettings | undefined,
          signal: controller.signal,
          onText: (text) => emit("delta", text),
          onThinking: (text) => emit("thinking", text),
          onTool: (text) => emit("tool", text),
        });
      } catch (error) {
        turn.result = {
          error: error instanceof Error ? error.message : "local_turn_failed",
        };
      } finally {
        turn.done = true;
        clearTimeout(turn.timer);
        turn.controller.abort();
        turn.expires = Date.now() + 60000;
      }
    })();
    return { turnId: id };
  }
  poll(owner: string, id: string, offset: number) {
    const turn = this.get(owner, id);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > turn.events.length
    )
      throw Error("invalid_event_offset");
    return {
      tasks: [...turn.tasks.values()].map((v) => v.task),
      events: turn.events.slice(offset),
      offset: turn.events.length,
      done: turn.done,
      result: turn.result,
    };
  }
  reply(
    owner: string,
    id: string,
    taskId: string,
    value: unknown,
    error: unknown,
  ) {
    const turn = this.get(owner, id),
      task = turn.tasks.get(taskId);
    if (!task) throw Error("local_task_not_found");
    if (typeof error === "string") task.reject(Error(error.slice(0, 2000)));
    else if (!value || typeof value !== "object")
      throw Error("invalid_local_task_result");
    else task.resolve(value as NativeObservation);
    return { accepted: true };
  }
  cancel(owner: string, id: string) {
    const turn = this.get(owner, id);
    turn.controller.abort();
    return { cancelled: true };
  }
  private get(owner: string, id: string) {
    this.cleanup();
    const turn = this.turns.get(id);
    if (!turn || turn.owner !== owner)
      throw Error("local_turn_session_not_found");
    return turn;
  }
  private cleanup() {
    for (const [id, t] of this.turns)
      if (t.expires < Date.now()) {
        t.controller.abort();
        clearTimeout(t.timer);
        this.turns.delete(id);
      }
  }
  revoke(owner: string) {
    for (const [id, t] of this.turns)
      if (t.owner === owner) {
        t.controller.abort();
        clearTimeout(t.timer);
        this.turns.delete(id);
      }
  }
  dispose() {
    clearInterval(this.cleanupTimer);
    for (const t of this.turns.values()) {
      t.controller.abort();
      clearTimeout(t.timer);
    }
    this.turns.clear();
  }
}
