/*
 * The WOPI editor runs in a cross-origin iframe and cannot read our CSS
 * variables, so the values it needs are restated here. design-system.test.ts
 * fails if any value drifts from tokens.css.
 *
 * The editor's accent is neutral ink on purpose: teal means "the AI did
 * this" everywhere in Spellbook, and the editor's own selection, active tab
 * and thumbnail borders are not AI actions.
 */
export const editorThemeTokens = {
  accent: { token: "--sb-gray-700", value: "#35404a" },
  accentDark: { token: "--sb-gray-900", value: "#151b22" },
  accentSoft: { token: "--sb-gray-100", value: "#eceff2" },
  text: { token: "--sb-gray-900", value: "#151b22" },
  background: { token: "--sb-gray-25", value: "#fbfcfd" },
  canvas: { token: "--sb-canvas", value: "#e5e9ec" },
  border: { token: "--sb-gray-200", value: "#dce1e6" },
  toolbarBorder: { token: "--sb-gray-150", value: "#e3e7eb" },
} as const;

function rgbTriplet(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
}

/** Value for the Collabora `css_variables` launch parameter. */
export function collaboraCssVariables() {
  const t = editorThemeTokens;
  return [
    `--color-primary=${t.accent.value}`,
    `--color-primary-dark=${t.accentDark.value}`,
    `--color-primary-lighter=${t.accentSoft.value}`,
    `--color-main-text=${t.text.value}`,
    `--color-main-background=${t.background.value}`,
    `--color-canvas=${t.canvas.value}`,
    `--color-border=${t.border.value}`,
    `--color-toolbar-border=${t.toolbarBorder.value}`,
    `--orange1-txt-primary-color=${rgbTriplet(t.accent.value)}`,
    // Read by services/office-editor/host-bridge.css for the editor's
    // document-type accent (tab underline, current slide, selection).
    `--spellbook-editor-accent-rgb=${rgbTriplet(t.accent.value)}`,
    "--header-font-size=11px",
    "--default-font-size=11px",
    "--medium-font-size=11px",
    "--overflow-group-font-size=10px",
    "--header-height=28px",
    "--sidebar-header-height=28px",
    "--notebookbar-element-height=48px",
    "--btn-size=24px",
  ].join(";");
}
