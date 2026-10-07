import { serviceLinks } from "./service-links";

/**
 * A support email that already says which file and which failure it is
 * about. It carries identifiers only — never document content, file names
 * or AI requests — so the person can send it as it is.
 */
export interface SupportContext {
  /** Where the person was, for example "편집 화면" or "설정". */
  place?: string;
  documentId?: string | null;
  /** The short number shown next to an error. */
  errorReference?: string | null;
  /** The internal reason code, if there was one. */
  errorCode?: string | null;
  occurredAt?: string;
}

const CODE = /^[a-z][a-z0-9_.-]{0,79}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

export function supportMailto(
  context: SupportContext = {},
  supportEmail: string | null = serviceLinks.supportEmail,
  now: Date = new Date(),
): string | null {
  if (!supportEmail) return null;
  const lines = [
    "어떤 문제가 있었는지 적어 주세요:",
    "",
    "",
    "---",
    "아래 정보는 문제를 찾는 데만 써요. 문서 내용은 들어 있지 않아요.",
    context.place ? `화면: ${context.place.slice(0, 40)}` : null,
    context.documentId && ID.test(context.documentId)
      ? `문서 ID: ${context.documentId}`
      : null,
    context.errorReference && ID.test(context.errorReference)
      ? `오류 번호: ${context.errorReference}`
      : null,
    context.errorCode && CODE.test(context.errorCode)
      ? `오류 코드: ${context.errorCode}`
      : null,
    `시각: ${context.occurredAt && Number.isFinite(Date.parse(context.occurredAt)) ? context.occurredAt : now.toISOString()}`,
  ].filter((line): line is string => line !== null);
  const subject = context.errorReference
    ? `[Spellbook 문제 신고] 오류 번호 ${context.errorReference}`
    : "[Spellbook 문의]";
  return `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

/** A short number a person can read out or paste when asking for help. */
export function newErrorReference(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
