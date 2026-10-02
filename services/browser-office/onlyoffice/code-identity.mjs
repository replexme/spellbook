/* SPDX-License-Identifier: MPL-2.0 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Generated code is ignored by Git. Bind the actual SDK (both halves), host,
// component and converter used by local trials; this is not font/asset admission.
export async function readOnlyOfficeCodeIdentity(candidateRoot) {
  const root = path.join(candidateRoot, "dist");
  const files = [];
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(?:js|mjs|wasm)$/u.test(name)) {
        if (!entry.isFile())
          throw new Error("Candidate code must be a regular file: " + name);
        const bytes = await readFile(path.join(root, name));
        files.push({
          path: name,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk();
  files.sort((a, b) => a.path.localeCompare(b.path));
  for (const engine of ["slide", "cell"])
    for (const part of ["sdk-all.js", "sdk-all-min.js"])
      if (!files.some((file) => file.path === `sdkjs/${engine}/${part}`))
        throw new Error(`Candidate ${engine} SDK is incomplete: ${part}`);
  if (
    !files.some((file) => file.path === "npm/public-api.js") ||
    !files.some((file) => file.path.endsWith(".wasm"))
  )
    throw new Error("Candidate component/converter code is incomplete");
  return {
    scope:
      "Generated JavaScript and WASM code in candidate dist; excludes fonts and non-code assets",
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
}
