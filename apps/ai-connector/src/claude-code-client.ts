import { randomBytes, randomUUID } from "node:crypto";
import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ModelSettings } from "../../../contracts/ai-models.js";
import type { AvailableModel } from "./types.js";
import type {
  AgentTurnClient,
  AgentTurnOptions,
  ToolResult,
} from "./app-server-client.js";

const execFileAsync = promisify(execFile);
const claudeModels: AvailableModel[] = [
  model("sonnet", "Claude Sonnet", true),
  model("opus", "Claude Opus"),
  model("haiku", "Claude Haiku"),
];

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
}

interface ClaudeStreamResult {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  error?: string;
}

interface ToolServer {
  url: string;
  authorization: string;
  close(): Promise<void>;
}

export class ClaudeCodeClient implements AgentTurnClient {
  readonly supportsImageGeneration = false;
  private readonly conversationSessions = new Map<string, string>();
  private loginProcess: ChildProcess | null = null;

  constructor(private readonly binary = resolveClaudeBinary()) {}

  async accountRead(): Promise<{
    account: null | {
      type: "claude";
      email: string | null;
      planType: string | null;
    };
    requiresClaudeAuth: boolean;
  }> {
    const status = await readClaudeAuthStatus(this.binary);
    return {
      account: status.loggedIn
        ? {
            type: "claude",
            email: status.email ?? null,
            planType: status.subscriptionType ?? null,
          }
        : null,
      requiresClaudeAuth: !status.loggedIn,
    };
  }

  async startBrowserLogin(): Promise<{ status: "started" | "pending" }> {
    if (this.loginProcess && this.loginProcess.exitCode === null)
      return { status: "pending" };
    const child = spawn(this.binary, ["auth", "login", "--claudeai"], {
      env: restrictedClaudeEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
    this.loginProcess = child;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      if (this.loginProcess === child) this.loginProcess = null;
      throw error;
    }
    const timeout = setTimeout(() => child.kill(), 5 * 60_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      if (this.loginProcess === child) this.loginProcess = null;
    });
    child.unref();
    return { status: "started" };
  }

  async models(): Promise<AvailableModel[]> {
    return structuredClone(claudeModels);
  }

  async validateModelSettings(settings: ModelSettings): Promise<void> {
    const selected = claudeModels.find((item) => item.model === settings.model);
    if (
      !selected?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === settings.effort,
      )
    )
      throw new Error(
        "Selected Claude model or effort is unavailable. Refresh the model list.",
      );
  }

  async runStructuredTurn(
    input: Array<Record<string, unknown>>,
    outputSchema: Record<string, unknown>,
    timeoutMs = 300_000,
    options?: AgentTurnOptions,
  ): Promise<string> {
    if (options?.allowImageGeneration)
      throw new Error("Claude Code does not expose native image generation.");
    if (options?.modelSettings)
      await this.validateModelSettings(options.modelSettings);
    const prompt = input
      .map((item) => {
        if (item.type !== "text" || typeof item.text !== "string")
          throw new Error(
            "Claude Code receives slide images only through Spellbook observation tools.",
          );
        return item.text;
      })
      .join("\n");
    const toolServer = options?.tools.length
      ? await createToolServer(options)
      : null;
    const sessionId =
      options?.threadId ??
      (options?.conversationKey
        ? this.conversationSessions.get(options.conversationKey)
        : undefined) ??
      randomUUID();
    const resume =
      Boolean(options?.threadId) ||
      Boolean(
        options?.conversationKey &&
          this.conversationSessions.has(options.conversationKey),
      );
    const args = claudeTurnArguments({
      modelSettings: options?.modelSettings,
      outputSchema,
      resume,
      sessionId,
      toolServer,
      toolNames: options?.tools.map((tool) => tool.name) ?? [],
    });
    const workspace =
      process.env.SPELLBOOK_AI_WORKSPACE ?? "/tmp/spellbook-ai/empty";
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    const child = spawn(this.binary, args, {
      cwd: workspace,
      env: restrictedClaudeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const text = await runClaudeProcess(
        child,
        prompt,
        sessionId,
        timeoutMs,
        options?.tools.map((tool) => tool.name) ?? [],
        options,
      );
      if (options?.conversationKey)
        this.conversationSessions.set(options.conversationKey, sessionId);
      return text;
    } finally {
      await toolServer?.close();
    }
  }
}

export function isClaudeModel(modelName: string | undefined): boolean {
  return claudeModels.some((model) => model.model === modelName);
}

export async function readClaudeAuthStatus(
  binary = resolveClaudeBinary(),
): Promise<ClaudeAuthStatus> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(binary, ["auth", "status", "--json"], {
      env: restrictedClaudeEnvironment(),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    const failed = error as { stdout?: string };
    if (typeof failed.stdout !== "string" || !failed.stdout.trim()) throw error;
    stdout = failed.stdout;
  }
  const value = JSON.parse(stdout) as ClaudeAuthStatus;
  if (typeof value.loggedIn !== "boolean")
    throw new Error("Claude Code returned an invalid authentication status.");
  return value;
}

export function resolveClaudeBinary(
  configured = process.env.CLAUDE_BIN?.trim(),
  exists: (file: string) => boolean = existsSync,
): string {
  if (configured) return configured;
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    path.join(os.homedir(), ".local", "bin", executable),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
      : []),
  ];
  return candidates.find(exists) ?? executable;
}

export function claudeTurnArguments(input: {
  modelSettings?: ModelSettings;
  outputSchema: Record<string, unknown>;
  resume: boolean;
  sessionId: string;
  toolServer: Pick<ToolServer, "url" | "authorization"> | null;
  toolNames: string[];
}): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--system-prompt",
    "You are the AI runtime inside Spellbook. Use only the explicitly supplied Spellbook MCP tools. Never use shell, filesystem, browser, code-editing, plugin, skill, hook, subagent, remote-control, or external MCP capabilities. The live document observation and host permission are authoritative.",
  ];
  if (input.resume) args.push("--resume", input.sessionId);
  else args.push("--session-id", input.sessionId);
  if (input.modelSettings)
    args.push(
      "--model",
      input.modelSettings.model,
      "--effort",
      input.modelSettings.effort,
    );
  if (Object.keys(input.outputSchema).length)
    args.push("--json-schema", JSON.stringify(input.outputSchema));
  if (input.toolServer) {
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          spellbook: {
            type: "http",
            url: input.toolServer.url,
            headers: { Authorization: input.toolServer.authorization },
          },
        },
      }),
      "--allowedTools",
      input.toolNames.map((name) => `mcp__spellbook__${name}`).join(","),
    );
  }
  return args;
}

function restrictedClaudeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  };
}

async function runClaudeProcess(
  child: ChildProcessWithoutNullStreams,
  prompt: string,
  sessionId: string,
  timeoutMs: number,
  expectedTools: string[],
  options?: AgentTurnOptions,
): Promise<string> {
  let diagnostics = "";
  let output = "";
  let settled = false;
  let buffer = "";
  const abort = () => child.kill("SIGTERM");
  options?.signal?.addEventListener("abort", abort, { once: true });
  options?.onTurn?.(async (text) => {
    if (settled || child.stdin.destroyed) throw new Error("Inactive turn.");
    child.stdin.write(`${userMessage(text)}\n`);
  });
  options?.onThread?.(sessionId);
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-16_000);
  });
  child.stdin.write(`${userMessage(prompt)}\n`);
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
      if (!child.stdin.destroyed) child.stdin.end();
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      abort();
      finish(new Error("Claude Code turn timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(line) as Record<string, any>;
        } catch {
          continue;
        }
        if (
          process.env.SPELLBOOK_CLAUDE_TRACE === "1" &&
          event.type === "system" &&
          event.subtype === "init"
        )
          process.stderr.write(`${line}\n`);
        if (event.type === "system" && event.subtype === "init") {
          const servers = Array.isArray(event.mcp_servers)
            ? event.mcp_servers
            : [];
          const tools = Array.isArray(event.tools) ? event.tools : [];
          if (
            expectedTools.length > 0 &&
            (!servers.some(
              (server) =>
                server?.name === "spellbook" && server?.status === "connected",
            ) ||
              expectedTools.some(
                (name) => !tools.includes(`mcp__spellbook__${name}`),
              ))
          ) {
            abort();
            finish(
              new Error(
                "Claude Code could not connect to the isolated Spellbook document tools.",
              ),
            );
            return;
          }
        }
        const delta = event.event?.delta;
        if (
          event.type === "stream_event" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          options?.onEvent?.({
            method: "item/agentMessage/delta",
            params: { delta: delta.text },
          });
        }
        if (event.type === "result") {
          const result = event as ClaudeStreamResult;
          if (
            result.subtype !== "success" ||
            result.is_error ||
            typeof result.result !== "string"
          ) {
            finish(
              new Error(result.error || `Claude Code turn ${result.subtype}.`),
            );
            return;
          }
          output = result.result;
          finish();
          return;
        }
      }
    });
    child.on("error", () =>
      finish(new Error("Claude Code subscription process could not start.")),
    );
    child.on("exit", (code) => {
      if (!settled)
        finish(
          new Error(
            `Claude Code subscription process exited with code ${code}.${diagnostics ? ` ${diagnostics}` : ""}`,
          ),
        );
    });
    if (options?.signal?.aborted) {
      abort();
      finish(new Error("Claude Code turn interrupted."));
    }
  });
}

async function createToolServer(
  options: AgentTurnOptions,
): Promise<ToolServer> {
  const authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const server = new Server(
    { name: "spellbook-document-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = options.tools.find(
      (candidate) => candidate.name === request.params.name,
    );
    if (!tool)
      return {
        isError: true,
        content: [{ type: "text", text: "Unknown tool." }],
      };
    const result = await options.onTool(
      tool.name,
      request.params.arguments ?? {},
      randomUUID(),
      controller.signal,
    );
    return mcpToolResult(result);
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  let expectedHost = "";
  const httpServer = http.createServer((request, response) => {
    if (process.env.SPELLBOOK_CLAUDE_TRACE === "1")
      process.stderr.write(
        `spellbook-mcp ${request.method} ${request.url} host=${request.headers.host ?? ""} auth=${request.headers.authorization === authorization ? "valid" : "invalid"}\n`,
      );
    if (process.env.SPELLBOOK_CLAUDE_TRACE === "1")
      response.once("finish", () =>
        process.stderr.write(`spellbook-mcp status=${response.statusCode}\n`),
      );
    if (
      request.url !== "/mcp" ||
      request.headers.host !== expectedHost ||
      request.headers.authorization !== authorization
    ) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"forbidden"}');
      return;
    }
    void transport.handleRequest(request, response).catch((error) => {
      if (process.env.SPELLBOOK_CLAUDE_TRACE === "1")
        process.stderr.write(
          `spellbook-mcp error=${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("Spellbook Claude tool server could not bind locally.");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    async close() {
      controller.abort();
      await transport.close();
      await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function mcpToolResult(result: ToolResult) {
  return {
    isError: !result.success,
    content: result.contentItems.map((item) => {
      if (item.type === "inputText")
        return { type: "text" as const, text: item.text };
      const match =
        /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/u.exec(
          item.imageUrl,
        );
      if (!match)
        return {
          type: "text" as const,
          text: "Invalid Spellbook image evidence.",
        };
      return { type: "image" as const, mimeType: match[1], data: match[2] };
    }),
  };
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

function model(
  name: string,
  displayName: string,
  isDefault = false,
): AvailableModel {
  return {
    provider: "claude_code",
    model: name,
    displayName,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map(
      (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
    ),
    isDefault,
  };
}
