import { upstreamManifest } from "./upstream.mjs";

const requiredModuleAssets = Object.freeze({
  calc: "/instdir/share/config/soffice.cfg/modules/scalc/menubar/menubar.xml",
  writer:
    "/instdir/share/config/soffice.cfg/modules/swriter/menubar/menubar.xml",
  impress:
    "/instdir/share/config/soffice.cfg/modules/simpress/menubar/menubar.xml",
  draw: "/instdir/share/config/soffice.cfg/modules/sdraw/menubar/menubar.xml",
});

export function assertBrowserOfficePackageMetadata(metadata, dataBytes) {
  if (
    !Number.isSafeInteger(dataBytes) ||
    dataBytes <= 0 ||
    metadata?.remote_package_size !== dataBytes ||
    !Array.isArray(metadata.files)
  )
    throw new Error(
      "Browser Office package metadata does not match its data file.",
    );

  const files = new Map(metadata.files.map((file) => [file.filename, file]));
  for (const module of [
    ...upstreamManifest.sourceCandidate.wasmModules,
    "draw",
  ]) {
    const asset = requiredModuleAssets[module];
    const file = files.get(asset);
    if (
      !file ||
      !Number.isSafeInteger(file.start) ||
      !Number.isSafeInteger(file.end) ||
      file.start < 0 ||
      file.end <= file.start ||
      file.end > dataBytes
    )
      throw new Error(`Browser Office package is missing ${module} assets.`);
  }
}

export function assertBrowserOfficeFilesystemLayout(metadata, javascript) {
  if (!Array.isArray(metadata?.files) || typeof javascript !== "string")
    throw new Error("Browser Office filesystem layout is unavailable.");

  const createdDirectories = new Set(
    [
      ...javascript.matchAll(
        /Module\["FS_createPath"\]\("([^"]+)","([^"]+)",true,true\);/gu,
      ),
    ].map(([, parent, name]) => `${parent.replace(/\/$/u, "")}/${name}`),
  );
  const missing = [
    ...new Set(
      metadata.files.map((file) =>
        file.filename.slice(0, file.filename.lastIndexOf("/")),
      ),
    ),
  ].filter((directory) => !createdDirectories.has(directory));
  if (missing.length)
    throw new Error(
      `Browser Office package and JavaScript filesystem disagree: ${missing.length} directories are missing, beginning with ${missing[0]}.`,
    );
}
