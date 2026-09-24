import { describe, expect, it } from "vitest";

import { browserEditorAvailable, configuredEditorMode } from "./editor-mode";

describe("editor mode admission", () => {
  it("keeps the promoted WOPI runtime as the default", () => {
    expect(configuredEditorMode(undefined)).toBe("wopi");
    expect(configuredEditorMode(" WOPI ")).toBe("wopi");
  });

  it("selects browser Office only through an explicit release setting", () => {
    expect(configuredEditorMode("browser")).toBe("browser");
    expect(() => configuredEditorMode("auto")).toThrow(
      "SPELLBOOK_EDITOR_MODE must be wopi or browser.",
    );
  });

  it("opens the browser editor route once it is configured", () => {
    expect(browserEditorAvailable("wopi", undefined)).toBe(false);
    expect(browserEditorAvailable("wopi", " ")).toBe(false);
    expect(browserEditorAvailable("wopi", "https://office.example")).toBe(true);
    expect(browserEditorAvailable("browser", undefined)).toBe(true);
  });
});
