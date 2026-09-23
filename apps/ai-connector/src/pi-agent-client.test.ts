import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const runtimes: Array<{
    credentials: unknown;
    keys: Map<string, string>;
  }> = [];
  const promptListeners: Array<(event: unknown) => void> = [];
  return { runtimes, promptListeners };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      subscribe: (listener: (event: unknown) => void) => {
        harness.promptListeners.push(listener);
        return () => undefined;
      },
      prompt: vi.fn(async () => {
        for (const listener of harness.promptListeners.splice(0)) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "ok" },
          });
        }
      }),
      dispose: vi.fn(),
      agent: { state: { messages: [] } },
    },
  })),
  DefaultResourceLoader: class {
    reload = vi.fn(async () => undefined);
    constructor(_options: unknown) {}
  },
  ModelRuntime: {
    create: vi.fn(async ({ credentials }: { credentials: unknown }) => {
      const runtime = {
        credentials,
        keys: new Map<string, string>(),
        setRuntimeApiKey: vi.fn(async (provider: string, key: string) => {
          runtime.keys.set(provider, key);
        }),
        getModel: vi.fn(() => undefined),
      };
      harness.runtimes.push(runtime);
      return runtime;
    }),
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

import { PiAgentClient } from "./pi-agent-client.js";

describe("API-key model runtime isolation", () => {
  beforeEach(() => {
    harness.runtimes.length = 0;
    harness.promptListeners.length = 0;
  });

  it("keeps concurrent tenant keys in separate in-memory runtimes without mutating env", async () => {
    const envBefore = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };

    const [first, second] = await Promise.all([
      new PiAgentClient("tenant-a-secret", "openai_api").runStructuredTurn(
        [{ type: "text", text: "system" }],
        {},
      ),
      new PiAgentClient("tenant-b-secret", "openai_api").runStructuredTurn(
        [{ type: "text", text: "system" }],
        {},
      ),
    ]);

    expect(first).toBe("ok");
    expect(second).toBe("ok");
    expect(harness.runtimes).toHaveLength(2);
    expect(harness.runtimes[0]?.keys.get("openai")).toBe("tenant-a-secret");
    expect(harness.runtimes[1]?.keys.get("openai")).toBe("tenant-b-secret");
    expect(harness.runtimes[0]?.credentials).not.toBe(
      harness.runtimes[1]?.credentials,
    );
    expect({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    }).toEqual(envBefore);
  });
});
