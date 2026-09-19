import type { VersionHistoryItem } from "@/lib/history-types";
import { when } from "../copy";

/* Version list shaping, kept apart from the panel so it can be tested. */

export type VersionEntry = {
  key: string;
  /** The version a restore returns to (the newest one in a manual group). */
  versionId: string;
  parentVersionId: string | null;
  kind: VersionHistoryItem["origin"];
  title: string;
  detail: string;
  at: string;
  current: boolean;
  previews: Array<string | null>;
  members: VersionHistoryItem[];
};

const GROUP_WINDOW_MS = 30 * 60 * 1000;

export function dayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (date.getTime() >= today) return "오늘";
  if (date.getTime() >= today - 86_400_000) return "어제";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
  }).format(date);
}

function clip(text: string, limit = 48) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Newest first; consecutive manual saves become one entry. Saves no person
 * changed (`system`) are not listed; if one is current, the next older entry
 * has the same content and is marked current instead.
 */
export function versionEntries(versions: VersionHistoryItem[]): VersionEntry[] {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const entries: VersionEntry[] = [];
  let currentPending = false;
  for (const listed of versions) {
    if (listed.origin === "system") {
      currentPending ||= listed.current;
      continue;
    }
    const version = currentPending ? { ...listed, current: true } : listed;
    currentPending = false;
    const previous = entries.at(-1);
    const last = previous?.members.at(-1);
    if (
      version.origin === "manual" &&
      previous?.kind === "manual" &&
      last &&
      new Date(last.createdAt).getTime() -
        new Date(version.createdAt).getTime() <=
        GROUP_WINDOW_MS
    ) {
      previous.members.push(version);
      previous.current ||= version.current;
      const newest = previous.members[0]!;
      const oldest = version;
      previous.detail = `${when(oldest.createdAt)}–${when(newest.createdAt).replace(/^.* /, "")} · 저장 ${previous.members.length}번`;
      continue;
    }
    const restoredFrom = version.restoredFrom
      ? byId.get(version.restoredFrom)
      : null;
    entries.push({
      key: version.id,
      versionId: version.id,
      parentVersionId: version.parentVersionId,
      kind: version.origin,
      title:
        version.origin === "original"
          ? "가져온 원본"
          : version.origin === "ai"
            ? `“${clip(version.turn?.requestText ?? "AI 요청")}”`
            : version.origin === "restored"
              ? restoredFrom
                ? `${when(restoredFrom.createdAt)} 버전으로 되돌림`
                : "이전 버전으로 되돌림"
              : version.origin === "undone"
                ? `“${clip(version.turn?.requestText ?? "AI 요청")}” 되돌림`
                : "직접 수정",
      detail:
        version.origin === "original"
          ? `${when(version.createdAt)} · 언제든 이 상태로 돌아갈 수 있어요`
          : version.origin === "ai"
            ? `AI · ${when(version.createdAt)}`
            : version.origin === "restored" || version.origin === "undone"
              ? `되돌림 · ${when(version.createdAt)}`
              : `${when(version.createdAt)} · 저장 1번`,
      at: version.createdAt,
      current: version.current,
      previews: version.previews,
      members: [version],
    });
  }
  return entries;
}

/** The sentence a restore confirmation leads with. */
export function restoreLead(entry: VersionEntry, mode: "this" | "before") {
  if (mode === "before") return `${entry.title} 요청 전 상태로 돌아가요.`;
  if (entry.kind === "original") return "가져온 원본 상태로 돌아가요.";
  if (entry.kind === "ai") return `${entry.title} 요청 직후 상태로 돌아가요.`;
  return `${when(entry.at)}에 저장한 상태로 돌아가요.`;
}
