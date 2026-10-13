import assert from "node:assert/strict";
import test from "node:test";

import { compareRenderReports } from "./compare-render-reports.mjs";

function report(version, values, sha = "source-sha") {
  return {
    renderer: { name: "Spellbook document engine", version },
    decks: [
      {
        id: "deck-1",
        sourceSha256: sha,
        slides: values.map((value, index) => ({
          slideNumber: index + 1,
          comparison: { normalizedRmse: value },
        })),
      },
    ],
  };
}

test("compares the same slides and ranks improvements and regressions", () => {
  const result = compareRenderReports(
    report("baseline", [0.3, 0.2, 0.1]),
    report("candidate", [0.1, 0.25, 0.1]),
    { top: 1 },
  );
  assert.equal(result.baseline.metrics.count, 3);
  assert.equal(result.candidate.metrics.mean, 0.15);
  assert.equal(result.candidate.metrics.p95, 0.25);
  assert.equal(result.delta.improvedSlides, 1);
  assert.equal(result.delta.regressedSlides, 1);
  assert.equal(result.delta.unchangedSlides, 1);
  assert.equal(result.delta.biggestImprovements[0].slideNumber, 1);
  assert.equal(result.delta.biggestRegressions[0].slideNumber, 2);
});

test("rejects mismatched source files and slide sets", () => {
  assert.throws(
    () => compareRenderReports(report("a", [0.1]), report("b", [0.1], "x")),
    /Source SHA-256 differs/,
  );
  assert.throws(
    () => compareRenderReports(report("a", [0.1, 0.2]), report("b", [0.1])),
    /missing deck-1:2/,
  );
  assert.throws(
    () => compareRenderReports(report("a", []), report("b", [])),
    /no compared slides/,
  );
});

test("compares an explicitly selected focused deck against a full baseline", () => {
  const baseline = report("baseline", [0.3]);
  baseline.decks.push({
    id: "deck-2",
    sourceSha256: "source-sha-2",
    slides: [{ slideNumber: 1, comparison: { normalizedRmse: 0.4 } }],
  });
  const candidate = {
    renderer: { name: "Spellbook document engine", version: "candidate" },
    decks: [baseline.decks[1]],
  };

  const result = compareRenderReports(baseline, candidate, {
    deckIds: ["deck-2"],
  });

  assert.equal(result.baseline.metrics.count, 1);
  assert.equal(result.delta.unchangedSlides, 1);
});
