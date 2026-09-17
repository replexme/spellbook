import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { upstreamManifest } from "./libreoffice/upstream.mjs";
import {
  assertBrowserOfficeFilesystemLayout,
  assertBrowserOfficePackageMetadata,
} from "./libreoffice/runtime-package.mjs";

const requiredArtifactNames = Object.freeze([
  "soffice.js",
  "soffice.data.js.metadata",
  "soffice.wasm",
  "soffice.data",
  "soffice.wasm.br",
  "soffice.data.br",
]);
const servedRuntimeArtifacts = Object.freeze([
  {
    path: "soffice.js",
    storedPath: "soffice.js",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    path: "soffice.data.js.metadata",
    storedPath: "soffice.data.js.metadata",
    contentType: "application/json",
  },
  {
    path: "soffice.wasm",
    storedPath: "soffice.wasm.br",
    contentType: "application/wasm",
    contentEncoding: "br",
  },
  {
    path: "soffice.data",
    storedPath: "soffice.data.br",
    contentType: "application/octet-stream",
    contentEncoding: "br",
  },
]);

export async function admitCandidateRuntime({
  runtimeDirectory,
  receiptPath = path.join(runtimeDirectory, "build-receipt.json"),
  manifest = upstreamManifest,
}) {
  const directory = path.resolve(runtimeDirectory);
  const receiptBytes = await readFile(path.resolve(receiptPath));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  assertReceiptIdentity(receipt, manifest);

  const receiptArtifacts = new Map(
    receipt.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  if (receiptArtifacts.size !== requiredArtifactNames.length)
    throw new Error(
      "Candidate runtime receipt has an unexpected artifact set.",
    );

  const verifiedArtifacts = new Map();
  let packageMetadata;
  let packageBytes;
  let runtimeJavascript;
  for (const name of requiredArtifactNames) {
    const expected = receiptArtifacts.get(name);
    if (!expected) throw new Error(`Candidate runtime receipt omits ${name}.`);
    const file = path.join(directory, name);
    const [bytes, details] = await Promise.all([readFile(file), stat(file)]);
    if (!details.isFile() || details.size !== expected.bytes)
      throw new Error(`Candidate runtime size differs for ${name}.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256)
      throw new Error(`Candidate runtime digest differs for ${name}.`);
    if (
      name === "soffice.wasm" &&
      !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    )
      throw new Error("Candidate runtime artifact is not WebAssembly.");
    if (name.endsWith(".metadata"))
      packageMetadata = JSON.parse(bytes.toString("utf8"));
    if (name === "soffice.data") packageBytes = bytes.byteLength;
    if (name === "soffice.js") runtimeJavascript = bytes.toString("utf8");
    verifiedArtifacts.set(name, {
      bytes: details.size,
      sha256,
    });
  }
  assertBrowserOfficePackageMetadata(packageMetadata, packageBytes);
  assertBrowserOfficeFilesystemLayout(packageMetadata, runtimeJavascript);
  const runtimeAssets = servedRuntimeArtifacts.map((asset) => ({
    ...asset,
    ...verifiedArtifacts.get(asset.storedPath),
  }));

  const runtimeIdentity = Object.freeze({
    buildCommit: manifest.source.candidateCommit,
    candidateCommit: manifest.source.candidateCommit,
    patchLevel: manifest.sourceCandidate.patchLevel,
    patchSeriesSha256: manifest.sourceCandidate.patchSeriesSha256,
    publicCommit: receipt.spellbookSourceRevision,
    buildReady: true,
    // Candidate verification must exercise the patched slide lifecycle. The
    // tracked upstream manifest remains false until that verification and the
    // PowerPoint matrix pass; gating it here would make promotion impossible
    // by testing only the rejection path.
    nativeSlideStructureReady: true,
  });
  return {
    runtimeDirectory: directory,
    receipt,
    receiptSha256,
    runtimeIdentity,
    upstream: {
      ...manifest,
      source: {
        ...manifest.source,
        buildCommit: manifest.source.candidateCommit,
      },
      sourceCandidate: {
        ...manifest.sourceCandidate,
        buildReady: true,
        nativeSlideStructureReady: true,
      },
      runtimeAssets,
    },
  };
}

function assertReceiptIdentity(receipt, manifest) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.status !== "built_unverified" ||
    !/^[0-9a-f]{40}$/u.test(receipt.spellbookSourceRevision ?? "")
  )
    throw new Error("Candidate runtime receipt is not a built artifact.");
  const expectedLibreOffice = {
    repository: manifest.source.repository,
    commit: manifest.source.candidateCommit,
    patchLevel: manifest.sourceCandidate.patchLevel,
    patchSeriesSha256: manifest.sourceCandidate.patchSeriesSha256,
  };
  if (
    JSON.stringify(receipt.libreOffice) !== JSON.stringify(expectedLibreOffice)
  )
    throw new Error("Candidate runtime LibreOffice identity differs.");
  if (JSON.stringify(receipt.toolchain) !== JSON.stringify(manifest.toolchain))
    throw new Error("Candidate runtime toolchain identity differs.");
  if (
    JSON.stringify(receipt.wasmModules) !==
    JSON.stringify(manifest.sourceCandidate.wasmModules)
  )
    throw new Error("Candidate runtime module set differs.");
  if (!Array.isArray(receipt.artifacts))
    throw new Error("Candidate runtime receipt has no artifacts.");
  for (const artifact of receipt.artifacts) {
    if (
      !artifact ||
      typeof artifact.name !== "string" ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")
    )
      throw new Error("Candidate runtime receipt has an invalid artifact.");
  }
}
