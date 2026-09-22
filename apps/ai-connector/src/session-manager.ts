import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppServerClient, type AgentTurnClient } from "./app-server-client.js";
import { PiAgentClient } from "./pi-agent-client.js";
import { activeAiRuntime } from "./ai-runtime-contract.js";
import { ClaudeCodeClient, isClaudeModel } from "./claude-code-client.js";
import type { ModelSettings } from "../../../contracts/ai-models.js";
import type { AvailableModel } from "./types.js";

interface ManagedSession {
  client: AppServerClient;
  home: string;
  email: string;
  isolated: boolean;
}

const CONNECTED_AT_FILE = "spellbook-connected-at";

/**
 * When a subscription was connected through this service. Written the first
 * time a login started here is seen connected; an account that was already
 * connected has no known date and reports null rather than a guess.
 */
export async function trackConnectedAt(
  home: string,
  connected: boolean,
  loginStarted: boolean,
  now = new Date(),
): Promise<string | null> {
  const file = path.join(home, CONNECTED_AT_FILE);
  if (!connected) {
    await fs.rm(file, { force: true });
    return null;
  }
  const stored = await fs.readFile(file, "utf8").then(
    (value) => value.trim(),
    () => "",
  );
  if (stored && !Number.isNaN(Date.parse(stored))) return stored;
  if (!loginStarted) return null;
  const value = now.toISOString();
  await fs.writeFile(file, `${value}\n`, { mode: 0o600 });
  return value;
}

export class SessionManager {
  private readonly sessions = new Map<string, Promise<ManagedSession>>();
  private readonly claude = new ClaudeCodeClient();
  private readonly loginsStarted = new Set<string>();

  async status(rawEmail: string): Promise<{
    account: unknown;
    providers: Array<{ id: "codex" | "claude_code"; connected: boolean }>;
    rateLimits: unknown;
    runtime: typeof activeAiRuntime;
    connectedAt: string | null;
  }> {
    const session = await this.get(rawEmail);
    const codex = await session.client.accountRead();
    const claude = await this.claude.accountRead().catch(() => ({
      account: null,
      requiresClaudeAuth: true,
    }));
    let rateLimits: unknown = null;
    if (codex.account?.type === "chatgpt") {
      try {
        rateLimits = await session.client.rateLimitsRead();
      } catch {
        rateLimits = null;
      }
    }
    const codexConnected = codex.account?.type === "chatgpt";
    // Only isolated homes belong to this service; a shared ~/.codex is the
    // person's own and gets no marker file.
    const connectedAt = session.isolated
      ? await trackConnectedAt(
          session.home,
          codexConnected,
          this.loginsStarted.has(session.email),
        ).catch(() => null)
      : null;
    if (codexConnected) this.loginsStarted.delete(session.email);
    return {
      account: codex.account ? codex : claude,
      providers: [
        { id: "codex", connected: codexConnected },
        { id: "claude_code", connected: claude.account?.type === "claude" },
      ],
      rateLimits,
      runtime: activeAiRuntime,
      connectedAt,
    };
  }

  async startLogin(rawEmail: string): Promise<unknown> {
    const session = await this.get(rawEmail);
    this.loginsStarted.add(session.email);
    return session.client.startDeviceLogin();
  }

  async startBrowserLogin(rawEmail: string): Promise<unknown> {
    const session = await this.get(rawEmail);
    this.loginsStarted.add(session.email);
    return session.client.startBrowserLogin();
  }

  async logout(rawEmail: string): Promise<void> {
    const session = await this.get(rawEmail);
    await session.client.logout();
    this.loginsStarted.delete(session.email);
    if (session.isolated)
      await fs.rm(path.join(session.home, CONNECTED_AT_FILE), { force: true });
  }

  async models(rawEmail: string): Promise<AvailableModel[]> {
    const session = await this.get(rawEmail);
    const models: AvailableModel[] = [];
    const codex = await session.client.accountRead();
    if (codex.account?.type === "chatgpt")
      models.push(...(await session.client.models()));
    const claude = await this.claude.accountRead().catch(() => ({
      account: null,
      requiresClaudeAuth: true,
    }));
    if (claude.account?.type === "claude")
      models.push(...(await this.claude.models()));
    if (models.length === 0)
      throw new Error("No supported AI subscription is connected.");
    return models;
  }

  async client(
    rawEmail: string,
    modelSettings?: ModelSettings,
    apiKey?: string,
  ): Promise<AgentTurnClient> {
    if (modelSettings?.provider === "openai_api") {
      return new PiAgentClient(apiKey || "", "openai_api");
    }
    if (modelSettings?.provider === "openrouter_api") {
      return new PiAgentClient(apiKey || "", "openrouter_api");
    }
    if (modelSettings?.provider === "custom_api") {
      return new PiAgentClient(apiKey || "", "custom_api", modelSettings.customBaseUrl);
    }
    if (modelSettings?.provider === "anthropic_api") {
      return new PiAgentClient(apiKey || "", "anthropic_api");
    }
    if (modelSettings?.provider === "gemini_api") {
      return new PiAgentClient(apiKey || "", "gemini_api");
    }
    if (selectedProvider(modelSettings) === "claude_code") {
      if ((await this.claude.accountRead()).account?.type !== "claude")
        throw new Error("Claude subscription is not connected in Claude Code.");
      return this.claude;
    }
    const session = await this.get(rawEmail);
    const status = await session.client.accountRead();
    if (status.account?.type !== "chatgpt")
      throw new Error("ChatGPT subscription is not connected.");
    return session.client;
  }

  private async get(rawEmail: string): Promise<ManagedSession> {
    const email = normalizeEmail(rawEmail);
    if (!isAllowedAiIdentity(email))
      throw new Error("This local account cannot connect an AI subscription.");
    const existing = this.sessions.get(email);
    if (existing) {
      const session = await existing;
      if (session.client.isRunning) return session;
      if (this.sessions.get(email) !== existing) return this.get(email);
      this.sessions.delete(email);
    }
    const created = this.create(email);
    this.sessions.set(email, created);
    try {
      return await created;
    } catch (error) {
      this.sessions.delete(email);
      throw error;
    }
  }

  private async create(email: string): Promise<ManagedSession> {
    const location = codexSessionLocation(email);
    const home = location.home;
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    if (location.isolated) await fs.chmod(home, 0o700);
    return {
      client: await AppServerClient.start(home, {
        createRestrictedConfig: location.isolated,
        processHome: location.processHome,
      }),
      home,
      email,
      isolated: location.isolated,
    };
  }
}

export function selectedProvider(
  modelSettings?: ModelSettings,
): "codex" | "claude_code" {
  return modelSettings?.provider === "claude_code" ||
    (!modelSettings?.provider && isClaudeModel(modelSettings?.model))
    ? "claude_code"
    : "codex";
}

export function codexSessionLocation(email: string): {
  home: string;
  processHome: string;
  isolated: boolean;
} {
  const processHome = os.homedir();
  const mode =
    process.env.SPELLBOOK_CODEX_AUTH_MODE?.trim() ||
    (process.env.SPELLBOOK_CONNECTOR_MODE === "local" ? "shared" : "isolated");
  if (mode !== "shared" && mode !== "isolated")
    throw new Error("invalid_spellbook_codex_auth_mode");
  if (mode === "shared") {
    const home = path.resolve(
      process.env.CODEX_HOME?.trim() || path.join(processHome, ".codex"),
    );
    return { home, processHome, isolated: false };
  }
  const base = path.resolve(
    process.env.SPELLBOOK_CODEX_AUTH_DIR?.trim() || ".spellbook/ai-auth",
  );
  const home = path.join(base, stableIdentityKey(email));
  return { home, processHome: home, isolated: true };
}

export function isAllowedAiIdentity(email: string): boolean {
  const allowed = process.env.SPELLBOOK_LOCAL_EMAIL?.trim().toLowerCase();
  return Boolean(allowed && normalizeEmail(email) === allowed);
}

export function stableIdentityKey(value: string): string {
  return createHash("sha256")
    .update(normalizeEmail(value))
    .digest("hex")
    .slice(0, 20);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
