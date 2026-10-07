import { boundedConversationHistory } from "../../../../contracts/native-turn-policy.cjs";
export type { ConversationTurn as NativeConversationTurn } from "../../../../contracts/native-turn-policy.cjs";
export {
  NATIVE_HISTORY_TURN_LIMIT,
  NATIVE_HISTORY_CHARACTER_LIMIT,
} from "../../../../contracts/native-turn-policy.cjs";
export function boundedNativeConversationHistory(
  newestFirstRows: Array<{
    request_text?: unknown;
    assistant_text?: unknown;
    status?: unknown;
    changed?: unknown;
    reviewed?: unknown;
    task?: unknown;
  }>,
) {
  return boundedConversationHistory(
    [...newestFirstRows].reverse().map((row) => ({
      request: row.request_text,
      response: row.assistant_text,
      status: row.status,
      changed: row.changed,
      reviewed: row.reviewed,
      task: row.task,
    })),
  );
}
