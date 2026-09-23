import { describe, expect, it } from "vitest";

import { signInErrorMessage } from "./sign-in-errors";

describe("sign-in error messages", () => {
  it("shows no message without an error code", () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("")).toBeNull();
  });

  it("explains known sign-in failures in plain language", () => {
    expect(signInErrorMessage("access_denied")).toBe(
      "이 계정에는 이 서비스를 이용할 권한이 없습니다.",
    );
    expect(signInErrorMessage("access_unavailable")).toContain(
      "잠시 후 다시 시도",
    );
  });

  it("never echoes an unknown or provider-supplied code", () => {
    const message = signInErrorMessage("server_error<script>");
    expect(message).toBe("로그인하지 못했습니다. 다시 시도해 주세요.");
    expect(message).not.toContain("server_error");
  });
});
