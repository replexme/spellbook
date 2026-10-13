import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["raw.githubusercontent.com"]);

const FEATURE_RULES = {
  "strict-ooxml": ({ xml }) => /purl\.oclc\.org\/ooxml/u.test(xml),
  "slide-size": ({ xml }) => /<(?:p:)?sldSz\b/u.test(xml),
  "slide-master-layout": ({ entries }) =>
    hasEntry(entries, "ppt/slideMasters/") &&
    hasEntry(entries, "ppt/slideLayouts/"),
  theme: ({ entries }) => hasEntry(entries, "ppt/theme/"),
  placeholder: ({ visualXml }) => /<(?:p:)?ph\b/u.test(visualXml),
  text: ({ visualXml }) => /<(?:a:)?t>/u.test(visualXml),
  "text-columns": ({ visualXml }) => /\bnumCol="[2-9]/u.test(visualXml),
  "text-rtl": ({ visualXml }) => /\b(?:rtl|rtlCol)="1"/u.test(visualXml),
  "text-vertical": ({ visualXml }) =>
    /\bvert="(?!horz")[^"]+"/u.test(visualXml),
  "text-autofit": ({ visualXml }) =>
    /<(?:a:)?(?:normAutofit|spAutoFit|noAutofit)\b/u.test(visualXml),
  bullets: ({ visualXml }) =>
    /<(?:a:)?bu(?:AutoNum|Char|Blip|None)\b/u.test(visualXml),
  "alternate-language": ({ visualXml }) => /\baltLang="[^"]+"/u.test(visualXml),
  "embedded-font": ({ entries }) => hasEntry(entries, "ppt/fonts/"),
  "basic-shape": ({ visualXml }) => /<(?:p:)?sp\b/u.test(visualXml),
  connector: ({ visualXml }) => /<(?:p:)?cxnSp\b/u.test(visualXml),
  "custom-geometry": ({ visualXml }) => /<(?:a:)?custGeom\b/u.test(visualXml),
  group: ({ visualXml }) => /<(?:p:)?grpSp\b/u.test(visualXml),
  rotation: ({ visualXml }) => /\brot="-?\d+"/u.test(visualXml),
  "solid-fill": ({ visualXml }) => /<(?:a:)?solidFill\b/u.test(visualXml),
  "gradient-fill": ({ visualXml }) => /<(?:a:)?gradFill\b/u.test(visualXml),
  "pattern-or-bitmap-fill": ({ visualXml }) =>
    /<(?:a:)?(?:pattFill|blipFill)\b/u.test(visualXml),
  transparency: ({ visualXml }) =>
    /<(?:a:)?alpha(?:ModFix|Off)?\b/u.test(visualXml),
  effects: ({ visualXml }) =>
    /<(?:a:)?(?:effectLst|effectDag|outerShdw|innerShdw|reflection|softEdge|glow)\b/u.test(
      visualXml,
    ),
  "three-dimensional": ({ visualXml }) =>
    /<(?:a:)?(?:scene3d|sp3d|bevelT|bevelB|extrusionClr)\b/u.test(visualXml),
  picture: ({ visualXml }) => /<(?:p:)?pic\b/u.test(visualXml),
  "picture-crop": ({ visualXml }) => /<(?:a:)?srcRect\b/u.test(visualXml),
  "vector-image": ({ entries }) =>
    entries.some((entry) => /\.(?:svg|emf|wmf)$/iu.test(entry)),
  "animated-gif": ({ entries }) =>
    entries.some((entry) => /\.gif$/iu.test(entry)),
  table: ({ entries, visualXml }) =>
    hasEntry(entries, "ppt/tables/") || /<(?:a:)?tbl\b/u.test(visualXml),
  chart: ({ entries }) => hasEntry(entries, "ppt/charts/"),
  smartart: ({ entries }) => hasEntry(entries, "ppt/diagrams/"),
  "word-art": ({ visualXml }) => /<(?:a:)?prstTxWarp\b/u.test(visualXml),
  ink: ({ entries, visualXml }) =>
    entries.some((entry) => /\/ink\//iu.test(entry)) ||
    /inkml|contentType="ink"|<(?:o:)?ink\b/iu.test(visualXml),
  "embedded-media": ({ entries }) =>
    entries.some((entry) =>
      /ppt\/media\/.*\.(?:mp3|m4a|wav|wma|mp4|m4v|mov|avi)$/iu.test(entry),
    ),
  "ole-object": ({ entries, visualXml }) =>
    hasEntry(entries, "ppt/embeddings/") || /<(?:p:)?oleObj\b/u.test(visualXml),
  equation: ({ visualXml }) => /<(?:m:)?oMath(?:Para)?\b/u.test(visualXml),
  hyperlink: ({ relationships }) =>
    /relationships\/hyperlink/iu.test(relationships),
  "external-relationship": ({ relationships }) =>
    /TargetMode="External"/u.test(relationships),
  notes: ({ entries }) => hasEntry(entries, "ppt/notesSlides/"),
  comments: ({ entries }) =>
    hasEntry(entries, "ppt/comments/") ||
    hasEntry(entries, "ppt/commentAuthors.xml"),
  transition: ({ visualXml }) => /<(?:p:)?transition\b/u.test(visualXml),
  animation: ({ visualXml }) => /<(?:p:)?timing\b/u.test(visualXml),
  activex: ({ entries }) => hasEntry(entries, "ppt/activeX/"),
  "custom-xml": ({ entries }) => hasEntry(entries, "customXml/"),
  sections: ({ xml }) => /<(?:p14:)?sectionLst\b/u.test(xml),
};

export function detectPptxFeatures(parts) {
  return Object.entries(FEATURE_RULES)
    .filter(([, rule]) => rule(parts))
    .map(([feature]) => feature)
    .sort();
}

export function validateCatalog(catalog, matrix) {
  if (catalog.contractVersion !== "1.0")
    throw new Error("public corpus contractVersion must be 1.0.");
  if (!Array.isArray(catalog.repositories) || catalog.repositories.length === 0)
    throw new Error("At least one upstream repository is required.");
  if (!Array.isArray(catalog.decks) || catalog.decks.length === 0)
    throw new Error("At least one public corpus deck is required.");
  if (matrix.contractVersion !== "1.0" || !Array.isArray(matrix.features))
    throw new Error("feature matrix contractVersion must be 1.0.");

  const repositories = new Map();
  for (const repository of catalog.repositories) {
    if (
      !repository.id ||
      !repository.repositoryUrl ||
      !/^[0-9a-f]{40}$/u.test(repository.revision) ||
      !repository.license?.spdx ||
      !repository.license?.url ||
      !repository.license?.scope
    )
      throw new Error(
        `Invalid repository record: ${repository.id ?? "unknown"}`,
      );
    if (repositories.has(repository.id))
      throw new Error(`Duplicate repository id: ${repository.id}`);
    repositories.set(repository.id, repository);
  }

  const knownFeatures = new Set(matrix.features.map((feature) => feature.id));
  const ids = new Set();
  for (const deck of catalog.decks) {
    if (
      !deck.id ||
      !repositories.has(deck.repository) ||
      !deck.path?.toLowerCase().endsWith(".pptx") ||
      !/^[0-9a-f]{64}$/u.test(deck.sha256) ||
      !Number.isInteger(deck.bytes) ||
      deck.bytes < 1 ||
      deck.bytes > DEFAULT_MAX_BYTES ||
      !Array.isArray(deck.expectedFeatures) ||
      deck.expectedFeatures.length === 0
    )
      throw new Error(`Invalid deck record: ${deck.id ?? "unknown"}`);
    if (ids.has(deck.id)) throw new Error(`Duplicate deck id: ${deck.id}`);
    ids.add(deck.id);
    for (const feature of deck.expectedFeatures)
      if (!knownFeatures.has(feature))
        throw new Error(`Unknown feature '${feature}' in ${deck.id}.`);
  }

  return { repositories, knownFeatures };
}

export function assessCoverage(matrix, decks) {
  const counts = Object.fromEntries(matrix.features.map(({ id }) => [id, 0]));
  for (const deck of decks)
    for (const feature of new Set(deck.detectedFeatures ?? []))
      if (feature in counts) counts[feature] += 1;

  const required = matrix.features.filter(
    (feature) => feature.verification !== "excluded",
  );
  const gaps = required
    .filter((feature) => counts[feature.id] < (feature.minimumFixtures ?? 1))
    .map((feature) => ({
      feature: feature.id,
      expected: feature.minimumFixtures ?? 1,
      actual: counts[feature.id],
    }));
  return { status: gaps.length === 0 ? "pass" : "incomplete", counts, gaps };
}

export async function inspectPptx(file) {
  const entriesResult = spawnSync("unzip", ["-Z1", file], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (entriesResult.error || entriesResult.status !== 0)
    throw commandError("unzip", entriesResult);
  const entries = entriesResult.stdout.split(/\r?\n/u).filter(Boolean).sort();
  const xml = unzipText(file, "*.xml");
  const visualXml = `${unzipText(file, "ppt/slides/*.xml", {
    optional: true,
  })}\n${unzipText(file, "ppt/slideLayouts/*.xml", {
    optional: true,
  })}\n${unzipText(file, "ppt/slideMasters/*.xml", {
    optional: true,
  })}\n${unzipText(file, "ppt/notesSlides/*.xml", {
    optional: true,
  })}\n${unzipText(file, "ppt/diagrams/*.xml", {
    optional: true,
  })}\n${unzipText(file, "*.vml", { optional: true })}`;
  const relationships = unzipText(file, "*.rels");
  const slideCount = entries.filter((entry) =>
    /^ppt\/slides\/slide\d+\.xml$/u.test(entry),
  ).length;
  if (slideCount === 0) throw new Error(`${file} contains no slides.`);
  return {
    slideCount,
    entryCount: entries.length,
    detectedFeatures: detectPptxFeatures({
      entries,
      xml,
      visualXml,
      relationships,
    }),
  };
}

function unzipText(file, pattern, { optional = false } = {}) {
  const result = spawnSync("unzip", ["-p", file, pattern], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !optional))
    throw commandError("unzip", result);
  if (result.status !== 0) return "";
  return result.stdout;
}

export async function fetchPublicCorpus(options) {
  const catalogPath = path.resolve(options.catalog);
  const matrixPath = path.resolve(options.matrix);
  const [catalog, matrix] = await Promise.all([
    readJson(catalogPath),
    readJson(matrixPath),
  ]);
  const { repositories } = validateCatalog(catalog, matrix);
  const downloads = path.resolve(options.downloads);
  await fs.mkdir(downloads, { recursive: true, mode: 0o700 });
  const existingManifest = await readOptionalJson(options.manifestOutput);

  const results = [];
  for (const deck of catalog.decks) {
    const repository = repositories.get(deck.repository);
    const sourceUrl = rawUrl(repository, deck.path);
    const target = path.join(downloads, `${safeName(deck.id)}.pptx`);
    const existing = await fileIdentity(target);
    const reused =
      existing?.sha256 === deck.sha256 && existing.bytes === deck.bytes;
    if (!reused) {
      const response = await fetch(sourceUrl, { redirect: "error" });
      if (!response.ok)
        throw new Error(
          `Download failed for ${deck.id}: HTTP ${response.status}`,
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      const identity = bufferIdentity(bytes);
      if (identity.bytes !== deck.bytes || identity.sha256 !== deck.sha256)
        throw new Error(
          `Pinned identity mismatch for ${deck.id}: expected ${deck.bytes}/${deck.sha256}, got ${identity.bytes}/${identity.sha256}.`,
        );
      const temporary = `${target}.partial`;
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, target);
    }
    const inspection = await inspectPptx(target);
    const missingExpected = deck.expectedFeatures.filter(
      (feature) => !inspection.detectedFeatures.includes(feature),
    );
    if (missingExpected.length > 0)
      throw new Error(
        `${deck.id} is missing expected features: ${missingExpected.join(", ")}.`,
      );
    results.push({
      id: deck.id,
      repository: deck.repository,
      upstreamPath: deck.path,
      sourceUrl,
      sha256: deck.sha256,
      bytes: deck.bytes,
      reused,
      ...inspection,
    });
  }

  const coverage = assessCoverage(matrix, results);
  const coverageReport = {
    contractVersion: "1.0",
    corpusId: catalog.corpusId,
    repositories: catalog.repositories.map((repository) => ({
      id: repository.id,
      repositoryUrl: repository.repositoryUrl,
      revision: repository.revision,
      license: repository.license,
    })),
    summary: {
      decks: results.length,
      slides: results.reduce((sum, deck) => sum + deck.slideCount, 0),
      bytes: results.reduce((sum, deck) => sum + deck.bytes, 0),
      coverageStatus: coverage.status,
    },
    coverage,
    decks: results,
  };
  await writeJson(options.coverageOutput, coverageReport);

  const manifestDirectory = path.dirname(path.resolve(options.manifestOutput));
  const manifest = preserveReferenceState(
    {
      contractVersion: "1.0",
      corpusId: catalog.corpusId,
      renderer: {
        name: "Spellbook document engine",
        image: options.rendererImage,
        version: options.rendererVersion,
      },
      referenceRenderer: {
        name: "Microsoft PowerPoint",
        version: "not-recorded",
        os: "not-recorded",
        exportProcedure: "not-recorded",
      },
      reviewRendererVersion: options.rendererVersion,
      categoryMinimums: {},
      decks: catalog.decks.map((deck) => {
        const repository = repositories.get(deck.repository);
        return {
          id: deck.id,
          source: path.relative(
            manifestDirectory,
            path.join(downloads, `${safeName(deck.id)}.pptx`),
          ),
          supportClass: "B",
          usageRights: `repository-license-${repository.license.spdx}; fixture-specific-redistribution-not-asserted; fetched-for-regression-only; see ${repository.license.url}`,
          sensitivity: "public-upstream-fixture",
          categories: deck.expectedFeatures,
        };
      }),
    },
    existingManifest,
  );
  await writeJson(options.manifestOutput, manifest, 0o600);
  return { coverageReport, manifest };
}

export function preserveReferenceState(manifest, existingManifest) {
  if (!existingManifest || existingManifest.corpusId !== manifest.corpusId)
    return manifest;

  const existingDecks = new Map(
    (existingManifest.decks ?? []).map((deck) => [deck.id, deck]),
  );
  for (const deck of manifest.decks) {
    const existing = existingDecks.get(deck.id);
    if (
      existing?.source === deck.source &&
      typeof existing.references === "string"
    )
      deck.references = existing.references;
  }
  if (manifest.decks.some((deck) => deck.references))
    manifest.referenceRenderer = existingManifest.referenceRenderer;
  if (Array.isArray(existingManifest.referenceFailures))
    manifest.referenceFailures = existingManifest.referenceFailures;
  return manifest;
}

function rawUrl(repository, sourcePath) {
  const base = new URL(repository.repositoryUrl);
  if (base.protocol !== "https:" || base.hostname !== "github.com")
    throw new Error(`Unsupported repository URL: ${repository.repositoryUrl}`);
  const segments = base.pathname.split("/").filter(Boolean);
  if (segments.length !== 2)
    throw new Error(`Invalid GitHub repository URL: ${base}`);
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/${repository.revision}/${encodedPath}`,
  );
  if (!ALLOWED_HOSTS.has(url.hostname))
    throw new Error(`Download host is not allowlisted: ${url.hostname}`);
  return url.toString();
}

function hasEntry(entries, prefix) {
  return entries.some((entry) => entry.startsWith(prefix));
}

async function fileIdentity(file) {
  try {
    const bytes = await fs.readFile(file);
    return bufferIdentity(bytes);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function bufferIdentity(bytes) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value, mode = 0o644) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function commandError(command, result) {
  const detail = [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return new Error(`${command} failed: ${detail.slice(0, 1200)}`);
}

function parseArguments(argv) {
  const parsed = {
    catalog: "eval/public/sources.json",
    matrix: "eval/public/feature-matrix.json",
    downloads: "eval/public/downloads",
    coverageOutput: "eval/public/coverage.json",
    manifestOutput: ".tmp-eval/public-corpus.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--catalog") parsed.catalog = argv[++index];
    else if (value === "--matrix") parsed.matrix = argv[++index];
    else if (value === "--downloads") parsed.downloads = argv[++index];
    else if (value === "--coverage-output")
      parsed.coverageOutput = argv[++index];
    else if (value === "--manifest-output")
      parsed.manifestOutput = argv[++index];
    else if (value === "--renderer-version")
      parsed.rendererVersion = argv[++index];
    else if (value === "--renderer-image") parsed.rendererImage = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.rendererVersion || !parsed.rendererImage)
    throw new Error(
      "Usage: --renderer-version <release> --renderer-image <image> [--catalog ... --matrix ... --downloads ... --coverage-output ... --manifest-output ...]",
    );
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await fetchPublicCorpus(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify(
        {
          decks: result.coverageReport.summary.decks,
          slides: result.coverageReport.summary.slides,
          bytes: result.coverageReport.summary.bytes,
          coverage: result.coverageReport.summary.coverageStatus,
        },
        null,
        2,
      ),
    );
    if (result.coverageReport.coverage.status !== "pass") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
