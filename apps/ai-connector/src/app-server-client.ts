import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { ModelSettings } from "../../../contracts/ai-models.js";

import type {
  AccountReadResult,
  AvailableModel,
  BrowserLoginResult,
  DeviceLoginResult,
  RpcNotification,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolResult {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
}
export interface GeneratedImage {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg";
  revisedPrompt?: string;
  transparentBackground?: boolean;
}
export interface AgentTurnOptions {
  modelSettings?: ModelSettings;
  tools: DynamicTool[];
  onTool: (
    tool: string,
    args: unknown,
    callId: string,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  onEvent?: (event: RpcNotification) => void;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  signal?: AbortSignal;
  threadId?: string;
  conversationKey?: string;
  onThread?: (id: string) => void;
  onTurn?: (steer: (text: string) => Promise<void>) => void;
  allowImageGeneration?: boolean;
  onGeneratedImage?: (image: GeneratedImage) => void | Promise<void>;
}

export interface AppServerStartOptions {
  createRestrictedConfig?: boolean;
  processHome?: string;
}

export interface AgentTurnClient {
  readonly supportsImageGeneration?: boolean;
  runStructuredTurn(
    input: Array<Record<string, unknown>>,
    outputSchema: Record<string, unknown>,
    timeoutMs?: number,
    options?: AgentTurnOptions,
  ): Promise<string>;
}

export class AppServerClient {
  readonly supportsImageGeneration = true;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new EventEmitter();
  private requestId = 0;
  private stderr = "";
  private stopped = false;
  private readonly toolHandlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<ToolResult>
  >();
  private readonly conversationThreads = new Map<string, string>();

  get isRunning(): boolean {
    return (
      !this.stopped &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    );
  }

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process;
    const lines = readline.createInterface({ input: process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_000);
    });
    const fail = (error: Error) => {
      this.stopped = true;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.events.emit("exit", error);
    };
    process.on("error", () =>
      fail(new Error("AI subscription process could not start.")),
    );
    process.stdin.on("error", () =>
      fail(new Error("AI subscription process connection closed.")),
    );
    process.on("exit", (code) =>
      fail(new Error(`AI subscription process exited with code ${code}.`)),
    );
  }

  static async start(
    codexHome: string,
    options: AppServerStartOptions = {},
  ): Promise<AppServerClient> {
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    if (options.createRestrictedConfig !== false) {
      const configPath = path.join(codexHome, "config.toml");
      try {
        await fs.access(configPath);
      } catch {
        await fs.writeFile(
          configPath,
          'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\ndisable_response_storage = true\nweb_search = "disabled"\n',
          { mode: 0o600 },
        );
      }
    }

    const binary = resolveCodexBinary();
    const allowedEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: options.processHome ?? codexHome,
      CODEX_HOME: codexHome,
      LANG: process.env.LANG ?? "C.UTF-8",
      LOG_FORMAT: "json",
      RUST_LOG: "warn",
    };
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      env: allowedEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new AppServerClient(child);
    await client.request("initialize", {
      clientInfo: {
        name: "replex_present",
        title: "Replex Spellbook",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  }

  async accountRead(refreshToken = false): Promise<AccountReadResult> {
    return this.request<AccountReadResult>("account/read", { refreshToken });
  }

  async rateLimitsRead(): Promise<unknown> {
    return this.request("account/rateLimits/read");
  }

  async providerCapabilities(): Promise<{
    imageGeneration: boolean;
    namespaceTools: boolean;
    webSearch: boolean;
  }> {
    return this.request("modelProvider/capabilities/read", {});
  }

  async models(): Promise<AvailableModel[]> {
    const models = new Map<string, AvailableModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request<{
        data: Array<
          AvailableModel & { hidden?: boolean; inputModalities?: string[] }
        >;
        nextCursor: string | null;
      }>("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.data) {
        // Older Codex catalogs omit modalities; the official protocol defines
        // that case as text + image. Explicit text-only models cannot inspect PPT.
        if (
          item.hidden ||
          (item.inputModalities && !item.inputModalities.includes("image"))
        )
          continue;
        if (
          !item.model ||
          !item.supportedReasoningEfforts?.some(
            (e) => e.reasoningEffort === item.defaultReasoningEffort,
          )
        )
          continue;
        models.set(item.model, {
          provider: "codex",
          model: item.model,
          displayName: item.displayName,
          defaultReasoningEffort: item.defaultReasoningEffort,
          supportedReasoningEfforts: item.supportedReasoningEfforts,
          isDefault: item.isDefault,
        });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("Model catalog pagination failed.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  }

  async validateModelSettings(settings: {
    model: string;
    effort: string;
  }): Promise<void> {
    const model = (await this.models()).find(
      (item) => item.model === settings.model,
    );
    if (
      !model?.supportedReasoningEfforts.some(
        (item) => item.reasoningEffort === settings.effort,
      )
    )
      throw new Error(
        "Selected model or reasoning effort is no longer available. Refresh the model list.",
      );
  }

  async startDeviceLogin(): Promise<DeviceLoginResult> {
    return this.request<DeviceLoginResult>("account/login/start", {
      type: "chatgptDeviceCode",
    });
  }

  async startBrowserLogin(): Promise<BrowserLoginResult> {
    return this.request<BrowserLoginResult>("account/login/start", {
      type: "chatgpt",
    });
  }

  async logout(): Promise<void> {
    await this.request("account/logout");
  }

  async runStructuredTurn(
    input: Array<Record<string, unknown>>,
    outputSchema: Record<string, unknown>,
    timeoutMs = 300_000,
    options?: AgentTurnOptions,
  ): Promise<string> {
    if (options?.modelSettings)
      await this.validateModelSettings(options.modelSettings);
    const workspace = path.join(
      process.env.SPELLBOOK_AI_WORKSPACE ?? "/tmp/spellbook-ai",
      "empty",
    );
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    // Image generation is a turn-scoped privilege, while App Server feature
    // flags are fixed when a thread starts. Never resume a normal thread for
    // an elevated image turn, and never replace the normal conversation with
    // the elevated thread afterwards.
    const elevatedImageThread = options?.allowImageGeneration === true;
    const resumeId =
      options?.threadId ??
      (!elevatedImageThread && options?.conversationKey
        ? this.conversationThreads.get(options.conversationKey)
        : undefined);
    const thread = await this.request<{ thread: { id: string } }>(
      resumeId ? "thread/resume" : "thread/start",
      {
        ...(resumeId ? { threadId: resumeId } : {}),
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        personality: "pragmatic",
        ephemeral: !options,
        ...(options
          ? {
              dynamicTools: options.tools,
              environments: [],
              config: {
                "features.shell_tool": false,
                "features.unified_exec": false,
                "features.multi_agent": false,
                "features.code_mode": false,
                "features.view_image": false,
                "features.image_generation":
                  options.allowImageGeneration === true,
                web_search: "disabled",
              },
              developerInstructions: [
                "You operate only through the supplied Spellbook tools. Do not use shell, filesystem, network, or other tools.",
                options.allowImageGeneration
                  ? "Built-in image generation is allowed only when the user explicitly asks to create a visual. Generated images remain editable picture objects after Spellbook inserts them."
                  : "Image generation is disabled for this turn.",
                "The current document and selection supplied by the host are authoritative; past messages are context, not current state or expanded authorization. Preserve native editability: never cover editable text, tables, charts or other objects with replacement shapes, text boxes or images to imitate an unsupported native edit. Use supported native operations; if a requested property cannot be edited, explain the limitation instead of constructing a visual imitation.",
              ].join(" "),
            }
          : {}),
        ...(options?.modelSettings?.model || process.env.SPELLBOOK_CODEX_MODEL
          ? {
              model:
                options?.modelSettings?.model ??
                process.env.SPELLBOOK_CODEX_MODEL,
            }
          : {}),
      },
    );
    const threadId = thread.thread.id;
    if (options?.conversationKey && !elevatedImageThread)
      this.conversationThreads.set(options.conversationKey, threadId);
    options?.onThread?.(threadId);
    const abort = new AbortController();
    let finalMessage = "";
    let turnId = "";
    let timedOut = false;
    const generatedImages: Promise<void>[] = [];
    const interrupt = () => {
      if (turnId)
        void this.request("turn/interrupt", { threadId, turnId }).catch(
          () => undefined,
        );
    };

    return new Promise<string>((resolve, reject) => {
      const cancel = () => {
        timedOut = true;
        cleanup();
        interrupt();
        reject(new Error("Codex turn interrupted."));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        cleanup();
        interrupt();
        reject(new Error("Codex turn timed out."));
      }, timeoutMs);
      const onNotification = (notification: RpcNotification) => {
        const params = notification.params as
          | Record<string, unknown>
          | undefined;
        if (params?.threadId !== threadId) return;
        if (turnId && params.turnId && params.turnId !== turnId) return;
        options?.onEvent?.(notification);
        if (notification.method === "item/completed") {
          if (turnId && params.turnId !== turnId) return;
          const item = params?.item as Record<string, unknown> | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            finalMessage = item.text;
          }
          if (
            item?.type === "imageGeneration" &&
            item.status === "completed" &&
            typeof item.result === "string" &&
            options?.allowImageGeneration &&
            options.onGeneratedImage
          ) {
            const generated = decodeGeneratedImage(item);
            const insertion = Promise.resolve(
              options.onGeneratedImage(generated),
            );
            generatedImages.push(insertion);
            // Image insertion can fail before Codex emits turn/completed.
            // Observe the rejection immediately so Node does not terminate the
            // connector; Promise.all below still propagates it to this turn.
            void insertion.catch(() => undefined);
          }
        }
        if (notification.method === "turn/completed") {
          const completed = params?.turn as Record<string, unknown> | undefined;
          if (!completed || (turnId && completed.id !== turnId)) {
            return;
          }
          cleanup();
          if (completed.status !== "completed") {
            const turnError = completed.error as
              | Record<string, unknown>
              | undefined;
            const detail =
              typeof turnError?.message === "string"
                ? ` ${turnError.message}`
                : "";
            reject(
              new Error(
                `Codex turn ${String(completed.status ?? "failed")}.${detail}`,
              ),
            );
            return;
          }
          const finalItems = Array.isArray(completed.items)
            ? completed.items
            : [];
          const summary = [...finalItems]
            .reverse()
            .find(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).type === "agentMessage",
            ) as Record<string, unknown> | undefined;
          const text =
            typeof summary?.text === "string" ? summary.text : finalMessage;
          if (!text && generatedImages.length === 0) {
            reject(
              new Error("Codex completed without a final structured message."),
            );
            return;
          }
          void Promise.all(generatedImages).then(
            () => resolve(text || "이미지를 생성했습니다."),
            (error) =>
              reject(error instanceof Error ? error : new Error(String(error))),
          );
        }
      };
      const cleanup = () => {
        abort.abort();
        this.toolHandlers.delete(threadId);
        options?.signal?.removeEventListener("abort", cancel);
        clearTimeout(timer);
        this.events.off("notification", onNotification);
        this.events.off("exit", onExit);
      };
      const onExit = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.events.on("notification", onNotification);
      this.events.on("exit", onExit);
      if (options) {
        this.toolHandlers.set(threadId, async (params) => {
          if (abort.signal.aborted || (turnId && params.turnId !== turnId))
            throw new Error("Inactive tool turn.");
          if (
            typeof params.tool !== "string" ||
            !options.tools.some((tool) => tool.name === params.tool) ||
            typeof params.callId !== "string"
          )
            throw new Error("Unknown tool.");
          return options.onTool(
            params.tool,
            params.arguments,
            params.callId,
            abort.signal,
          );
        });
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) {
          cancel();
          return;
        }
      }
      void this.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        ...(options?.modelSettings
          ? { model: options.modelSettings.model }
          : {}),
        effort: options?.modelSettings?.effort ?? "medium",
        summary: "concise",
        ...(Object.keys(outputSchema).length ? { outputSchema } : {}),
      })
        .then((result) => {
          turnId = result.turn.id;
          if (timedOut) interrupt();
          else
            options?.onTurn?.(async (text) => {
              if (abort.signal.aborted) throw new Error("Inactive turn.");
              await this.request("turn/steer", {
                threadId,
                expectedTurnId: turnId,
                input: [{ type: "text", text }],
              });
            });
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  onNotification(
    listener: (notification: RpcNotification) => void,
  ): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  close(): void {
    this.process.kill("SIGTERM");
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestId;
    const message =
      params === undefined ? { method, id } : { method, id, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}.`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process.stdin.write(
      `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`,
    );
  }

  private handleLine(line: string): void {
    let message:
      | RpcResponse
      | RpcNotification
      | (RpcNotification & { id: number });
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (
      "id" in message &&
      typeof message.id === "number" &&
      !("method" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ??
              `Codex RPC ${message.error.code ?? "error"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      "id" in message &&
      (typeof message.id === "number" || typeof message.id === "string") &&
      "method" in message
    ) {
      const params = message.params as Record<string, unknown> | undefined;
      const handler =
        typeof params?.threadId === "string"
          ? this.toolHandlers.get(params.threadId)
          : undefined;
      if (message.method === "item/tool/call" && handler && params) {
        const id = message.id;
        void handler(params).then(
          (result) =>
            this.process.stdin.write(`${JSON.stringify({ id, result })}\n`),
          () =>
            this.process.stdin.write(
              `${JSON.stringify({ id, result: { success: false, contentItems: [{ type: "inputText", text: "Tool execution failed or this turn is no longer active. Do not claim success." }] } })}\n`,
            ),
        );
        return;
      }
      this.process.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Client tool calls are disabled." } })}\n`,
      );
      return;
    }
    if ("method" in message) {
      this.events.emit("notification", message);
    }
  }
}

export function resolveCodexBinary(
  configured = process.env.CODEX_BIN?.trim(),
): string {
  if (configured) return configured;
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  return path.join(packageRoot, "node_modules", ".bin", "codex");
}

function decodeGeneratedImage(item: Record<string, unknown>): GeneratedImage {
  const result = String(item.result);
  const encoded = result.startsWith("data:")
    ? result.slice(result.indexOf(",") + 1)
    : result;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 12_000_000)
    throw new Error("Generated image has an invalid size.");
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) throw new Error("Generated image format is unsupported.");
  return {
    bytes,
    mediaType: png ? "image/png" : "image/jpeg",
    ...(typeof item.revisedPrompt === "string"
      ? { revisedPrompt: item.revisedPrompt }
      : {}),
    ...(typeof item.transparentBackground === "boolean"
      ? { transparentBackground: item.transparentBackground }
      : {}),
  };
}
