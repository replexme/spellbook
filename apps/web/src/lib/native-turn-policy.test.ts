import { describe, expect, it } from "vitest";
import {
  continuationGoal,
  finalizeTurn,
  parseCompletion,
} from "../../../../contracts/native-turn-policy.cjs";
const evidence = {
  requestText: "사진을 원형으로 잘라서 넣어줘",
  readOnly: false,
  changed: false,
  reviewed: false,
  requestSatisfied: false,
  unconfirmedMutation: false,
};
const report = (overrides = {}) =>
  JSON.stringify({
    intent: "edit",
    goal: evidence.requestText,
    outcome: "applied",
    message: "원형 사진으로 수정했습니다.",
    reason: "",
    ...overrides,
  });
describe("completion grounded in execution", () => {
  it("rejects the actual first false completion, with both old and structured output", () => {
    for (const raw of [
      "사진을 원형으로 크롭해 자연스럽게 보이도록 수정했습니다.",
      report(),
    ]) {
      const result = finalizeTurn(raw, evidence);
      expect(result.task.outcome).toBe("unverified");
      expect(result.text).not.toContain("수정했습니다");
    }
  });
  it("does not downgrade an explicit edit instruction to an answer", () => {
    expect(
      finalizeTurn(report({ intent: "answer", outcome: "answered" }), evidence)
        .task.outcome,
    ).toBe("unverified");
    expect(
      finalizeTurn(
        report({
          intent: "answer",
          outcome: "answered",
          message: "방법을 설명합니다.",
        }),
        { ...evidence, requestText: "원형으로 자르는 방법을 알려줘" },
      ).task.outcome,
    ).toBe("answered");
  });
  it("requires both visual review and confirmation of the requested result", () => {
    expect(
      finalizeTurn(report(), { ...evidence, changed: true, reviewed: true })
        .task.outcome,
    ).toBe("unverified");
    expect(
      finalizeTurn(report(), {
        ...evidence,
        changed: true,
        requestSatisfied: true,
      }).task.outcome,
    ).toBe("unverified");
    expect(
      finalizeTurn(report(), {
        ...evidence,
        changed: true,
        reviewed: true,
        requestSatisfied: true,
      }).task.outcome,
    ).toBe("fulfilled");
  });
  it("never turns a failed mutation into completion", () => {
    expect(
      finalizeTurn(report(), { ...evidence, unconfirmedMutation: true }).task
        .outcome,
    ).toBe("unverified");
  });
  it("answers questions without requiring a document change", () => {
    const result = finalizeTurn(
      report({
        intent: "answer",
        outcome: "answered",
        message: "현재 제목은 프로필입니다.",
      }),
      { ...evidence, requestText: "현재 제목이 뭐야?" },
    );
    expect(result.task.outcome).toBe("answered");
    expect(result.text).toBe("현재 제목은 프로필입니다.");
  });
  it("distinguishes already desired state and missing information from applied edits", () => {
    for (const outcome of ["unchanged", "needs_input"]) {
      const result = finalizeTurn(
        report({ outcome, message: "대상 사진을 선택해 주세요." }),
        evidence,
      );
      expect(result.task.outcome).toBe(outcome);
      expect(result.text).toContain("문서는 변경되지 않았습니다");
    }
  });
  it("does not repeat the unchanged notice when the server checks an already checked response", () => {
    for (const outcome of ["needs_input", "unchanged"]) {
      const worker = finalizeTurn(
        report({ outcome, message: "대상 사진을 선택해 주세요." }),
        evidence,
      );
      const server = finalizeTurn(
        report({ outcome, message: worker.text }),
        evidence,
      );
      expect(server.text).toBe(worker.text);
    }
  });
  it("does not state an invented engine limitation as a confirmed cause", () => {
    const result = finalizeTurn(
      report({
        outcome: "blocked",
        reason: "ONLYOFFICE는 원형 사진을 지원하지 않습니다.",
      }),
      evidence,
    );
    expect(result.text).not.toContain("지원하지 않습니다");
    expect(result.task.reason).toContain("ONLYOFFICE");
  });
  it("carries the original goal through corrections and repeated requests to proceed", () => {
    const history = [
      {
        request: evidence.requestText,
        changed: false,
        response: "수정했습니다.",
      },
      { request: "문서가 왜 안바꼈어", changed: false },
      { request: "되는 방안을 찾아와", changed: false },
    ];
    expect(continuationGoal("니가 그걸 진행하라니까", history)).toBe(
      evidence.requestText,
    );
    const first = finalizeTurn(
      report({ outcome: "blocked", reason: "방법 미확인" }),
      evidence,
    );
    expect(
      continuationGoal("진행 하라고", [
        { task: first.task },
        {
          task: {
            intent: "answer",
            goal: "왜 변경되지 않았는지 설명",
            outcome: "answered",
            reason: "",
          },
        },
      ]),
    ).toBe(evidence.requestText);
    expect(
      finalizeTurn(report({ intent: "answer", outcome: "answered" }), {
        ...evidence,
        requiredIntent: "edit",
      }).task.outcome,
    ).toBe("unverified");
    expect(
      continuationGoal("계속", [
        { task: { ...first.task, outcome: "fulfilled" } },
      ]),
    ).toBeNull();
    expect(continuationGoal("제목이 뭐야?", [{ task: first.task }])).toBeNull();
  });
  it("rejects malformed and excessively long completion reports", () => {
    for (const raw of [
      "{}",
      report({ goal: "" }),
      report({ message: "x".repeat(8001) }),
    ])
      expect(parseCompletion(raw)).toBeNull();
  });
});
