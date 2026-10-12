import { describe, expect, it, vi } from "vitest";
import type { AgentTurnOptions, AppServerClient } from "./app-server-client.js";
import {
  runNativeTurn,
  nativeModelObservation,
  UNCONFIRMED_EDIT_NOTICE,
  UNREVIEWED_EDIT_NOTICE,
  type NativeObservation,
  type NativePermission,
} from "./native-agent.js";
import * as editTools from "../../../contracts/native-edit-tools.cjs";

const {
  nativeEditContract,
  nativeEditOperationCount,
  nativePlatformAssetOperations,
} = editTools;

const state: NativeObservation = {
  unit: "1/100mm",
  engine: {
    supportedOperations: nativeEditContract.toolInputSchema.properties.op.enum,
  },
  revision: "v2-test",
  activeSlide: 0,
  selectedElementIds: ["0/0"],
  assets: [
    {
      assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
      fileName: "diagram.png",
      contentType: "image/png",
      kind: "image",
      width: 1280,
      height: 720,
    },
    {
      assetId: "e20e579c-61a9-46b5-9e31-d00f28a10656",
      fileName: "clip.mp4",
      contentType: "video/mp4",
      kind: "media",
      width: 0,
      height: 0,
    },
  ],
  slides: [
    {
      slideIndex: 0,
      elements: [
        { elementId: "0/0", text: "Before" },
        { elementId: "0/1", text: "Other" },
      ],
    },
  ],
  images: [{ slideIndex: 0, pngBytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
  changedSlideIndexes: [],
  visualEvidenceComplete: true,
};
const changedState: NativeObservation = {
  ...structuredClone(state),
  revision: "v2-after",
  changedSlideIndexes: [0],
  visualEvidenceComplete: true,
};
const permission: NativePermission = {
  mode: "document",
  elementIds: [],
  slideIndexes: [],
};
function fixture(
  work: (options: AgentTurnOptions) => Promise<void>,
  scope = permission,
  mutationState: NativeObservation = changedState,
  initialState: NativeObservation = state,
  followUp: (options: AgentTurnOptions) => Promise<void> = async () => {},
) {
  let turns = 0;
  let current = structuredClone(initialState);
  const call = vi.fn(
    async (request: Record<string, unknown>, _signal: AbortSignal) => {
      if (request.operation !== "observe" && !request.dryRun)
        current = structuredClone(mutationState);
      return structuredClone(current);
    },
  );
  const signal = new AbortController().signal;
  const client = {
    runStructuredTurn: async (
      _a: unknown,
      _b: unknown,
      _c: unknown,
      options: AgentTurnOptions,
    ) => {
      turns += 1;
      // The first turn answers the request; later turns are the agent's
      // follow-up (for example the enforced post-edit review).
      await (turns === 1 ? work : followUp)(options);
      return JSON.stringify({
        intent: "edit",
        goal: "Change title",
        outcome: "applied",
        message: "result",
        reason: "",
        review: null,
      });
    },
  } as unknown as AppServerClient;
  return {
    call,
    turns: () => turns,
    run: () =>
      runNativeTurn(client, {
        requestText: "Change title",
        host: { call },
        signal,
        permission: scope,
        onText: vi.fn(),
        onTool: vi.fn(),
      }),
    signal,
  };
}
describe("shared open document agent", () => {
  it("shows the model the layout issues of the pages in detail and counts the rest", () => {
    const view = nativeModelObservation({
      ...structuredClone(state),
      slides: [0, 1, 2].map((slideIndex) => ({ slideIndex, elements: [] })),
      layoutAudit: {
        issueCount: 3,
        issues: [0, 1, 2].map((slideIndex) => ({
          code: "text_overflow",
          slideIndex,
          elementId: `${slideIndex}/0`,
        })),
        introducedIssues: [
          { code: "text_overflow", slideIndex: 2, elementId: "2/0" },
        ],
      },
    } as NativeObservation) as unknown as {
      layoutAudit: {
        issues: Array<{ slideIndex: number }>;
        otherPagesIssueCount: number;
        introducedIssues: unknown[];
      };
    };
    expect(view.layoutAudit.issues.map((i) => i.slideIndex)).toEqual([0]);
    expect(view.layoutAudit.otherPagesIssueCount).toBe(2);
    expect(view.layoutAudit.introducedIssues).toHaveLength(1);
  });
  it("offers only the operations the open document's engine runs", async () => {
    const seen: Array<{ batch: string[]; asset: string[] | null }> = [];
    const client = {
      runStructuredTurn: async (
        _a: unknown,
        _b: unknown,
        _c: unknown,
        options: AgentTurnOptions,
      ) => {
        const items = (name: string) =>
          options.tools.find((tool) => tool.name === name)?.inputSchema as
            | {
                properties: {
                  commands?: {
                    items: { properties: { op: { enum: string[] } } };
                  };
                  op?: { enum: string[] };
                };
              }
            | undefined;
        const asset = items("native_edit");
        seen.push({
          batch:
            items("native_batch_edit")!.properties.commands!.items.properties.op
              .enum,
          asset: asset ? asset.properties.op!.enum : null,
        });
        return "답";
      },
    } as unknown as AppServerClient;
    const run = (supportedOperations: string[]) =>
      runNativeTurn(client, {
        requestText: "제목을 바꿔줘",
        host: { call: vi.fn(async () => structuredClone(state)) },
        signal: new AbortController().signal,
        permission,
        initialObservation: {
          ...structuredClone(state),
          engine: { supportedOperations },
        },
        onText: vi.fn(),
        onTool: vi.fn(),
      } as Parameters<typeof runNativeTurn>[1]);
    await run(["move", "replace_text", "insert_image"]);
    await run(["replace_text"]);
    expect(seen).toEqual([
      { batch: ["replace_text", "move"], asset: ["insert_image"] },
      { batch: ["replace_text"], asset: null },
    ]);
  });
  it("keeps the observation after an edit the editor refused, so the model can resend it", async () => {
    let edits = 0;
    const call = vi.fn(async (request: Record<string, unknown>) => {
      if (request.operation === "observe") return structuredClone(state);
      edits += 1;
      if (edits === 1)
        throw new Error(
          "product_mutation_rejected:command 0: invalid_command: text missing",
        );
      return structuredClone(changedState);
    });
    const outputs: Array<{ success: boolean; text: string }> = [];
    const client = {
      runStructuredTurn: async (
        _a: unknown,
        _b: unknown,
        _c: unknown,
        options: AgentTurnOptions,
      ) => {
        await options.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          new AbortController().signal,
        );
        for (const id of ["2", "3"]) {
          const out = (await options.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "replace_text", elementId: "0/0", text: "After" },
              ],
              dryRun: false,
            },
            id,
            new AbortController().signal,
          )) as { success: boolean; contentItems: Array<{ text?: string }> };
          outputs.push({
            success: out.success,
            text: out.contentItems[0]?.text ?? "",
          });
        }
        return "바꿨어요";
      },
    } as unknown as AppServerClient;
    await runNativeTurn(client, {
      requestText: "제목을 바꿔줘",
      host: { call },
      signal: new AbortController().signal,
      permission,
      onText: vi.fn(),
      onTool: vi.fn(),
    });
    expect(outputs[0]).toMatchObject({ success: false });
    expect(outputs[0]!.text).toContain("still current");
    // Resent without observing again.
    expect(outputs[1]!.success).toBe(true);
    expect(
      call.mock.calls.filter(([r]) => r.operation === "observe").length,
    ).toBeGreaterThanOrEqual(1);
    expect(call.mock.calls.map(([r]) => r.operation).slice(0, 3)).toEqual([
      "observe",
      "edit_batch",
      "edit_batch",
    ]);
  });
  for (const [label, issue, approved] of [
    [
      "a warning the edit introduced does not hold up approval",
      {
        code: "possible_element_overlap",
        severity: "warning",
        slideIndex: 0,
        elementIds: ["0/0", "0/1"],
      },
      true,
    ],
    [
      "a problem the edit introduced holds up approval",
      {
        code: "text_overflow",
        slideIndex: 0,
        elementId: "0/0",
        overflowPt: 12,
      },
      false,
    ],
  ] as const)
    it(label, async () => {
      const clean = {
        ...structuredClone(state),
        layoutAudit: { issueCount: 0, issues: [] },
      };
      const after = {
        ...structuredClone(changedState),
        layoutAudit: { issueCount: 1, issues: [issue] },
      };
      let review: { success: boolean; text: string } | null = null;
      const f = fixture(
        async (o) => {
          await o.onTool(
            "native_observe",
            { detailSlideIndex: null },
            "1",
            f.signal,
          );
          await o.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "replace_text", elementId: "0/0", text: "After" },
              ],
              dryRun: false,
            },
            "2",
            f.signal,
          );
          const out = (await o.onTool(
            "native_review",
            {
              approved: true,
              requestSatisfied: true,
              problems: [],
              reviewedSlideIndexes: [0],
            },
            "3",
            f.signal,
          )) as { success: boolean; contentItems: Array<{ text?: string }> };
          review = {
            success: out.success,
            text: out.contentItems[0]?.text ?? "",
          };
        },
        permission,
        after as NativeObservation,
        clean as NativeObservation,
      );
      const result = await f.run();
      expect(review!.success).toBe(approved);
      if (!approved) expect(review!.text).toContain("text_overflow");
      expect(result.reviewed).toBe(approved);
    });
  it("does not advertise image generation to a provider without that capability", async () => {
    const client = {
      supportsImageGeneration: false,
      runStructuredTurn: async (
        _a: unknown,
        _b: unknown,
        _c: unknown,
        options: AgentTurnOptions,
      ) => {
        expect(options.allowImageGeneration).toBe(false);
        expect(options.onGeneratedImage).toBeUndefined();
        return "이미지 생성은 지원하지 않습니다.";
      },
    } as unknown as AppServerClient;
    await runNativeTurn(client, {
      requestText: "이미지를 만들어줘",
      host: { call: vi.fn() },
      signal: new AbortController().signal,
      permission,
      onText: vi.fn(),
      onTool: vi.fn(),
    });
  });

  it("keeps image generation off for an unsupported model on a capable client", async () => {
    const client = {
      supportsImageGeneration: true,
      supportsImageGenerationForModel: async () => false,
      runStructuredTurn: async (
        _input: unknown,
        _schema: unknown,
        _timeout: unknown,
        options: AgentTurnOptions,
      ) => {
        expect(options.allowImageGeneration).toBe(false);
        expect(options.onGeneratedImage).toBeUndefined();
        return "기존 도형을 수정했습니다.";
      },
    } as unknown as AppServerClient;
    await runNativeTurn(client, {
      requestText: "도형 색을 바꿔줘",
      host: { call: vi.fn() },
      signal: new AbortController().signal,
      permission,
      onText: vi.fn(),
      onTool: vi.fn(),
    });
  });

  it("uses explicit durable history without a connector-local conversation thread", async () => {
    let prompt = "";
    const client = {
      runStructuredTurn: async (
        messages: Array<{ type: string; text: string }>,
        _schema: unknown,
        _timeout: unknown,
        options: AgentTurnOptions,
      ) => {
        prompt = messages[0]?.text ?? "";
        expect(options.conversationKey).toBeUndefined();
        return "현재 상태를 다시 확인하겠습니다.";
      },
    } as unknown as AppServerClient;
    await runNativeTurn(client, {
      requestText: "아까 요청을 다시 해줘",
      conversationHistory: [
        {
          request: "제목을 바꿔줘",
          response: "수정했습니다.",
          status: "completed",
        },
      ],
      host: { call: vi.fn() },
      signal: new AbortController().signal,
      permission,
      onText: vi.fn(),
      onTool: vi.fn(),
    });
    expect(prompt).toContain('"request":"제목을 바꿔줘"');
    expect(prompt).toContain(
      "live observation and revision are the only authority",
    );
    expect(prompt).toContain("User request: 아까 요청을 다시 해줘");
  });

  it("publishes every bounded native operation from the shared contract", async () => {
    const f = fixture(async (o) => {
      const batch = o.tools.find((tool) => tool.name === "native_batch_edit")
        ?.inputSchema as { properties: { commands: { items: unknown } } };
      const schema = batch.properties.commands.items as {
        properties: {
          op: { enum: string[] };
          row: { type: string[] };
          column: { type: string[] };
        };
      };
      // Every operation the batch runs: not the excluded ones, and not the
      // file-asset ones, which go through native_edit.
      expect(schema.properties.op.enum).toEqual(
        nativeEditContract.toolInputSchema.properties.op.enum.filter(
          (op: string) => !nativePlatformAssetOperations.has(op),
        ),
      );
      expect(schema.properties.op.enum).toEqual(
        expect.arrayContaining([
          "insert_slide",
          "add_text_box",
          "add_shape",
          "add_table",
          "align",
          "distribute",
          "group",
          "ungroup",
          "rotate",
          "flip",
          "z_order",
          "set_speaker_notes",
          "set_chart_data",
          "set_chart_type",
          "set_background",
          "set_table_cell",
          "set_slide_layout",
          "text_shadow",
          "crop_image",
          "set_slide_transition",
          "set_animation_timing",
          "set_object_interaction",
          "set_line_style",
          "set_paragraph_format",
        ]),
      );
      expect(schema.properties.op.enum).toHaveLength(
        nativeEditOperationCount - nativePlatformAssetOperations.size,
      );
      expect(schema.properties.op.enum).not.toContain("set_printable");
      expect(schema.properties.row.type).toContain("number");
      expect(schema.properties.column.type).toContain("number");
      expect(
        o.tools.find((tool) => tool.name === "native_batch_edit")?.description,
      ).toContain("one native Undo action");
      expect(
        o.tools.find((tool) => tool.name === "native_batch_edit")?.description,
      ).toContain("crop_image");
    });
    await f.run();
  });

  it("authorizes every bounded operation through the live engine capabilities", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "observe",
        f.signal,
      );
      for (const operation of nativeEditContract.toolInputSchema.properties.op
        .enum) {
        const command: Record<string, unknown> =
          nativeEditContract.operationGroups.document.includes(operation)
            ? { op: operation }
            : nativeEditContract.operationGroups.slide.includes(operation)
              ? { op: operation, slideIndex: 0 }
              : nativeEditContract.operationGroups.create.includes(operation)
                ? { op: operation, slideIndex: 0 }
                : nativeEditContract.operationGroups.multiElement.includes(
                      operation,
                    )
                  ? { op: operation, elementIds: ["0/0", "0/1"] }
                  : { op: operation, elementId: "0/0" };
        if (nativePlatformAssetOperations.has(operation))
          command.assetId = operation.endsWith("_image")
            ? "38c76733-fbed-40cc-98b0-5237aaec6387"
            : "e20e579c-61a9-46b5-9e31-d00f28a10656";
        expect(
          (
            await o.onTool(
              "native_edit",
              command,
              `edit-${operation}`,
              f.signal,
            )
          ).success,
          operation,
        ).toBe(true);
      }
    });
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(nativeEditOperationCount + 1);
  });

  it("refuses an operation the open document's engine does not run", async () => {
    const withoutSupport: NativeObservation = {
      ...structuredClone(state),
      engine: { supportedOperations: ["replace_text"] },
    };
    const f = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "observe",
          f.signal,
        );
        const result = await o.onTool(
          "native_edit",
          { op: "set_background", slideIndex: 0, color: 0xffffff },
          "edit",
          f.signal,
        );
        expect(result.success).toBe(false);
        expect(result.contentItems[0]).toMatchObject({
          type: "inputText",
          text: expect.stringContaining("supportedOperations"),
        });
      },
      permission,
      changedState,
      withoutSupport,
    );
    await f.run();
  });

  it("observes paragraph ranges on a requested slide without changing the active slide", async () => {
    const f = fixture(async (o) => {
      const schema = o.tools.find((tool) => tool.name === "native_observe")
        ?.inputSchema as {
        required: string[];
        properties: { detailSlideIndex: { type: string[] } };
      };
      expect(schema.required).toEqual(["detailSlideIndex"]);
      expect(schema.properties.detailSlideIndex.type).toEqual([
        "number",
        "null",
      ]);
      expect(
        (
          await o.onTool(
            "native_observe",
            { detailSlideIndex: 4 },
            "1",
            f.signal,
          )
        ).success,
      ).toBe(true);
    });
    await f.run();
    expect(f.call).toHaveBeenCalledWith(
      { operation: "observe", detailSlideIndex: 4 },
      f.signal,
    );
  });

  it("publishes atomic batch editing and forwards dry-run without marking the turn changed", async () => {
    const f = fixture(async (o) => {
      expect(o.tools.map((tool) => tool.name)).toContain("native_batch_edit");
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      expect(
        (
          await o.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "move", elementId: "0/0", x: 100, y: 200 },
                { op: "resize", elementId: "0/0", width: 300, height: 400 },
              ],
              dryRun: true,
            },
            "2",
            f.signal,
          )
        ).success,
      ).toBe(true);
    });
    expect(await f.run()).toMatchObject({
      changed: false,
      status: "needs_review",
      task: { outcome: "unverified" },
    });
    expect(f.call.mock.calls[1]?.[0]).toMatchObject({
      operation: "edit_batch",
      expectedRevision: "v2-test",
      dryRun: true,
      commands: [
        { op: "move", elementId: "0/0", x: 100, y: 200 },
        { op: "resize", elementId: "0/0", width: 300, height: 400 },
      ],
    });
  });

  it("marks an applied batch changed and rejects the whole batch before dispatch when one target is outside permission", async () => {
    const applied = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        applied.signal,
      );
      expect(
        (
          await o.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "move", elementId: "0/0", x: 100, y: 200 },
                { op: "resize", elementId: "0/0", width: 300, height: 400 },
              ],
              dryRun: false,
            },
            "2",
            applied.signal,
          )
        ).success,
      ).toBe(true);
    });
    expect(await applied.run()).toMatchObject({
      changed: true,
      status: "needs_review",
    });

    const restricted = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          restricted.signal,
        );
        expect(
          (
            await o.onTool(
              "native_batch_edit",
              {
                commands: [
                  { op: "move", elementId: "0/0", x: 100, y: 200 },
                  { op: "move", elementId: "0/1", x: 300, y: 400 },
                ],
                dryRun: false,
              },
              "2",
              restricted.signal,
            )
          ).success,
        ).toBe(false);
      },
      { mode: "selection", elementIds: ["0/0"], slideIndexes: [] },
    );
    await restricted.run();
    expect(restricted.call).toHaveBeenCalledTimes(1);
  });

  it("rejects an identity-replacing chart edit before a later batch command can target the deleted native object", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      expect(
        (
          await o.onTool(
            "native_batch_edit",
            {
              commands: [
                {
                  op: "set_chart_data",
                  elementId: "0/0",
                  data: [[5.3]],
                },
                { op: "move", elementId: "0/0", x: 100, y: 200 },
              ],
              dryRun: false,
            },
            "2",
            f.signal,
          )
        ).success,
      ).toBe(false);
    });
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("requires observation and rejects executable or unknown tools", async () => {
    const f = fixture(async (o) => {
      expect(
        (await o.onTool("native_edit", { elementId: "0/0" }, "1", f.signal))
          .success,
      ).toBe(false);
      expect(
        (await o.onTool("eval", { code: "arbitrary()" }, "2", f.signal))
          .success,
      ).toBe(false);
    });
    await f.run();
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each<NativePermission>([
    { mode: "read_only", elementIds: [], slideIndexes: [] },
    { mode: "selection", elementIds: ["0/1"], slideIndexes: [] },
    { mode: "slides", elementIds: [], slideIndexes: [1] },
  ])("enforces $mode before dispatch", async (scope) => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      expect(
        (
          await o.onTool(
            "native_edit",
            { op: "replace_text", elementId: "0/0", text: "After" },
            "2",
            f.signal,
          )
        ).success,
      ).toBe(false);
    }, scope);
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("sends the exact observed revision and fresh image, and requires review", async () => {
    const f = fixture(async (o) => {
      const observed = await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      expect(observed.contentItems[1]).toMatchObject({ type: "inputImage" });
      await o.onTool(
        "native_edit",
        { op: "replace_text", elementId: "0/0", text: "After" },
        "2",
        f.signal,
      );
    });
    expect(await f.run()).toMatchObject({
      changed: true,
      reviewed: false,
      status: "needs_review",
    });
    expect(f.call.mock.calls[1]?.[0]).toMatchObject({
      operation: "edit",
      expectedSlides: JSON.stringify(state.slides),
      permission,
    });
  });
  it("allows creation in an authorized slide and multi-object edits in an authorized selection", async () => {
    const scope: NativePermission = {
      mode: "selection",
      elementIds: ["0/0", "0/1"],
      slideIndexes: [],
    };
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      expect(
        (
          await o.onTool(
            "native_edit",
            {
              op: "align",
              elementIds: ["0/0", "0/1"],
              alignment: "left",
            },
            "2",
            f.signal,
          )
        ).success,
      ).toBe(true);
    }, scope);
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(2);

    const slideScope: NativePermission = {
      mode: "slides",
      elementIds: [],
      slideIndexes: [0],
    };
    const create = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        create.signal,
      );
      expect(
        (
          await o.onTool(
            "native_edit",
            {
              op: "add_table",
              slideIndex: 0,
              x: 100,
              y: 100,
              width: 1000,
              height: 500,
              cells: [
                ["항목", "값"],
                ["A", "1"],
              ],
            },
            "2",
            create.signal,
          )
        ).success,
      ).toBe(true);
    }, slideScope);
    await create.run();
    expect(create.call).toHaveBeenCalledTimes(2);
  });
  it("invalidates review after another edit", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      await o.onTool(
        "native_edit",
        { op: "replace_text", elementId: "0/0", text: "After" },
        "2",
        f.signal,
      );
      await o.onTool(
        "native_review",
        {
          approved: true,
          requestSatisfied: true,
          problems: [],
          reviewedSlideIndexes: [0],
        },
        "3",
        f.signal,
      );
      await o.onTool(
        "native_edit",
        { op: "move", elementId: "0/0", x: 100, y: 100 },
        "4",
        f.signal,
      );
    });
    expect(await f.run()).toMatchObject({
      reviewed: false,
      status: "needs_review",
    });
  });
  it("requires explicit review coverage for every changed slide", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      await o.onTool(
        "native_edit",
        { op: "replace_text", elementId: "0/0", text: "After" },
        "2",
        f.signal,
      );
      expect(
        (
          await o.onTool(
            "native_review",
            {
              approved: true,
              requestSatisfied: true,
              problems: [],
              reviewedSlideIndexes: [],
            },
            "3",
            f.signal,
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await o.onTool(
            "native_review",
            {
              approved: true,
              requestSatisfied: true,
              problems: [],
              reviewedSlideIndexes: [0],
            },
            "4",
            f.signal,
          )
        ).success,
      ).toBe(true);
    });

    expect(await f.run()).toMatchObject({
      changed: true,
      reviewed: true,
      status: "completed",
    });
  });
  it("asks a model that edited and stopped to look at the result", async () => {
    const f = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          f.signal,
        );
        await o.onTool(
          "native_edit",
          { op: "replace_text", elementId: "0/0", text: "After" },
          "2",
          f.signal,
        );
      },
      permission,
      changedState,
      state,
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "3",
          f.signal,
        );
        expect(
          (
            await o.onTool(
              "native_review",
              {
                approved: true,
                requestSatisfied: true,
                problems: [],
                reviewedSlideIndexes: [0],
              },
              "4",
              f.signal,
            )
          ).success,
        ).toBe(true);
      },
    );
    const result = await f.run();
    expect(f.turns()).toBe(2);
    expect(result).toMatchObject({
      changed: true,
      reviewed: true,
      status: "completed",
    });
    expect(result.text).not.toContain(UNREVIEWED_EDIT_NOTICE);
  });
  it("says plainly that an edit is unconfirmed when the review never happens", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      await o.onTool(
        "native_edit",
        { op: "replace_text", elementId: "0/0", text: "After" },
        "2",
        f.signal,
      );
    });
    const result = await f.run();
    expect(f.turns()).toBe(2);
    expect(result).toMatchObject({ reviewed: false, status: "needs_review" });
    expect(result.text).toContain(UNREVIEWED_EDIT_NOTICE);
  });
  it("offers only observation and review in the enforced review step", async () => {
    let reviewTools: string[] = [];
    let blockedEdit: { success: boolean } | undefined;
    const f = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          f.signal,
        );
        await o.onTool(
          "native_edit",
          { op: "replace_text", elementId: "0/0", text: "After" },
          "2",
          f.signal,
        );
      },
      permission,
      changedState,
      state,
      async (o) => {
        reviewTools = o.tools.map((tool) => tool.name);
        blockedEdit = await o.onTool(
          "native_edit",
          { op: "replace_text", elementId: "0/1", text: "Unrelated" },
          "3",
          f.signal,
        );
      },
    );
    const callsBeforeRun = f.call.mock.calls.length;
    const result = await f.run();
    expect(reviewTools.sort()).toEqual(["native_observe", "native_review"]);
    expect(blockedEdit?.success).toBe(false);
    expect(
      f.call.mock.calls
        .slice(callsBeforeRun)
        .filter(([request]) => request.operation !== "observe"),
    ).toHaveLength(1);
    expect(result).toMatchObject({ reviewed: false, status: "needs_review" });
  });
  it("says so when an edit call fails even if the model claims success", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      const edit = await o.onTool(
        "native_batch_edit",
        {
          dryRun: false,
          commands: [{ op: "replace_text", elementId: "0/0", text: "After" }],
        },
        "2",
        f.signal,
      );
      expect(edit.success).toBe(false);
    });
    f.call.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.operation !== "observe")
        throw new Error("native_task_expired");
      return structuredClone(state);
    });
    const result = await f.run();
    expect(result).toMatchObject({
      changed: false,
      status: "needs_review",
      task: { outcome: "unverified" },
    });
    expect(result.text).toContain(UNCONFIRMED_EDIT_NOTICE);
  });
  it("adds no failure notice to a dry run that fails", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      await o.onTool(
        "native_batch_edit",
        {
          dryRun: true,
          commands: [{ op: "replace_text", elementId: "0/0", text: "After" }],
        },
        "2",
        f.signal,
      );
    });
    f.call.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.operation !== "observe") throw new Error("invalid_plan");
      return structuredClone(state);
    });
    expect((await f.run()).text).not.toContain(UNCONFIRMED_EDIT_NOTICE);
  });
  it("does not ask for a review when nothing changed", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
    });
    expect(await f.run()).toMatchObject({
      changed: false,
      status: "needs_review",
      task: { outcome: "unverified" },
    });
    expect(f.turns()).toBe(1);
  });
  it("cannot approve a mutation with a newly introduced layout issue", async () => {
    const issueState: NativeObservation = {
      ...structuredClone(changedState),
      layoutAudit: {
        issueCount: 1,
        issues: [{ code: "overlap", slideIndex: 0 }],
        introducedIssueCount: 1,
        introducedIssues: [{ code: "overlap", slideIndex: 0 }],
      },
    };
    const f = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          f.signal,
        );
        await o.onTool(
          "native_edit",
          { op: "move", elementId: "0/0", x: 100, y: 100 },
          "2",
          f.signal,
        );
        expect(
          (
            await o.onTool(
              "native_review",
              {
                approved: true,
                requestSatisfied: true,
                problems: [],
                reviewedSlideIndexes: [0],
              },
              "3",
              f.signal,
            )
          ).success,
        ).toBe(false);
      },
      permission,
      issueState,
    );

    expect(await f.run()).toMatchObject({
      changed: true,
      reviewed: false,
      status: "needs_review",
    });
  });
  it("does not accept a mutation result without complete fresh screenshots", async () => {
    const incompleteState: NativeObservation = {
      ...structuredClone(changedState),
      images: [],
      visualEvidenceComplete: false,
    };
    const f = fixture(
      async (o) => {
        await o.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "1",
          f.signal,
        );
        expect(
          (
            await o.onTool(
              "native_edit",
              { op: "move", elementId: "0/0", x: 100, y: 100 },
              "2",
              f.signal,
            )
          ).success,
        ).toBe(false);
      },
      permission,
      incompleteState,
    );

    expect(await f.run()).toMatchObject({ changed: false, reviewed: false });
  });
  it("does not claim success when the live engine rejects stale state", async () => {
    const f = fixture(async (o) => {
      await o.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "1",
        f.signal,
      );
      f.call.mockRejectedValueOnce(new Error("document_changed_observe_again"));
      expect(
        (
          await o.onTool(
            "native_edit",
            { op: "move", elementId: "0/0", x: 100, y: 100 },
            "2",
            f.signal,
          )
        ).success,
      ).toBe(false);
      const retry = await o.onTool(
        "native_edit",
        { op: "move", elementId: "0/0", x: 100, y: 100 },
        "3",
        f.signal,
      );
      expect(retry.success).toBe(false);
      expect(f.call).toHaveBeenCalledTimes(2);
    });
    expect(await f.run()).toMatchObject({ changed: false, reviewed: false });
  });

  it.each([
    ["insert_image", "image", { slideIndex: 0 }],
    ["replace_image", "image", { elementId: "0/0" }],
    ["insert_media", "media", { slideIndex: 0 }],
    ["replace_media", "media", { elementId: "0/0" }],
  ] as const)(
    "routes %s through the trusted top-level asset boundary",
    async (operation, kind, target) => {
      const command = {
        op: operation,
        assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
        ...target,
      };
      const f = fixture(
        async (options) => {
          await options.onTool(
            "native_observe",
            { detailSlideIndex: null },
            "observe",
            f.signal,
          );
          expect(
            (
              await options.onTool(
                "native_edit",
                command,
                "asset-edit",
                f.signal,
              )
            ).success,
          ).toBe(true);
        },
        permission,
        changedState,
        {
          ...state,
          assets: [
            {
              assetId: command.assetId,
              fileName: kind === "image" ? "diagram.png" : "clip.mp4",
              contentType: kind === "image" ? "image/png" : "video/mp4",
              kind,
              width: kind === "image" ? 1280 : 0,
              height: kind === "image" ? 720 : 0,
            },
          ],
        },
      );
      await f.run();
      expect(f.call).toHaveBeenLastCalledWith(
        {
          ...command,
          operation,
          slideIndex: 0,
          expectedRevision: "v2-test",
          expectedSlides: JSON.stringify(state.slides),
          permission,
        },
        f.signal,
      );
    },
  );

  it("rejects an unobserved or wrong-kind platform asset", async () => {
    const f = fixture(
      async (options) => {
        await options.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "observe",
          f.signal,
        );
        const unobserved = await options.onTool(
          "native_edit",
          {
            op: "insert_image",
            assetId: "99999999-9999-4999-8999-999999999999",
            slideIndex: 0,
          },
          "unobserved",
          f.signal,
        );
        expect(unobserved.success).toBe(false);
        const wrongKind = await options.onTool(
          "native_edit",
          {
            op: "insert_media",
            assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
            slideIndex: 0,
          },
          "wrong-kind",
          f.signal,
        );
        expect(wrongKind.success).toBe(false);
      },
      permission,
      changedState,
      {
        ...state,
        assets: [
          {
            assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
            fileName: "diagram.png",
            contentType: "image/png",
            kind: "image",
            width: 1280,
            height: 720,
          },
        ],
      },
    );
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("rejects platform asset delivery inside an atomic command batch", async () => {
    const f = fixture(async (options) => {
      await options.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "observe",
        f.signal,
      );
      const result = await options.onTool(
        "native_batch_edit",
        {
          commands: [
            {
              op: "insert_media",
              assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
              slideIndex: 0,
            },
          ],
          dryRun: false,
        },
        "asset-batch",
        f.signal,
      );
      expect(result.success).toBe(false);
    });
    await f.run();
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("stores a generated image, inserts it as a native object, then starts a visual review turn", async () => {
    const inserted: NativeObservation = {
      ...structuredClone(state),
      slides: [
        {
          ...structuredClone(state.slides[0]),
          elements: [
            ...structuredClone(state.slides[0].elements),
            {
              elementId: "0/2",
              kind: "com.sun.star.drawing.GraphicObjectShape",
            },
          ],
        },
      ],
      revision: "v2-image",
      changedSlideIndexes: [0],
      visualEvidenceComplete: true,
    };
    let imageInserted = false;
    const call = vi.fn(
      async (request: Record<string, unknown>, _signal: AbortSignal) => {
        if (request.operation === "insert_image") imageInserted = true;
        return structuredClone(imageInserted ? inserted : state);
      },
    );
    const createImage = vi.fn(async () => ({
      assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
    }));
    let invocation = 0;
    const client = {
      supportsImageGeneration: true,
      supportsImageGenerationForModel: async () => true,
      runStructuredTurn: async (
        _a: unknown,
        _b: unknown,
        _c: unknown,
        options: AgentTurnOptions,
      ) => {
        invocation += 1;
        if (invocation === 1) {
          expect(options.allowImageGeneration).toBe(true);
          await options.onTool(
            "native_observe",
            { detailSlideIndex: null },
            "observe",
            signal,
          );
          await options.onGeneratedImage?.({
            bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            mediaType: "image/png",
          });
          return "이미지를 생성했습니다.";
        }
        expect(options.allowImageGeneration).toBe(false);
        await options.onTool(
          "native_observe",
          { detailSlideIndex: null },
          "review-observe",
          signal,
        );
        await options.onTool(
          "native_review",
          {
            approved: true,
            requestSatisfied: true,
            problems: [],
            reviewedSlideIndexes: [0],
          },
          "review",
          signal,
        );
        return JSON.stringify({
          intent: "edit",
          goal: "이미지 삽입",
          outcome: "applied",
          message: "삽입된 이미지를 확인했습니다.",
          reason: "",
        });
      },
    } as unknown as AppServerClient;
    const signal = new AbortController().signal;
    const result = await runNativeTurn(client, {
      requestText: "이 슬라이드에 추상 이미지를 만들어 넣어줘",
      host: { call, createImage },
      signal,
      permission,
      onText: vi.fn(),
      onTool: vi.fn(),
    });

    expect(result).toMatchObject({
      text: "삽입된 이미지를 확인했습니다.",
      changed: true,
      reviewed: true,
      status: "completed",
    });
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      {
        operation: "insert_image",
        assetId: "38c76733-fbed-40cc-98b0-5237aaec6387",
        slideIndex: 0,
        expectedRevision: "v2-test",
        expectedSlides: JSON.stringify(state.slides),
        permission,
      },
      signal,
    );
  });

  it("does not insert a generated image outside the granted slide", async () => {
    const createImage = vi.fn(async () => ({ assetId: "unused" }));
    const restricted: NativePermission = {
      mode: "slides",
      elementIds: [],
      slideIndexes: [1],
    };
    const f = fixture(async (options) => {
      await options.onTool(
        "native_observe",
        { detailSlideIndex: null },
        "observe",
        f.signal,
      );
      await expect(
        options.onGeneratedImage?.({
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          mediaType: "image/png",
        }),
      ).rejects.toThrow("허용된 슬라이드 밖입니다");
    }, restricted);
    await runNativeTurn(
      {
        supportsImageGeneration: true,
        supportsImageGenerationForModel: async () => true,
        runStructuredTurn: async (
          _a: unknown,
          _b: unknown,
          _c: unknown,
          options: AgentTurnOptions,
        ) => {
          await options.onTool(
            "native_observe",
            { detailSlideIndex: null },
            "observe",
            f.signal,
          );
          await expect(
            options.onGeneratedImage?.({
              bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
              mediaType: "image/png",
            }),
          ).rejects.toThrow("허용된 슬라이드 밖입니다");
          return "삽입하지 않았습니다.";
        },
      } as unknown as AppServerClient,
      {
        requestText: "이미지를 넣어줘",
        host: { call: f.call, createImage },
        signal: f.signal,
        permission: restricted,
        onText: vi.fn(),
        onTool: vi.fn(),
      },
    );
    expect(createImage).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledTimes(1);
  });
});

it("keeps theme and layout targets while excluding non-editable master drawings from model output", () => {
  const full = {
    ...state,
    masters: [
      {
        masterIndex: 0,
        theme: { name: "Theme", majorLatin: "Arial" },
        drawings: [{ text: "x".repeat(100000) }],
        layouts: [
          { layoutIndex: 0, name: "Title", drawings: [{ text: "template" }] },
        ],
      },
    ],
  };
  const model = nativeModelObservation(full);
  expect(model.masters).toEqual([
    {
      masterIndex: 0,
      theme: { name: "Theme", majorLatin: "Arial" },
      layouts: [{ layoutIndex: 0, name: "Title" }],
    },
  ]);
  expect(model.slides).toEqual(full.slides);
  expect(full.masters[0].drawings[0].text.length).toBe(100000);
  expect(full.images).toBe(state.images);
  expect(model.images).toBeUndefined();
});

it("scopes detailed model data to observed slides while keeping the full host revision and document", () => {
  const full = {
    ...state,
    slides: Array.from({ length: 50 }, (_, slideIndex) => ({
      slideIndex,
      elements: [
        {
          elementId: slideIndex + "/0",
          text: "Long authored text " + "x".repeat(20000),
        },
      ],
    })),
    textDetails: { slideIndex: 2, elements: [] },
    images: [{ slideIndex: 2, pngBase64: "iVBORw0KGgo=" }],
  };
  const model = nativeModelObservation(full);
  expect(model.slides[0]).toBe(full.slides[0]);
  expect(model.slides[2]).toBe(full.slides[2]);
  expect(model.slides[49]).toEqual({
    slideIndex: 49,
    elementCount: 1,
    previewText: full.slides[49].elements[0].text.slice(0, 200),
    detailsAvailable: true,
  });
  expect(full.slides[49].elements[0].text.length).toBeGreaterThan(20000);
  expect(model.revision).toBe(full.revision);
  expect(JSON.stringify(model).length).toBeLessThan(100000);
});
