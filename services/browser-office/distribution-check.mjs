/* SPDX-License-Identifier: MPL-2.0 */
import { createHash } from "node:crypto";
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
