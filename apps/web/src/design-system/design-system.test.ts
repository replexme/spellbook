import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collaboraCssVariables, editorThemeTokens } from "./editor-theme";

const sourceRoot = path.resolve(__dirname, "..");
const tokensFile = path.join(sourceRoot, "design-system", "tokens.css");

/*
 * Screens that predate the system. They are not rendered by any route
 * (see docs/product/design-system.md) and may only shrink. New files never
 * belong here.
 */
const legacyAllowlist = new Set(
  [
    "app/globals.css",
    "components/document-editor.tsx",
    "components/direct-edit-tools.tsx",
    "components/conversation-timeline.tsx",
    "components/permission-control.tsx",
  ].map((file) => path.join(sourceRoot, file)),
);

const exempt = new Set([
  tokensFile,
  path.join(sourceRoot, "design-system", "editor-theme.ts"),
]);

const systemCss = [
  "tokens.css",
  "base.css",
  "components.css",
  "patterns.css",
].map((file) => path.join(sourceRoot, "design-system", file));

/** Legacy components that only the legacy allowlist renders. */
const legacyComponents = new Set(
  [
    "components/chat-icon.tsx",
    "components/model-control.tsx",
    "components/spellbook-ui.tsx",
  ].map((file) => path.join(sourceRoot, file)),
);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(css|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const colorLiteral =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(|:\s*(?:white|black)\b/;

function tokenValues() {
  const values = new Map<string, string>();
  for (const match of readFileSync(tokensFile, "utf8").matchAll(
    /(--[a-z0-9-]+):\s*([^;]+);/g,
  ))
    values.set(match[1]!, match[2]!.trim().toLowerCase());
  return values;
}

function definedClasses() {
  const classes = new Set<string>();
  for (const file of systemCss)
    for (const match of readFileSync(file, "utf8").matchAll(
      /\.([a-z][a-z0-9-]*)/g,
    ))
      classes.add(match[1]!);
  return classes;
}

/** Class names written literally in className attributes (dynamic parts skipped). */
function classNamesIn(source: string) {
  const names: string[] = [];
  const attribute = /className=(?:"([^"]*)"|\{)/g;
  for (const match of source.matchAll(attribute)) {
    if (match[1] !== undefined) {
      names.push(...match[1].split(/\s+/));
      continue;
    }
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    // Strings in comparisons (size === "sm") are conditions, not class names.
    const expression = source
      .slice(start, index - 1)
      .replace(/[!=]==?\s*(?:"[^"]*"|'[^']*')/g, "")
      .replace(/(?:"[^"]*"|'[^']*')\s*[!=]==?/g, "");
    for (const literal of expression.matchAll(
      /"([^"]*)"|'([^']*)'|`([^`]*)`/g,
    )) {
      const text = (literal[1] ?? literal[2] ?? literal[3] ?? "").replace(
        /\$\{[^}]*\}/g,
        " ",
      );
      names.push(...text.split(/\s+/));
    }
  }
  return names.filter((name) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(name));
}

describe("design system", () => {
  it("composes every product screen from classes the system defines", () => {
    const classes = definedClasses();
    const unknown: string[] = [];
    for (const file of walk(sourceRoot)) {
      if (
        !file.endsWith(".tsx") ||
        legacyAllowlist.has(file) ||
        legacyComponents.has(file)
      )
        continue;
      for (const name of classNamesIn(readFileSync(file, "utf8")))
        if (!classes.has(name))
          unknown.push(`${path.relative(sourceRoot, file)}: .${name}`);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("keeps stylesheets inside the system", () => {
    const stray = walk(sourceRoot)
      .filter((file) => file.endsWith(".css"))
      .filter((file) => !systemCss.includes(file) && !legacyAllowlist.has(file))
      .map((file) => path.relative(sourceRoot, file));
    expect(stray).toEqual([]);
    const layout = readFileSync(
      path.join(sourceRoot, "app", "layout.tsx"),
      "utf8",
    );
    for (const file of systemCss)
      expect(layout).toContain(`@/design-system/${path.basename(file)}`);
    expect(layout).not.toContain("globals.css");
  });

  it("keeps accessibility behaviour in the base layer", () => {
    const base = readFileSync(
      path.join(sourceRoot, "design-system", "base.css"),
      "utf8",
    );
    expect(base).toContain(":focus-visible");
    expect(base).toContain("prefers-reduced-motion: reduce");
    expect(base).toContain(".ds-visually-hidden");
  });

  it("opens the editor with the tabbed ribbon and no slide sidebar", () => {
    const workspace = readFileSync(
      path.join(sourceRoot, "components", "native-workspace.tsx"),
      "utf8",
    );
    expect(workspace).toContain("UIMode=tabbed");
    expect(workspace).toContain("PresentationSidebar=false");
    expect(workspace).not.toContain("UIMode=notebookbar");
    expect(workspace).toContain("collaboraCssVariables()");
  });

  it("keeps colour literals inside tokens.css", () => {
    const violations: string[] = [];
    for (const file of walk(sourceRoot)) {
      if (exempt.has(file) || legacyAllowlist.has(file)) continue;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (colorLiteral.test(line))
          violations.push(
            `${path.relative(sourceRoot, file)}:${index + 1}: ${line.trim()}`,
          );
      });
    }
    expect(violations).toEqual([]);
  });

  it("gives the editor iframe exactly the token values", () => {
    const values = tokenValues();
    for (const [name, entry] of Object.entries(editorThemeTokens))
      expect(values.get(entry.token), `${name} → ${entry.token}`).toBe(
        entry.value,
      );
    expect(collaboraCssVariables()).toContain("--color-primary=#35404a");
    expect(collaboraCssVariables()).not.toContain("d24726");
  });

  it("drives the editor's own accent from the value Spellbook passes", () => {
    const hostCss = readFileSync(
      path.resolve(
        sourceRoot,
        "../../../services/office-editor/host-bridge.css",
      ),
      "utf8",
    );
    expect(collaboraCssVariables()).toContain(
      "--spellbook-editor-accent-rgb=53,64,74",
    );
    expect(hostCss).toContain("--doc-type: var(--spellbook-editor-accent-rgb");
    for (const duplicate of [
      "#document-titlebar",
      ".unoSave",
      ".unoUndo",
      ".unoRedo",
    ])
      expect(hostCss).toContain(duplicate);
  });

  it("sets type in the seven steps only", () => {
    const values = tokenValues();
    const steps = [...values.entries()]
      .filter(
        ([token, value]) =>
          /^--ds-text-[a-z0-9]+$/.test(token) && value.endsWith("px"),
      )
      .map(([, value]) => value);
    expect(steps).toEqual([
      "11.5px",
      "12.5px",
      "13px",
      "14px",
      "16px",
      "18px",
      "26px",
    ]);
    const stray: string[] = [];
    for (const file of systemCss.filter((file) => file !== tokensFile))
      for (const match of stripComments(readFileSync(file, "utf8")).matchAll(
        /font-size:\s*([^;]+);/g,
      ))
        if (
          !/^var\(--ds-text-(?:xs|sm|md|base|lg|xl|2xl)\)$|^[0-9.]+em$|^inherit$/.test(
            match[1]!.trim(),
          )
        )
          stray.push(`${path.basename(file)}: ${match[1]}`);
    expect(stray).toEqual([]);
    expect(values.get("--ds-control-sm")).toBe("26px");
    expect(values.get("--ds-control-md")).toBe("30px");
    expect(values.get("--ds-control-lg")).toBe("40px");
  });

  it("draws every icon inside its 24×24 box", () => {
    const source = readFileSync(
      path.join(sourceRoot, "design-system", "icon.tsx"),
      "utf8",
    );
    const outside: string[] = [];
    for (const [, name, paths] of source.matchAll(/^\s+(\w+): \[([^\]]*)\]/gm))
      for (const [, d] of paths!.matchAll(/"([^"]*)"/g)) {
        // A path's first move is absolute even when written lower-case.
        const start = /^[Mm]\s*(-?[\d.]+)[\s,]*(-?[\d.]+)/.exec(d!);
        if (
          !start ||
          [start[1], start[2]].some(
            (value) => Number(value) < 0 || Number(value) > 24,
          )
        )
          outside.push(`${name}: ${d}`);
      }
    expect(outside).toEqual([]);
  });

  it("reserves the AI colour for the AI role", () => {
    const values = tokenValues();
    const teal = values.get("--sb-teal-600");
    const aiRoles = [...values.entries()]
      .filter(([, value]) => value === "var(--sb-teal-600)")
      .map(([token]) => token)
      .filter((token) => !token.startsWith("--ds-accent"));
    expect(teal).toBe("#0f6f61");
    expect(aiRoles).toEqual(["--ds-ai"]);
  });
});
