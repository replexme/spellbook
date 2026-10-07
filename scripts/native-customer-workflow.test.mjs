/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  runNativeTurn,
  newModelInput,
} = require("../contracts/native-turn-runtime.cjs");
const {
  simpleGoalCommands,
  normalizeActiveGoal,
  goalChecks,
  verifyGoalChecks,
  prepareActiveGoal,
} = require("../contracts/native-goal.cjs");
const {
  boundedConversationHistory,
  continuationGoal,
} = require("../contracts/native-turn-policy.cjs");
const {
  validateOperationArguments,
  nativeEditContract,
  nativeAssetEditSchema,
  nativeBatchEditSchema,
} = require("../contracts/native-edit-tools.cjs");
const permission = { mode: "document", slideIndexes: [], elementIds: [] };
const image = {
  elementId: "0/0",
  kind: "image",
  width: 2000,
  height: 2000,
  onlyoffice: { geometry: { preset: "rect" } },
};
const before = {
  revision: "r1",
  activeSlide: 0,
  selectedElementIds: [],
  engine: { supportedOperations: ["crop_image", "replace_text"] },
  textDetails: { slideIndex: 0, elements: [] },
  slides: [{ slideIndex: 0, elements: [image] }],
  images: [{ slideIndex: 0, pngBase64: "iVBORw0KGgo=" }],
  changedSlideIndexes: [],
  visualEvidenceComplete: true,
};
const review = {
  approved: true,
  requestSatisfied: true,
  problems: [],
  reviewedSlideIndexes: [0],
};
const completion = (extra = {}) =>
  JSON.stringify({
    intent: "edit",
    goal: "사진을 원형으로 잘라줘",
    outcome: "applied",
    message: "사진을 원형으로 잘랐습니다.",
    reason: "",
    review,
    ...extra,
  });
const input = (host) => ({
  requestText: "사진을 원형으로 잘라줘. 위치는 유지해줘",
  documentScope: "document-1",
  permission,
  initialObservation: structuredClone(before),
  host,
  web: { search: async () => [], readPage: async () => "" },
  signal: new AbortController().signal,
  onText: () => {},
  onTool: () => {},
});

test("pending goal survives 12-turn/24k context truncation, questions, cancellation and scope changes", () => {
  const goal = prepareActiveGoal("사진을 원형으로 잘라줘", null, "document-1");
  const history = boundedConversationHistory(
    Array.from({ length: 20 }, () => ({
      request: "어떤 사진이야?",
      response: "사진 설명",
      status: "completed",
    })),
  );
  assert.equal(history.length, 12);
  assert.equal(
    continuationGoal(
      "진행 하라고",
      history,
      normalizeActiveGoal(goal, "document-1"),
    ),
    goal.request,
  );
  assert.deepEqual(prepareActiveGoal("왜 그래?", goal, "document-1"), goal);
  assert.equal(normalizeActiveGoal(goal, "document-2"), null);
  for (const phrase of [
    "하라니까? 왜 자꾸 멈추는데",
    "아까 요청을 다시 해줘",
    "그 작업 이어서 해줘",
  ])
    assert.equal(continuationGoal(phrase, history, goal), goal.request);
  assert.equal(
    continuationGoal("그 작업 말고 제목을 바꿔줘", history, goal),
    null,
  );
});

test("status questions receive the durable goal after history truncation without executing it", async () => {
  const activeGoal = prepareActiveGoal(
    "사진을 원형으로 잘라줘",
    null,
    "document-1",
  );
  const host = {
    call: async () => {
      throw Error("question_must_not_edit");
    },
  };
  const result = await runNativeTurn(
    {
      run: async (options) => {
        assert(
          options.instructions.includes(
            "Durable pending goal for this document:",
          ),
        );
        assert(options.instructions.includes(activeGoal.request));
        return completion({
          intent: "answer",
          outcome: "answered",
          message: "사진을 원형으로 바꾸는 일이 남았습니다.",
          review: null,
        });
      },
    },
    {
      ...input(host),
      requestText: "무슨 작업이 남았어?",
      activeGoal,
      conversationHistory: [],
    },
  );
  assert.equal(result.task.outcome, "answered");
  assert.deepEqual(result.activeGoal, activeGoal);
  assert.equal(result.changed, false);
});
test("circle is an ellipse with equal frame dimensions, not any successful command or an oval", () => {
  const checks = goalChecks("사진을 원형으로 잘라줘", before, permission);
  assert.equal(verifyGoalChecks(checks, before).passed, false);
  const after = structuredClone(before);
  after.slides[0].elements[0].onlyoffice.geometry.preset = "ellipse";
  assert.equal(verifyGoalChecks(checks, after).passed, true);
  after.slides[0].elements[0].width = 3000;
  assert.equal(verifyGoalChecks(checks, after).passed, false);
  assert.deepEqual(
    goalChecks("모든 사진을 원형으로 잘라줘", before, {
      mode: "slides",
      slideIndexes: [1],
      elementIds: [],
    }),
    [],
  );
});
test("every executable operation has argument metadata and unused values are rejected", () => {
  const ops = nativeEditContract.mutationModel.operations;
  for (const [op, metadata] of Object.entries(ops))
    if (metadata.availability !== "format_excluded") {
      assert(Array.isArray(metadata.arguments), op);
      assert.equal(
        new Set(metadata.arguments).size,
        metadata.arguments.length,
        op,
      );
      for (const field of metadata.arguments)
        assert(
          field in nativeEditContract.toolInputSchema.properties,
          op + ":" + field,
        );
      assert.equal(validateOperationArguments({ op }), true);
    }
  assert.throws(
    () =>
      validateOperationArguments({
        op: "replace_text",
        elementId: "0/0",
        text: "title",
        geometry: "ellipse",
      }),
    /argument_unused/,
  );
  assert.throws(
    () =>
      validateOperationArguments({
        op: "crop_image",
        elementId: "0/0",
        geometry: "line",
      }),
    /image_shape/,
  );
  assert.throws(
    () =>
      validateOperationArguments({
        op: "crop_image",
        elementId: "0/0",
        unexpected: null,
      }),
    /argument_unused/,
  );
  assert(nativeAssetEditSchema.properties.op.enum.length === 4);
  assert.equal(
    nativeBatchEditSchema.properties.commands.items.properties.op.enum.length,
    94,
  );
});
test("final visual review and message complete in one provider run, after fresh editor readback", async () => {
  const after = structuredClone(before);
  after.revision = "r2";
  after.changedSlideIndexes = [0];
  after.slides[0].elements[0].onlyoffice.geometry.preset = "ellipse";
  let current = before,
    modelCalls = 0,
    hostCalls = 0;
  const host = {
    call: async (request) => {
      hostCalls++;
      if (request.operation === "edit_batch") current = after;
      return structuredClone(current);
    },
  };
  const model = {
    run: async (options) => {
      modelCalls++;
      const result = await options.onTool(
        "native_batch_edit",
        {
          commands: [
            {
              op: "crop_image",
              elementId: "0/0",
              geometry: "ellipse",
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            },
          ],
          dryRun: false,
        },
        options.signal,
      );
      assert(result.ok);
      assert(!options.tools.some((tool) => tool.name === "native_review"));
      return completion();
    },
  };
  const result = await runNativeTurn(model, input(host));
  assert.equal(result.task.outcome, "fulfilled");
  assert.equal(result.activeGoal, null);
  assert.equal(modelCalls, 1);
  assert.equal(hostCalls, 2);
  assert.equal(result.modelInput.hostCalls, 2);
});
test("a model cannot approve a rectangle as a fulfilled circular photo", async () => {
  const after = {
    ...structuredClone(before),
    revision: "r2",
    changedSlideIndexes: [0],
  };
  let current = before;
  const host = {
    call: async (request) => {
      if (request.operation === "edit_batch") current = after;
      return structuredClone(current);
    },
  };
  let modelCalls = 0;
  const result = await runNativeTurn(
    {
      run: async (options) => {
        if (!modelCalls++)
          await options.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
              ],
              dryRun: false,
            },
            options.signal,
          );
        return completion();
      },
    },
    input(host),
  );
  assert.equal(result.task.outcome, "unverified");
  assert.equal(result.requestSatisfied, false);
  assert(result.activeGoal.checks.length === 1);
});
test("human changes invalidate final review even after a successful edit", async () => {
  let current = before;
  const after = {
    ...structuredClone(before),
    revision: "r2",
    changedSlideIndexes: [0],
  };
  after.slides[0].elements[0].onlyoffice.geometry.preset = "ellipse";
  const host = {
    call: async (request) => {
      if (request.operation === "edit_batch") current = after;
      else if (current.revision === "r2")
        current = { ...after, revision: "human-r3" };
      return structuredClone(current);
    },
  };
  let calls = 0;
  const result = await runNativeTurn(
    {
      run: async (options) => {
        if (!calls++)
          await options.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
              ],
              dryRun: false,
            },
            options.signal,
          );
        return completion();
      },
    },
    input(host),
  );
  assert.equal(result.task.outcome, "unverified");
  assert.equal(result.reviewed, false);
});
test("aborted queued work never runs, while failure timing is retained", async () => {
  const controller = new AbortController(),
    metrics = newModelInput();
  let mutations = 0;
  const turn = {
    ...input({
      call: async () => {
        mutations++;
        return before;
      },
    }),
    signal: controller.signal,
    modelInput: metrics,
  };
  await assert.rejects(
    runNativeTurn(
      {
        run: async (options) => {
          controller.abort();
          await options.onTool(
            "native_batch_edit",
            {
              commands: [
                { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
              ],
              dryRun: false,
            },
            options.signal,
          );
          return completion();
        },
      },
      turn,
    ),
    /abort/i,
  );
  assert.equal(mutations, 0);
  assert(Number.isInteger(metrics.elapsedMs));
});

test("simple native execution accepts only the complete unique square-picture instruction", () => {
  const checks = goalChecks("사진을 원형으로 잘라줘", before, permission);
  assert.deepEqual(
    simpleGoalCommands("사진을 원형으로 잘라줘", checks, before, permission),
    [{ op: "crop_image", elementId: "0/0", geometry: "ellipse" }],
  );
  assert.equal(
    simpleGoalCommands(
      "사진을 원형으로 잘라줘. 제목도 바꿔줘",
      checks,
      before,
      permission,
    ),
    null,
  );
  assert.equal(
    simpleGoalCommands("사진을 원형으로 잘라줘", checks, before, {
      ...permission,
      mode: "read_only",
    }),
    null,
  );
  const rectangle = structuredClone(before);
  rectangle.slides[0].elements[0].width = 4000;
  assert.equal(
    simpleGoalCommands("사진을 원형으로 잘라줘", checks, rectangle, permission),
    null,
  );
});

test("a failed objective is repaired using fresh images in a new provider call", async () => {
  let current = structuredClone(before),
    mutations = 0,
    calls = 0;
  const result = await runNativeTurn(
    {
      run: async (options) => {
        calls++;
        if (calls === 2) {
          assert(options.initialPage.images.length === 1);
          assert.equal(JSON.parse(options.initialPage.text).revision, "r2");
          assert(
            options.tools.some((tool) => tool.name === "native_batch_edit"),
          );
        }
        const edited = await options.onTool(
          "native_batch_edit",
          {
            commands: [
              { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
            ],
            dryRun: false,
          },
          options.signal,
        );
        assert(edited.ok);
        return completion();
      },
    },
    input({
      call: async (request) => {
        if (request.operation === "edit_batch") {
          mutations++;
          current.revision = "r" + (mutations + 1);
          current.changedSlideIndexes = [0];
          if (mutations === 2)
            current.slides[0].elements[0].onlyoffice.geometry.preset =
              "ellipse";
        }
        return structuredClone(current);
      },
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.task.outcome, "fulfilled");
});

test("known no-effect rejections can recover; ambiguous transport failures stay unverified", async () => {
  for (const error of [
    "product_mutation_rejected:invalid",
    "product_mutation_rolled_back:invalid",
    "transport_timeout",
  ]) {
    let current = structuredClone(before),
      mutations = 0;
    const result = await runNativeTurn(
      {
        run: async (options) => {
          const command = {
            commands: [
              { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
            ],
            dryRun: false,
          };
          const failed = await options.onTool(
            "native_batch_edit",
            command,
            options.signal,
          );
          assert.equal(failed.ok, false);
          await options.onTool(
            "native_observe",
            { detailSlideIndex: 0 },
            options.signal,
          );
          assert(
            (await options.onTool("native_batch_edit", command, options.signal))
              .ok,
          );
          return completion();
        },
      },
      input({
        call: async (request) => {
          if (request.operation === "edit_batch") {
            if (!mutations++) throw Error(error);
            current.revision = "r2";
            current.changedSlideIndexes = [0];
            current.slides[0].elements[0].onlyoffice.geometry.preset =
              "ellipse";
          }
          return structuredClone(current);
        },
      }),
    );
    assert.equal(
      result.task.outcome,
      error === "transport_timeout" ? "unverified" : "fulfilled",
      error,
    );
  }
});

test("successive edits require final screenshots and review for every touched slide", async () => {
  const initial = structuredClone(before);
  initial.slides.push({
    slideIndex: 1,
    elements: [{ ...structuredClone(image), elementId: "1/0" }],
  });
  let current = initial,
    mutations = 0,
    captured = [];
  const result = await runNativeTurn(
    {
      run: async (options) => {
        for (const slide of [0, 1])
          assert(
            (
              await options.onTool(
                "native_batch_edit",
                {
                  commands: [
                    {
                      op: "crop_image",
                      elementId: slide + "/0",
                      geometry: "ellipse",
                    },
                  ],
                  dryRun: false,
                },
                options.signal,
              )
            ).ok,
          );
        return completion({
          review: { ...review, reviewedSlideIndexes: [0, 1] },
        });
      },
    },
    {
      ...input({
        call: async (request) => {
          if (request.operation === "edit_batch") {
            const slide = mutations++;
            current = structuredClone(current);
            current.revision = "r" + (mutations + 1);
            current.slides[slide].elements[0].onlyoffice.geometry.preset =
              "ellipse";
            current.images = [{ ...before.images[0], slideIndex: slide }];
            current.changedSlideIndexes = [slide];
          }
          if (request.captureSlideIndexes) {
            captured = request.captureSlideIndexes;
            return {
              ...structuredClone(current),
              images: captured.map((slideIndex) => ({
                ...before.images[0],
                slideIndex,
              })),
            };
          }
          return structuredClone(current);
        },
      }),
      requestText: "모든 사진을 원형으로 잘라줘",
      initialObservation: initial,
    },
  );
  assert.deepEqual(captured, [0, 1]);
  assert.equal(result.task.outcome, "fulfilled");
});

test("circle check preserves the actual source media fingerprint", () => {
  const source = structuredClone(before);
  source.slides[0].onlyoffice = {
    drawings: [{ imagePath: "sha256:" + "a".repeat(64) }],
  };
  const checks = goalChecks("사진을 원형으로 잘라줘", source, permission);
  source.slides[0].elements[0].onlyoffice.geometry.preset = "ellipse";
  assert(verifyGoalChecks(checks, source).passed);
  source.slides[0].onlyoffice.drawings[0].imagePath =
    "sha256:" + "b".repeat(64);
  assert.equal(verifyGoalChecks(checks, source).passed, false);
});

test("repair removes introduced layout defects without hiding old document warnings", async () => {
  const initial = structuredClone(before);
  initial.layoutAudit = {
    issues: [{ code: "old_warning", slideIndex: 0 }],
    issueCount: 1,
  };
  let current = initial,
    calls = 0,
    mutations = 0;
  const result = await runNativeTurn(
    {
      run: async (options) => {
        calls++;
        assert(
          (
            await options.onTool(
              "native_batch_edit",
              {
                commands: [
                  { op: "crop_image", elementId: "0/0", geometry: "ellipse" },
                ],
                dryRun: false,
              },
              options.signal,
            )
          ).ok,
        );
        return completion();
      },
    },
    {
      ...input({
        call: async (request) => {
          if (request.operation === "edit_batch") {
            current = structuredClone(current);
            current.revision = "r" + (++mutations + 1);
            current.changedSlideIndexes = [0];
            current.slides[0].elements[0].onlyoffice.geometry.preset =
              "ellipse";
            current.layoutAudit =
              mutations === 1
                ? {
                    issues: [
                      ...initial.layoutAudit.issues,
                      { code: "new_overlap", slideIndex: 0 },
                    ],
                    issueCount: 2,
                  }
                : { ...initial.layoutAudit, introducedIssueCount: 1 };
          }
          return structuredClone(current);
        },
      }),
      initialObservation: initial,
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.task.outcome, "fulfilled");
});

test("direct native execution counts only the result actually sent to the model", async () => {
  let current = structuredClone(before);
  const result = await runNativeTurn(
    {
      run: async (options) => {
        assert.equal(JSON.parse(options.initialPage.text).revision, "r2");
        assert.equal(options.initialPage.images.length, 1);
        return completion();
      },
    },
    {
      ...input({
        call: async (request) => {
          if (request.operation === "edit_batch") {
            current.revision = "r2";
            current.changedSlideIndexes = [0];
            current.slides[0].elements[0].onlyoffice.geometry.preset =
              "ellipse";
          }
          return structuredClone(current);
        },
      }),
      requestText: "사진을 원형으로 잘라줘",
    },
  );
  assert.equal(result.task.outcome, "fulfilled");
  assert.equal(result.modelInput.calls, 1);
  assert.equal(result.modelInput.imageCount, 1);
});

test("an asynchronously inserted generated image is reviewed only after its slide image is delivered", async () => {
  let current = structuredClone(before),
    calls = 0;
  const result = await runNativeTurn(
    {
      allowImageGeneration: true,
      run: async (options) => {
        calls++;
        if (calls === 1) await options.onGeneratedImage({ bytes: [] });
        else {
          assert.equal(JSON.parse(options.initialPage.text).revision, "r2");
          assert.equal(options.initialPage.images.length, 1);
        }
        return completion({ goal: "새 사진 추가" });
      },
    },
    {
      ...input({
        createImage: async () => ({ assetId: "new-image" }),
        call: async (request) => {
          if (request.operation === "insert_image") {
            current = structuredClone(current);
            current.revision = "r2";
            current.changedSlideIndexes = [0];
            current.slides[0].elements.push({ ...image, elementId: "0/1" });
          }
          return structuredClone(current);
        },
      }),
      requestText: "새 사진을 추가해줘",
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.task.outcome, "fulfilled");
  assert.equal(result.modelInput.imageCount, 2);
});

test("a provider that cannot receive images cannot approve an unseen slide", async () => {
  let current = structuredClone(before);
  const result = await runNativeTurn(
    { supportsInputImages: false, run: async () => completion() },
    {
      ...input({
        call: async (request) => {
          if (request.operation === "edit_batch") {
            current.revision = "r2";
            current.changedSlideIndexes = [0];
            current.slides[0].elements[0].onlyoffice.geometry.preset =
              "ellipse";
          }
          return structuredClone(current);
        },
      }),
      requestText: "사진을 원형으로 잘라줘",
    },
  );
  assert.equal(result.task.outcome, "unverified");
  assert.equal(result.reviewed, false);
  assert.equal(result.modelInput.imageCount, 0);
});
