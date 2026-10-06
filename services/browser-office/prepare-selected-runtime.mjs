/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  admitSelectedOnlyOffice,
  selectedDistribution,
  configuredBrowserEngine,
} from "./engine-selection.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
if (configuredBrowserEngine() === "libreoffice") {
  execFileSync(process.execPath, [path.join(root, "fetch-runtime.mjs")], {
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "build-harness.mjs")], {
    stdio: "inherit",
  });
} else {
  const directory = selectedDistribution();
  if (process.argv[2]) {
    const source = path.resolve(process.argv[2]);
    await admitSelectedOnlyOffice(source);
    if (source !== directory) {
      try {
        await fs.access(directory);
      } catch {
        await fs.cp(source, directory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    }
  }
  const admission = await admitSelectedOnlyOffice(directory);
  try {
    for (const file of [
      "workspace.bundle.js",
      "sdk.bundle.js",
      "local-ai.bundle.js",
    ])
      await fs.access(path.join(root, "onlyoffice/workspace-dist", file));
    await fs.access(path.join(root, "runtime/ooxml-worker.js"));
  } catch {
    execFileSync(
      process.execPath,
      [path.join(root, "onlyoffice/build-workspace.mjs")],
      { stdio: "inherit" },
    );
  }
  console.log(
    JSON.stringify({ engine: "onlyoffice", admission, engineBuilds: 0 }),
  );
}
