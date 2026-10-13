import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_IMAGE = "spellbook-document-worker:local";
// Programs in the document worker image: the element graph comes from the .NET tool, the slide
// images from the document engine, with the fallback fonts the worker draws previews with.
const TOOL_PROGRAM = "/app/tool/Spellbook.Document.Tool";
const ENGINE_PROGRAM = "/app/present-pptx";
const RENDER_WIDTH = "1280";
export const DOCUMENT_TOOL_TIMEOUT_MS = 300_000;

export function assessCorpus(manifest, deckResults) {
  const reasons = [];
  const supportedA = deckResults.filter((deck) => deck.supportClass === "A");
  const allSlides = supportedA.flatMap((deck) => deck.slides ?? []);
  const reviewedSlides = allSlides.filter(
    (slide) => slide.humanReview?.severity,
  );
  const severeSlides = reviewedSlides.filter((slide) =>
    ["P0", "P1"].includes(slide.humanReview.severity),
  );
  const p0Slides = reviewedSlides.filter(
    (slide) => slide.humanReview.severity === "P0",
  );
  const renderFailures = supportedA.filter(
    (deck) => deck.status !== "rendered",
  );
  const restrictedDecks = supportedA.filter(
    (deck) => (deck.warnings?.length ?? 0) > 0,
  );
  const unsupportedSlides = allSlides.filter(
    (slide) => slide.supportGrade !== "A",
  );
  const fontRiskDecks = supportedA.filter(
    (deck) =>
      deck.fontAudit?.inventoryAvailable !== true ||
      (deck.fontAudit?.missingFonts?.length ?? 0) > 0,
  );
  const p1FreeRate =
    reviewedSlides.length === 0
      ? null
      : (reviewedSlides.length - severeSlides.length) / reviewedSlides.length;

  if (deckResults.length < 20)
    reasons.push(`코퍼스가 ${deckResults.length}개로 최소 20개보다 적다.`);
  if (supportedA.length === 0) reasons.push("A 지원 후보 덱이 없다.");
  if (
    !manifest.renderer?.name ||
    !manifest.renderer?.image ||
    !manifest.renderer?.version
  ) {
    reasons.push("렌더러 이름·이미지·버전이 고정되지 않았다.");
  }
  if (
    !manifest.referenceRenderer?.name ||
    !manifest.referenceRenderer?.version ||
    !manifest.referenceRenderer?.os ||
    !manifest.referenceRenderer?.exportProcedure
  ) {
    reasons.push("PowerPoint 기준 렌더러와 내보내기 절차가 고정되지 않았다.");
  }
  if (
    !manifest.reviewRendererVersion ||
    manifest.reviewRendererVersion !== manifest.renderer?.version
  ) {
    reasons.push(
      "사람 판정의 렌더러 버전이 현재 렌더러 버전과 일치하지 않는다.",
    );
  }
  const categoryMinimums = manifest.categoryMinimums ?? {};
  if (Object.keys(categoryMinimums).length === 0)
    reasons.push("기능 범주별 최소 덱 수가 고정되지 않았다.");
  for (const [category, minimum] of Object.entries(categoryMinimums)) {
    const actual = deckResults.filter((deck) =>
      deck.categories?.includes(category),
    ).length;
    if (!Number.isInteger(minimum) || minimum < 1)
      reasons.push(`${category}: 최소 덱 수가 양의 정수가 아니다.`);
    else if (actual < minimum)
      reasons.push(
        `${category}: ${actual}개로 고정한 최소 ${minimum}개보다 적다.`,
      );
  }
  for (const deck of deckResults) {
    if (!isVerifiedValue(deck.usageRights))
      reasons.push(`${deck.id}: 사용·평가 권리가 기록되지 않았다.`);
    if (!isVerifiedValue(deck.sensitivity))
      reasons.push(`${deck.id}: 민감도가 기록되지 않았다.`);
    if (!Array.isArray(deck.categories) || deck.categories.length === 0)
      reasons.push(`${deck.id}: 기능 범주가 기록되지 않았다.`);
  }
  const missingReferences = allSlides.filter(
    (slide) => !slide.reference?.exists,
  );
  if (missingReferences.length > 0)
    reasons.push(
      `A 슬라이드 ${missingReferences.length}개에 PowerPoint 기준 이미지가 없다.`,
    );
  const uncomparedSlides = allSlides.filter(
    (slide) => !isQuantitativelyCompared(slide.comparison),
  );
  if (uncomparedSlides.length > 0)
    reasons.push(
      `A 슬라이드 ${uncomparedSlides.length}개에 정량 비교 결과가 없다.`,
    );
  if (reviewedSlides.length !== allSlides.length)
    reasons.push(
      `A 슬라이드 ${allSlides.length - reviewedSlides.length}개에 사람 P0/P1/P2 판정이 없다.`,
    );

  const hardFailures = [];
  if (renderFailures.length > 0)
    hardFailures.push(`A 덱 ${renderFailures.length}개가 렌더링되지 않았다.`);
  if (restrictedDecks.length > 0)
    hardFailures.push(
      `A 덱 ${restrictedDecks.length}개에 편집 제한 경고가 있다.`,
    );
  if (unsupportedSlides.length > 0)
    hardFailures.push(
      `A 후보 안에 엔진 지원 등급 B 슬라이드가 ${unsupportedSlides.length}개 있다.`,
    );
  if (fontRiskDecks.length > 0)
    hardFailures.push(
      `A 후보 ${fontRiskDecks.length}개에 미확인 또는 누락 글꼴이 있다.`,
    );
  if (p0Slides.length > 0)
    hardFailures.push(`A 슬라이드 ${p0Slides.length}개에 P0 오류가 있다.`);
  if (
    p1FreeRate !== null &&
    reviewedSlides.length === allSlides.length &&
    p1FreeRate < 0.95
  ) {
    hardFailures.push(
      `A 슬라이드의 P1 없는 비율이 ${(p1FreeRate * 100).toFixed(1)}%로 95%보다 낮다.`,
    );
  }

  return {
    status:
      hardFailures.length > 0
        ? "fail"
        : reasons.length > 0
          ? "incomplete"
          : "pass",
    reasons: [...hardFailures, ...reasons],
    metrics: {
      corpusDecks: deckResults.length,
      supportedADecks: supportedA.length,
      supportedASlides: allSlides.length,
      referencedASlides: allSlides.length - missingReferences.length,
      comparedASlides: allSlides.length - uncomparedSlides.length,
      reviewedASlides: reviewedSlides.length,
      p0Slides: p0Slides.length,
      p1FreeRate,
      renderFailures: renderFailures.length,
      restrictedADecks: restrictedDecks.length,
      unsupportedASlides: unsupportedSlides.length,
      fontRiskADecks: fontRiskDecks.length,
    },
    contractVersion: manifest.contractVersion ?? null,
  };
}

export function summarizeDeckResults(deckResults) {
  const rendered = deckResults.filter((deck) => deck.status === "rendered");
  const totals = (key) =>
    rendered.reduce((sum, deck) => sum + (deck[key] ?? 0), 0);
  const mergeCounts = (key) => {
    const result = {};
    for (const deck of rendered) {
      for (const [name, count] of Object.entries(deck[key] ?? {}))
        result[name] = (result[name] ?? 0) + count;
    }
    return result;
  };
  const durations = rendered
    .map((deck) => deck.timings?.totalMs)
    .filter(Number.isFinite);
  const missingFontDeckCounts = {};
  const substitutionDeckCounts = {};
  for (const deck of rendered) {
    for (const family of deck.fontAudit?.missingFonts ?? []) {
      missingFontDeckCounts[family] = (missingFontDeckCounts[family] ?? 0) + 1;
    }
    for (const substitution of deck.fontAudit?.substitutions ?? []) {
      const pair = `${substitution.original}→${substitution.substituted}`;
      substitutionDeckCounts[pair] = (substitutionDeckCounts[pair] ?? 0) + 1;
    }
  }
  return {
    decks: deckResults.length,
    renderedDecks: rendered.length,
    failedDecks: deckResults.length - rendered.length,
    slides: totals("slideCount"),
    elements: totals("elementCount"),
    editableElements: totals("editableElementCount"),
    warnings: rendered.reduce(
      (sum, deck) => sum + (deck.warnings?.length ?? 0),
      0,
    ),
    elementKinds: mergeCounts("elementKinds"),
    supportGrades: mergeCounts("supportGrades"),
    fontAudit: {
      inventoryUnavailableDecks: rendered.filter(
        (deck) => deck.fontAudit?.inventoryAvailable !== true,
      ).length,
      decksWithMissingFonts: rendered.filter(
        (deck) => (deck.fontAudit?.missingFonts?.length ?? 0) > 0,
      ).length,
      missingFontDeckCounts,
      substitutionDeckCounts,
    },
    timingMs: {
      total: durations.reduce((sum, duration) => sum + duration, 0),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
  };
}

export function parseRmse(value) {
  const match = String(value).match(/(?:^|\s)[\d.]+\s+\(([\d.eE+-]+)\)/);
  if (!match)
    throw new Error(
      `ImageMagick RMSE output is not understood: ${String(value).trim()}`,
    );
  return Number(match[1]);
}

export function sortRenderedSlidePaths(files) {
  return [...files].sort(
    (left, right) => slideNumber(left) - slideNumber(right),
  );
}

export async function evaluateCorpus({ manifestPath, outputPath }) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifest);
  const manifest = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  validateManifest(manifest);
  const absoluteOutput = path.resolve(outputPath);
  await fs.mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
  const image = manifest.renderer?.image || DEFAULT_IMAGE;
  const rendererEnvironment = manifest.renderer?.environment ?? {};
  requireCommand("docker", ["image", "inspect", image]);
  const imageMagick = detectImageMagick();
  const magickAvailable = imageMagick !== null;
  const deckResults = [];

  for (const deck of manifest.decks) {
    console.log(`[corpus] ${deck.id}: start`);
    const deckStarted = performance.now();
    const source = path.resolve(manifestDirectory, deck.source);
    const deckOutput = path.join(absoluteOutput, safeName(deck.id));
    const renderOutput = path.join(deckOutput, "render");
    await fs.mkdir(renderOutput, { recursive: true, mode: 0o777 });
    await fs.chmod(deckOutput, 0o777);
    await fs.chmod(renderOutput, 0o777);
    const result = {
      id: deck.id,
      supportClass: deck.supportClass,
      usageRights: deck.usageRights,
      sensitivity: deck.sensitivity,
      categories: deck.categories,
      source: deck.source,
      sourceSha256: null,
      status: "pending",
      warnings: [],
      slides: [],
      timings: { inspectMs: null, renderMs: null, totalMs: null },
    };
    try {
      result.sourceSha256 = await fileSha256(source);
      const inspectStarted = performance.now();
      console.log(`[corpus] ${deck.id}: inspect start`);
      runDocumentTool(image, rendererEnvironment, source, deckOutput, [
        TOOL_PROGRAM,
        "inspect",
        "/input/document.pptx",
        "/output/element-graph.json",
      ]);
      result.timings.inspectMs = roundedMilliseconds(
        performance.now() - inspectStarted,
      );
      console.log(
        `[corpus] ${deck.id}: inspect complete in ${result.timings.inspectMs}ms`,
      );
      const renderStarted = performance.now();
      console.log(`[corpus] ${deck.id}: render start`);
      runDocumentTool(image, rendererEnvironment, source, deckOutput, [
        ENGINE_PROGRAM,
        "render-all",
        "/input/document.pptx",
        "/output/render",
        RENDER_WIDTH,
        "--fonts",
        "/app/fonts",
      ]);
      result.timings.renderMs = roundedMilliseconds(
        performance.now() - renderStarted,
      );
      console.log(
        `[corpus] ${deck.id}: render complete in ${result.timings.renderMs}ms`,
      );
      const graph = JSON.parse(
        await fs.readFile(path.join(deckOutput, "element-graph.json"), "utf8"),
      );
      const elements = (graph.slides ?? []).flatMap(
        (slide) => slide.elements ?? [],
      );
      result.status = "rendered";
      result.warnings = [
        ...new Set([
          ...(graph.warnings ?? []),
          ...(graph.slides ?? []).flatMap((slide) => slide.warnings ?? []),
        ]),
      ];
      result.slideCount = graph.slides?.length ?? 0;
      result.elementCount = elements.length;
      result.editableElementCount = elements.filter(
        (element) => element.editable,
      ).length;
      result.elementKinds = countValues(
        elements.map((element) => element.kind),
      );
      result.supportGrades = countValues(
        (graph.slides ?? []).map((slide) => slide.supportGrade),
      );
      result.fontAudit = {
        inventoryAvailable: graph.fontInventoryAvailable === true,
        declaredFonts: graph.declaredFonts ?? [],
        missingFonts: graph.missingFonts ?? [],
        substitutions: graph.fontSubstitutions ?? [],
      };
      result.detectedFeatures = {
        koreanTextElements: elements.filter((element) =>
          /[가-힣]/u.test(element.text ?? ""),
        ).length,
        rotatedElements: elements.filter(
          (element) => Number(element.rotation) !== 0,
        ).length,
        pictures: result.elementKinds.picture ?? 0,
        groups: result.elementKinds.group ?? 0,
        graphicFrames: result.elementKinds.graphicFrame ?? 0,
        connectors: result.elementKinds.connector ?? 0,
      };
      const renderedImages = await renderedSlideImages(renderOutput);
      if (renderedImages.length !== result.slideCount) {
        throw new Error(
          `Renderer produced ${renderedImages.length} PNG files for ${result.slideCount} slides.`,
        );
      }
      for (const [slideOffset, graphSlide] of (graph.slides ?? []).entries()) {
        const slideNumber = Number(graphSlide.slideIndex) + 1;
        const rendered = renderedImages[slideOffset];
        const reference = deck.references
          ? path.resolve(
              manifestDirectory,
              deck.references,
              `slide-${slideNumber}.png`,
            )
          : null;
        const slideResult = {
          slideNumber,
          supportGrade: graphSlide.supportGrade,
          rendered: relativeTo(absoluteOutput, rendered),
          renderedSize: magickAvailable
            ? identifyImage(rendered, imageMagick)
            : null,
          reference: {
            path: reference ? relativeTo(manifestDirectory, reference) : null,
            exists: reference ? await exists(reference) : false,
          },
          humanReview: deck.humanReview?.[String(slideNumber)] ?? null,
          comparison: null,
        };
        if (slideResult.reference.exists && magickAvailable) {
          slideResult.comparison = compareImages(
            reference,
            rendered,
            imageMagick,
          );
        }
        result.slides.push(slideResult);
      }
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.timings.totalMs = roundedMilliseconds(
      performance.now() - deckStarted,
    );
    deckResults.push(result);
    console.log(
      `[corpus] ${deck.id}: ${result.status} in ${result.timings.totalMs}ms`,
    );
  }

  const report = {
    contractVersion: "1.0",
    generatedAt: new Date().toISOString(),
    corpusId: manifest.corpusId,
    renderer: manifest.renderer,
    referenceRenderer: manifest.referenceRenderer,
    reviewRendererVersion: manifest.reviewRendererVersion,
    categoryMinimums: manifest.categoryMinimums,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      magickAvailable,
    },
    summary: summarizeDeckResults(deckResults),
    gate: assessCorpus(manifest, deckResults),
    decks: deckResults,
  };
  await fs.writeFile(
    path.join(absoluteOutput, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  return report;
}

export function compareImages(reference, rendered, imageMagick) {
  const referenceSize = identifyImage(reference, imageMagick);
  const renderedSize = identifyImage(rendered, imageMagick);
  const dimensionMode = classifyDimensionComparison(
    referenceSize,
    renderedSize,
  );
  if (dimensionMode.mode === "mismatch") {
    return {
      status: "dimension_mismatch",
      referenceSize,
      renderedSize,
      normalizedRmse: null,
      similarity: null,
    };
  }
  const comparisonTarget =
    dimensionMode.mode === "normalize"
      ? [
          "(",
          rendered,
          "-resize",
          `${referenceSize.width}x${referenceSize.height}!`,
          ")",
        ]
      : [rendered];
  const invocation = imageMagickInvocation(imageMagick, "compare", [
    "-metric",
    "RMSE",
    reference,
    ...comparisonTarget,
    "null:",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
  });
  if (![0, 1].includes(result.status ?? -1))
    throw commandError("magick", result);
  const normalizedRmse = parseRmse(result.stderr || result.stdout);
  return {
    status:
      dimensionMode.mode === "normalize"
        ? "compared_with_dimension_normalization"
        : "compared",
    referenceSize,
    renderedSize,
    dimensionNormalization:
      dimensionMode.mode === "normalize"
        ? {
            widthDelta: dimensionMode.widthDelta,
            heightDelta: dimensionMode.heightDelta,
            method: "resize_to_reference",
          }
        : null,
    normalizedRmse,
    similarity: 1 - normalizedRmse,
  };
}

export function classifyDimensionComparison(referenceSize, renderedSize) {
  const widthDelta = Math.abs(referenceSize.width - renderedSize.width);
  const heightDelta = Math.abs(referenceSize.height - renderedSize.height);
  if (widthDelta === 0 && heightDelta === 0)
    return { mode: "exact", widthDelta, heightDelta };
  if (widthDelta <= 1 && heightDelta <= 1)
    return { mode: "normalize", widthDelta, heightDelta };
  return { mode: "mismatch", widthDelta, heightDelta };
}

function identifyImage(file, imageMagick) {
  const invocation = imageMagickInvocation(imageMagick, "identify", [
    "-format",
    "%w %h",
    file,
  ]);
  const result = requireCommand(invocation.command, invocation.args);
  const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
  return { width, height };
}

export function detectImageMagick() {
  if (commandSucceeds("magick", ["-version"])) return "magick";
  if (
    commandSucceeds("compare", ["-version"]) &&
    commandSucceeds("identify", ["-version"])
  )
    return "standalone";
  return null;
}

function isQuantitativelyCompared(comparison) {
  return ["compared", "compared_with_dimension_normalization"].includes(
    comparison?.status,
  );
}

export function imageMagickInvocation(mode, subcommand, args) {
  if (mode === "magick")
    return { command: "magick", args: [subcommand, ...args] };
  if (mode === "standalone") return { command: subcommand, args };
  throw new Error("ImageMagick is unavailable.");
}

export function documentToolInvocation(
  image,
  environment,
  source,
  output,
  [program, ...toolArgs],
) {
  const environmentArgs = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  const containerName = `spellbook-corpus-${createHash("sha256")
    .update(
      [source, output, ...environmentArgs, program, ...toolArgs].join("\0"),
    )
    .digest("hex")
    .slice(0, 20)}`;
  return {
    containerName,
    args: [
      "run",
      "--rm",
      "--name",
      containerName,
      "--stop-timeout",
      "10",
      "--entrypoint",
      program,
      "--volume",
      `${source}:/input/document.pptx:ro`,
      "--volume",
      `${output}:/output`,
      ...environmentArgs,
      image,
      ...toolArgs,
    ],
  };
}

function runDocumentTool(image, environment, source, output, toolArgs) {
  const invocation = documentToolInvocation(
    image,
    environment,
    source,
    output,
    toolArgs,
  );
  const result = spawnSync("docker", invocation.args, {
    encoding: "utf8",
    timeout: DOCUMENT_TOOL_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  if (result.error?.code === "ETIMEDOUT") {
    spawnSync("docker", ["rm", "--force", invocation.containerName], {
      encoding: "utf8",
      timeout: 30_000,
    });
    throw new Error(
      `Document tool timed out after ${DOCUMENT_TOOL_TIMEOUT_MS}ms: ${toolArgs[1] ?? "unknown"}`,
    );
  }
  if (result.error || result.status !== 0) throw commandError("docker", result);
}

function validateManifest(manifest) {
  if (manifest.contractVersion !== "1.0")
    throw new Error("corpus contractVersion must be 1.0.");
  if (!manifest.corpusId || typeof manifest.corpusId !== "string")
    throw new Error("corpusId is required.");
  if (
    manifest.renderer?.environment !== undefined &&
    (manifest.renderer.environment === null ||
      Array.isArray(manifest.renderer.environment) ||
      typeof manifest.renderer.environment !== "object" ||
      Object.entries(manifest.renderer.environment).some(
        ([name, value]) =>
          !/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== "string",
      ))
  ) {
    throw new Error(
      "renderer.environment must map environment variable names to strings.",
    );
  }
  if (!Array.isArray(manifest.decks) || manifest.decks.length === 0)
    throw new Error("At least one corpus deck is required.");
  const ids = new Set();
  for (const deck of manifest.decks) {
    if (
      !deck.id ||
      !deck.source ||
      !["A", "B", "C", "D"].includes(deck.supportClass)
    ) {
      throw new Error(
        "Every deck requires id, source, and supportClass A/B/C/D.",
      );
    }
    if (ids.has(deck.id)) throw new Error(`Duplicate deck id: ${deck.id}`);
    ids.add(deck.id);
  }
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw commandError(command, result);
  return result;
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return !result.error && result.status === 0;
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

async function fileSha256(file) {
  const data = await fs.readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function countValues(values) {
  const counts = {};
  for (const value of values) {
    if (typeof value === "string" && value !== "")
      counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function roundedMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

async function renderedSlideImages(directory) {
  const entries = await fs.readdir(directory);
  return sortRenderedSlidePaths(
    entries
      .filter((entry) => /^slide-\d+\.png$/i.test(entry))
      .map((entry) => path.join(directory, entry)),
  );
}

function slideNumber(file) {
  const match = path.basename(file).match(/slide-(\d+)\.png$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function isVerifiedValue(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !["unknown", "unverified", "unclassified"].includes(
      value.trim().toLowerCase(),
    )
  );
}

function relativeTo(base, target) {
  return path.relative(base, target) || ".";
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--manifest" || value === "--output")
      parsed[value.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.manifest || !parsed.output)
    throw new Error(
      "Usage: --manifest <corpus.json> --output <result-directory>",
    );
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await evaluateCorpus({
      manifestPath: options.manifest,
      outputPath: options.output,
    });
    console.log(
      JSON.stringify(
        {
          report: path.resolve(options.output, "report.json"),
          gate: report.gate,
        },
        null,
        2,
      ),
    );
    process.exitCode =
      report.gate.status === "fail"
        ? 1
        : report.gate.status === "incomplete"
          ? 2
          : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
