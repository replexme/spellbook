import { describe, expect, it } from "vitest";
import capabilities from "../../../../../contracts/native-edit-capabilities.json";
import type { VersionHistoryItem } from "@/lib/history-types";
import type { TurnSummary } from "@/lib/native-turn-summary";
import { directionParticle, objectParticle, timeRange } from "../copy";
import {
  ALWAYS_EDITABLE,
  scopeDescription,
  scopeLabel,
  suggestionsFor,
  type EditorSelection,
} from "./request-scope";
import { runningStages } from "./running-stages";
import {
  impactSentence,
  manualEditRuns,
  restoreImpact,
  savedAfter,
  undoActionFor,
  type TimelineTurn,
} from "./turn-timeline";

const at = (hour: number, minute: number) =>
  new Date(2026, 8, 18, hour, minute).toISOString();

function version(
  id: string,
  origin: VersionHistoryItem["origin"],
  createdAt: string,
  turnId?: string,
): VersionHistoryItem {
  return {
    id,
    parentVersionId: null,
    origin,
    createdAt,
    slideCount: 3,
    current: false,
    turn: turnId ? { id: turnId, requestText: "요청" } : null,
    restoredFrom: null,
    previews: [],
    bytes: null,
  };
}

const turns: TimelineTurn[] = [
  {
    turnId: "a",
    requestText: "날짜 맞춰 줘",
    startedAt: at(10, 20),
    changed: true,
    undone: false,
  },
  {
    turnId: "b",
    requestText: "제목 줄여 줘",
    startedAt: at(10, 42),
    changed: true,
    undone: false,
  },
];

const versions = [
  version("o", "original", at(9, 58)),
  version("m1", "manual", at(10, 2)),
  version("m2", "manual", at(10, 15)),
  version("ai-a", "ai", at(10, 21), "a"),
  version("s", "system", at(10, 30)),
  version("m3", "manual", at(10, 31)),
  version("m4", "manual", at(10, 38)),
  version("ai-b", "ai", at(10, 43), "b"),
];

describe("manual edit lines", () => {
  it("groups direct-edit saves between AI requests", () => {
    expect(manualEditRuns(versions, turns)).toEqual([
      { from: at(10, 2), to: at(10, 15), saves: 2, afterTurnId: null },
      { from: at(10, 31), to: at(10, 38), saves: 2, afterTurnId: "a" },
    ]);
  });

  it("names what going back takes with it", () => {
    const impact = restoreImpact(versions, turns, at(10, 19), "a");
    expect(impact.aiRequests).toEqual([
      { at: at(10, 42), requestText: "제목 줄여 줘" },
    ]);
    expect(impactSentence(impact)).toBe(
      `그 뒤의 직접 수정(${timeRange(at(10, 31), at(10, 38))})과 AI 요청 1건(${timeRange(at(10, 42), at(10, 42))})도 함께 되돌아가요.`,
    );
    expect(
      impactSentence(restoreImpact(versions, turns, at(10, 44))),
    ).toBeNull();
  });

  it("finds saves after a request other than its own", () => {
    expect(savedAfter(versions, "a", at(10, 20))).toBe(true);
    expect(savedAfter(versions, "b", at(10, 42))).toBe(false);
  });
});

describe("undo action", () => {
  const summary = {
    changedSlides: [2],
    undoSteps: 1,
    revisions: { before: "r1", after: "r2" },
  } as unknown as TurnSummary;
  const base = {
    summary,
    outcome: "changed",
    beforeVersionId: "v1",
    undone: false,
    latest: true,
    editorLive: true,
    changedSince: false,
  };

  it("undoes the latest untouched request in the editor", () => {
    expect(undoActionFor(base)).toEqual({ kind: "native", label: "되돌리기" });
    expect(
      undoActionFor({
        ...base,
        summary: { ...summary, changedSlides: [1, 2] } as TurnSummary,
      }),
    ).toEqual({ kind: "native", label: "모두 되돌리기" });
  });

  it("goes back to the saved version once anything came after", () => {
    expect(undoActionFor({ ...base, changedSince: true })).toEqual({
      kind: "restore",
      label: "이 요청 전으로 돌아가기",
    });
    expect(undoActionFor({ ...base, latest: false })?.kind).toBe("restore");
    expect(
      undoActionFor({
        ...base,
        summary: { ...summary, undoSteps: 0 } as TurnSummary,
      })?.kind,
    ).toBe("restore");
  });

  it("offers nothing for undone or unchanged requests", () => {
    expect(undoActionFor({ ...base, undone: true })).toBeNull();
    expect(undoActionFor({ ...base, outcome: "unchanged" })).toBeNull();
  });
});

describe("request scope", () => {
  const selection: EditorSelection = {
    activeSlide: 2,
    slideCount: 12,
    selected: [
      {
        elementId: "2/0",
        name: "Title 1",
        kind: "com.sun.star.presentation.TitleTextShape",
        text: "하반기 시장",
      },
    ],
    editableOperations: ["replace_text"],
  };

  it("names the selected element and slide", () => {
    expect(scopeLabel("selection", selection)).toBe("선택 · 제목 (3번)");
    expect(scopeLabel("slides", selection)).toBe("범위 · 3번 슬라이드");
    expect(scopeLabel("selection", { ...selection, selected: [] })).toBe(
      "선택 · 선택한 것 없음",
    );
    expect(scopeDescription("selection", selection)).toBe(
      "지금 선택한 제목 1개만 바꿔요",
    );
    expect(scopeDescription("slides", selection)).toBe(
      "3번 슬라이드 안에서만 바꿔요",
    );
  });

  it("suggests only edits the editor can run", () => {
    const groups = suggestionsFor(selection);
    expect(groups[0]!.title).toBe("선택한 제목으로");
    expect(groups[0]!.items.map((item) => item.text)).toEqual([
      "이 제목을 한 줄로 줄이기",
      "이 제목을 영어로 바꾸기",
    ]);
    const patched = suggestionsFor({
      ...selection,
      editableOperations: ["replace_text", "font_size"],
    });
    expect(patched[0]!.items.map((item) => item.text)).toContain(
      "다른 슬라이드 제목과 글자 크기 맞추기",
    );
  });

  it("keeps the always-editable list inside what every engine can run", () => {
    const operations = capabilities.mutationModel.operations as Record<
      string,
      { minEnginePatch: number }
    >;
    for (const operation of ALWAYS_EDITABLE)
      expect(operations[operation]?.minEnginePatch).toBe(0);
  });
});

describe("running stages", () => {
  it("places the agent's progress labels on four stages", () => {
    expect(runningStages([], false).map((row) => row.state)).toEqual([
      "now",
      "todo",
      "todo",
      "todo",
    ]);
    const rows = runningStages(
      ["현재 슬라이드 확인", "수정 계획 검사", "여러 요소 한 번에 수정"],
      false,
    );
    expect(rows.map((row) => row.state)).toEqual([
      "done",
      "now",
      "todo",
      "todo",
    ]);
    expect(rows[1]).toMatchObject({
      label: "고치기",
      detail: "여러 요소 한 번에 수정",
    });
    expect(
      runningStages(
        ["현재 슬라이드 확인", "슬라이드 수정", "현재 슬라이드 확인"],
        false,
      ).map((row) => row.state),
    ).toEqual(["done", "done", "now", "todo"]);
    expect(
      runningStages(
        [
          "현재 슬라이드 확인",
          "슬라이드 수정",
          "현재 슬라이드 확인",
          "수정 화면 확인 완료",
        ],
        false,
      ).at(-1)!.state,
    ).toBe("now");
  });

  it("uses two stages for a question", () => {
    expect(
      runningStages(["현재 슬라이드 확인"], true, true).map((row) => row.state),
    ).toEqual(["done", "now"]);
  });
});

describe("particles and times", () => {
  it("picks particles by the last sound", () => {
    expect(objectParticle("제목")).toBe("을");
    expect(objectParticle("텍스트 상자")).toBe("를");
    expect(directionParticle("제목")).toBe("으로");
    expect(directionParticle("그림")).toBe("으로");
    expect(directionParticle("표")).toBe("로");
    expect(directionParticle("파일")).toBe("로");
  });

  it("shortens a same-day range", () => {
    expect(timeRange(at(10, 31), at(10, 38))).toMatch(
      /^\d{2}:\d{2}–\d{2}:\d{2}$|^.+ \d{2}:\d{2}–\d{2}:\d{2}$/,
    );
  });
});
