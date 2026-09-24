import { describe, expect, it } from "vitest";

import { connectedAiName } from "./use-ai-account";

const codex = {
  id: "codex" as const,
  displayName: "ChatGPT 구독 (Codex)",
  connected: false,
  isActive: false,
};
const gemini = {
  id: "gemini_api" as const,
  displayName: "Google Gemini API 키",
  connected: true,
  isActive: true,
};

describe("connected AI name", () => {
  it("counts an API-key connection when no subscription is connected", () => {
    expect(connectedAiName([codex, gemini])).toBe("Google Gemini API 키");
  });

  it("prefers the active connection and names the subscription runtime", () => {
    expect(
      connectedAiName(
        [
          { ...codex, connected: true, isActive: true },
          { ...gemini, isActive: false },
        ],
        "Codex",
      ),
    ).toBe("Codex");
  });

  it("reports no connection when nothing is connected", () => {
    expect(
      connectedAiName([codex, { ...gemini, connected: false }]),
    ).toBeNull();
  });
});
