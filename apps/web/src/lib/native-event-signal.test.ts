import { describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
  notify: undefined as undefined | ((id: string) => void),
  unlisten: vi.fn(async () => {}),
}));
vi.mock("./db", () => ({
  db: () => ({
    listen: async (_channel: string, notify: (id: string) => void) => {
      connection.notify = notify;
      return { unlisten: connection.unlisten };
    },
  }),
}));

import { subscribeNativeChanges } from "./native-event-signal";

describe("shared native event subscription", () => {
  it("routes signals by session and makes cleanup idempotent", async () => {
    const a = vi.fn(),
      b = vi.fn();
    const leaveA = await subscribeNativeChanges("a", a);
    const leaveB = await subscribeNativeChanges("a", b);
    connection.notify?.("b");
    expect(a).not.toHaveBeenCalled();
    connection.notify?.("a");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    leaveA();
    leaveA();
    connection.notify?.("a");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
    leaveB();
    await vi.waitFor(() => expect(connection.unlisten).toHaveBeenCalledOnce());
  });
});
