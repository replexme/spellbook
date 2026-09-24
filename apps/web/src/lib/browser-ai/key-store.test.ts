import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserKeyModels,
  maskApiKey,
  readBrowserKeys,
  writeBrowserKeys,
} from "./key-store";

describe("API keys kept in the browser", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("keeps each account's keys apart on a shared browser", () => {
    writeBrowserKeys("account-a", {
      active: "gemini_api",
      keys: { gemini_api: "AIza-account-a" },
    });
    expect(readBrowserKeys("account-a")).toEqual({
      active: "gemini_api",
      keys: { gemini_api: "AIza-account-a" },
    });
    expect(readBrowserKeys("account-b")).toEqual({ active: null, keys: {} });
    expect(readBrowserKeys(null)).toEqual({ active: null, keys: {} });
  });

  it("ignores an active choice without a key and unknown providers", () => {
    window.localStorage.setItem(
      "spellbook.ai-keys.v1:account-a",
      JSON.stringify({
        active: "openai_api",
        keys: { custom_api: "x", gemini_api: "AIza-key" },
      }),
    );
    expect(readBrowserKeys("account-a")).toEqual({
      active: null,
      keys: { gemini_api: "AIza-key" },
    });
  });

  it("survives unreadable storage", () => {
    window.localStorage.setItem("spellbook.ai-keys.v1:account-a", "{not json");
    expect(readBrowserKeys("account-a")).toEqual({ active: null, keys: {} });
  });

  it("lists models only for providers with a key and masks keys", () => {
    const models = browserKeyModels({
      active: null,
      keys: { anthropic_api: "sk-ant-123456789" },
    });
    expect(new Set(models.map((model) => model.provider))).toEqual(
      new Set(["anthropic_api"]),
    );
    expect(maskApiKey("sk-ant-123456789")).toBe("sk-ant...6789");
  });
});
