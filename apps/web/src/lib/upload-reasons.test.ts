import { describe, expect, it } from "vitest";
import { precheckUpload, uploadFailure } from "./upload-reasons";

const MAX = 50 * 1024 * 1024;

describe("upload reasons", () => {
  it("tells a legacy .ppt apart from other formats", () => {
    expect(
      uploadFailure("unsupported_format", "계획.ppt", MAX).reason,
    ).toContain(".ppt");
    expect(
      uploadFailure("unsupported_format", "memo.key", MAX).reason,
    ).toContain(".pptx");
  });

  it("states the size limit from the format registry", () => {
    expect(uploadFailure("file_too_large", "a.pptx", MAX).reason).toBe(
      "파일이 50MB보다 커요.",
    );
  });

  it("gives every failure a reason and a fix", () => {
    for (const code of [
      "unsupported_format",
      "empty_file",
      "file_too_large",
      "encrypted_or_legacy_file",
      "invalid_package",
      "document_processing_failed",
      "storage_capacity_exhausted",
      "network",
      "something_new",
    ]) {
      const failure = uploadFailure(code, "a.pptx", MAX);
      expect(failure.reason.length).toBeGreaterThan(4);
      expect(failure.fix.length).toBeGreaterThan(4);
    }
  });

  it("checks name and size before sending", () => {
    expect(precheckUpload({ name: "a.ppt", size: 10 }, MAX)).toBe(
      "unsupported_format",
    );
    expect(precheckUpload({ name: "a.pptx", size: 0 }, MAX)).toBe("empty_file");
    expect(precheckUpload({ name: "a.pptx", size: MAX + 1 }, MAX)).toBe(
      "file_too_large",
    );
    expect(precheckUpload({ name: "A.PPTX", size: 10 }, MAX)).toBeNull();
  });
});
