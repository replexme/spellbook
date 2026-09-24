import { describe, expect, it } from "vitest";

import { aiTurnLimit, assertWithinAiTurnLimit } from "./ai-turn-limit";

describe("AI turn limit", () => {
  it("is unlimited unless configured", () => {
    expect(aiTurnLimit({})).toEqual({ perHour: null, perDay: null });
    expect(() =>
      assertWithinAiTurnLimit(aiTurnLimit({}), {
        lastHour: 10_000,
        lastDay: 10_000,
      }),
    ).not.toThrow();
  });

  it("refuses a request once the hourly or daily count is reached", () => {
    const limit = aiTurnLimit({
      SPELLBOOK_AI_TURNS_PER_HOUR: "60",
      SPELLBOOK_AI_TURNS_PER_DAY: "300",
    });
    expect(() =>
      assertWithinAiTurnLimit(limit, { lastHour: 59, lastDay: 299 }),
    ).not.toThrow();
    expect(() =>
      assertWithinAiTurnLimit(limit, { lastHour: 60, lastDay: 60 }),
    ).toThrow("ai_rate_limited");
    expect(() =>
      assertWithinAiTurnLimit(limit, { lastHour: 1, lastDay: 300 }),
    ).toThrow("ai_rate_limited");
  });

  it("rejects a malformed limit instead of silently ignoring it", () => {
    expect(() => aiTurnLimit({ SPELLBOOK_AI_TURNS_PER_HOUR: "0" })).toThrow();
    expect(() => aiTurnLimit({ SPELLBOOK_AI_TURNS_PER_DAY: "ten" })).toThrow();
  });
});
