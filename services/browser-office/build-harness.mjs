import { mkdir, writeFile } from "node:fs/promises";
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHarness();
  process.stdout.write("built ooxml-worker.js\n");
}
