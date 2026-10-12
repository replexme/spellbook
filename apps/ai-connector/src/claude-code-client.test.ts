import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeCodeClient,
  claudeModelsFromCatalog,
  claudeTurnArguments,
  isClaudeModel,
  readClaudeAuthStatus,
  resolveClaudeBinary,
  mcpToolResult,
  claudeToolEvidenceTruncated,
} from "./claude-code-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Claude Code subscription adapter", () => {
  it("rejects a provider success event when its document tool evidence was truncated", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "spellbook-claude-truncated-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "claude");
    const truncated = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "<persisted-output>Output too large",
          },
        ],
      },
    };
    const success = {
      type: "result",
      subtype: "success",
      result: "review complete",
    };
    writeFileSync(
      binary,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(truncated)}' '${JSON.stringify(success)}'\n`,
    );
    chmodSync(binary, 0o700);
    const client = new ClaudeCodeClient(binary);
    await expect(
      client.runStructuredTurn([{ type: "text", text: "review" }], {}, 1000),
    ).rejects.toThrow("화면 검토는 완료되지 않았습니다");
  });
  it("refuses a completed visual review after Claude persisted or truncated document evidence", () => {
    const event = (content: unknown) => ({
      message: { content: [{ type: "tool_result", content }] },
    });
    expect(
      claudeToolEvidenceTruncated(event("<persisted-output>Output too large")),
    ).toBe(true);
    expect(
      claudeToolEvidenceTruncated(
        event([
          { type: "image", data: "png" },
          {
            type: "text",
            text: "\n\n[OUTPUT TRUNCATED - exceeded 25000 token limit]",
          },
        ]),
      ),
    ).toBe(true);
    expect(
      claudeToolEvidenceTruncated(
        event([
          {
            type: "text",
            text: '{"title":"OUTPUT TRUNCATED quoted authored text"}',
          },
        ]),
      ),
    ).toBe(false);
    expect(
      claudeToolEvidenceTruncated(
        event([
          { type: "image", data: "png" },
          { type: "text", text: "complete document evidence" },
        ]),
      ),
    ).toBe(false);
  });
  it("delivers screenshot blocks before document text without losing either", () => {
    const result = mcpToolResult({
      success: true,
      contentItems: [
        { type: "inputText", text: "large document structure" },
        { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    });
    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "text", text: "large document structure" },
    ]);
  });
  it("uses only the isolated Spellbook MCP tools", () => {
    const args = claudeTurnArguments({
      modelSettings: { model: "sonnet", effort: "high" },
      outputSchema: {},
      resume: false,
      sessionId: "00000000-0000-4000-8000-000000000000",
      toolServer: {
        url: "http://127.0.0.1:43128/mcp",
        authorization: "Bearer test-only",
      },
      toolNames: ["native_observe", "native_edit", "native_review"],
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("dontAsk");
    expect(args).toContain("");
    expect(args).toContain(
      "mcp__spellbook__native_observe,mcp__spellbook__native_edit,mcp__spellbook__native_review",
    );
    expect(args.join(" ")).not.toMatch(/dangerously-skip|Bash|Read|Edit/u);
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(config.mcpServers.spellbook).toEqual({
      type: "http",
      url: "http://127.0.0.1:43128/mcp",
      headers: { Authorization: "Bearer test-only" },
    });
  });

  it("maps the provider-owned nonzero logged-out status", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "spellbook-claude-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "claude");
    writeFileSync(
      binary,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\'\nexit 1\n',
    );
    chmodSync(binary, 0o700);
    await expect(readClaudeAuthStatus(binary)).resolves.toEqual({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    });
  });

  it("uses an explicitly installed unmodified Claude Code binary", () => {
    expect(resolveClaudeBinary("/opt/homebrew/bin/claude")).toBe(
      "/opt/homebrew/bin/claude",
    );
  });

  it("starts the installed Claude Code subscription browser flow", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "spellbook-claude-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "claude");
    const marker = path.join(directory, "login-args");
    writeFileSync(binary, `#!/bin/sh\nprintf '%s' "$*" > '${marker}'\n`);
    chmodSync(binary, 0o700);
    const client = new ClaudeCodeClient(binary);
    const [first, second] = await Promise.all([
      client.startBrowserLogin(),
      client.startBrowserLogin(),
    ]);
    expect(first).toEqual({ status: "started" });
    expect(second).toEqual({ status: "pending" });
    await vi.waitFor(() =>
      expect(readFileSync(marker, "utf8")).toBe("auth login --claudeai"),
    );
  });

  it("finds a normal desktop install without depending on shell PATH", () => {
    expect(
      resolveClaudeBinary(undefined, (candidate) =>
        candidate.endsWith("/.local/bin/claude"),
      ),
    ).toMatch(/\.local\/bin\/claude$/u);
  });

  it("identifies only models owned by the Claude adapter", () => {
    expect(isClaudeModel("sonnet")).toBe(true);
    expect(isClaudeModel("fable")).toBe(true);
    expect(isClaudeModel("opus[1m]")).toBe(true);
    expect(isClaudeModel("claude-fable-5-1")).toBe(true);
    expect(isClaudeModel("gpt-5.6-sol")).toBe(false);
  });

  it("names Claude models as Claude Code lists them for the account", () => {
    // Claude Code 2.1.294 signed in with a subscription (2026-10-12).
    const subscription = claudeModelsFromCatalog([
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Sonnet 5.5 · Efficient for routine tasks",
      },
      {
        value: "opus",
        displayName: "Opus 5.5",
        description: "For complex work and everyday tasks",
      },
      {
        value: "fable",
        displayName: "Fable 5.1",
        description: "For your toughest challenges",
      },
      {
        value: "sonnet",
        displayName: "Sonnet 5.5",
        description: "Most efficient for simpler tasks",
      },
      {
        value: "haiku",
        displayName: "Haiku 5.5",
        description: "Fastest for quick answers",
      },
      {
        value: "claude-opus-4-8",
        displayName: "Opus 4.8",
        description: "Best for everyday, complex tasks",
      },
    ]);
    expect(
      subscription.map((m) => [m.model, m.displayName, m.isDefault]),
    ).toEqual([
      ["opus", "Claude Opus 5.5", false],
      ["fable", "Claude Fable 5.1", false],
      ["sonnet", "Claude Sonnet 5.5", true],
      ["haiku", "Claude Haiku 5.5", false],
    ]);
    // Claude Code 2.1.280 without a subscription: bare names, versions in the descriptions.
    const api = claudeModelsFromCatalog([
      {
        value: "default",
        displayName: "Default (recommended)",
        description:
          "Use the default model (currently Opus 5.5 (1M context)) · $4",
      },
      {
        value: "opus[1m]",
        displayName: "Opus (1M context)",
        description:
          "Opus 5.5 with 1M context · Best for everyday, complex tasks",
      },
      {
        value: "claude-fable-5-1",
        displayName: "Fable",
        description: "Fable 5.1 · Most capable",
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    ]);
    expect(api.map((m) => [m.model, m.displayName, m.isDefault])).toEqual([
      ["opus[1m]", "Claude Opus 5.5 with 1M context", true],
      ["claude-fable-5-1", "Claude Fable 5.1", false],
      ["sonnet", "Claude Sonnet 5", false],
      ["haiku", "Claude Haiku 4.5", false],
    ]);
    expect(claudeModelsFromCatalog([])).toEqual([]);
  });

  it("asks the installed Claude Code for its models and falls back when it cannot", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "spellbook-claude-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "claude");
    writeFileSync(
      binary,
      `#!/bin/sh\nread line\nprintf '%s\\n' '{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":[{"value":"sonnet","displayName":"Sonnet 5.5","description":"x"}]}}}'\n`,
    );
    chmodSync(binary, 0o700);
    expect(
      (await new ClaudeCodeClient(binary).models()).map((m) => m.displayName),
    ).toEqual(["Claude Sonnet 5.5"]);
    const missing = path.join(directory, "missing-claude");
    expect(
      (await new ClaudeCodeClient(missing).models()).map((m) => m.model),
    ).toEqual(["sonnet", "opus", "haiku"]);
  });
});
