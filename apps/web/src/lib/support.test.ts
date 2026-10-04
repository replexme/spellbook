import { describe, expect, it } from "vitest";

import { newErrorReference, supportMailto } from "./support";

describe("support email", () => {
  it("is absent when the operator has no support address", () => {
    expect(supportMailto({ documentId: "abc" }, null)).toBeNull();
  });

  it("prefills identifiers only", () => {
    const link = supportMailto(
      {
        place: "편집 화면",
        documentId: "4f0c2a3e-1b2c-4d5e-8f90-123456789abc",
        errorReference: "A1B2C3D4",
        errorCode: "browser_revision_changed",
      },
      "help@example.com",
      new Date("2026-10-04T00:00:00.000Z"),
    )!;
    expect(link.startsWith("mailto:help@example.com?subject=")).toBe(true);
    const body = decodeURIComponent(link.split("&body=")[1]!);
    expect(body).toContain("문서 ID: 4f0c2a3e-1b2c-4d5e-8f90-123456789abc");
    expect(body).toContain("오류 번호: A1B2C3D4");
    expect(body).toContain("오류 코드: browser_revision_changed");
    expect(body).toContain("시각: 2026-10-04T00:00:00.000Z");
    expect(decodeURIComponent(link)).toContain("오류 번호 A1B2C3D4");
  });

  it("drops anything that is not an identifier or a code", () => {
    const link = supportMailto(
      {
        documentId: "회의 자료.pptx",
        errorCode: "TypeError: secret slide text",
      },
      "help@example.com",
    )!;
    const body = decodeURIComponent(link.split("&body=")[1]!);
    expect(body).not.toContain("회의 자료");
    expect(body).not.toContain("secret slide text");
  });

  it("makes short readable references", () => {
    expect(newErrorReference()).toMatch(/^[0-9A-F]{8}$/);
  });
});
