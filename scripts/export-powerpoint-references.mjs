import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POWERPOINT_APP = "/Applications/Microsoft PowerPoint.app";
const POWERPOINT_CONTAINER_DOCUMENTS = path.join(
  os.homedir(),
  "Library/Containers/com.microsoft.Powerpoint/Data/Documents",
);
const DEFAULT_DPI = 144;
const DEFAULT_TIMEOUT_MS = 300_000;

export async function retainNativeReferencePdf(pdfPath, directory) {
  await fs.copyFile(pdfPath, path.join(directory, "reference.pdf"));
}

// Launch Services opens the deck without activating PowerPoint (-g), so an
// export never takes input focus from whoever is using the machine; a
// PowerPoint that the export has to launch also starts hidden (-j).
const EXPORT_APPLESCRIPT = String.raw`
on run argv
  set sourcePath to item 1 of argv
  set outputPath to item 2 of argv
  set openedPresentation to missing value
  tell application "Microsoft PowerPoint"
    if (count of presentations) is not 0 then error "PowerPoint has an open presentation. Close it before corpus export."
  end tell
  do shell script "/usr/bin/open -g -j -a 'Microsoft PowerPoint' " & quoted form of sourcePath
  tell application "Microsoft PowerPoint"
    try
      set waitedTenths to 0
      repeat while (count of presentations) is 0
        if waitedTenths is greater than 1200 then error "PowerPoint did not open the presentation."
        delay 0.1
        set waitedTenths to waitedTenths + 1
      end repeat
      set openedPresentation to presentation 1
      save openedPresentation in (POSIX file outputPath) as save as PDF
      close openedPresentation saving no
    on error errorMessage number errorNumber
      if openedPresentation is not missing value then
        try
          close openedPresentation saving no
        end try
      end if
      error errorMessage number errorNumber
    end try
  end tell
  return outputPath
end run
`;

export function parseRasterSlideName(file) {
  const match = path.basename(file).match(/^slide-(\d+)\.png$/i);
  return match ? Number(match[1]) : null;
}

export function buildReferenceRenderer({
  powerPointVersion,
  macOsVersion,
  dpi,
}) {
  return {
    name: "Microsoft PowerPoint",
    version: powerPointVersion,
    os: `macOS ${macOsVersion}`,
    exportProcedure: `PowerPoint AppleScript save as PDF, then Poppler pdftoppm ${dpi} DPI PNG; one image per slide`,
  };
}

export async function exportPowerPointReferences({
  manifestPath,
  referencesRoot,
  dpi = DEFAULT_DPI,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (process.platform !== "darwin")
    throw new Error("PowerPoint reference export currently requires macOS.");
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600)
    throw new Error("--dpi must be an integer between 72 and 600.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000)
    throw new Error(
      "--timeout-ms must be an integer between 30000 and 900000.",
    );

  await fs.access(POWERPOINT_APP);
  const openCount = Number(
    requireCommand("osascript", [
      "-e",
      'tell application "Microsoft PowerPoint" to return (count of presentations)',
    ]).stdout.trim(),
  );
  if (openCount !== 0)
    throw new Error(
      `PowerPoint has ${openCount} open presentation(s). Close them before corpus export.`,
    );
  requireCommand("pdftoppm", ["-v"]);

  const absoluteManifest = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifest);
  const manifest = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  validateManifest(manifest);
  const absoluteReferencesRoot = referencesRoot
    ? path.resolve(referencesRoot)
    : path.join(manifestDirectory, "references-powerpoint-macos");
  await fs.mkdir(absoluteReferencesRoot, { recursive: true, mode: 0o700 });

  const powerPointVersion = requireCommand("mdls", [
    "-name",
    "kMDItemVersion",
    "-raw",
    POWERPOINT_APP,
  ]).stdout.trim();
  const macOsVersion = requireCommand("sw_vers", [
    "-productVersion",
  ]).stdout.trim();
  const referenceRenderer = buildReferenceRenderer({
    powerPointVersion,
    macOsVersion,
    dpi,
  });
  const exported = [];
  const failures = [];

  for (const [index, deck] of manifest.decks.entries()) {
    const source = path.resolve(manifestDirectory, deck.source);
    await fs.access(source);
    const sourceSha256 = await sha256(source);
    const finalDirectory = path.join(absoluteReferencesRoot, safeName(deck.id));
    const reusable = await reusableReference(finalDirectory, {
      sourceSha256,
      referenceRenderer,
    });
    if (reusable) {
      deck.references = relativePosix(manifestDirectory, finalDirectory);
      exported.push({ id: deck.id, slides: reusable.slides, status: "reused" });
      console.log(
        `[powerpoint] ${index + 1}/${manifest.decks.length} ${deck.id}: reused ${reusable.slides} slide(s)`,
      );
      continue;
    }
    if (await exists(finalDirectory))
      throw new Error(
        `Reference directory already exists but is stale or incomplete: ${finalDirectory}`,
      );

    const temporaryDirectory = await fs.mkdtemp(
      path.join(absoluteReferencesRoot, `.${safeName(deck.id)}-`),
    );
    const powerPointStagingDirectory = await fs.mkdtemp(
      path.join(POWERPOINT_CONTAINER_DOCUMENTS, "spellbook-reference-"),
    );
    try {
      const stagedSource = path.join(powerPointStagingDirectory, "source.pptx");
      const pdfPath = path.join(powerPointStagingDirectory, "reference.pdf");
      await fs.copyFile(source, stagedSource);
      runPowerPointExport(stagedSource, pdfPath, timeoutMs);
      requireCommand("pdftoppm", [
        "-png",
        "-r",
        String(dpi),
        pdfPath,
        path.join(temporaryDirectory, "slide"),
      ]);
      const slides = await normalizeRasterNames(temporaryDirectory);
      if (slides === 0)
        throw new Error(`PowerPoint exported no slides for ${deck.id}.`);
      // Retain the native PDF for text-origin/font diagnostics; PNG alone
      // cannot explain changes in shaping, tracking, or paragraph layout.
      await retainNativeReferencePdf(pdfPath, temporaryDirectory);
      await fs.rm(pdfPath);
      await fs.rm(stagedSource);
      await fs.writeFile(
        path.join(temporaryDirectory, "reference-metadata.json"),
        `${JSON.stringify(
          { sourceSha256, referenceRenderer, slides },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await fs.rename(temporaryDirectory, finalDirectory);
      await fs.rm(powerPointStagingDirectory, { recursive: true, force: true });
      deck.references = relativePosix(manifestDirectory, finalDirectory);
      exported.push({ id: deck.id, slides, status: "exported" });
      console.log(
        `[powerpoint] ${index + 1}/${manifest.decks.length} ${deck.id}: exported ${slides} slide(s)`,
      );
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      await fs.rm(powerPointStagingDirectory, {
        recursive: true,
        force: true,
      });
      const message = error instanceof Error ? error.message : String(error);
      delete deck.references;
      failures.push({ id: deck.id, error: message });
      console.error(
        `[powerpoint] ${index + 1}/${manifest.decks.length} ${deck.id}: failed: ${message}`,
      );
      recoverPowerPointAfterFailure();
    }
  }

  manifest.referenceRenderer = referenceRenderer;
  manifest.referenceFailures = failures;
  const temporaryManifest = `${absoluteManifest}.tmp-${process.pid}`;
  await fs.writeFile(
    temporaryManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.rename(temporaryManifest, absoluteManifest);

  return {
    manifest: absoluteManifest,
    referencesRoot: absoluteReferencesRoot,
    referenceRenderer,
    decks: exported.length,
    slides: exported.reduce((sum, item) => sum + item.slides, 0),
    exported: exported.filter((item) => item.status === "exported").length,
    reused: exported.filter((item) => item.status === "reused").length,
    failures,
  };
}

function runPowerPointExport(source, pdfPath, timeoutMs) {
  const result = spawnSync("osascript", ["-", source, pdfPath], {
    encoding: "utf8",
    input: EXPORT_APPLESCRIPT,
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0)
    throw commandError("Microsoft PowerPoint", result);
}

function recoverPowerPointAfterFailure() {
  const stateResult = spawnSync(
    "osascript",
    [
      "-e",
      'tell application "Microsoft PowerPoint"',
      "-e",
      "set presentationCount to count of presentations",
      "-e",
      'set presentationName to ""',
      "-e",
      "if presentationCount is 1 then set presentationName to name of presentation 1",
      "-e",
      "return (presentationCount as string) & tab & presentationName",
      "-e",
      "end tell",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (stateResult.error || stateResult.status !== 0)
    throw commandError("PowerPoint recovery inspection", stateResult);

  const [countText, name = ""] = stateResult.stdout.trim().split("\t");
  const count = Number(countText);
  if (count > 1 || (count === 1 && name !== "source.pptx"))
    throw new Error(
      `PowerPoint recovery refused to close an unrelated presentation: count=${count}, name=${name || "<none>"}.`,
    );

  if (count === 1) {
    const closeResult = spawnSync(
      "osascript",
      [
        "-e",
        'tell application "Microsoft PowerPoint" to close presentation "source.pptx" saving no',
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (closeResult.error || closeResult.status !== 0) terminatePowerPoint();
  }

  const quitResult = spawnSync(
    "osascript",
    ["-e", 'tell application "Microsoft PowerPoint" to quit saving no'],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (quitResult.error || quitResult.status !== 0) terminatePowerPoint();

  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const running = spawnSync("pgrep", ["-x", "Microsoft PowerPoint"]);
    if (running.status !== 0) return;
    Atomics.wait(waitBuffer, 0, 0, 100);
  }

  terminatePowerPoint();
  const terminationDeadline = Date.now() + 10_000;
  while (Date.now() < terminationDeadline) {
    const running = spawnSync("pgrep", ["-x", "Microsoft PowerPoint"]);
    if (running.status !== 0) return;
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
  throw new Error("PowerPoint did not exit during recovery.");
}

function terminatePowerPoint() {
  const terminateResult = spawnSync(
    "pkill",
    ["-TERM", "-x", "Microsoft PowerPoint"],
    { encoding: "utf8" },
  );
  if (![0, 1].includes(terminateResult.status ?? -1))
    throw commandError("PowerPoint recovery", terminateResult);
}

async function normalizeRasterNames(directory) {
  const rasterFiles = (await fs.readdir(directory))
    .map((file) => ({ file, slide: parseRasterSlideName(file) }))
    .filter((item) => item.slide !== null)
    .sort((left, right) => left.slide - right.slide);
  for (const { file, slide } of rasterFiles) {
    const canonical = `slide-${slide}.png`;
    if (file !== canonical)
      await fs.rename(
        path.join(directory, file),
        path.join(directory, canonical),
      );
  }
  return rasterFiles.length;
}

async function reusableReference(directory, expected) {
  try {
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(directory, "reference-metadata.json"),
        "utf8",
      ),
    );
    if (
      metadata.sourceSha256 !== expected.sourceSha256 ||
      JSON.stringify(metadata.referenceRenderer) !==
        JSON.stringify(expected.referenceRenderer) ||
      !Number.isInteger(metadata.slides) ||
      metadata.slides < 1
    )
      return null;
    for (let slide = 1; slide <= metadata.slides; slide += 1)
      await fs.access(path.join(directory, `slide-${slide}.png`));
    return { slides: metadata.slides };
  } catch {
    return null;
  }
}

function validateManifest(manifest) {
  if (manifest.contractVersion !== "1.0")
    throw new Error("corpus contractVersion must be 1.0.");
  if (!Array.isArray(manifest.decks) || manifest.decks.length === 0)
    throw new Error("At least one corpus deck is required.");
  for (const deck of manifest.decks)
    if (!deck.id || !deck.source)
      throw new Error("Every deck requires id and source.");
}

function parseArguments(argv) {
  const parsed = { dpi: DEFAULT_DPI, timeout_ms: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--manifest" || value === "--references-root")
      parsed[value.slice(2).replaceAll("-", "_")] = argv[++index];
    else if (value === "--dpi") parsed.dpi = Number(argv[++index]);
    else if (value === "--timeout-ms")
      parsed.timeout_ms = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.manifest)
    throw new Error(
      "Usage: --manifest <corpus.json> [--references-root <directory>] [--dpi 144] [--timeout-ms 300000]",
    );
  return {
    manifestPath: parsed.manifest,
    referencesRoot: parsed.references_root,
    dpi: parsed.dpi,
    timeoutMs: parsed.timeout_ms,
  };
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw commandError(command, result);
  return result;
}

function commandError(command, result) {
  const detail = [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return new Error(
    `${command} failed${result.status === null ? "" : ` with ${result.status}`}: ${detail.slice(0, 1200)}`,
  );
}

async function sha256(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function relativePosix(base, target) {
  return path.relative(base, target).split(path.sep).join("/") || ".";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await exportPowerPointReferences(
      parseArguments(process.argv.slice(2)),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length > 0) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
