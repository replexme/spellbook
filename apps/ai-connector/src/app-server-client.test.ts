import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { AppServerClient, resolveCodexBinary } from "./app-server-client.js";

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    await fs.rm(home, { recursive: true, force: true });
});

async function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
  const calls: Array<{
    id: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  let thread = 0;
  const send = (message: unknown) =>
    child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(String(chunk));
    calls.push(message);
    if (message.method === "initialize") send({ id: message.id, result: {} });
    if (message.method === "model/list")
      send({
        id: message.id,
        result: {
          data: [
            {
              model: "account-model",
              displayName: "Account Model",
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "Deep" },
              ],
              inputModalities: ["text", "image"],
            },
            {
              model: "gpt-6-astra",
              displayName: "GPT-6 Astra",
              isDefault: false,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "Deep" },
              ],
              inputModalities: ["text", "image"],
            },
            {
              model: "text-only",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              inputModalities: ["text"],
            },
            {
              model: "hidden",
              hidden: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            },
          ],
          nextCursor: null,
        },
      });
    if (message.method === "modelProvider/capabilities/read")
      send({
        id: message.id,
        result: {
          imageGeneration: true,
          namespaceTools: true,
          webSearch: true,
        },
      });
    if (message.method === "account/login/start")
      send({
        id: message.id,
        result:
          message.params.type === "chatgpt"
            ? {
                type: "chatgpt",
                loginId: "browser-login",
                authUrl: "https://auth.openai.test/browser",
              }
            : {
                type: "chatgptDeviceCode",
                loginId: "device-login",
                verificationUrl: "https://auth.openai.test/device",
                userCode: "ABCD-EFGH",
              },
      });
    if (message.method === "thread/start")
      send({
        id: message.id,
        result: { thread: { id: `thread-${++thread}` } },
      });
    if (message.method === "thread/resume")
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId } },
      });
    if (message.method === "turn/start")
      send({
        id: message.id,
        result: { turn: { id: `turn-${message.params.threadId}` } },
      });
    if (message.method === "turn/interrupt" || message.method === "turn/steer")
      send({ id: message.id, result: {} });
  });
  mocks.spawn.mockReturnValue(child);
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "spellbook-app-server-test-"),
  );
  homes.push(home);
  const client = await AppServerClient.start(home);
  return { client, child, calls, send };
}

it("can reuse a standard Codex home without modifying its configuration", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "spellbook-shared-codex-test-"),
  );
  homes.push(home);
  const existingConfig = 'model = "user-choice"\n';
  await fs.writeFile(path.join(home, "config.toml"), existingConfig);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(String(chunk));
    if (message.method === "initialize")
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  mocks.spawn.mockReturnValue(child);

  const client = await AppServerClient.start(home, {
    createRestrictedConfig: false,
    processHome: "/Users/example",
  });
  expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(
    existingConfig,
  );
  expect(mocks.spawn).toHaveBeenLastCalledWith(
    expect.any(String),
    ["app-server", "--listen", "stdio://"],
    expect.objectContaining({
      env: expect.objectContaining({
        HOME: "/Users/example",
        CODEX_HOME: home,
      }),
    }),
  );
  client.close();
});

it("lets a packaged connector pin its bundled Codex executable", () => {
  expect(
    resolveCodexBinary(
      "/Applications/Spellbook AI Connector.app/Contents/Resources/codex/bin/codex",
    ),
  ).toBe(
    "/Applications/Spellbook AI Connector.app/Contents/Resources/codex/bin/codex",
  );
});

describe("structured turn isolation", () => {
  it("enables image generation only for a supported selected model and provider", async () => {
    const h = await harness();
    await expect(
      h.client.supportsImageGenerationForModel({
        model: "account-model",
        effort: "high",
      }),
    ).resolves.toBe(false);
    await expect(
      h.client.supportsImageGenerationForModel({
        model: "gpt-6-astra",
        effort: "high",
      }),
    ).resolves.toBe(true);
    await expect(
      h.client.runStructuredTurn([], {}, 2000, {
        tools: [],
        onTool: vi.fn(),
        modelSettings: { model: "account-model", effort: "high" },
        allowImageGeneration: true,
      }),
    ).rejects.toThrow("Selected model does not support image generation");
    expect(h.calls.some((call) => call.method === "thread/start")).toBe(false);
    vi.spyOn(h.client, "providerCapabilities").mockResolvedValue({
      imageGeneration: false,
      namespaceTools: true,
      webSearch: true,
    });
    await expect(
      h.client.supportsImageGenerationForModel({
        model: "gpt-6-astra",
        effort: "high",
      }),
    ).resolves.toBe(false);
    h.client.close();
  });

  it("starts standard browser login and keeps device code as an explicit fallback", async () => {
    const h = await harness();
    await expect(h.client.startBrowserLogin()).resolves.toMatchObject({
      type: "chatgpt",
      authUrl: "https://auth.openai.test/browser",
    });
    await expect(h.client.startDeviceLogin()).resolves.toMatchObject({
      type: "chatgptDeviceCode",
      userCode: "ABCD-EFGH",
    });
    expect(
      h.calls
        .filter((call) => call.method === "account/login/start")
        .map((call) => call.params.type),
    ).toEqual(["chatgpt", "chatgptDeviceCode"]);
    h.client.close();
  });

  it("reads provider image capability and returns a validated generated image", async () => {
    const h = await harness();
    await expect(h.client.providerCapabilities()).resolves.toMatchObject({
      imageGeneration: true,
    });
    const onGeneratedImage = vi.fn();
    const pending = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      modelSettings: { model: "gpt-6-astra", effort: "high" },
      allowImageGeneration: true,
      onGeneratedImage,
    });
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    expect(
      h.calls.find((call) => call.method === "thread/start")?.params.config,
    ).toMatchObject({ "features.image_generation": true });
    h.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-thread-1",
        item: {
          type: "imageGeneration",
          status: "completed",
          result: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
          revisedPrompt: "simple slide art",
        },
      },
    });
    h.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-thread-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "완료" }],
        },
      },
    });
    await expect(pending).resolves.toBe("완료");
    expect(onGeneratedImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: "image/png",
        revisedPrompt: "simple slide art",
      }),
    );
    h.client.close();
  });

  it("propagates an early generated-image insertion failure without an unhandled rejection", async () => {
    const h = await harness();
    const pending = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      modelSettings: { model: "gpt-6-astra", effort: "high" },
      allowImageGeneration: true,
      onGeneratedImage: vi.fn(async () => {
        throw new Error("generated_image_download_failed");
      }),
    });
    const rejected = expect(pending).rejects.toThrow(
      "generated_image_download_failed",
    );
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    h.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-thread-1",
        item: {
          type: "imageGeneration",
          status: "completed",
          result: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        },
      },
    });
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    h.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-thread-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "완료" }],
        },
      },
    });
    await rejected;
    expect(h.child.exitCode).toBeNull();
    h.client.close();
  });

  it("discovers account models and applies selected settings to both new and resumed turns", async () => {
    const h = await harness();
    expect((await h.client.models()).map((item) => item.model)).toEqual([
      "account-model",
      "gpt-6-astra",
    ]);
    await expect(
      h.client.validateModelSettings({ model: "account-model", effort: "max" }),
    ).rejects.toThrow("no longer available");
    for (let i = 0; i < 2; i++) {
      const pending = h.client.runStructuredTurn([], {}, 2000, {
        tools: [],
        onTool: vi.fn(),
        conversationKey: "same-document",
        modelSettings: { model: "account-model", effort: "high" },
      });
      await vi.waitFor(() =>
        expect(
          h.calls.filter((call) => call.method === "turn/start"),
        ).toHaveLength(i + 1),
      );
      expect(
        h.calls
          .filter(
            (call) => call.method === (i ? "thread/resume" : "thread/start"),
          )
          .at(-1)?.params.model,
      ).toBe("account-model");
      expect(
        h.calls.filter((call) => call.method === "turn/start").at(-1)?.params,
      ).toMatchObject({
        model: "account-model",
        effort: "high",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      h.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-thread-1",
            status: "completed",
            items: [{ type: "agentMessage", text: "done" }],
          },
        },
      });
      await expect(pending).resolves.toBe("done");
    }
    h.client.close();
  });
  it("isolates image generation in a fresh elevated thread without replacing the normal conversation", async () => {
    const h = await harness();
    const completeLatest = async (expectedThread: string) => {
      await vi.waitFor(() =>
        expect(
          h.calls.filter((call) => call.method === "turn/start").at(-1)?.params
            .threadId,
        ).toBe(expectedThread),
      );
      h.send({
        method: "turn/completed",
        params: {
          threadId: expectedThread,
          turn: {
            id: `turn-${expectedThread}`,
            status: "completed",
            items: [{ type: "agentMessage", text: "done" }],
          },
        },
      });
    };

    const normal = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      conversationKey: "same-document",
    });
    await completeLatest("thread-1");
    await normal;

    const elevated = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      conversationKey: "same-document",
      modelSettings: { model: "gpt-6-astra", effort: "high" },
      allowImageGeneration: true,
      onGeneratedImage: vi.fn(),
    });
    await completeLatest("thread-2");
    await elevated;
    expect(
      h.calls.filter((call) => call.method === "thread/start").at(-1)?.params
        .config,
    ).toMatchObject({ "features.image_generation": true });

    const resumed = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      conversationKey: "same-document",
    });
    await vi.waitFor(() =>
      expect(
        h.calls.filter((call) => call.method === "thread/resume").at(-1)?.params
          .threadId,
      ).toBe("thread-1"),
    );
    h.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-thread-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "resumed" }],
        },
      },
    });
    await expect(resumed).resolves.toBe("resumed");
    h.client.close();
  });
  it("steers only the active turn and rejects input after completion", async () => {
    const h = await harness();
    let steer: ((text: string) => Promise<void>) | undefined;
    const pending = h.client.runStructuredTurn([], {}, 2000, {
      tools: [],
      onTool: vi.fn(),
      onTurn: (send) => {
        steer = send;
      },
    });
    await vi.waitFor(() => expect(steer).toBeDefined());
    expect(
      h.calls.find((call) => call.method === "thread/start")?.params
        .developerInstructions,
    ).toContain("Preserve native editability");
    await steer!("색은 유지해줘");
    expect(
      h.calls.find((call) => call.method === "turn/steer")?.params,
    ).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-thread-1",
      input: [{ type: "text", text: "색은 유지해줘" }],
    });
    h.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-thread-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "완료" }],
        },
      },
    });
    await expect(pending).resolves.toBe("완료");
    await expect(steer!("추가 수정")).rejects.toThrow("Inactive turn");
    h.client.close();
  });
  it("routes dynamic tools only to their active thread and rejects late calls", async () => {
    const h = await harness();
    const tool = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "observed" }],
    }));
    const pending = h.client.runStructuredTurn([], {}, 1000, {
      tools: [
        {
          type: "function",
          name: "spellbook_observe",
          description: "observe",
          inputSchema: {},
        },
      ],
      onTool: tool,
    });
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    h.send({
      id: "foreign-call",
      method: "item/tool/call",
      params: {
        threadId: "foreign",
        turnId: "turn-thread-1",
        tool: "spellbook_observe",
        arguments: {},
        callId: "c0",
      },
    });
    expect(tool).not.toHaveBeenCalled();
    h.send({
      id: "real-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-thread-1",
        tool: "spellbook_observe",
        arguments: {},
        callId: "c1",
      },
    });
    await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
    h.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-thread-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "done" }],
        },
      },
    });
    await expect(pending).resolves.toBe("done");
    h.send({
      id: "late-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-thread-1",
        tool: "spellbook_observe",
        arguments: {},
        callId: "c2",
      },
    });
    expect(tool).toHaveBeenCalledTimes(1);
    h.client.close();
  });
  it("abort interrupts the turn and revokes pending tool authority", async () => {
    const h = await harness();
    const abort = new AbortController();
    const pending = h.client.runStructuredTurn([], {}, 10000, {
      tools: [],
      onTool: vi.fn(),
      signal: abort.signal,
    });
    const assertion = expect(pending).rejects.toThrow("interrupted");
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    abort.abort();
    await assertion;
    expect(h.calls.some((call) => call.method === "turn/interrupt")).toBe(true);
    h.client.close();
  });
  it("reports a dead subscription process so the manager can recreate it", async () => {
    const h = await harness();
    expect(h.client.isRunning).toBe(true);
    h.child.emit("exit", 1);
    expect(h.client.isRunning).toBe(false);
  });
  it("keeps simultaneous messages scoped to their thread and turn", async () => {
    const h = await harness();
    const first = h.client.runStructuredTurn(
      [{ type: "text", text: "first" }],
      {},
    );
    const second = h.client.runStructuredTurn(
      [{ type: "text", text: "second" }],
      {},
    );
    await vi.waitFor(() =>
      expect(h.calls.filter((c) => c.method === "turn/start")).toHaveLength(2),
    );
    // mkdir before thread/start is asynchronous. Invocation order does not
    // determine thread allocation order; identify each request by its input.
    const threadFor = (text: string) =>
      h.calls.find(
        (call) =>
          call.method === "turn/start" &&
          (call.params.input as Array<{ text: string }>)[0]?.text === text,
      )!.params.threadId as string;
    const firstThread = threadFor("first");
    const secondThread = threadFor("second");
    expect(firstThread).not.toBe(secondThread);
    const message = (
      threadId: string,
      text: string,
      turnId = `turn-${threadId}`,
    ) =>
      h.send({
        method: "item/completed",
        params: { threadId, turnId, item: { type: "agentMessage", text } },
      });
    const complete = (threadId: string) =>
      h.send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: `turn-${threadId}`, status: "completed", items: [] },
        },
      });
    message(firstThread, "first");
    message(secondThread, "second");
    message(firstThread, "wrong turn", "unrelated-turn");
    message("foreign-thread", "foreign");
    complete(firstThread);
    complete(secondThread);
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    h.client.close();
  });

  it("interrupts only the timed-out turn", async () => {
    const h = await harness();
    const pending = h.client.runStructuredTurn([], {}, 100);
    const assertion = expect(pending).rejects.toThrow("turn timed out");
    await assertion;
    expect(h.calls.find((c) => c.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    h.client.close();
  });

  it("rejects a running turn promptly when the server exits", async () => {
    const h = await harness();
    const pending = h.client.runStructuredTurn([], {});
    const assertion = expect(pending).rejects.toThrow("exited with code 7");
    await vi.waitFor(() =>
      expect(h.calls.some((c) => c.method === "turn/start")).toBe(true),
    );
    h.child.emit("exit", 7);
    await assertion;
  });

  it("bounds an unanswered account request", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const pending = h.client.accountRead();
    const assertion = expect(pending).rejects.toThrow(
      "request timed out: account/read",
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    h.client.close();
  });
});
