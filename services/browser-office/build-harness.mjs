import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { upstreamManifest } from "./libreoffice/upstream.mjs";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(serviceRoot, "runtime");
export async function buildHarness() {
  await mkdir(runtimeRoot, { recursive: true });
  const browserCandidate = {
    buildCommit: upstreamManifest.source.buildCommit,
    candidateCommit: upstreamManifest.source.candidateCommit,
    patchLevel: upstreamManifest.sourceCandidate.patchLevel,
    patchSeriesSha256: upstreamManifest.sourceCandidate.patchSeriesSha256,
    buildReady: upstreamManifest.sourceCandidate.buildReady,
    nativeSlideStructureReady:
      upstreamManifest.sourceCandidate.nativeSlideStructureReady,
  };
  await writeFile(
    path.join(runtimeRoot, "browser-candidate.js"),
    `globalThis.spellbookBrowserRuntimeCandidate = Object.freeze(${JSON.stringify(browserCandidate)});\n`,
  );
  await build({
    entryPoints: [path.join(serviceRoot, "ooxml-worker-source.mjs")],
    outfile: path.join(runtimeRoot, "ooxml-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "eof",
    logLevel: "warning",
  });
}

// Reuse is explicit and bound to exact bytes; a missing or stale worker cannot
// fall through into a build when the caller requested verification only.
export async function prepareHarness({
  argv = process.argv,
  runtimeDirectory = runtimeRoot,
} = {}) {
  const index = argv.indexOf("--existing-harness-worker-sha256");
  if (index < 0) return buildHarness();
  const worker = path.join(runtimeDirectory, "ooxml-worker.js");
  return verifyExistingArtifact(worker, argv[index + 1]);
}

export async function verifyExistingArtifact(file, expectedSha256) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? ""))
    throw new Error(
      "An existing artifact requires an explicit SHA-256; no build was started.",
    );
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256)
    throw new Error(
      "Existing artifact hash differs; no build was started: " + file,
    );
  return { file, bytes: bytes.length, sha256, newBuilds: 0 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildHarness();
  process.stdout.write("built ooxml-worker.js\n");
}
