/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import {
  createOnlyOfficeHeadlessRenderer,
  loadOnlyOfficeDiagnosticFontAssets,
} from "../services/browser-office/onlyoffice/headless-renderer.mjs";
import { compareEditorImage } from "./evaluate-office-editor-corpus.mjs";
import { detectImageMagick } from "./evaluate-render-corpus.mjs";

// Feature presence directs investigation; it is never a proved root cause.
export function presentationFeatureInventory(bytes, availableFamilies) {
  const families = new Set(),
    features = new Set(),
    slideParts = [];
  for (const [part, raw] of Object.entries(unzipSync(bytes))) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(part)) slideParts.push(part);
    if (/^ppt\/fonts\//.test(part)) features.add("embedded-fonts");
    if (!/^ppt\/.+\.xml$/.test(part)) continue;
    const source = strFromU8(raw),
      document = new DOMParser().parseFromString(source, "application/xml");
    const drawing = [
      "http://schemas.openxmlformats.org/drawingml/2006/main",
      "http://purl.oclc.org/ooxml/drawingml/main",
    ];
    const presentation = [
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "http://purl.oclc.org/ooxml/presentationml/main",
    ];
    const nodes = document.getElementsByTagName("*");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i],
        name = node.localName,
        ns = node.namespaceURI;
      if (drawing.includes(ns)) {
        if (["latin", "ea", "cs"].includes(name)) {
          const family = node.getAttribute("typeface");
          if (family && !family.startsWith("+")) families.add(family);
        }
        if (name === "tbl") features.add("tables");
        if (["spAutoFit", "normAutofit"].includes(name))
          features.add("autofit");
        if (["effectLst", "effectDag", "scene3d", "sp3d"].includes(name))
          features.add("effects");
        if (["videoFile", "audioFile"].includes(name)) features.add("media");
        if (name === "pPr" && node.getAttribute("algn") === "dist")
          features.add("distributed-paragraphs");
      }
      if (presentation.includes(ns)) {
        for (const [tag, feature] of [
          ["pic", "pictures"],
          ["grpSp", "groups"],
          ["cxnSp", "connectors"],
          ["timing", "animations"],
          ["transition", "transitions"],
          ["ph", "placeholders"],
        ])
          if (name === tag) features.add(feature);
        if (
          name === "sld" &&
          ["0", "false"].includes(node.getAttribute("show"))
        )
          features.add("hidden");
      }
      if (name === "chart" && ns?.endsWith("/chart")) features.add("charts");
      if (name === "relIds" && ns?.endsWith("/diagram"))
        features.add("smartart");
    }
  }
  return {
    slideParts: slideParts.length,
    features: [...features].sort(),
    declaredFamilies: [...families].sort(),
    unavailableFamilies: [...families]
      .filter((f) => !availableFamilies.includes(f))
      .sort(),
    scope:
      "Declared DrawingML families and feature presence; not actual glyph choice or cause attribution",
  };
}

if (process.argv[1] === import.meta.filename) {
  const [manifestPath, output, referencesRoot, ...options] =
    process.argv.slice(2);
  let reuseCaptures = false,
    diagnosticFontDirectory = null;
  for (let index = 0; index < options.length; index++) {
    if (options[index] === "--reuse-captures") reuseCaptures = true;
    else if (options[index] === "--diagnostic-fonts" && options[index + 1])
      diagnosticFontDirectory = path.resolve(options[++index]);
    else throw Error("Unknown or incomplete option: " + options[index]);
  }
  if (!manifestPath || !output || !referencesRoot)
    throw Error(
      "Usage: evaluate-onlyoffice-powerpoint.mjs MANIFEST OUTPUT REFERENCES",
    );
  const absoluteManifest = path.resolve(manifestPath),
    manifest = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  if (manifest.contractVersion !== "1.0" || !Array.isArray(manifest.decks))
    throw Error("Corpus 1.0 required");
  await fs.mkdir(output, { recursive: true });
  const catalogPath = diagnosticFontDirectory
    ? path.join(
        diagnosticFontDirectory,
        "onlyoffice-browser-font-source-map.json",
      )
    : new URL(
        "../services/browser-office/onlyoffice/distribution/onlyoffice-browser-font-source-map.json",
        import.meta.url,
      );
  const families = JSON.parse(
    await fs.readFile(catalogPath, "utf8"),
  ).visibleFamilies;
  const reusedFontIdentity =
    reuseCaptures && diagnosticFontDirectory
      ? (await loadOnlyOfficeDiagnosticFontAssets(diagnosticFontDirectory))
          .identity
      : null;
  const renderer = reuseCaptures
      ? null
      : await createOnlyOfficeHeadlessRenderer({ diagnosticFontDirectory }),
    imageMagick = detectImageMagick();
  if (!imageMagick) throw Error("ImageMagick required for visual differences");
  const report = {
    status: "running",
    startedAt: new Date().toISOString(),
    engine: renderer?.identity ?? null,
    scope:
      "All manifest entries, including unsupported/failed cases; native ONLYOFFICE view compared with background PowerPoint PDF captures",
    cases: [],
  };
  const persist = () =>
    fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  try {
    await persist();
    for (const [index, deck] of manifest.decks.entries()) {
      const row = {
        id: deck.id,
        cohort: deck.cohort,
        status: "running",
        stage: "render",
        comparisons: [],
      };
      report.cases.push(row);
      await persist();
      try {
        if (!/^[a-zA-Z0-9_-]+$/.test(deck.id)) throw Error("Unsafe corpus ID");
        const source = path.resolve(
            path.dirname(absoluteManifest),
            deck.source,
          ),
          bytes = await fs.readFile(source);
        row.sourceSha256 = createHash("sha256").update(bytes).digest("hex");
        if (deck.sourceSha256 && deck.sourceSha256 !== row.sourceSha256)
          throw Error("Source changed since corpus admission");
        row.inventory = presentationFeatureInventory(bytes, families);
        const directory = path.join(output, deck.id);
        const rendered = reuseCaptures
          ? JSON.parse(
              await fs.readFile(path.join(directory, "render.json"), "utf8"),
            )
          : await renderer.renderFile(source, { outputDirectory: directory });
        if (rendered.inputSha256 !== row.sourceSha256)
          throw Error("Capture source changed");
        row.renderer = rendered.renderer;
        if (
          reusedFontIdentity &&
          rendered.renderer.diagnosticFontAssets?.sha256 !==
            reusedFontIdentity.sha256
        )
          throw Error(
            "Diagnostic fonts changed since capture; fresh captures required",
          );
        if (
          reuseCaptures &&
          rendered.renderer.diagnosticFontAssets &&
          !reusedFontIdentity
        ) {
          row.inventory.unavailableFamilies = null;
          row.inventory.availabilityScope =
            "Diagnostic capture font catalog was not supplied; availability is unknown";
        }
        if (rendered.images.length !== rendered.slideCount)
          throw Error("Full-slide capture required");
        for (const image of rendered.images)
          if (
            createHash("sha256")
              .update(await fs.readFile(image.file))
              .digest("hex") !== image.sha256
          )
            throw Error("Capture image changed");
        row.slideCount = rendered.slideCount;
        row.openedMs = rendered.openedMs;
        row.totalMs = rendered.totalMs;
        row.runtimeErrors = rendered.errors;
        row.deniedOrigins = rendered.deniedRequests;
        row.stage = "reference";
        const metadata = JSON.parse(
          await fs.readFile(
            path.join(referencesRoot, deck.id, "reference-metadata.json"),
            "utf8",
          ),
        );
        if (metadata.sourceSha256 !== row.sourceSha256)
          throw Error("PowerPoint reference source mismatch");
        row.powerPoint = metadata.referenceRenderer;
        row.background = metadata.background;
        if (
          !metadata.background?.before?.hidden ||
          metadata.background.before.active ||
          (metadata.background.after &&
            (!metadata.background.after.hidden ||
              metadata.background.after.active))
        )
          throw Error(
            "PowerPoint reference lacks hidden inactive capture evidence",
          );
        if (metadata.slides !== rendered.slideCount)
          throw Error(
            `Slide count differs: PowerPoint ${metadata.slides}, ONLYOFFICE ${rendered.slideCount}`,
          );
        row.stage = "comparison";
        for (const image of rendered.images)
          row.comparisons.push({
            slideIndex: image.slideIndex,
            ...compareEditorImage(
              path.join(
                referencesRoot,
                deck.id,
                `slide-${image.slideIndex + 1}.png`,
              ),
              image.file,
              imageMagick,
            ),
          });
        row.status = "compared";
      } catch (error) {
        row.status =
          row.stage === "render"
            ? "render_failed"
            : row.stage === "reference"
              ? "reference_unavailable"
              : "comparison_failed";
        row.error = String(error.stack ?? error);
      }
      await persist();
      console.log(
        JSON.stringify({
          index: index + 1,
          total: manifest.decks.length,
          id: row.id,
          status: row.status,
          error: row.error?.split("\n")[0],
          slides: row.slideCount,
        }),
      );
    }
    report.status = "finished";
  } finally {
    report.finishedAt = new Date().toISOString();
    await persist();
    await renderer?.close();
  }
}
