import { HttpError } from "./http";

export interface AiTurnLimit {
  perHour: number | null;
  perDay: number | null;
}

function positiveLimit(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(`${name} must be a positive integer when set.`);
  return limit;
}

// Unset means unlimited (the self-hosted default). A hosted service sets these
// to keep one account from holding server AI capacity for everyone else.
export function aiTurnLimit(
  env: Record<string, string | undefined> = process.env,
): AiTurnLimit {
  return {
    perHour: positiveLimit(
      "SPELLBOOK_AI_TURNS_PER_HOUR",
      env.SPELLBOOK_AI_TURNS_PER_HOUR,
    ),
    perDay: positiveLimit(
      "SPELLBOOK_AI_TURNS_PER_DAY",
      env.SPELLBOOK_AI_TURNS_PER_DAY,
    ),
  };
}

export function assertWithinAiTurnLimit(
  limit: AiTurnLimit,
  used: { lastHour: number; lastDay: number },
): void {
  if (
    (limit.perHour !== null && used.lastHour >= limit.perHour) ||
    (limit.perDay !== null && used.lastDay >= limit.perDay)
  )
    throw new HttpError(429, "ai_rate_limited");
}
