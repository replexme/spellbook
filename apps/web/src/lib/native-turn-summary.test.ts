import { describe, expect, it } from "vitest";
import {
  describeElementChange,
  elementLabel,
  nativeFailureReason,
  summarizeTurn,
  type TurnRecord,
  type TurnTaskRecord,
} from "./native-turn-summary";

const slideSize = { width: 25_400, height: 14_288 };

function slide(slideIndex: number, elements: Array<Record<string, unknown>>) {
  return { slideIndex, name: `slide${slideIndex}`, ...slideSize, elements };
}

const title = {
  elementId: "2/0",
  stableId: "s2-title",
  name: "Title 1",
  kind: "com.sun.star.presentation.TitleTextShape",
  text: "2026년 하반기 국내 시장 현황과 주요 경쟁사 동향",
  fontSize: 32,
  x: 1_270,
  y: 800,
  width: 20_000,
  height: 2_000,
};
const body = {
  elementId: "2/1",
  stableId: "s2-body",
  name: "TextBox 2",
  kind: "com.sun.star.drawing.TextShape",
  text: "국내 시장 규모 4.2조 원",
  fontSize: 18,
  x: 1_270,
  y: 4_000,
  width: 10_000,
  height: 3_000,
};

const baseSlides = [slide(0, []), slide(1, []), slide(2, [title, body])];
const editedSlides = [
  slide(0, []),
  slide(1, []),
  slide(2, [{ ...title, text: "하반기 시장 현황", fontSize: 28 }, body]),
];
const png = "iVBORw0KGgo=";

function observe(
  id: string,
  slides = baseSlides,
  imageSlide = 2,
): TurnTaskRecord {
  return {
    id,
    request: { operation: "observe" },
    status: "completed",
    result: {
      slides,
      images: [{ slideIndex: imageSlide, pngBase64: png }],
      changedSlideIndexes: [],
    },
    error: null,
  };
}

function batch(
  id: string,
  overrides: Record<string, unknown> = {},
): TurnTaskRecord {
  return {
    id,
    request: { operation: "edit_batch", dryRun: false },
    status: "completed",
    result: {
      slides: editedSlides,
      changedSlideIndexes: [2],
      images: [{ slideIndex: 2, pngBase64: png }],
      layoutAudit: { introducedIssueCount: 0, introducedIssues: [] },
      transaction: { status: "applied", undoActionsAdded: 1 },
      ...overrides,
    },
    error: null,
  };
}

const completed: TurnRecord = {
  status: "completed",
  permissionMode: "slides",
  changed: true,
  reviewed: true,
  lastError: null,
};

describe("summarizeTurn", () => {
  it("summarizes a reviewed change from the editor records", () => {
    const summary = summarizeTurn(completed, [
      observe("t1"),
      batch("t2"),
      observe("t3", editedSlides),
    ]);
    expect(summary.outcome).toBe("changed");
    expect(summary.changedSlides).toEqual([2]);
    expect(summary.changes).toHaveLength(1);
    expect(summary.changes[0]).toMatchObject({
      slideIndex: 2,
      target: "제목",
      kind: "modified",
    });
    expect(summary.changes[0]!.details).toEqual([
      "문구 “2026년 하반기 국내 시장 현황과 주요 경쟁사 동향” → “하반기 시장 현황”",
      "글자 크기 32pt → 28pt",
    ]);
    expect(summary.changes[0]!.box?.x).toBeCloseTo(0.05, 2);
    expect(summary.introducedIssues).toEqual({
      overlap: 0,
      outOfBounds: 0,
      invalidSize: 0,
    });
    expect(summary.scopeEnforced).toBe(true);
    expect(summary.evidence).toEqual([
      { slideIndex: 2, before: "t1:0", after: "t3:0", framing: "slide" },
    ]);
  });

  it("marks a change the AI did not re-check as unverified", () => {
    const summary = summarizeTurn({ ...completed, reviewed: false }, [
      observe("t1"),
      batch("t2"),
    ]);
    expect(summary.outcome).toBe("unverified");
    expect(summary.evidence[0]).toEqual({
      slideIndex: 2,
      before: "t1:0",
      after: "t2:0",
      framing: "slide",
    });
  });

  it("marks whole-window captures from the browser editor so outlines are not placed on them", () => {
    const windowed = (task: TurnTaskRecord): TurnTaskRecord => ({
      ...task,
      result: {
        ...task.result!,
        images: (task.result!.images as Array<Record<string, unknown>>).map(
          (image) => ({
            ...image,
            source: "browser_canvas",
          }),
        ),
      },
    });
    const summary = summarizeTurn(completed, [
      windowed(observe("t1")),
      windowed(batch("t2")),
    ]);
    expect(summary.evidence[0]!.framing).toBe("window");
  });

  it("follows the editor record when nothing changed, whatever the reply says", () => {
    const summary = summarizeTurn(
      { ...completed, changed: false, reviewed: false },
      [
        observe("t1"),
        batch("t2", {
          changedSlideIndexes: [],
          transaction: { status: "unchanged" },
        }),
      ],
    );
    expect(summary.outcome).toBe("unchanged");
    expect(summary.changes).toEqual([]);
  });

  it("treats a read-only request as an answer", () => {
    const summary = summarizeTurn(
      {
        ...completed,
        permissionMode: "read_only",
        changed: false,
        reviewed: false,
      },
      [observe("t1")],
    );
    expect(summary.outcome).toBe("answered");
    expect(summary.introducedIssues).toBeNull();
  });

  it("reports scope rejections from failed editor tasks", () => {
    const summary = summarizeTurn(
      { ...completed, changed: false, reviewed: false },
      [
        observe("t1"),
        {
          id: "t2",
          request: { operation: "edit" },
          status: "failed",
          result: null,
          error: "선택 범위 밖입니다.",
        },
      ],
    );
    expect(summary.outcome).toBe("unchanged");
    expect(summary.scopeRejected).toBe(true);
  });

  it("counts introduced layout issues once", () => {
    const issue = {
      code: "out_of_slide_bounds",
      slideIndex: 2,
      stableIds: ["s2-title"],
    };
    const summary = summarizeTurn(completed, [
      observe("t1"),
      batch("t2", {
        layoutAudit: { introducedIssueCount: 1, introducedIssues: [issue] },
      }),
      batch("t3", {
        layoutAudit: { introducedIssueCount: 1, introducedIssues: [issue] },
      }),
    ]);
    expect(summary.introducedIssues).toEqual({
      overlap: 0,
      outOfBounds: 1,
      invalidSize: 0,
    });
  });

  it("does not guess element changes when slides were added", () => {
    const summary = summarizeTurn(completed, [
      observe("t1"),
      batch("t2", {
        slides: [...editedSlides, slide(3, [])],
        changedSlideIndexes: [3],
      }),
    ]);
    expect(summary.changes).toEqual([
      expect.objectContaining({
        target: "문서",
        details: ["슬라이드 3장 → 4장"],
      }),
    ]);
  });

  it("compares every slide, so the card can say the others did not change", () => {
    const summary = summarizeTurn(completed, [
      observe("t1"),
      batch("t2", { revision: "after" }),
      observe("t3", editedSlides),
    ]);
    expect(summary.unchangedSlides).toBe(2);
    expect(summary.undoSteps).toBe(1);
    expect(summary.changes[0]!.elementId).toBe("2/0");
    expect(summary.revisions).toEqual({ before: null, after: "after" });
  });

  it("finds a change on a slide the edit did not report", () => {
    const touched = [
      slide(0, [
        { ...body, elementId: "0/0", stableId: "s0-body", text: "바뀜" },
      ]),
      ...editedSlides.slice(1),
    ];
    const before = [
      slide(0, [{ ...body, elementId: "0/0", stableId: "s0-body" }]),
      ...baseSlides.slice(1),
    ];
    const summary = summarizeTurn(completed, [
      observe("t1", before),
      batch("t2", { slides: touched }),
    ]);
    expect(summary.changedSlides).toEqual([0, 2]);
    expect(summary.unchangedSlides).toBe(1);
  });

  it("makes no claim about other slides when the masters changed", () => {
    const summary = summarizeTurn(completed, [
      {
        ...observe("t1"),
        result: {
          ...observe("t1").result!,
          masters: [{ name: "A", shapeCount: 3 }],
        },
      },
      batch("t2", { masters: [{ name: "B", shapeCount: 3 }] }),
    ]);
    expect(summary.unchangedSlides).toBeNull();
  });

  it("ignores the master shape count, which the editor itself treats as noise", () => {
    const summary = summarizeTurn(completed, [
      {
        ...observe("t1"),
        result: {
          ...observe("t1").result!,
          masters: [{ name: "A", shapeCount: 3 }],
        },
      },
      batch("t2", { masters: [{ name: "A", shapeCount: 5 }] }),
    ]);
    expect(summary.unchangedSlides).toBe(2);
  });

  it("reports moved slides as a structural change, not element edits", () => {
    const moved = [baseSlides[0]!, slide(1, [title, body]), slide(2, [])];
    const summary = summarizeTurn(completed, [
      observe("t1"),
      {
        ...batch("t2", { slides: moved, changedSlideIndexes: [1] }),
        request: {
          operation: "edit_batch",
          commands: [{ op: "move_slide", slideIndex: 2, toIndex: 1 }],
        },
      },
    ]);
    expect(summary.changes).toEqual([
      expect.objectContaining({
        target: "문서",
        details: ["슬라이드 순서 바꿈"],
      }),
    ]);
    expect(summary.changedSlides).toEqual([1, 2]);
    expect(summary.unchangedSlides).toBe(1);
  });

  it("measures from the first edit that took effect", () => {
    const refused: TurnTaskRecord = {
      id: "t2",
      request: { operation: "edit_batch" },
      status: "failed",
      result: null,
      error: "document_changed_observe_again",
    };
    const personEdited = [
      slide(0, []),
      slide(1, [{ ...body, elementId: "1/0", stableId: "s1-body" }]),
      slide(2, [title, body]),
    ];
    const afterEdit = [personEdited[0]!, personEdited[1]!, editedSlides[2]!];
    const summary = summarizeTurn(completed, [
      observe("t1"),
      refused,
      observe("t3", personEdited),
      batch("t4", { slides: afterEdit }),
    ]);
    expect(summary.changedSlides).toEqual([2]);
  });

  it("adds up the undo actions of every applied edit", () => {
    const single: TurnTaskRecord = {
      id: "t3",
      request: { operation: "edit" },
      status: "completed",
      result: { slides: editedSlides, changedSlideIndexes: [2], images: [] },
      error: null,
    };
    const summary = summarizeTurn(completed, [
      observe("t1"),
      batch("t2"),
      single,
    ]);
    expect(summary.undoSteps).toBe(2);
  });

  it("groups changes by slide and finds the one detail they share", () => {
    const retitled = (index: number) => ({
      ...title,
      elementId: `${index}/0`,
      stableId: `s${index}-title`,
    });
    const before = [0, 1, 2].map((index) => slide(index, [retitled(index)]));
    const after = [0, 1, 2].map((index) =>
      slide(index, [{ ...retitled(index), fontSize: 28 }]),
    );
    const summary = summarizeTurn(completed, [
      observe("t1", before),
      batch("t2", { slides: after, changedSlideIndexes: [0, 1, 2] }),
    ]);
    expect(summary.slideGroups).toEqual([
      { slideIndex: 0, count: 1, targets: [{ label: "제목", count: 1 }] },
      { slideIndex: 1, count: 1, targets: [{ label: "제목", count: 1 }] },
      { slideIndex: 2, count: 1, targets: [{ label: "제목", count: 1 }] },
    ]);
    expect(summary.sharedDetail).toBe("글자 크기 32pt → 28pt");
    expect(summary.unchangedSlides).toBe(0);
  });

  it("flags an after image the browser editor may not have repainted", () => {
    const stale = batch("t2", {
      images: [{ slideIndex: 2, pngBase64: png, stale: true }],
    });
    const summary = summarizeTurn({ ...completed, reviewed: false }, [
      observe("t1"),
      stale,
    ]);
    expect(summary.evidence[0]!.stale).toBe(true);
  });

  it("explains failures with a readable reason", () => {
    const summary = summarizeTurn(
      {
        ...completed,
        status: "failed",
        changed: false,
        reviewed: false,
        lastError: "native_agent_interrupted",
      },
      [observe("t1")],
    );
    expect(summary.outcome).toBe("failed");
    expect(summary.failure?.code).toBe("interrupted");
  });
});

describe("labels and reasons", () => {
  it("names elements in Korean", () => {
    expect(elementLabel({ name: "Title 1" })).toBe("제목");
    expect(elementLabel({ name: "TextBox 7" })).toBe("텍스트 상자");
    expect(elementLabel({ name: "제목 상자" })).toBe("제목 상자");
    expect(
      elementLabel({
        name: "",
        kind: "com.sun.star.drawing.GraphicObjectShape",
      }),
    ).toBe("그림");
  });

  it("describes formatting changes with values", () => {
    expect(
      describeElementChange(
        { fill: 0x2f6feb, fillStyle: "SOLID", fontWeight: 100 },
        { fill: 0xf5c518, fillStyle: "SOLID", fontWeight: 150 },
      ),
    ).toEqual(["굵게", "채우기 색 #2F6FEB → #F5C518"]);
  });

  it("maps failure text to specific reasons", () => {
    expect(nativeFailureReason("request timed out after 25s").code).toBe(
      "timeout",
    );
    expect(nativeFailureReason("429 Too Many Requests: rate limit").code).toBe(
      "usage_limit",
    );
    expect(nativeFailureReason("Generated an accurate plan").code).toBe(
      "unknown",
    );
    expect(nativeFailureReason("selected_model_unavailable").code).toBe(
      "model_unavailable",
    );
    expect(nativeFailureReason("native_session_not_active").code).toBe(
      "save_in_progress",
    );
  });
});
