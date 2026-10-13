#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const failures = [];
const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean),
);
const generatedControlFiles = new Set([
  "apps/web/AGENTS.md",
  "apps/web/CLAUDE.md",
]);
const ignoredDirectories = new Set([
  ".git",
  ".spellbook",
  ".next",
  "node_modules",
  "dist",
  "bin",
  "obj",
  "coverage",
  "artifacts",
  "playwright-report",
  "test-results",
  "__pycache__",
]);
const forbiddenTopLevel = new Set(["infra"]);
const forbiddenNames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "MOAI_OPERATIONS.md",
]);
const textExtensions = new Set([
  "",
  ".cs",
  ".conf",
  ".css",
  ".dockerignore",
  ".env",
  ".gitignore",
  ".go",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".patch",
  ".py",
  ".rs",
  ".sh",
  ".slnx",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const forbiddenContent = [
  [/accounts\.moai\.to/gi, "private Replex identity endpoint"],
  [/MOAI_ACCOUNTS/gi, "private Replex identity variable"],
  [/moai-fbdfc/gi, "private cloud project"],
  [/salaryup-db/gi, "unrelated production database"],
  [
    /(?:fineday9@gmail\.com|hello@replex\.me|dfg1499@gmail\.com)/gi,
    "private identity",
  ],
  [/present-web-mviaa4yhiq/gi, "private service endpoint"],
  [
    /(?:@google-cloud\/|Google\.Cloud\.(?:Storage|Tasks)|SecretManagerServiceClient|CloudTasksClient)/g,
    "hosted cloud SDK",
  ],
  [
    /(?:GOOGLE_CLOUD_PROJECT|SPELLBOOK_GCP_PROJECT_ID|SPELLBOOK_BUCKET)/g,
    "hosted cloud variable",
  ],
  [/(?:eval\/private|\.moai\/|MOAI_OPERATIONS)/g, "private workspace path"],
];

walk(root);

if (failures.length) {
  console.error(`Public boundary check failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Public boundary check passed");

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".tmp-"))
      continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    // Cargo build output at the repository root.
    if (relative === "target") continue;
    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
        failures.push(`${relative}: symlink escapes repository`);
      continue;
    }
    if (entry.isDirectory()) {
      if (!relative.includes("/") && forbiddenTopLevel.has(entry.name))
        failures.push(
          `${relative}/: hosted infrastructure directory is forbidden`,
        );
      else walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (generatedControlFiles.has(relative) && !trackedFiles.has(relative))
      continue;
    if (entry.name.endsWith(".tsbuildinfo")) continue;
    if (forbiddenNames.has(entry.name) || entry.name.endsWith(".pyc"))
      failures.push(
        `${relative}: generated or private control file is forbidden`,
      );
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) && !entry.name.startsWith("Dockerfile"))
      continue;
    if (relative === "scripts/check-public-boundary.mjs") continue;
    const content = fs.readFileSync(absolute, "utf8");
    for (const [pattern, reason] of forbiddenContent) {
      pattern.lastIndex = 0;
      if (pattern.test(content))
        failures.push(`${relative}: contains ${reason}`);
    }
  }
}
