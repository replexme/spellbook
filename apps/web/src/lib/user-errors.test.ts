import { describe, expect, it } from "vitest";

import {
  errorNeedsReference,
  isKnownErrorCode,
  userFacingError,
} from "./user-errors";

describe("user-facing product errors", () => {
  it("explains storage protection without exposing an internal code", () => {
    expect(
      userFacingError("storage_capacity_exhausted", "업로드하지 못했어요."),
    ).toBe(
      "저장 공간이 부족해 작업을 안전하게 중단했어요. 기존 파일은 그대로 있어요. 공간을 확보한 뒤 다시 시도해 주세요.",
    );
  });

  it("never passes raw codes, English or exception text through", () => {
    for (const raw of [
      "unexpected_error",
      "some_new_internal_code",
      "Only .pptx files are supported",
      "TypeError: Cannot read properties of undefined (reading 'x')",
      'duplicate key value violates unique constraint "spellbook_documents_pkey"',
    ])
      expect(userFacingError(raw, "실패했어요.")).toBe("실패했어요.");
  });

  it("keeps Korean sentences that were written for people", () => {
    expect(
      userFacingError("AI 작업 전에 지금 편집 내용을 저장하지 못했어요.", "x"),
    ).toBe("AI 작업 전에 지금 편집 내용을 저장하지 못했어요.");
  });

  it("maps the codes the save and AI paths report", () => {
    for (const code of [
      "browser_revision_changed",
      "browser_session_changed",
      "document_too_large",
      "ai_subscription_busy",
      "native_ai_unavailable",
      "login_required",
    ]) {
      expect(isKnownErrorCode(code)).toBe(true);
      expect(userFacingError(code, "x")).toMatch(/[가-힣]/);
    }
  });

  it("explains a full account without the raw quota code", () => {
    for (const code of ["storage_full", "document_limit_reached"])
      expect(userFacingError(code, "x")).toContain("삭제");
  });

  it("explains an AI worker's reported reason in Korean", () => {
    expect(userFacingError("ai_failure:timeout", "x")).toMatch(/[가-힣]/);
    expect(userFacingError("ai_failure:timeout", "x")).not.toContain(
      "ai_failure",
    );
    expect(errorNeedsReference("ai_failure:usage_limit")).toBe(false);
  });

  it("asks for a reference only when nobody described the failure", () => {
    expect(errorNeedsReference("browser_revision_changed")).toBe(false);
    expect(errorNeedsReference("편집기에서 오류가 생겼어요.")).toBe(false);
    expect(errorNeedsReference("Error: boom")).toBe(true);
    expect(errorNeedsReference(null)).toBe(true);
    // Inherited object keys are not error codes.
    expect(isKnownErrorCode("constructor")).toBe(false);
    expect(userFacingError("toString", "실패했어요.")).toBe("실패했어요.");
  });
});
