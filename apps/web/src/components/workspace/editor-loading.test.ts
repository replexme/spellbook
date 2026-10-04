import { describe, expect, it } from "vitest";
import {
  EDITOR_SLOW_SECONDS,
  EDITOR_STUCK_SECONDS,
  editorLoadingMessage,
} from "./editor-loading-copy";

describe("editor opening progress", () => {
  it("counts the wait and explains a slow or stuck first open", () => {
    expect(editorLoadingMessage(3)).toBe(
      "편집기 준비 중 · 처음 열 때는 1분쯤 걸려요",
    );
    expect(editorLoadingMessage(20)).toContain("20초");
    expect(editorLoadingMessage(EDITOR_SLOW_SECONDS)).toContain(
      "평소보다 오래 걸려요",
    );
    expect(editorLoadingMessage(EDITOR_STUCK_SECONDS)).toContain(
      "열리지 않고 있어요",
    );
  });
});
