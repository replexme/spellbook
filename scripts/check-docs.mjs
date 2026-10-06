#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const rootMarkdownAllowlist = new Set([
  "README.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
]);
const requiredDocuments = [
  "docs/README.md",
  "docs/product/format-support.md",
  "docs/product/multiformat-roadmap.md",
  "docs/architecture/document-platform.md",
  "docs/architecture/open-core-boundary.md",
  "docs/delivery/self-hosting.md",
  "docs/delivery/release-gates.md",
  "docs/delivery/runtime-verification-2026-09-11.md",
  "docs/research/open-core-selfhost-research-2026-09-11.md",
];

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (
    entry.isFile() &&
    entry.name.endsWith(".md") &&
    !rootMarkdownAllowlist.has(entry.name)
  ) {
    failures.push(
      `${entry.name}: project-root Markdown is not allowed; move it under docs/<responsibility>`,
    );
  }
}

for (const relativePath of requiredDocuments) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    failures.push(`${relativePath}: required canonical document is missing`);
  }
}

const mutationCapabilities = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts/native-edit-capabilities.json"),
    "utf8",
  ),
);
const editorUpstream = JSON.parse(
  fs.readFileSync(
    path.join(root, "services/office-editor/libreoffice/upstream.json"),
    "utf8",
  ),
);
const mutationOperations = Object.values(
  mutationCapabilities.mutationModel.operations,
);
const operationCount = mutationOperations.length;
const exposedOperationCount =
  mutationCapabilities.toolInputSchema.properties.op.enum.length;
const availabilityCount = (availability) =>
  mutationOperations.filter(
    (operation) => operation.availability === availability,
  ).length;
const candidateOperationCount =
  availabilityCount("engine_patch_ready") +
  availabilityCount("runtime_validation_required");
const formatSupport = fs.readFileSync(
  path.join(root, "docs/product/format-support.md"),
  "utf8",
);
for (const requiredStatement of [
  `classifies ${operationCount} operations`,
  `of which ${exposedOperationCount} bounded operations are exposed`,
  `Registry status: ${availabilityCount("runtime_verified")} runtime-verified; ${candidateOperationCount} engine candidates (\`${editorUpstream.patchLevel}\`).`,
]) {
  if (!formatSupport.includes(requiredStatement))
    failures.push(
      `docs/product/format-support.md: capability summary drifted; expected "${requiredStatement}"`,
    );
}

function markdownFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".spellbook" ||
        entry.name === "artifacts" ||
        path.relative(root, path.join(directory, entry.name)) === "services/browser-office/onlyoffice/distribution" ||
        entry.name.startsWith(".tmp"))
    ) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".md"))
      result.push(fullPath);
  }
  return result;
}

function checkDestination(source, destination) {
  let value = destination.trim();
  if (
    !value ||
    value.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)
  ) {
    return;
  }
  if (value.startsWith("<") && value.includes(">"))
    value = value.slice(1, value.indexOf(">"));
  else value = value.match(/^\S+/)?.[0] ?? "";
  const filePart = value.split(/[?#]/, 1)[0];
  if (!filePart) return;

  let decoded = filePart;
  try {
    decoded = decodeURIComponent(filePart);
  } catch {
    failures.push(
      `${path.relative(root, source)}: invalid encoded link ${filePart}`,
    );
    return;
  }

  const target = path.resolve(path.dirname(source), decoded);
  if (!fs.existsSync(target)) {
    failures.push(
      `${path.relative(root, source)}: broken relative link ${filePart}`,
    );
  }
}

for (const source of markdownFiles(root)) {
  const content = fs.readFileSync(source, "utf8");
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(([^\n)]*)\)/g)) {
    checkDestination(source, match[1]);
  }
  for (const match of content.matchAll(/^\s*\[(?!\^)[^\]]+\]:\s*(\S+)/gm)) {
    checkDestination(source, match[1]);
  }
}

if (failures.length > 0) {
  console.error(`Documentation check failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Documentation check passed");
