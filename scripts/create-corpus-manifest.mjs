import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export async function discoverPptxFiles(
  roots,
  { limit = 30, maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  const discovered = [];
  for (const root of roots)
    await walk(path.resolve(root), discovered, maxBytes);
  return discovered
    .sort(
      (left, right) =>
        left.bytes - right.bytes || left.path.localeCompare(right.path),
    )
    .slice(0, limit);
}

export function buildDiscoveryManifest(
  files,
  rendererVersion,
  rendererImage = "spellbook-document-worker:local",
) {
  return {
    contractVersion: "1.0",
    corpusId: `local-discovery-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
    renderer: {
      name: "Spellbook document engine",
      image: rendererImage,
      version: rendererVersion,
    },
    referenceRenderer: {
      name: "Microsoft PowerPoint",
      version: "not-recorded",
      os: "not-recorded",
      exportProcedure: "not-recorded",
    },
    reviewRendererVersion: rendererVersion,
    categoryMinimums: {
      "basic-corporate": 6,
      "korean-text": 5,
      "group-rotation-image": 4,
      "table-chart-smartart": 4,
      "master-layout": 3,
      "complex-external": 3,
    },
    decks: files.map((file, index) => ({
      id: `local-${String(index + 1).padStart(2, "0")}-${createHash("sha256").update(file.path).digest("hex").slice(0, 8)}`,
      source: file.path,
      sourceBytes: file.bytes,
      supportClass: "D",
      usageRights: "unverified",
      sensitivity: "unclassified",
      categories: ["unclassified-real-deck"],
    })),
  };
}

async function walk(directory, discovered, maxBytes) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, discovered, maxBytes);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pptx")) {
      const stat = await fs.stat(target);
      if (stat.size <= maxBytes)
        discovered.push({ path: target, bytes: stat.size });
    }
  }
}

function parseArguments(argv) {
  const parsed = { roots: [], limit: 30, maxBytes: DEFAULT_MAX_BYTES };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--root") parsed.roots.push(argv[++index]);
    else if (value === "--output") parsed.output = argv[++index];
    else if (value === "--limit") parsed.limit = Number(argv[++index]);
    else if (value === "--max-bytes") parsed.maxBytes = Number(argv[++index]);
    else if (value === "--renderer-version")
      parsed.rendererVersion = argv[++index];
    else if (value === "--renderer-image") parsed.rendererImage = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (parsed.roots.length === 0 || !parsed.output || !parsed.rendererVersion) {
    throw new Error(
      "Usage: --root <directory> [--root <directory>] --output <corpus.json> --renderer-version <release> [--renderer-image <image>] [--limit 30] [--max-bytes 52428800]",
    );
  }
  if (!Number.isInteger(parsed.limit) || parsed.limit < 1)
    throw new Error("--limit must be a positive integer.");
  if (!Number.isInteger(parsed.maxBytes) || parsed.maxBytes < 1)
    throw new Error("--max-bytes must be a positive integer.");
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const files = await discoverPptxFiles(options.roots, options);
    if (files.length === 0)
      throw new Error("No PPTX files matched the discovery boundary.");
    const manifest = buildDiscoveryManifest(
      files,
      options.rendererVersion,
      options.rendererImage,
    );
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ output, decks: manifest.decks.length }, null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
