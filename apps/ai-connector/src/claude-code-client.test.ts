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
    expect(isClaudeModel("gpt-5.6-sol")).toBe(false);
  });
});
