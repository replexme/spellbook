import type {
  NativeObservation,
  NativePermission,
} from "./native-turn-runtime.cjs";
import type { TaskResult } from "./native-turn-policy.cjs";
export type GoalCheck = {
  kind: "image_shape";
  elementId: string;
  shape: "circle" | "rectangle";
  mediaFingerprint?: string;
};
export type ActiveGoal = {
  version: 1;
  scope: string;
  request: string;
  checks: GoalCheck[];
};
export function normalizeActiveGoal(
  value: unknown,
  scope: string,
): ActiveGoal | null;
export function goalChecks(
  request: string,
  observation: NativeObservation,
  permission: NativePermission,
): GoalCheck[];
export function verifyGoalChecks(
  checks: GoalCheck[],
  observation: NativeObservation,
): { passed: boolean; checked: number; failures: unknown[] };
export function nextActiveGoal(
  previous: unknown,
  scope: string,
  request: string,
  completion: { task: TaskResult },
  checks: GoalCheck[],
): ActiveGoal | null;

export function prepareActiveGoal(
  request: string,
  previous: unknown,
  scope: string,
): ActiveGoal | null;

export function simpleGoalCommands(
  request: string,
  checks: GoalCheck[],
  observation: NativeObservation,
  permission: NativePermission,
): Array<Record<string, unknown>> | null;
