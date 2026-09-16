import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computePatchSeriesSha256, upstreamManifest } from "./upstream.mjs";
import { assertBrowserOfficePackageMetadata } from "./runtime-package.mjs";

const requiredArtifacts = Object.freeze([
  "soffice.js",
  "soffice.data.js.metadata",
  "soffice.wasm",
  "soffice.data",
  "soffice.wasm.br",
  "soffice.data.br",
]);

export async function createBrowserRuntimeReceipt({
  runtimeDirectory,
  repositoryRoot,
  sourceRevision,
  builtAt = new Date().toISOString(),
  platform = `${os.platform()}-${os.arch()}`,
}) {
  const patchSeriesSha256 = computePatchSeriesSha256();
  if (patchSeriesSha256 !== upstreamManifest.sourceCandidate.patchSeriesSha256)
    throw new Error("Browser patch series changed during the build.");

  const artifacts = [];
  let packageMetadata;
  let packageBytes;
  for (const name of requiredArtifacts) {
    const artifactPath = path.join(runtimeDirectory, name);
    const [bytes, details] = await Promise.all([
      readFile(artifactPath),
      stat(artifactPath),
    ]);
    if (!details.isFile() || bytes.byteLength === 0)
      throw new Error(`Browser runtime artifact is empty: ${name}`);
    if (
      name === "soffice.wasm" &&
      !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    )
      throw new Error("Browser runtime artifact is not WebAssembly.");
    if (name.endsWith(".metadata"))
      packageMetadata = JSON.parse(bytes.toString("utf8"));
    if (name === "soffice.data") packageBytes = bytes.byteLength;
    artifacts.push({
      name,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assertBrowserOfficePackageMetadata(packageMetadata, packageBytes);

  const resolvedSourceRevision =
    sourceRevision ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  if (!/^[0-9a-f]{40}$/u.test(resolvedSourceRevision))
    throw new Error("Spellbook source revision is not immutable.");

  return {
    schemaVersion: 2,
    status: "built_unverified",
    builtAt,
    platform,
    spellbookSourceRevision: resolvedSourceRevision,
    libreOffice: {
      repository: upstreamManifest.source.repository,
      commit: upstreamManifest.source.candidateCommit,
      patchLevel: upstreamManifest.sourceCandidate.patchLevel,
      patchSeriesSha256,
    },
    wasmModules: upstreamManifest.sourceCandidate.wasmModules,
    toolchain: upstreamManifest.toolchain,
    artifacts,
  };
}

async function main() {
  const runtimeFlag = process.argv.indexOf("--runtime-dir");
  const outputFlag = process.argv.indexOf("--output");
  if (
    runtimeFlag < 0 ||
    !process.argv[runtimeFlag + 1] ||
    outputFlag < 0 ||
    !process.argv[outputFlag + 1]
  )
    throw new Error(
      "Usage: node write-build-receipt.mjs --runtime-dir <dir> --output <json>",
    );
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDirectory, "../../..");
  const receipt = await createBrowserRuntimeReceipt({
    runtimeDirectory: path.resolve(process.argv[runtimeFlag + 1]),
    repositoryRoot,
    sourceRevision: process.env.SPELLBOOK_SOURCE_REVISION,
  });
  await writeFile(
    path.resolve(process.argv[outputFlag + 1]),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
