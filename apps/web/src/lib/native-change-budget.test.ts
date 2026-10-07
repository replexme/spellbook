import { describe, expect, it } from "vitest";

import {
  humanNativeSavePolicy,
  nativeSavePolicyFromTasks,
  reviewedAiSavePolicy,
} from "./native-change-budget";

const result = (changedSlideIndexes: number[]) => ({ changedSlideIndexes });

describe("native save change budgets", () => {
  it("ignores proven rejection/rollback and completed no-ops, but retains ambiguous failures", () => {
    const task = {
      id: "attempt",
      request: { operation: "edit", command: { op: "replace_text" } },
      result: null,
      taskStatus: "failed",
      turnStatus: "failed",
      changed: false,
      reviewed: false,
    };
    for (const error of [
      "product_mutation_rejected:invalid",
      "product_mutation_rolled_back:invalid",
    ])
      expect(nativeSavePolicyFromTasks([{ ...task, error }]).origin).toBe(
        "human",
      );
    expect(() =>
      nativeSavePolicyFromTasks([{ ...task, error: "transport_timeout" }]),
    ).toThrow("native_ai_change_review_pending");
    expect(
      nativeSavePolicyFromTasks([
        {
          ...task,
          taskStatus: "completed",
          turnStatus: "completed",
          result: result([]),
        },
      ]).origin,
    ).toBe("human");
  });
  it("accepts a person's explicit retention of completed unreviewed edits, never an ambiguous or running edit", () => {
    const task = {
      id: "edited",
      request: { operation: "edit", command: { op: "replace_text" } },
      result: result([0]),
      taskStatus: "completed",
      turnStatus: "completed",
      changed: true,
      reviewed: false,
    };
    expect(() => nativeSavePolicyFromTasks([task])).toThrow(
      "native_ai_change_review_pending",
    );
    const policy = nativeSavePolicyFromTasks([task], true);
    expect(policy.origin).toBe("human");
    expect(policy.taskIds).toEqual(["edited"]);
    expect(policy.budget.allowedCategories).not.toContain("macros");
    for (const change of [
      { turnStatus: "running" },
      { taskStatus: "failed" },
      { changed: false },
    ])
      expect(() =>
        nativeSavePolicyFromTasks([{ ...task, ...change }], true),
      ).toThrow("native_ai_change_review_pending");
    expect(
      nativeSavePolicyFromTasks([{ ...task, reviewed: true }]).origin,
    ).toBe("ai");
  });
  it("allows the complete native human surface but rejects opaque package mutation", () => {
    const policy = humanNativeSavePolicy();

    expect(policy.origin).toBe("human");
    expect(policy.budget.targetSlideIndexes).toBeNull();
    expect(policy.budget.allowPartCreationOrDeletion).toBe(true);
    expect(policy.budget.allowedCategories).toContain("slide_master_parts");
    expect(policy.budget.allowedCategories).toContain("diagram_parts");
    expect(policy.budget.allowedCategories).not.toContain("macros");
    expect(policy.budget.allowedCategories).not.toContain("custom_xml");
    expect(policy.budget.allowedCategories).not.toContain("unknown");
  });

  it("unions only the executed AI operation families and changed slides", () => {
    const policy = reviewedAiSavePolicy([
      {
        id: "task-text",
        request: {
          operation: "edit_batch",
          dryRun: false,
          commands: [
            { op: "replace_text", elementId: "0/0" },
            { op: "set_chart_data", elementId: "2/0" },
          ],
        },
        result: result([2, 0]),
      },
    ]);

    expect(policy).toMatchObject({
      origin: "ai",
      taskIds: ["task-text"],
      budget: {
        targetSlideIndexes: [0, 2],
        allowPartCreationOrDeletion: false,
      },
    });
    expect(policy.budget.allowedCategories).toEqual([
      "chart_parts",
      "embedded_workbooks",
      "slide_parts",
      "slide_relationships",
    ]);
  });

  it.each([
    "insert_image",
    "replace_image",
    "insert_media",
    "replace_media",
  ] as const)(
    "derives the %s save budget from the platform asset contract",
    (operation) => {
      const policy = reviewedAiSavePolicy([
        {
          id: `task-${operation}`,
          request: { operation, slideIndex: 1 },
          result: result([1]),
        },
      ]);

      expect(policy.budget.allowPartCreationOrDeletion).toBe(true);
      expect(policy.budget.allowedCategories).toEqual([
        "media_parts",
        "package_manifest",
        "presentation_relationships",
        "slide_parts",
        "slide_relationships",
      ]);
    },
  );

  it("fails closed when reviewed AI change evidence has no bounded mutation", () => {
    expect(() =>
      reviewedAiSavePolicy([
        {
          id: "task-observe",
          request: { operation: "observe" },
          result: result([]),
        },
      ]),
    ).toThrow("native_ai_change_evidence_missing");
    expect(() =>
      reviewedAiSavePolicy([
        {
          id: "task-unknown",
          request: {
            operation: "edit",
            command: { op: "run_arbitrary_macro" },
          },
          result: result([0]),
        },
      ]),
    ).toThrow("native_ai_change_budget_unknown_operation");
  });

  it("does not treat an unfinished AI edit as an unrestricted human save", () => {
    const edit = {
      id: "task-edit",
      request: { operation: "edit", command: { op: "replace_text" } },
      result: result([0]),
      taskStatus: "completed",
      turnStatus: "running",
      changed: false,
      reviewed: false,
    };
    expect(() => nativeSavePolicyFromTasks([edit])).toThrow(
      "native_ai_change_review_pending",
    );
    expect(() =>
      nativeSavePolicyFromTasks([
        { ...edit, turnStatus: "completed", changed: true },
      ]),
    ).toThrow("native_ai_change_review_pending");
    expect(() =>
      nativeSavePolicyFromTasks([
        { ...edit, taskStatus: "failed", turnStatus: "failed" },
      ]),
    ).toThrow("native_ai_change_review_pending");
  });

  it("ignores observation and dry-run tasks when deriving a reviewed AI budget", () => {
    const policy = nativeSavePolicyFromTasks([
      {
        id: "task-observe",
        request: { operation: "observe" },
        result: result([3]),
        taskStatus: "completed",
        turnStatus: "completed",
        changed: true,
        reviewed: true,
      },
      {
        id: "task-dry-run",
        request: { operation: "edit_batch", dryRun: true },
        result: result([2]),
        taskStatus: "completed",
        turnStatus: "completed",
        changed: true,
        reviewed: true,
      },
      {
        id: "task-edit",
        request: { operation: "edit", command: { op: "replace_text" } },
        result: result([0]),
        taskStatus: "completed",
        turnStatus: "completed",
        changed: true,
        reviewed: true,
      },
    ]);

    expect(policy).toMatchObject({
      origin: "ai",
      taskIds: ["task-edit"],
      budget: { allowedCategories: ["slide_parts"], targetSlideIndexes: [0] },
    });
    expect(
      nativeSavePolicyFromTasks([
        {
          id: "task-observe",
          request: { operation: "observe" },
          result: result([3]),
          taskStatus: "completed",
          turnStatus: "completed",
          changed: false,
          reviewed: false,
        },
      ]).origin,
    ).toBe("human");
  });
});
