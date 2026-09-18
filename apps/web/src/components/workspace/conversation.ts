import type { TurnHistoryItem } from "@/lib/history-types";
import type { TurnSummary } from "@/lib/native-turn-summary";
import type { CardTurn } from "./result-card";
import type { ManualRun } from "./turn-timeline";

/*
 * One ordered conversation from three sources: the saved request history
 * (so past requests show while the editor is still opening), this page's
 * live events, and runs of direct edits between requests.
 */

/** A message as the live event stream builds it. */
export type LiveMessage = {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  tools: string[];
  status: "running" | "done" | "error" | "review";
  turnId?: string;
  permission?: string;
  summary?: TurnSummary | null;
  changed?: boolean;
  reviewed?: boolean;
  at?: string;
  finishedAt?: string;
  error?: string;
  /** Written before the editor was ready; sent once it is. */
  queued?: boolean;
};

export type ConversationItem =
  | { kind: "user"; key: string; text: string; permission: string; queued: boolean }
  | { kind: "system"; key: string; text: string }
  | { kind: "manual"; key: string; run: ManualRun }
  | { kind: "turn"; key: string; turn: CardTurn };

function historyStatus(status: string): CardTurn["status"] {
  if (status === "queued" || status === "running") return "running";
  if (status === "failed" || status === "cancelled") return "error";
  return "done";
}

export function cardFromHistory(turn: TurnHistoryItem): CardTurn {
  const status = historyStatus(turn.status);
  const outcome = turn.summary?.outcome;
  return {
    key: turn.id,
    turnId: turn.id,
    requestText: turn.requestText,
    permission: turn.permissionMode,
    status,
    text: turn.assistantText ?? "",
    tools: [],
    summary: turn.summary,
    changed: outcome === "changed" || outcome === "unverified",
    reviewed: outcome === "changed",
    startedAt: turn.createdAt,
    finishedAt: status === "running" ? null : turn.updatedAt,
    error: null,
    beforeVersionId: turn.beforeVersionId,
    undoneAt: turn.undoneAt,
  };
}

function withLive(card: CardTurn, message: LiveMessage): CardTurn {
  const status: CardTurn["status"] =
    message.status === "running" ? "running" : message.status === "error" ? "error" : "done";
  return {
    ...card,
    permission: message.permission ?? card.permission,
    status,
    text: message.text || card.text,
    tools: message.tools.length ? message.tools : card.tools,
    summary: message.summary ?? card.summary,
    changed: message.changed ?? card.changed,
    reviewed: message.status === "review" ? false : (message.reviewed ?? card.reviewed),
    startedAt: card.startedAt ?? message.at ?? null,
    finishedAt: message.finishedAt ?? (status === "running" ? null : card.finishedAt),
    error: message.error ?? card.error ?? null,
  };
}

const time = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.NaN);

export function buildConversation({
  history,
  messages,
  runs,
  undone,
}: {
  history: TurnHistoryItem[];
  messages: LiveMessage[];
  runs: ManualRun[];
  /** Requests undone during this page session, by turn id. */
  undone?: Map<string, string>;
}): ConversationItem[] {
  const entries: Array<{ sort: number; order: number; item: ConversationItem }> = [];
  const byTurn = new Map<string, { sort: number; card: CardTurn; user: ConversationItem }>();
  let order = 0;
  for (const turn of history) {
    byTurn.set(turn.id, {
      sort: time(turn.createdAt),
      card: cardFromHistory(turn),
      user: {
        kind: "user",
        key: `u:${turn.id}`,
        text: turn.requestText,
        permission: turn.permissionMode,
        queued: false,
      },
    });
  }
  let lastSort = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const sort = Number.isFinite(time(message.at)) ? time(message.at) : lastSort;
    if (message.role === "assistant" && message.turnId) {
      const known = byTurn.get(message.turnId);
      const card = withLive(
        known?.card ?? {
          key: message.turnId,
          turnId: message.turnId,
          requestText: "",
          permission: message.permission ?? "selection",
          status: "running",
          text: "",
          tools: [],
          summary: null,
          startedAt: message.at ?? null,
          finishedAt: null,
        },
        message,
      );
      byTurn.set(message.turnId, {
        sort: known?.sort ?? sort,
        card,
        user: known?.user ?? {
          kind: "user",
          key: `u:${message.turnId}`,
          text: messages.find((item) => item.role === "user" && item.turnId === message.turnId)?.text ?? card.requestText,
          permission: card.permission,
          queued: false,
        },
      });
      if (!known) lastSort = Math.max(lastSort, sort);
      continue;
    }
    if (message.role === "user") {
      // A user message with a turn id is shown with that turn.
      if (message.turnId) continue;
      entries.push({
        sort: message.queued ? Number.POSITIVE_INFINITY : Math.max(sort, lastSort) + 0.25,
        order: order++,
        item: {
          kind: "user",
          key: `p:${message.id}`,
          text: message.text,
          permission: message.permission ?? "selection",
          queued: Boolean(message.queued),
        },
      });
      continue;
    }
    if (message.role === "system")
      entries.push({ sort, order: order++, item: { kind: "system", key: `s:${message.id}`, text: message.text } });
  }
  for (const [turnId, { sort, card, user }] of byTurn) {
    const requestText = card.requestText || (user.kind === "user" ? user.text : "");
    const undoneAt = card.undoneAt ?? undone?.get(turnId) ?? null;
    entries.push({ sort, order: order++, item: user });
    entries.push({
      sort,
      order: order++,
      item: { kind: "turn", key: `t:${turnId}`, turn: { ...card, requestText, undoneAt } },
    });
  }
  for (const run of runs)
    entries.push({ sort: time(run.from), order: order++, item: { kind: "manual", key: `m:${run.from}`, run } });
  return entries
    .sort(
      (left, right) =>
        (left.sort === right.sort ? 0 : left.sort < right.sort ? -1 : 1) || left.order - right.order,
    )
    .map((entry) => entry.item);
}
