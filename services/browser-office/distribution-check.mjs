/* SPDX-License-Identifier: MPL-2.0 */
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyOfficeDistribution(root) {
  root = path.resolve(root);
  const resolve = (name) => {
    if (
      !name ||
      name.includes("\\") ||
      path.isAbsolute(name) ||
      name.split("/").some((part) => part === "..")
    )
      throw new Error("Unsafe distribution path: " + name);
    return path.join(root, name);
  };
  const hash = async (name) => {
    const file = resolve(name);
    if (!(await lstat(file)).isFile())
      throw new Error("Distribution file must be regular: " + name);
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  };
  const manifestBytes = await readFile(resolve("distribution-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.engine !== "onlyoffice")
    throw new Error("Unsupported Office distribution manifest");
  if (
    !manifest.sourceMaterialsPackaged ||
    !manifest.sources?.length ||
    !manifest.files?.length
  )
    throw new Error("Office distribution lacks source/build materials");
  const expected = new Map();
  for (const file of manifest.files) {
    if (expected.has(file.path))
      throw new Error("Duplicate distribution file: " + file.path);
    expected.set(file.path, file.sha256);
    if ((await hash(file.path)) !== file.sha256)
      throw new Error("Distribution hash mismatch: " + file.path);
  }
  // A hashed but stale precompressed file can serve different code or fonts.
  // Every compression variant must decode to its final plain counterpart.
  let runtimeCompressedPairsVerified = 0;
  for (const name of expected.keys()) {
    if (!name.endsWith(".br")) continue;
    const plain = name.slice(0, -3);
    if (!expected.has(plain))
      throw new Error("Compressed asset lacks a listed counterpart: " + name);
    let decoded;
    try {
      decoded = brotliDecompressSync(await readFile(resolve(name)));
    } catch {
      throw new Error("Invalid compressed runtime asset: " + name);
    }
    if (!decoded.equals(await readFile(resolve(plain))))
      throw new Error(
        "Compressed runtime content differs from plain asset: " + name,
      );
    runtimeCompressedPairsVerified++;
  }
  async function walk(relative = "") {
    for (const entry of await readdir(resolve(relative || "."), {
      withFileTypes: true,
    })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (!entry.isFile())
        throw new Error("Unexpected non-file in distribution: " + name);
      else if (name !== "distribution-manifest.json" && !expected.has(name))
        throw new Error("Unlisted distribution file: " + name);
    }
  }
  await walk();
  for (const source of manifest.sources) {
    if ((await hash("sources/" + source.archive)) !== source.archiveSha256)
      throw new Error("Source archive identity mismatch: " + source.id);
  }
  if (manifest.auxiliaryWasmRebuildVerified === true) {
    const receiptPath = "sources/auxiliary-build-receipt.json";
    if (!expected.has(receiptPath))
      throw new Error("Auxiliary rebuild receipt is missing");
    const receipt = JSON.parse(await readFile(resolve(receiptPath), "utf8"));
    const source = manifest.sources.filter(
      (entry) => entry.id === "onlyoffice-auxiliary",
    );
    if (
      source.length !== 1 ||
      receipt.schemaVersion !== 1 ||
      receipt.cleanRebuildVerified !== true ||
      receipt.reproductionStatus !== "exact-reproduction-verified" ||
      receipt.sourceArchive !== source[0].archive ||
      receipt.sourceArchiveSha256 !== source[0].archiveSha256 ||
      !/^emscripten\/emsdk@sha256:[a-f0-9]{64}$/u.test(receipt.compilerImage) ||
      receipt.platform !== "linux/amd64"
    )
      throw new Error(
        "Auxiliary rebuild source/compiler evidence is incomplete",
      );
    const modules = {
      zlib: "sdkjs/common/zlib/engine/zlib",
      spell: "sdkjs/common/spell/spell/spell",
      hash: "sdkjs/common/hash/hash/engine",
      font: "sdkjs/common/libfont/engine/fonts",
    };
    if (!Array.isArray(receipt.outputs) || receipt.outputs.length !== 8)
      throw new Error("Auxiliary rebuild must bind all four JS/WASM pairs");
    if (
      receipt.reproductionReport !== "auxiliary-reproduction.json" ||
      expected.get("sources/" + receipt.reproductionReport) !==
        receipt.reproductionReportSha256
    )
      throw new Error(
        "Auxiliary clean reproduction report is missing or changed",
      );
    const reproduction = JSON.parse(
      await readFile(resolve("sources/" + receipt.reproductionReport), "utf8"),
    );
    if (
      reproduction.status !== receipt.reproductionStatus ||
      reproduction.sourceArchiveSha256 !== receipt.sourceArchiveSha256 ||
      reproduction.compilerImage !== receipt.compilerImage ||
      reproduction.platform !== receipt.platform ||
      !Array.isArray(reproduction.outputs) ||
      reproduction.outputs.length !== 8
    )
      throw new Error("Auxiliary clean reproduction evidence is incomplete");
    for (const [module, base] of Object.entries(modules))
      for (const extension of ["js", "wasm"]) {
        const name = base + "." + extension;
        const rows = receipt.outputs.filter(
          (row) => row.module === module && row.path === name,
        );
        const reproduced = reproduction.outputs.filter(
          (row) => row.module === module && row.path === name,
        );
        if (
          rows.length !== 1 ||
          rows[0].sha256 !== expected.get(name) ||
          reproduced.length !== 1 ||
          reproduced[0].sha256 !== rows[0].sha256 ||
          reproduced[0].reproduced !== true
        )
          throw new Error(
            "Auxiliary rebuild output identity mismatch: " + name,
          );
      }
  }
  const license = "LICENSE-AGPL-3.0.txt";
  for (const name of [
    license,
    "NOTICE.txt",
    "licensing.html",
    "sources/BUILD.md",
  ])
    if (!expected.has(name))
      throw new Error("Missing legal/source material: " + name);
  const fonts = JSON.parse(
    await readFile(resolve("onlyoffice-browser-font-assets.json"), "utf8"),
  );
  const permissions = JSON.parse(
    await readFile(resolve("font-licenses.json"), "utf8"),
  ).fonts;
  if (
    fonts.fontSet !== "redistributable" ||
    permissions.length !== fonts.fonts.length
  )
    throw new Error(
      "Distribution fonts are not reviewed redistributable assets",
    );
  for (const file of fonts.fonts) {
    const entries = permissions.filter(
      (permission) => permission.file === file,
    );
    if (
      entries.length !== 1 ||
      entries[0].license !== "OFL-1.1" ||
      !entries[0].notice?.includes("SIL OPEN FONT LICENSE") ||
      !entries[0].source?.startsWith("https://") ||
      (await hash(file)) !== entries[0].sha256
    )
      throw new Error("Missing or mismatched font permission: " + file);
  }
  if (
    !manifestBytes.equals(await readFile(resolve("distribution-manifest.json")))
  )
    throw new Error("Distribution manifest changed during verification");
  return {
    distributionSha256: createHash("sha256")
      .update(manifestBytes)
      .digest("hex"),
    engine: manifest.engine,
    files: expected.size,
    fonts: fonts.fonts.length,
    sourceMaterialsPackaged: true,
    runtimeCompressedPairsVerified,
    auxiliaryWasmRebuildVerified:
      manifest.auxiliaryWasmRebuildVerified === true,
    upstreamEditorRebuildVerified:
      manifest.upstreamEditorRebuildVerified === true,
  };
}

// Trial finalization must retain a failed readback in its report rather than
// losing the report when an asset was removed or changed during execution.
export async function readOfficeDistributionEvidence(root) {
  try {
    return { valid: true, ...(await verifyOfficeDistribution(root)) };
  } catch (error) {
    return { valid: false, error: String(error.message ?? error) };
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  if (!process.argv[2])
    throw new Error("Usage: node distribution-check.mjs <distribution-root>");
  console.log(
    JSON.stringify(await verifyOfficeDistribution(process.argv[2]), null, 2),
  );
}
