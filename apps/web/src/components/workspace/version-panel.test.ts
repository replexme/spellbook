import { describe, expect, it } from "vitest";
import type { VersionHistoryItem } from "@/lib/history-types";
import { versionEntries } from "./version-entries";

function version(id: string, origin: VersionHistoryItem["origin"], minutesAgo: number, current = false): VersionHistoryItem {
  return {
    id,
    parentVersionId: null,
    origin,
    createdAt: new Date(Date.UTC(2026, 8, 18, 3, 0) - minutesAgo * 60_000).toISOString(),
    slideCount: 3,
    current,
    turn: origin === "ai" ? { id: "turn", requestText: "제목을 바꿔 줘" } : null,
    restoredFrom: null,
    previews: [],
    bytes: null,
  };
}

describe("versionEntries", () => {
  it("does not list saves no person changed", () => {
    const entries = versionEntries([
      version("ai", "ai", 1, true),
      version("system-2", "system", 2),
      version("system-1", "system", 3),
      version("original", "original", 4),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["ai", "original"]);
    expect(entries[0]!.current).toBe(true);
  });

  it("marks the same-content older entry current when a system save is current", () => {
    const entries = versionEntries([version("system", "system", 1, true), version("original", "original", 2)]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.versionId).toBe("original");
    expect(entries[0]!.current).toBe(true);
  });

  it("still groups consecutive manual saves", () => {
    const entries = versionEntries([
      version("m3", "manual", 1, true),
      version("m2", "manual", 5),
      version("m1", "manual", 9),
      version("original", "original", 60),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["manual", "original"]);
    expect(entries[0]!.members).toHaveLength(3);
    expect(entries[0]!.detail).toContain("저장 3번");
  });
});
