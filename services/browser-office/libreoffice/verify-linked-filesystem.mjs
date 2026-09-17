import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBrowserOfficeFilesystemLayout,
  assertBrowserOfficePackageMetadata,
} from "./runtime-package.mjs";

export async function verifyLinkedFilesystem(wasmBuild) {
  const program = path.join(wasmBuild, "instdir/program");
  const packageRoot = path.join(
    wasmBuild,
    "workdir/CustomTarget/static/emscripten_fs_image",
  );
  const [javascript, metadataBytes, data] = await Promise.all([
    readFile(path.join(program, "soffice.js"), "utf8"),
    readFile(path.join(packageRoot, "soffice.data.js.metadata")),
    stat(path.join(packageRoot, "soffice.data")),
  ]);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assertBrowserOfficePackageMetadata(metadata, data.size);
  assertBrowserOfficeFilesystemLayout(metadata, javascript);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const buildFlag = process.argv.indexOf("--wasm-build");
  if (buildFlag < 0 || !process.argv[buildFlag + 1])
    throw new Error(
      "Usage: node verify-linked-filesystem.mjs --wasm-build <directory>",
    );
  await verifyLinkedFilesystem(path.resolve(process.argv[buildFlag + 1]));
}
