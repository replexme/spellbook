/* SPDX-License-Identifier: MPL-2.0 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assertBuildFilesystem(root) {
  mkdirSync(root, { recursive: true });
  const probe = mkdtempSync(path.join(root, ".spellbook-filesystem-"));
  try {
    writeFileSync(
      path.join(probe, "spellbook-case-probe"),
      "case-sensitive build input\n",
    );
    if (existsSync(path.join(probe, "SPELLBOOK-CASE-PROBE"))) {
      throw new Error(
        "LibreOffice build requires a case-sensitive filesystem. Use a Docker named volume or a case-sensitive Linux build directory; macOS shared bind mounts can misresolve UNO type names.",
      );
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2]) throw new Error("Build directory required");
  assertBuildFilesystem(path.resolve(process.argv[2]));
}
