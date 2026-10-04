import { describe, expect, it } from "vitest";

import {
  aiFailureMessage,
  aiRequestError,
  classifyAiFailure,
} from "./ai-errors";
import { nativeFailureReason } from "./native-turn-summary";
import { userFacingError } from "./user-errors";

const hangulOnly = (text: string) =>
  !/ai_failure|ai_subscription_busy|not connected|rate limit/i.test(text);

describe("AI failure explanations", () => {
  it("names the AI the person chose", () => {
    expect(aiFailureMessage("usage_limit", "codex")).toMatch(/^ChatGPT 구독의 사용 한도/);
    expect(aiFailureMessage("usage_limit", "claude_code")).toMatch(/^Claude 구독의 사용 한도/);
    expect(aiFailureMessage("usage_limit", "gemini_api")).toMatch(/^Google Gemini API 요청 한도/);
    expect(aiFailureMessage("quota_exhausted", "openai_api")).toMatch(/OpenAI API 계정의 잔액/);
    expect(aiFailureMessage("auth_expired", "claude_code")).toMatch(/Claude 구독 로그인이 만료/);
    expect(aiFailureMessage("auth_expired", "anthropic_api")).toMatch(/Anthropic API 키가 올바르지/);
    expect(aiFailureMessage("not_connected", "codex")).toMatch(/ChatGPT 구독이 연결돼 있지 않아요/);
    expect(aiFailureMessage("not_connected", "openrouter_api")).toMatch(/OpenRouter API 키가 없어요/);
    expect(aiFailureMessage("model_unavailable", "claude_code")).toMatch(/선택한 Claude 구독 모델/);
    expect(aiFailureMessage("busy", "codex")).toMatch(/같은 ChatGPT 구독 계정/);
  });

  it("never shows a Codex message for a Claude request", () => {
    const failure = nativeFailureReason("ai_failure:usage_limit", "claude_code");
    expect(failure.code).toBe("usage_limit");
    expect(failure.message).toMatch(/Claude/);
    expect(failure.message).not.toMatch(/Codex|ChatGPT/);
  });

  it.each([
    ["ai_subscription_busy", "busy"],
    ["Claude subscription is not connected.", "not_connected"],
    ["ChatGPT subscription is not connected.", "not_connected"],
    ["429 Too Many Requests", "usage_limit"],
    ["Incorrect API key provided: sk-***", "auth_expired"],
    ["insufficient_quota", "quota_exhausted"],
    ["The model `gpt-x` does not exist", "model_unavailable"],
  ])("classifies %s", (text, reason) => {
    expect(classifyAiFailure(text)).toBe(reason);
  });

  it("shows no raw code or English for request errors", () => {
    for (const error of [
      "ai_subscription_busy",
      "Claude subscription is not connected.",
      "selected_model_unavailable",
      "native_ai_unavailable",
      "native_session_not_active",
      "ai_failure:auth_expired",
      "some_internal_code",
      "Unexpected end of JSON input",
    ]) {
      const message = aiRequestError(error, "요청을 보내지 못했어요.", "claude_code");
      expect(message).toMatch(/[가-힣]/);
      expect(hangulOnly(message)).toBe(true);
      expect(message).not.toMatch(/_/);
    }
    expect(aiRequestError("some_internal_code", "요청을 보내지 못했어요.")).toBe(
      "요청을 보내지 못했어요.",
    );
    // A sentence already written for the person is kept.
    expect(
      aiRequestError("이 브라우저에 저장된 API 키가 없어요.", "fallback"),
    ).toBe("이 브라우저에 저장된 API 키가 없어요.");
  });

  it("turns unknown English failure text into a Korean sentence on the card", () => {
    const failure = nativeFailureReason("Something odd happened in the worker");
    expect(failure.message).toBe("AI가 요청을 끝내지 못했어요. 잠시 뒤 다시 요청해 주세요.");
    expect(failure.detail).toBeUndefined();
  });

  it("explains worker reasons on the older screens too", () => {
    expect(userFacingError("ai_failure:usage_limit", "실패")).toMatch(/사용 한도/);
  });
});
