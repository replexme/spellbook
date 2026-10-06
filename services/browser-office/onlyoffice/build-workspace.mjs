/* SPDX-License-Identifier: MPL-2.0 */
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.dirname(fileURLToPath(import.meta.url)),
  repo = path.resolve(root, "../../.."),
  out = path.join(root, "workspace-dist");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await fs.mkdir(out, { recursive: true });
// The Docker context excludes retained LibreOffice runtime files. Build the
// small source-preservation Worker independently from its engine; otherwise
// source packaging and the SDK Worker URL fail in a clean container context.
if (!process.argv.includes("--package-only")) {
  await fs.mkdir(path.join(repo, "services/browser-office/runtime"), { recursive: true });
  await build({
    entryPoints: [path.join(repo, "services/browser-office/ooxml-worker-source.mjs")],
    outfile: path.join(repo, "services/browser-office/runtime/ooxml-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    legalComments: "eof",
  });
}
const bundles = [];
// Only small host modules are bundled. No vendor engine or WASM is rebuilt.
for (const [input, output] of [
  ["workspace-entry.mjs", "workspace.bundle.js"],
  ["workspace-sdk-entry.mjs", "sdk.bundle.js"],
  ["../local-ai.mjs", "local-ai.bundle.js"],
]) {
  const result = process.argv.includes("--package-only")
    ? {
        metafile: JSON.parse(
          await fs.readFile(path.join(out, output + ".inputs.json"), "utf8"),
        ),
      }
    : await build({
        entryPoints: [path.join(root, input)],
        outfile: path.join(out, output),
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["/npm/*", "./local-workspace.mjs"],
        legalComments: "eof",
        metafile: true,
      });
  await fs.writeFile(
    path.join(out, output + ".inputs.json"),
    JSON.stringify(result.metafile, null, 2),
  );
  bundles.push({
    path: output,
    sha256: sha(await fs.readFile(path.join(out, output))),
    inputs: Object.keys(result.metafile.inputs),
  });
}
const sources = [];
async function collect(directory) {
  for (const entry of await fs.readdir(path.join(repo, directory), {
    withFileTypes: true,
  })) {
    const name = directory + "/" + entry.name;
    if (entry.isDirectory()) {
      if (
        !["runtime", "workspace-dist", "node_modules", "distribution"].includes(
          entry.name,
        )
      )
        await collect(name);
    } else if (
      entry.isFile() &&
      (/\.(mjs|js|json|html|md|ts|txt|patch|sh|py|css)$/.test(name) ||
        entry.name.startsWith("Dockerfile"))
    )
      sources.push(name);
  }
}
await collect("services/browser-office");
await collect("services/office-session-spike");
await collect("contracts");
await collect("LICENSES");
await collect("apps/web/src/design-system");
sources.push(
  "apps/web/src/lib/local-ai-connector.ts",
  "apps/web/src/lib/ai-connector-config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "docker-compose.yml",
  ".dockerignore",
  "services/browser-office/runtime/ooxml-worker.js",
);
for (const file of ["LICENSE", "LICENSE.txt", "LICENSE-MPL-2.0.txt"])
  try {
    await fs.access(path.join(repo, file));
    sources.push(file);
  } catch {}
for (const input of bundles.flatMap((b) => b.inputs))
  if (!input.includes("node_modules/"))
    sources.push(input.replace(/ with \{.*$/, ""));
const unique = [...new Set(sources)]
  .map((name) => path.relative(repo, path.resolve(repo, name)))
  .sort();
if (unique.some((name) => name.startsWith("../") || path.isAbsolute(name)))
  throw Error("source_path_invalid");
await fs.writeFile(
  path.join(out, "source-files.json"),
  JSON.stringify(unique, null, 2),
);
execFileSync("tar", [
  "-czf",
  path.join(out, "workspace-sources.tar.gz"),
  "-C",
  repo,
  ...unique,
], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const receipt = {
  scope:
    "host integration source and bundles; pinned vendor distribution, its source archives and auxiliary WASM reproduction evidence are separately served",
  bundles,
  sources: await Promise.all(
    unique.map(async (name) => ({
      path: name,
      sha256: sha(await fs.readFile(path.join(repo, name))),
    })),
  ),
  archiveSha256: sha(
    await fs.readFile(path.join(out, "workspace-sources.tar.gz")),
  ),
  engineBuilds: 0,
};
await fs.writeFile(
  path.join(out, "workspace-source-receipt.json"),
  JSON.stringify(receipt, null, 2),
);
console.log(
  JSON.stringify({
    hostBundles: bundles.length,
    sourceFiles: unique.length,
    engineBuilds: 0,
    archiveSha256: receipt.archiveSha256,
  }),
);
