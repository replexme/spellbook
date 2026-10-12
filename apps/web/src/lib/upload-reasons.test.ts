import { describe, expect, it } from "vitest";
import {
  failureShort,
  precheckUpload,
  retryableFailure,
  uploadFailure,
} from "./upload-reasons";

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
      "too_many_slides",
      "expanded_too_large",
      "image_too_large",
      "render_timeout",
      "processing_timeout",
      "storage_full",
      "document_limit_reached",
      "direct_upload_blocked",
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
    expect(precheckUpload({ name: "issue.idml", size: 10 }, MAX)).toBeNull();
  });

  it("tells a full account how to make room", () => {
    for (const code of ["storage_full", "document_limit_reached"]) {
      expect(uploadFailure(code, "a.pptx", MAX).fix).toContain("삭제");
      expect(uploadFailure(code, "a.pptx", MAX).link?.href).toBe(
        "/settings#plan",
      );
    }
  });

  it("offers a second check only where it can pass", () => {
    expect(retryableFailure("processing_timeout")).toBe(true);
    expect(retryableFailure("render_timeout")).toBe(true);
    expect(retryableFailure("encrypted_or_legacy_file")).toBe(false);
    expect(retryableFailure("too_many_slides")).toBe(false);
    expect(failureShort("image_too_large")).toBe("아주 큰 그림이 들어 있어요");
  });

  it("names the browsers that can edit when this one cannot", () => {
    const failure = uploadFailure("browser_unsupported", "a.pptx", MAX);
    expect(failure.reason).toContain("이 브라우저");
    expect(failure.fix).toContain("Chrome");
    expect(failure.fix).toContain("iPhone");
  });

  it("gives InDesign files InDesign's own fixes and keeps PowerPoint's wording", () => {
    for (const code of [
      "empty_file",
      "invalid_package",
      "broken_presentation",
      "render_failed",
      "too_many_slides",
      "image_too_large",
      "processing_failed",
      "document_processing_failed",
      "encrypted_or_legacy_file",
    ]) {
      const idml = uploadFailure(code, "issue.idml", MAX);
      expect(`${idml.reason} ${idml.fix}`, code).not.toContain("PowerPoint");
      expect(`${idml.reason} ${idml.fix}`, code).not.toContain("슬라이드");
    }
    expect(uploadFailure("processing_failed", "issue.idml", MAX).fix).toContain(
      "InDesign Markup(IDML)",
    );
    expect(uploadFailure("processing_failed", "deck.pptx", MAX).fix).toBe(
      "PowerPoint에서 열어 다시 저장한 뒤 가져와 보세요. 올린 원본은 파일 목록에 남아 있어요.",
    );
    expect(uploadFailure("render_timeout", "deck.pptx", MAX).reason).toBe(
      "슬라이드를 그리는 데 너무 오래 걸려서 멈췄어요.",
    );
  });
});
