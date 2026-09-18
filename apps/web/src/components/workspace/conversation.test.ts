import { describe, expect, it } from "vitest";
import type { TurnHistoryItem } from "@/lib/history-types";
import { buildConversation, type LiveMessage } from "./conversation";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 18, 1, minute)).toISOString();

function saved(id: string, minute: number, status = "completed"): TurnHistoryItem {
  return {
    id,
    requestText: `요청 ${id}`,
    permissionMode: "slides",
    status,
    assistantText: "답",
    createdAt: at(minute),
    updatedAt: at(minute + 1),
    summary: null,
    beforeVersionId: null,
    afterVersionId: null,
    savedPreviews: [],
    undoneAt: null,
  };
}

describe("buildConversation", () => {
  it("shows saved requests before any live event arrives", () => {
    const items = buildConversation({ history: [saved("a", 0), saved("b", 10)], messages: [], runs: [] });
    expect(items.map((item) => item.key)).toEqual(["u:a", "t:a", "u:b", "t:b"]);
  });

  it("lays live progress over the saved request and places direct edits between requests", () => {
    const live: LiveMessage[] = [
      { id: 5, role: "user", text: "요청 b", tools: [], status: "done", turnId: "b", at: at(10) },
      { id: 6, role: "assistant", text: "", tools: ["현재 슬라이드 확인"], status: "running", turnId: "b", at: at(10) },
    ];
    const items = buildConversation({
      history: [saved("a", 0), saved("b", 10, "running")],
      messages: live,
      runs: [{ from: at(3), to: at(8), saves: 2, afterTurnId: "a" }],
    });
    expect(items.map((item) => item.kind)).toEqual(["user", "turn", "manual", "user", "turn"]);
    const running = items.at(-1);
    expect(running?.kind === "turn" && running.turn.tools).toEqual(["현재 슬라이드 확인"]);
  });

  it("adds a new live request after the saved ones and keeps a queued draft last", () => {
    const live: LiveMessage[] = [
      { id: 9, role: "assistant", text: "", tools: [], status: "running", turnId: "c", at: at(20) },
      { id: -1, role: "user", text: "나중에 보낼 요청", tools: [], status: "done", queued: true },
    ];
    const items = buildConversation({ history: [saved("a", 0)], messages: live, runs: [] });
    expect(items.map((item) => item.key)).toEqual(["u:a", "t:a", "u:c", "t:c", "p:-1"]);
    const queued = items.at(-1);
    expect(queued?.kind === "user" && queued.queued).toBe(true);
  });

  it("marks requests undone during this page session", () => {
    const items = buildConversation({
      history: [saved("a", 0)],
      messages: [],
      runs: [],
      undone: new Map([["a", at(5)]]),
    });
    const card = items.find((item) => item.kind === "turn");
    expect(card?.kind === "turn" && card.turn.undoneAt).toBe(at(5));
  });
});
