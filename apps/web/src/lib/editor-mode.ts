export type EditorMode = "wopi" | "browser";

export function configuredEditorMode(
  value = process.env.SPELLBOOK_EDITOR_MODE,
): EditorMode {
  const normalized = value?.trim().toLowerCase() || "wopi";
  if (normalized !== "wopi" && normalized !== "browser")
    throw new Error("SPELLBOOK_EDITOR_MODE must be wopi or browser.");
  return normalized;
}

/**
 * The browser editor is reachable at its own route once it is configured, so
 * it can be verified in production before it becomes the default.
 */
export function browserEditorAvailable(
  mode = configuredEditorMode(),
  officeUrl = process.env.SPELLBOOK_BROWSER_OFFICE_URL,
): boolean {
  return mode === "browser" || Boolean(officeUrl?.trim());
}
