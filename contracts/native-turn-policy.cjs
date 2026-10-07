// Shared by the browser, subscription connector and managed worker.
// Model interpretation is provisional; editor execution evidence wins.
const completionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["answer", "edit"] },
    goal: { type: "string" },
    outcome: {
      type: "string",
      enum: [
        "answered",
        "applied",
        "blocked",
        "needs_input",
        "unchanged",
        "unverified",
      ],
    },
    message: { type: "string" },
    reason: { type: "string" },
    review: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        approved: { type: "boolean" },
        requestSatisfied: { type: "boolean" },
        problems: { type: "array", items: { type: "string" } },
        reviewedSlideIndexes: {
          type: "array",
          items: { type: "integer", minimum: 0 },
        },
      },
      required: [
        "approved",
        "requestSatisfied",
        "problems",
        "reviewedSlideIndexes",
      ],
    },
  },
  required: ["intent", "goal", "outcome", "message", "reason", "review"],
};
const completionInstruction = `Return only JSON with intent (answer or edit), goal (the user's intended result, preserving an unfinished goal on continuation), outcome (answered, applied, blocked, needs_input, unchanged), message (Korean), and reason. Do not downgrade an edit request to an answer merely because no edit ran. Applied requires actual mutation and review of every returned changed-slide image. Include review (approved, requestSatisfied, problems, reviewedSlideIndexes) in your final JSON after inspecting those images; use null for an answer without changes. This final review and completion are one response; do not call native_review unless recovering an incomplete review. Unchanged never means an edit was applied. Blocked requires a concrete missing capability, permission or asset; do not invent a cause. An embedded picture is not a missing user upload. Use the live engine capabilities, not earlier assistant claims. The edit result already includes fresh screenshots; review them directly, without another observe unless more detail is needed. Before the final review, check the user's goal, not just the absence of layout problems; set requestSatisfied accordingly. A follow-up asking to proceed inherits the unfinished goal, not the previous unsupported workaround.`;

function parseCompletion(raw) {
  try {
    const value = JSON.parse(
      raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
    if (
      !["answer", "edit"].includes(value.intent) ||
      ![
        "answered",
        "applied",
        "blocked",
        "needs_input",
        "unchanged",
        "unverified",
      ].includes(value.outcome) ||
      !["goal", "message", "reason"].every(
        (k) => typeof value[k] === "string",
      ) ||
      !value.goal.trim() ||
      value.goal.length > 2000 ||
      value.message.length > 8000 ||
      value.reason.length > 2000
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function explicitEditRequest(request) {
  // Only unambiguous imperatives: questions about editing remain answers.
  if (
    /(?:하지\s*마|수정하지|변경하지|어떻게|방법|왜|가능|알려|설명|뭐|무엇)/u.test(
      request,
    )
  )
    return false;
  return (
    /(?:바꿔|고쳐|수정해|수정해\s*줘|변경해|잘라|넣어|추가해|삭제해|옮겨|만들어|크롭해|정렬해)/u.test(
      request,
    ) ||
    /^(?:change|replace|insert|remove|delete|crop|edit|move|align)\b/i.test(
      request.trim(),
    )
  );
}

function finalizeTurn(raw, evidence) {
  const report = parseCompletion(raw);
  const goal = report?.goal || evidence.requestText;
  const intent =
    evidence.requiredIntent ||
    (!evidence.readOnly && explicitEditRequest(evidence.requestText)
      ? "edit"
      : report?.intent) ||
    (evidence.readOnly ? "answer" : "edit");
  const result = (outcome, text, reason = "") => ({
    text,
    task: { intent, goal, outcome, reason },
  });
  if (evidence.unconfirmedMutation)
    return result(
      "unverified",
      "편집 적용 여부를 확인하지 못했습니다. 현재 문서를 다시 확인해야 합니다.",
      "unconfirmed_mutation",
    );
  if (evidence.changed) {
    if (!evidence.reviewed || !evidence.requestSatisfied)
      return result(
        "unverified",
        "문서에 변경이 있지만 요청한 결과의 검수가 완료되지 않았습니다.",
        "goal_review_missing",
      );
    if (!report || report.intent !== "edit" || report.outcome !== "applied")
      return result(
        "unverified",
        "문서 변경과 화면 검수는 확인했지만 요청 전체의 완료 설명이 확인되지 않았습니다.",
        "completion_mismatch",
      );
    return result("fulfilled", report.message);
  }
  if (!report) {
    if (evidence.readOnly) return result("answered", raw.trim());
    return result(
      "unverified",
      "실제 문서 편집이 실행되지 않았습니다. 요청한 결과를 완료했다고 확인할 수 없습니다.",
      "completion_missing",
    );
  }
  if (
    report.outcome === "applied" ||
    (intent === "edit" && report.outcome === "answered")
  )
    return result(
      "unverified",
      "실제 문서 편집이 실행되지 않았습니다. 요청한 결과를 완료했다고 확인할 수 없습니다.",
      "no_mutation",
    );
  if (report.outcome === "unverified")
    return result(
      "unverified",
      "실제 문서 편집이 실행되지 않았습니다. 요청한 결과를 완료했다고 확인할 수 없습니다.",
      report.reason,
    );
  if (report.outcome === "blocked")
    return result(
      "blocked",
      `문서는 변경되지 않았습니다. 이번 실행에서는 요청한 결과를 만들 수 있는 방법을 확인하지 못했습니다.`,
      report.reason,
    );
  const unchangedMessage = report.message.startsWith(
    "문서는 변경되지 않았습니다.",
  )
    ? report.message
    : `문서는 변경되지 않았습니다. ${report.message}`;
  if (report.outcome === "needs_input")
    return result("needs_input", unchangedMessage, report.reason);
  if (report.outcome === "unchanged")
    return result("unchanged", unchangedMessage, report.reason);
  return result("answered", report.message);
}

function continuationGoal(request, history = [], activeGoal = null) {
  if (
    !/^(?:니가\s*)?(?:(?:그걸|그거|그\s*일|그\s*작업|아까\s*(?:요청|작업)(?:을)?|그러면)\s*)?(?:계속|이어서|진행|해\s*줘|해줘|하라고|하라니까|다시\s*해)/u.test(
      request.trim(),
    )
  )
    return null;
  if (activeGoal) return activeGoal.request;
  for (const previous of [...history].reverse()) {
    const task = previous?.task;
    if (task?.intent === "edit")
      return !["fulfilled", "answered"].includes(task.outcome)
        ? task.goal || null
        : null;
    if (task) continue;
    // Legacy turns carry execution facts, although they have no structured goal.
    if (previous.changed !== false) return null;
    if (
      typeof previous.request === "string" &&
      /(?:수정|바꿔|잘라|넣어|만들어|변경).*(?:줘|해|라)/u.test(
        previous.request,
      )
    )
      return previous.request;
  }
  return null;
}

const NATIVE_HISTORY_TURN_LIMIT = 12;
const NATIVE_HISTORY_CHARACTER_LIMIT = 24_000;
function boundedConversationHistory(turns) {
  if (!Array.isArray(turns)) return [];
  const selected = [];
  let remaining = NATIVE_HISTORY_CHARACTER_LIMIT;
  for (const row of [...turns].reverse().slice(0, NATIVE_HISTORY_TURN_LIMIT)) {
    if (!row || typeof row !== "object") continue;
    const status = row.status;
    if (!["completed", "failed", "cancelled"].includes(String(status)))
      continue;
    let request =
      typeof row.request === "string" ? row.request.slice(0, 2_000) : "";
    let response =
      typeof row.response === "string" ? row.response.slice(0, 8_000) : null;
    if (!request || remaining <= 0) continue;
    if (request.length > remaining) request = request.slice(0, remaining);
    remaining -= request.length;
    const task = row.task;
    let taskEvidence = null;
    if (
      task &&
      ["answer", "edit"].includes(task.intent) &&
      typeof task.goal === "string" &&
      typeof task.reason === "string" &&
      [
        "fulfilled",
        "answered",
        "blocked",
        "needs_input",
        "unchanged",
        "unverified",
      ].includes(task.outcome)
    ) {
      // Preserve the goal before spending the remaining budget on assistant prose.
      const goal = task.goal.slice(0, Math.min(2000, remaining));
      remaining -= goal.length;
      const reason = task.reason.slice(0, Math.min(1000, remaining));
      remaining -= reason.length;
      if (goal)
        taskEvidence = {
          intent: task.intent,
          outcome: task.outcome,
          goal,
          reason,
        };
    }
    if (response && response.length > remaining)
      response = response.slice(0, remaining);
    remaining -= response?.length ?? 0;
    selected.push({
      request,
      response: response || null,
      ...(typeof row.changed === "boolean" ? { changed: row.changed } : {}),
      ...(typeof row.reviewed === "boolean" ? { reviewed: row.reviewed } : {}),
      ...(taskEvidence ? { task: taskEvidence } : {}),
      status: status,
    });
    if (remaining <= 0) break;
  }
  return selected.reverse();
}

module.exports = {
  explicitEditRequest,
  boundedConversationHistory,
  NATIVE_HISTORY_TURN_LIMIT,
  NATIVE_HISTORY_CHARACTER_LIMIT,
  completionSchema,
  completionInstruction,
  parseCompletion,
  finalizeTurn,
  continuationGoal,
};
