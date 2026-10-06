/* SPDX-License-Identifier: MPL-2.0 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { configuredBrowserEngine, admitSelectedOnlyOffice, selectedDistribution } from "./engine-selection.mjs";

// Never prepare one engine and silently verify another. This command checks
// the selected distribution and host contracts without compiling an engine.
// The full native cohort remains a separate, explicit fixture-driven command.
if (configuredBrowserEngine() !== "onlyoffice")
  throw Error("Use the explicit browser-office:verify:libreoffice rollback command");
const admission = await admitSelectedOnlyOffice(selectedDistribution());
const root = path.resolve(import.meta.dirname, "../..");
const files = [];
for (const directory of ["services/browser-office", "services/browser-office/onlyoffice"]) {
  for (const file of await fs.readdir(path.join(root, directory))) {
    if (file.endsWith(".test.mjs")) files.push(path.join(directory, file));
  }
}
const result = spawnSync(process.execPath, ["--test", ...files.sort()], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({ engine: "onlyoffice", admission, scope: "distribution integrity and host contract tests; not a customer launch admission", newBuilds: 0 }));
