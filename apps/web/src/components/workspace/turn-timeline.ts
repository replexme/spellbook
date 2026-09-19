import type { VersionHistoryItem } from "@/lib/history-types";
import type { TurnSummary } from "@/lib/native-turn-summary";
import { timeRange, when } from "../copy";

/*
 * Where direct edits sit between AI requests, what going back to a version
 * takes with it, and how a result card undoes its request. Pure, so the
 * rules in docs/product/design-system.md are held by tests.
 */

export type TimelineTurn = {
  turnId: string | null;
  requestText: string;
  startedAt: string | null;
  /** The request changed the document (changed or unverified outcome). */
  changed: boolean;
  undone: boolean;
};

/** Consecutive direct-edit saves with no AI request started between them. */
export type ManualRun = {
  from: string;
  to: string;
  saves: number;
  afterTurnId: string | null;
};

const time = (value: string) => new Date(value).getTime();

export function manualEditRuns(
  versions: VersionHistoryItem[],
  turns: TimelineTurn[],
): ManualRun[] {
  const starts = turns
    .filter((turn) => turn.turnId && turn.startedAt)
    .map((turn) => ({ id: turn.turnId!, at: time(turn.startedAt!) }))
    .sort((left, right) => left.at - right.at);
  const ordered = versions
    .filter((version) => version.origin !== "system")
    .sort((left, right) => time(left.createdAt) - time(right.createdAt));
  const runs: ManualRun[] = [];
  let current: ManualRun | null = null;
  for (const version of ordered) {
    if (version.origin !== "manual") {
      current = null;
      continue;
    }
    const at = time(version.createdAt);
    const afterTurnId =
      starts.filter((start) => start.at <= at).at(-1)?.id ?? null;
    if (current && current.afterTurnId === afterTurnId) {
      current.to = version.createdAt;
      current.saves += 1;
      continue;
    }
    current = {
      from: version.createdAt,
      to: version.createdAt,
      saves: 1,
      afterTurnId,
    };
    runs.push(current);
  }
  return runs;
}

export type RestoreImpact = {
  manual: ManualRun[];
  aiRequests: Array<{ at: string; requestText: string }>;
};

/** What going back to the state at `after` also takes back. */
export function restoreImpact(
  versions: VersionHistoryItem[],
  turns: TimelineTurn[],
  after: string,
  exceptTurnId?: string | null,
): RestoreImpact {
  const cutoff = time(after);
  return {
    manual: manualEditRuns(
      versions.filter((version) => time(version.createdAt) > cutoff),
      turns,
    ),
    aiRequests: turns
      .filter(
        (turn) =>
          turn.changed &&
          !turn.undone &&
          turn.startedAt &&
          time(turn.startedAt) > cutoff &&
          turn.turnId !== exceptTurnId,
      )
      .map((turn) => ({ at: turn.startedAt!, requestText: turn.requestText })),
  };
}

/** "그 뒤의 직접 수정(10:31–10:38)과 AI 요청 1건(10:42)도 함께 되돌아가요." */
export function impactSentence(impact: RestoreImpact): string | null {
  const parts: string[] = [];
  const runs = impact.manual;
  if (runs.length)
    parts.push(
      runs.length <= 3
        ? `직접 수정(${runs.map((run) => timeRange(run.from, run.to)).join(", ")})`
        : `직접 수정 ${runs.length}번(${timeRange(runs[0]!.from, runs.at(-1)!.to)})`,
    );
  const requests = impact.aiRequests;
  if (requests.length)
    parts.push(
      `AI 요청 ${requests.length}건(${
        requests.length <= 3
          ? requests.map((request) => when(request.at)).join(", ")
          : timeRange(requests[0]!.at, requests.at(-1)!.at)
      })`,
    );
  if (!parts.length) return null;
  return `그 뒤의 ${parts.join("과 ")}도 함께 되돌아가요.`;
}

export type UndoAction =
  /** Undo in the editor by the request's own undo steps. */
  | { kind: "native"; label: string }
  /** Go back to the version saved right before the request. */
  | { kind: "restore"; label: string };

export function undoActionFor(input: {
  summary: TurnSummary | null;
  outcome: string;
  beforeVersionId: string | null | undefined;
  undone: boolean;
  /** The newest request in this conversation. */
  latest: boolean;
  /** The editor is open and connected. */
  editorLive: boolean;
  /** The person changed the document since (unsaved edits or later saves). */
  changedSince: boolean;
}): UndoAction | null {
  if (
    input.undone ||
    (input.outcome !== "changed" && input.outcome !== "unverified")
  )
    return null;
  const summary = input.summary;
  if (
    input.latest &&
    input.editorLive &&
    !input.changedSince &&
    (summary?.undoSteps ?? 0) > 0 &&
    summary?.revisions?.before &&
    summary.revisions.after
  )
    return {
      kind: "native",
      label: summary.changedSlides.length > 1 ? "모두 되돌리기" : "되돌리기",
    };
  if (input.beforeVersionId)
    return { kind: "restore", label: "이 요청 전으로 돌아가기" };
  return null;
}

/** Saves made after a request other than its own AI save. */
export function savedAfter(
  versions: VersionHistoryItem[],
  turnId: string,
  finishedAt: string | null,
) {
  if (!finishedAt) return false;
  const cutoff = time(finishedAt);
  return versions.some(
    (version) =>
      version.origin !== "system" &&
      time(version.createdAt) > cutoff &&
      !(version.origin === "ai" && version.turn?.id === turnId),
  );
}
