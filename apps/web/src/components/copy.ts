/* Shared wording so the same idea reads the same everywhere. */

export type PermissionMode = "read_only" | "selection" | "slides" | "document";

export const scopeOptions: Array<{
  value: PermissionMode;
  title: string;
  description: string;
}> = [
  { value: "selection", title: "선택한 요소", description: "편집기에서 지금 선택한 요소만 바꿔요" },
  { value: "slides", title: "이 슬라이드", description: "보고 있는 슬라이드 안에서만 바꿔요" },
  { value: "document", title: "전체 문서", description: "모든 슬라이드를 바꿀 수 있어요" },
  { value: "read_only", title: "묻기만", description: "문서를 바꾸지 않고 답해요" },
];

export function scopeTitle(mode: string) {
  return scopeOptions.find((option) => option.value === mode)?.title ?? "선택한 요소";
}

/** The next wider scope, for "widen and retry". */
export function widerScope(mode: string): PermissionMode | null {
  if (mode === "read_only" || mode === "selection") return "slides";
  if (mode === "slides") return "document";
  return null;
}

const effortNames: Record<string, { title: string; description: string }> = {
  minimal: { title: "가장 빠르게", description: "아주 짧은 수정에 알맞아요." },
  low: { title: "빠르게", description: "짧은 수정에 알맞아요. 가장 빨라요." },
  medium: { title: "보통", description: "대부분의 요청에 알맞아요." },
  high: {
    title: "꼼꼼하게",
    description: "여러 슬라이드를 고칠 때 알맞아요. 더 오래 걸리고 구독 사용량이 늘어요.",
  },
  xhigh: {
    title: "가장 꼼꼼하게",
    description: "까다로운 요청에만 쓰세요. 가장 오래 걸리고 구독 사용량이 많이 늘어요.",
  },
};

export function effortTitle(effort: string | undefined) {
  return (effort && effortNames[effort]?.title) || effort || "보통";
}

export function effortDescription(effort: string | undefined) {
  return (effort && effortNames[effort]?.description) || "";
}

const clock = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const day = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });

/** "10:42", "어제 17:20", "9월 12일 09:05". */
export function when(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = clock.format(date);
  if (date.getTime() >= startOfToday) return time;
  if (date.getTime() >= startOfToday - 86_400_000) return `어제 ${time}`;
  return `${day.format(date)} ${time}`;
}

/** "방금", "3분 전", "2시간 전", "어제", "9월 12일". */
export function relative(value: string | number | Date) {
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 172_800) return "어제";
  return day.format(date);
}

export function elapsed(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function slideList(indexes: number[]) {
  if (!indexes.length) return "";
  if (indexes.length === 1) return `${indexes[0]! + 1}번 슬라이드`;
  return `슬라이드 ${indexes.length}장`;
}

/** "812KB", "16.2MB". */
export function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Whether a word ends in a final consonant; null when it cannot be told. */
function hasFinalConsonant(word: string): boolean | null {
  const last = word.trim().at(-1);
  if (!last) return null;
  const syllable = last.charCodeAt(0) - 0xac00;
  if (syllable >= 0 && syllable < 11172) return syllable % 28 !== 0;
  // Digits read as Sino-Korean numbers: 영 일 이 삼 사 오 육 칠 팔 구.
  if (/[0-9]/.test(last)) return "013678".includes(last);
  return null;
}

/** 을 or 를 after a word; "을(를)" when unknown. */
export function objectParticle(word: string) {
  const final = hasFinalConsonant(word);
  return final === null ? "을(를)" : final ? "을" : "를";
}

/** 으로 or 로 after a word (로 after ㄹ and vowels); "(으)로" when unknown. */
export function directionParticle(word: string) {
  const final = hasFinalConsonant(word);
  if (final === null) return "(으)로";
  const last = word.trim().at(-1)!;
  const syllable = last.charCodeAt(0) - 0xac00;
  // 일, 칠, 팔 end in ㄹ too.
  const rieul = (syllable >= 0 && syllable < 11172 && syllable % 28 === 8) || /[178]/.test(last);
  return final && !rieul ? "으로" : "로";
}

/** "10:31–10:38"; one time when both fall in the same minute. */
export function timeRange(from: string | number | Date, to: string | number | Date) {
  const start = when(from);
  const end = when(to);
  if (start === end) return start;
  const day = (text: string) => (text.includes(" ") ? text.slice(0, text.lastIndexOf(" ")) : "");
  return day(start) === day(end) ? `${start}–${end.slice(end.lastIndexOf(" ") + 1)}` : `${start}–${end}`;
}

/** 이 or 가 after a word, chosen by its last sound; "이(가)" when unknown. */
export function subjectParticle(word: string) {
  const final = hasFinalConsonant(word);
  return final === null ? "이(가)" : final ? "이" : "가";
}
