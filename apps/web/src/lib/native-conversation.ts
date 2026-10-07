import type { TaskResult } from "../../../../contracts/native-turn-policy.cjs";
export type NativeConversationTurn = {
  request: string;
  response: string | null;
  task?: TaskResult;
  changed?: boolean;
  reviewed?: boolean;
  status: "completed" | "failed" | "cancelled";
};

export const NATIVE_HISTORY_TURN_LIMIT = 12;
export const NATIVE_HISTORY_CHARACTER_LIMIT = 24_000;

export function boundedNativeConversationHistory(
  newestFirstRows: Array<{
    request_text?: unknown;
    assistant_text?: unknown;
    status?: unknown;
    changed?: unknown;
    reviewed?: unknown;
    task?: unknown;
  }>,
): NativeConversationTurn[] {
  const selected: NativeConversationTurn[] = [];
  let remaining = NATIVE_HISTORY_CHARACTER_LIMIT;
  for (const row of newestFirstRows.slice(0, NATIVE_HISTORY_TURN_LIMIT)) {
    const status = row.status;
    if (!["completed", "failed", "cancelled"].includes(String(status)))
      continue;
    let request =
      typeof row.request_text === "string"
        ? row.request_text.slice(0, 2_000)
        : "";
    let response =
      typeof row.assistant_text === "string"
        ? row.assistant_text.slice(0, 8_000)
        : null;
    if (!request || remaining <= 0) continue;
    if (request.length > remaining) request = request.slice(0, remaining);
    remaining -= request.length;
    const task = row.task as TaskResult | null;
    let taskEvidence: TaskResult | null = null;
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
      status: status as NativeConversationTurn["status"],
    });
    if (remaining <= 0) break;
  }
  return selected.reverse();
}
