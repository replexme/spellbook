import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_TOOL_TIMEOUT_MS,
  assessCorpus,
  classifyDimensionComparison,
  documentToolInvocation,
  imageMagickInvocation,
  parseRmse,
  sortRenderedSlidePaths,
  summarizeDeckResults,
} from "./evaluate-render-corpus.mjs";

function completeDeck(index, severity = "P2") {
  return {
    id: `deck-${index}`,
    supportClass: "A",
    usageRights: "owned",
    sensitivity: "internal",
    categories: ["basic-corporate"],
    status: "rendered",
    warnings: [],
    slideCount: 1,
    elementCount: 3,
    editableElementCount: 2,
    elementKinds: { shape: 3 },
    supportGrades: { A: 1 },
    fontAudit: {
      inventoryAvailable: true,
      declaredFonts: ["Fixture Sans"],
      missingFonts: [],
      substitutions: [],
    },
    timings: { totalMs: 100 + index },
    slides: [
      {
        slideNumber: 1,
        supportGrade: "A",
        reference: { exists: true },
        comparison: { status: "compared" },
        humanReview: { severity },
      },
    ],
  };
}

function completeManifest() {
  return {
    contractVersion: "1.0",
    renderer: {
      name: "Spellbook document engine",
      image: "spellbook-document-worker:local",
      version: "mvp1",
    },
    referenceRenderer: {
      name: "PowerPoint",
      version: "2608",
      os: "Windows",
      exportProcedure: "fixed",
    },
    reviewRendererVersion: "mvp1",
    categoryMinimums: { "basic-corporate": 1 },
  };
}

test("parses ImageMagick normalized RMSE", () => {
  assert.equal(parseRmse("123.5 (0.0188449)"), 0.0188449);
});

test("supports ImageMagick 7 and Debian standalone commands", () => {
  assert.deepEqual(imageMagickInvocation("magick", "identify", ["a.png"]), {
    command: "magick",
    args: ["identify", "a.png"],
  });
  assert.deepEqual(
    imageMagickInvocation("standalone", "compare", ["a.png", "b.png"]),
    { command: "compare", args: ["a.png", "b.png"] },
  );
});

test("accepts one-pixel raster rounding as a quantitative comparison", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].slides[0].comparison.status =
    "compared_with_dimension_normalization";
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "pass");
  assert.equal(gate.metrics.comparedASlides, 20);
});

test("separates exact dimensions, one-pixel rounding, and real mismatch", () => {
  assert.deepEqual(
    classifyDimensionComparison(
      { width: 1440, height: 1080 },
      { width: 1440, height: 1080 },
    ),
    { mode: "exact", widthDelta: 0, heightDelta: 0 },
  );
  assert.deepEqual(
    classifyDimensionComparison(
      { width: 1920, height: 1080 },
      { width: 1921, height: 1080 },
    ),
    { mode: "normalize", widthDelta: 1, heightDelta: 0 },
  );
  assert.deepEqual(
    classifyDimensionComparison(
      { width: 1920, height: 1080 },
      { width: 1922, height: 1080 },
    ),
    { mode: "mismatch", widthDelta: 2, heightDelta: 0 },
  );
});

test("maps pdftoppm zero-padded slide names by numeric order", () => {
  assert.deepEqual(
    sortRenderedSlidePaths(["slide-10.png", "slide-02.png", "slide-1.png"]),
    ["slide-1.png", "slide-02.png", "slide-10.png"],
  );
});

test("bounds each document-tool container and gives it a removable stable name", () => {
  const invocation = documentToolInvocation(
    "renderer@sha256:fixture",
    {},
    "/tmp/source.pptx",
    "/tmp/output",
    [
      "/app/present-pptx",
      "render-all",
      "/input/document.pptx",
      "/output/render",
    ],
  );
  assert.equal(DOCUMENT_TOOL_TIMEOUT_MS, 300_000);
  assert.match(invocation.containerName, /^spellbook-corpus-[a-f0-9]{20}$/);
  assert.deepEqual(invocation.args.slice(0, 8), [
    "run",
    "--rm",
    "--name",
    invocation.containerName,
    "--stop-timeout",
    "10",
    "--entrypoint",
    "/app/present-pptx",
  ]);
  assert.deepEqual(invocation.args.slice(-4), [
    "renderer@sha256:fixture",
    "render-all",
    "/input/document.pptx",
    "/output/render",
  ]);
});

test("passes a sorted, recorded renderer environment to every container", () => {
  const invocation = documentToolInvocation(
    "renderer@sha256:fixture",
    {
      SPELLBOOK_Z_FLAG: "0",
      SPELLBOOK_A_FLAG: "1",
    },
    "/tmp/source.pptx",
    "/tmp/output",
    [
      "/app/present-pptx",
      "render-all",
      "/input/document.pptx",
      "/output/render",
    ],
  );
  const imageIndex = invocation.args.indexOf("renderer@sha256:fixture");
  assert.deepEqual(invocation.args.slice(imageIndex - 4, imageIndex), [
    "--env",
    "SPELLBOOK_A_FLAG=1",
    "--env",
    "SPELLBOOK_Z_FLAG=0",
  ]);
});

test("passes only a complete 20-deck A corpus", () => {
  const gate = assessCorpus(
    completeManifest(),
    Array.from({ length: 20 }, (_, index) => completeDeck(index)),
  );
  assert.equal(gate.status, "pass");
  assert.equal(gate.metrics.p1FreeRate, 1);
});

test("marks missing references and reviews as incomplete", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].slides[0].reference.exists = false;
  decks[1].slides[0].humanReview = null;
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "incomplete");
  assert.match(gate.reasons.join(" "), /기준 이미지/);
  assert.match(gate.reasons.join(" "), /사람 P0\/P1\/P2/);
});

test("does not treat placeholder rights or sensitivity as verified", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].usageRights = "unverified";
  decks[1].sensitivity = "unclassified";
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "incomplete");
  assert.match(gate.reasons.join(" "), /사용·평가 권리/);
  assert.match(gate.reasons.join(" "), /민감도/);
});

test("fails an A corpus with a P0 or render failure", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].slides[0].humanReview.severity = "P0";
  decks[1].status = "failed";
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "fail");
  assert.equal(gate.metrics.p0Slides, 1);
  assert.equal(gate.metrics.renderFailures, 1);
});

test("fails when an A candidate contains an engine-grade B slide", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].slides[0].supportGrade = "B";
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "fail");
  assert.equal(gate.metrics.unsupportedASlides, 1);
});

test("fails when an A candidate has a missing or unverified font environment", () => {
  const decks = Array.from({ length: 20 }, (_, index) => completeDeck(index));
  decks[0].fontAudit.missingFonts = ["Missing Corporate Font"];
  decks[1].fontAudit.inventoryAvailable = false;
  const gate = assessCorpus(completeManifest(), decks);
  assert.equal(gate.status, "fail");
  assert.equal(gate.metrics.fontRiskADecks, 2);
  assert.match(gate.reasons.join(" "), /누락 글꼴/);
});

test("summarizes render volume, element kinds, and timing percentiles", () => {
  const summary = summarizeDeckResults(
    Array.from({ length: 20 }, (_, index) => completeDeck(index)),
  );
  assert.equal(summary.renderedDecks, 20);
  assert.equal(summary.slides, 20);
  assert.equal(summary.elements, 60);
  assert.deepEqual(summary.elementKinds, { shape: 60 });
  assert.equal(summary.fontAudit.inventoryUnavailableDecks, 0);
  assert.equal(summary.fontAudit.decksWithMissingFonts, 0);
  assert.deepEqual(summary.fontAudit.substitutionDeckCounts, {});
  assert.equal(summary.timingMs.p50, 109);
  assert.equal(summary.timingMs.p95, 118);
});
