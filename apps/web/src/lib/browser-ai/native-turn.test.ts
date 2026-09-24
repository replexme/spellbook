import { describe, expect, it, vi } from "vitest";
import {
  runNativeTurn,
  UNCONFIRMED_EDIT_NOTICE,
  UNREVIEWED_EDIT_NOTICE,
  type NativeObservation,
  type NativePermission,
  type ToolOutput,
  type TurnModel,
} from "./native-turn";

const PNG_BASE64 = btoa(
  String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0),
);
const before: NativeObservation = {
  revision: "r1",
  activeSlide: 0,
  selectedElementIds: ["0/0"],
  engine: { patchLevel: "undo-v18", supportedOperations: [] },
  slides: [
    {
      slideIndex: 0,
      elements: [
        { elementId: "0/0", text: "Before" },
        { elementId: "0/1", text: "Other" },
      ],
    },
  ],
  images: [{ slideIndex: 0, pngBase64: PNG_BASE64 }],
  changedSlideIndexes: [],
  visualEvidenceComplete: true,
};
const after: NativeObservation = {
  ...structuredClone(before),
  revision: "r2",
  changedSlideIndexes: [0],
};
const documentScope: NativePermission = {
  mode: "document",
  slideIndexes: [],
  elementIds: [],
};

type Step = (
  tool: (name: string, args: unknown) => Promise<ToolOutput>,
  input: Parameters<TurnModel["run"]>[0],
) => Promise<string>;

/** A model that plays scripted steps, one per turn, against the real tools. */
function scriptedModel(...steps: Step[]) {
  const turns: Array<Parameters<TurnModel["run"]>[0]> = [];
  const model: TurnModel = {
    async run(input) {
      turns.push(input);
      const step = steps[turns.length - 1];
      if (!step) return "";
      return step(
        (name, args) => input.onTool(name, args, new AbortController().signal),
        input,
      );
    },
  };
  return { model, turns };
}

function editorHost(mutation: NativeObservation = after) {
  let current = structuredClone(before);
  const call = vi.fn(async (request: Record<string, unknown>) => {
    if (request.operation !== "observe" && !request.dryRun)
      current = structuredClone(mutation);
    return structuredClone(current);
  });
  return { call };
}

function run(
  model: TurnModel,
  host = editorHost(),
  permission = documentScope,
) {
  return runNativeTurn(model, {
    requestText: "제목을 바꿔줘",
    permission,
    host,
    web: { search: async () => [], readPage: async () => "" },
    signal: new AbortController().signal,
    onText: () => undefined,
    onTool: () => undefined,
  });
}

const edit = {
  op: "replace_text",
  elementId: "0/0",
  text: "After",
};

describe("browser-run AI request", () => {
  it("asks a model that edited and stopped to look again, with only look and review tools", async () => {
    const { model, turns } = scriptedModel(
      async (tool) => {
        await tool("native_observe", { detailSlideIndex: null });
        const result = await tool("native_edit", edit);
        expect(result.ok).toBe(true);
        expect(result.images).toEqual([PNG_BASE64]);
        return "바꿨어요";
      },
      async (tool) => {
        const refused = await tool("native_edit", edit);
        expect(refused.ok).toBe(false);
        await tool("native_observe", { detailSlideIndex: null });
        const review = await tool("native_review", {
          approved: true,
          problems: [],
          reviewedSlideIndexes: [0],
        });
        expect(review.ok).toBe(true);
        return "제목을 바꾸고 화면에서 확인했어요";
      },
    );
    const result = await run(model);
    expect(turns[1]!.tools.map((tool) => tool.name)).toEqual([
      "native_observe",
      "native_review",
    ]);
    expect(result).toMatchObject({
      changed: true,
      reviewed: true,
      status: "completed",
      text: "제목을 바꾸고 화면에서 확인했어요",
    });
  });

  it("says the result is unconfirmed when no review happens", async () => {
    const { model } = scriptedModel(async (tool) => {
      await tool("native_observe", { detailSlideIndex: null });
      await tool("native_edit", edit);
      return "바꿨어요";
    });
    const result = await run(model);
    expect(result.status).toBe("needs_review");
    expect(result.text).toContain(UNREVIEWED_EDIT_NOTICE);
  });

  it("refuses an edit outside the selected object before it reaches the editor", async () => {
    const host = editorHost();
    const { model } = scriptedModel(async (tool) => {
      await tool("native_observe", { detailSlideIndex: null });
      const refused = await tool("native_edit", { ...edit, elementId: "0/1" });
      expect(refused).toMatchObject({ ok: false, text: "선택 범위 밖입니다." });
      return "선택 밖이라 바꾸지 않았어요";
    });
    const result = await run(model, host, {
      mode: "selection",
      slideIndexes: [],
      elementIds: ["0/0"],
    });
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: false, status: "completed" });
  });

  it("does not accept an edit result without a fresh screenshot of the changed slide", async () => {
    const { model } = scriptedModel(async (tool) => {
      await tool("native_observe", { detailSlideIndex: null });
      const result = await tool("native_edit", edit);
      expect(result.ok).toBe(false);
      return "";
    });
    const result = await run(model, editorHost({ ...after, images: [] }));
    expect(result.changed).toBe(false);
    expect(result.text).toContain(UNCONFIRMED_EDIT_NOTICE);
  });

  it("cannot approve a review for a slide it did not look at", async () => {
    const { model } = scriptedModel(
      async (tool) => {
        await tool("native_observe", { detailSlideIndex: null });
        await tool("native_edit", edit);
        const review = await tool("native_review", {
          approved: true,
          problems: [],
          reviewedSlideIndexes: [],
        });
        expect(review.ok).toBe(false);
        return "";
      },
      async () => "",
    );
    expect((await run(model)).reviewed).toBe(false);
  });
});
