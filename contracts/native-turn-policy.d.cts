export type TaskResult = {
  intent: "answer" | "edit";
  goal: string;
  outcome:
    | "fulfilled"
    | "answered"
    | "blocked"
    | "needs_input"
    | "unchanged"
    | "unverified";
  reason: string;
};
export type TurnEvidence = {
  requestText: string;
  requiredIntent?: "answer" | "edit";
  readOnly: boolean;
  changed: boolean;
  reviewed: boolean;
  requestSatisfied: boolean;
  unconfirmedMutation: boolean;
};
export const completionSchema: Record<string, unknown>;
export const completionInstruction: string;
export function parseCompletion(raw: string): {
  intent: "answer" | "edit";
  goal: string;
  outcome: string;
  message: string;
  reason: string;
  review?: {
    approved: boolean;
    requestSatisfied: boolean;
    problems: string[];
    reviewedSlideIndexes: number[];
  } | null;
} | null;
export function finalizeTurn(
  raw: string,
  evidence: TurnEvidence,
): { text: string; task: TaskResult };
export function continuationGoal(
  request: string,
  history?: Array<{ task?: TaskResult; request?: string; changed?: boolean }>,
  activeGoal?: import("./native-goal.cjs").ActiveGoal | null,
): string | null;

export type ConversationTurn = {
  request: string;
  response: string | null;
  status: "completed" | "failed" | "cancelled";
  changed?: boolean;
  reviewed?: boolean;
  task?: TaskResult;
};
export const NATIVE_HISTORY_TURN_LIMIT: number;
export const NATIVE_HISTORY_CHARACTER_LIMIT: number;
export function boundedConversationHistory(turns: unknown): ConversationTurn[];

export function explicitEditRequest(request: string): boolean;
