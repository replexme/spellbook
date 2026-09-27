import assert from "node:assert/strict";
import test from "node:test";

import {
  aiObservationView,
  reusableAiObservation,
} from "./ai-observation-view.mjs";

test("AI sees a deck outline and full details for the requested and changed slides", () => {
  const slides = Array.from({ length: 60 }, (_, slideIndex) => ({
    slideIndex,
    name: `Slide ${slideIndex + 1}`,
    layoutName: "Title and Content",
    elements: [
      {
        elementId: `${slideIndex}/0`,
        name: "Title",
        kind: "TitleTextShape",
        text: `Revenue ${slideIndex} ${"x".repeat(500)}`,
        runFormatting: Array.from({ length: 100 }, () => ({
          font: "Noto Sans",
        })),
      },
    ],
  }));
  const observation = {
    revision: "revision-1",
    activeSlide: 0,
    textDetails: { slideIndex: 3, elements: [] },
    changedSlideIndexes: [5],
    slides,
    images: [{ slideIndex: 3, pngBytes: [1, 2, 3] }],
    readMetrics: { count: 1, elapsedMs: 12_000 },
  };
  const view = aiObservationView(observation);
  assert.deepEqual(view.detailSlideIndexes, [3, 5]);
  assert.equal(view.slides.length, 60);
  assert.deepEqual(view.slides[3], slides[3]);
  assert.deepEqual(view.slides[5], slides[5]);
  assert.equal(view.slides[10].elements[0].elementId, "10/0");
  assert.equal(
    view.slides[10].elements[0].textLength,
    slides[10].elements[0].text.length,
  );
  assert.equal(view.slides[10].elements[0].runFormatting, undefined);
  assert.equal(view.images, undefined);
  assert.equal(view.readMetrics, undefined);
  assert.ok(
    JSON.stringify(view).length < JSON.stringify(observation).length / 4,
  );
});

test("AI observation reuse fails closed on edits, selection, reload and missing listener", () => {
  const bytes = new Uint8Array([1]);
  const observation = { revision: "r1", slides: [] };
  const baseline = {
    bytes,
    revision: "r1",
    detailSlideIndex: null,
    documentChanges: 7,
    activeSlide: 0,
    selectedElementIds: ["0/1"],
  };
  const cache = { ...baseline, observation };
  assert.equal(
    reusableAiObservation(cache, baseline)?.observationCacheHit,
    true,
  );
  assert.equal(reusableAiObservation(cache, baseline)?.readMetrics.count, 0);
  for (const change of [
    { documentChanges: 8 },
    { documentChanges: null },
    { bytes: new Uint8Array([1]) },
    { revision: "r2" },
    { detailSlideIndex: 1 },
    { activeSlide: 1 },
    { selectedElementIds: [] },
  ])
    assert.equal(
      reusableAiObservation(cache, { ...baseline, ...change }),
      null,
    );
});
