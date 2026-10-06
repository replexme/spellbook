import { describe, it, expect, vi } from "vitest";
import { LocalNativeTurns } from "./local-native-turns.js";
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("paired local turn document transport", () => {
  it("binds all tools and results to the exact paired owner", async () => {
    const store = new LocalNativeTurns(async () => {
      throw Error("not_used");
    });
    try {
      const { turnId } = store.start("origin:tokenA", {
        requestText: "inspect",
        permissionMode: "read_only",
      });
      expect(() => store.poll("origin:tokenB", turnId, 0)).toThrow(
        "session_not_found",
      );
      const poll = store.poll("origin:tokenA", turnId, 0);
      expect(poll.tasks[0].request.operation).toBe("observe");
      expect(() =>
        store.reply("origin:tokenB", turnId, poll.tasks[0].id, {}, null),
      ).toThrow("session_not_found");
      store.reply(
        "origin:tokenA",
        turnId,
        poll.tasks[0].id,
        null,
        "editor_closed",
      );
      await pause();
      expect(store.poll("origin:tokenA", turnId, 0).done).toBe(true);
    } finally {
      store.dispose();
    }
  });
  it("cancellation rejects pending document requests and clears them", async () => {
    const store = new LocalNativeTurns(async () => {
      throw Error("not_used");
    });
    try {
      const { turnId } = store.start("owner", {
        requestText: "inspect",
        permissionMode: "read_only",
      });
      store.cancel("owner", turnId);
      await pause();
      const poll = store.poll("owner", turnId, 0);
      expect(poll.done).toBe(true);
      expect(poll.tasks).toEqual([]);
      expect(poll.result).toEqual({ error: "local_turn_cancelled" });
    } finally {
      store.dispose();
    }
  });
  it("rejects unknown permissions, external API configuration and duplicate active turns", () => {
    const store = new LocalNativeTurns(async () => {
      throw Error("not_used");
    });
    try {
      expect(() =>
        store.start("owner", { requestText: "x", permissionMode: "admin" }),
      ).toThrow("invalid_local_turn");
      expect(() =>
        store.start("owner", {
          requestText: "x",
          permissionMode: "document",
          modelSettings: { provider: "custom_api", model: "x" },
        }),
      ).toThrow("invalid_local_model");
      store.start("owner", {
        requestText: "inspect",
        permissionMode: "read_only",
      });
      expect(() =>
        store.start("owner", {
          requestText: "inspect",
          permissionMode: "read_only",
        }),
      ).toThrow("local_turn_limit");
    } finally {
      store.dispose();
    }
  });
});

it("expired local document turns are removed without another browser request", async () => {
  vi.useFakeTimers();
  const store = new LocalNativeTurns(async () => {
    throw Error("not_used");
  });
  try {
    const { turnId } = store.start("owner", {
      requestText: "inspect",
      permissionMode: "read_only",
    });
    await vi.advanceTimersByTimeAsync(665001);
    expect(() => store.poll("owner", turnId, 0)).toThrow("session_not_found");
  } finally {
    store.dispose();
    vi.useRealTimers();
  }
});
