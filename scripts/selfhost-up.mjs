#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanupScript = path.join(root, "scripts", "cleanup-local-docker.mjs");

export function selfhostUpPlan(
  nodeExecutable = process.execPath,
  editorMode = configuredSelfhostEditorMode(),
) {
  if (!new Set(["wopi", "browser"]).has(editorMode))
    throw new Error("SPELLBOOK_EDITOR_MODE must be wopi or browser.");
  const inactiveEditor =
    editorMode === "browser" ? "office-editor" : "browser-office";
  const compose = ["compose", "--profile", editorMode];
  return {
    beforeBuild: [nodeExecutable, [cleanupScript, "--execute"]],
    stopInactive: [
      "docker",
      ["compose", "stop", "--timeout", "30", inactiveEditor],
    ],
    build: ["docker", [...compose, "build"]],
    start: [
      "docker",
      [
        ...compose,
        "up",
        "--detach",
        "--no-build",
        "--wait",
        "--remove-orphans",
      ],
    ],
    afterStart: [nodeExecutable, [cleanupScript, "--execute"]],
  };
}

export function configuredSelfhostEditorMode(
  environment = process.env,
  environmentFile = path.join(root, ".env"),
) {
  if (environment.SPELLBOOK_EDITOR_MODE)
    return environment.SPELLBOOK_EDITOR_MODE.trim().toLowerCase();
  try {
    const line = readFileSync(environmentFile, "utf8")
      .split(/\r?\n/u)
      .find((entry) => entry.startsWith("SPELLBOOK_EDITOR_MODE="));
    return (
      line?.slice("SPELLBOOK_EDITOR_MODE=".length).trim().toLowerCase() ||
      "browser"
    );
  } catch {
    return "browser";
  }
}

function execute([command, args]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.status}`}.`,
    );
}

export function runSelfhostUp(plan = selfhostUpPlan(), executeStep = execute) {
  executeStep(plan.beforeBuild);
  try {
    executeStep(plan.stopInactive);
    executeStep(plan.build);
    executeStep(plan.start);
  } finally {
    executeStep(plan.afterStart);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runSelfhostUp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
