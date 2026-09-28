import assert from "node:assert/strict";
import test from "node:test";

import {
  aiObservationView,
  defersAiObservationCacheInvalidation,
  invalidatesAiObservationCache,
  navigatedAiObservationCache,
  readOnlyAiObservationAfterMutation,
  reusableAiObservation,
  reusableAiObservationForSlide,
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
  assert.deepEqual(view.slides[10], {
    slideIndex: 10,
    name: "Slide 11",
    heading: `Revenue 10 ${"x".repeat(69)}`,
  });
  assert.equal(view.slides[10].elements, undefined);
  assert.equal(view.images, undefined);
  assert.equal(view.readMetrics, undefined);
  assert.ok(
    JSON.stringify(view).length < JSON.stringify(observation).length / 4,
  );
});

test("a blank title does not borrow the body text as its heading", () => {
  const view = aiObservationView({
    revision: "r1",
    activeSlide: 1,
    changedSlideIndexes: [],
    slides: [
      {
        slideIndex: 0,
        name: "Opening",
        elements: [
          { name: "Title 1", text: "" },
          { name: "Body 2", text: "Private body content" },
        ],
      },
      { slideIndex: 1, elements: [] },
    ],
    images: [],
  });
  assert.deepEqual(view.slides[0], { slideIndex: 0, name: "Opening" });
});

test("a verified mutation can seed a later read without repeating its changed-slide demand", () => {
  const mutation = {
    revision: "revision-2",
    changedSlideIndexes: [0, 59],
    images: [{ slideIndex: 0, pngBytes: [137] }],
  };
  const read = readOnlyAiObservationAfterMutation(mutation);
  assert.deepEqual(read.changedSlideIndexes, []);
  assert.deepEqual(mutation.changedSlideIndexes, [0, 59]);
  assert.equal(read.revision, mutation.revision);
  assert.equal(read.images, mutation.images);
});

test("saving keeps an observation eligible for strict live-state reuse", () => {
  assert.equal(invalidatesAiObservationCache({ type: "save-result" }), false);
  assert.equal(
    invalidatesAiObservationCache({
      type: "command",
      messageId: "Action_Save",
    }),
    false,
  );
  assert.equal(
    invalidatesAiObservationCache({
      type: "command",
      messageId: "Action_GoToPage",
    }),
    false,
  );
  assert.equal(
    invalidatesAiObservationCache({
      id: "1",
      request: { operation: "observe" },
    }),
    false,
  );
  assert.equal(invalidatesAiObservationCache({ type: "open" }), true);
  assert.equal(
    invalidatesAiObservationCache({
      type: "command",
      messageId: "Action_Undo",
    }),
    true,
  );
  const edit = { id: "2", request: { operation: "edit_batch" } };
  assert.equal(invalidatesAiObservationCache(edit), false);
  assert.equal(defersAiObservationCacheInvalidation(edit), true);
  assert.equal(
    invalidatesAiObservationCache({
      id: "3",
      request: { operation: "undo_turn" },
    }),
    true,
  );
});

test("slide detail reuse keeps the whole-deck state and rejects stale or partial replies", () => {
  const bytes = new Uint8Array([1]);
  const slides = [0, 1].map((slideIndex) => ({
    slideIndex,
    elements: [{ elementId: `${slideIndex}/0`, text: `Title ${slideIndex}` }],
  }));
  const cache = {
    bytes,
    revision: "r1",
    detailSlideIndex: 0,
    documentChanges: 7,
    activeSlide: 0,
    selectedElementIds: [],
    observation: { revision: "r1", slides, textDetails: { slideIndex: 0 } },
  };
  const current = {
    bytes,
    revision: "r1",
    detailSlideIndex: 1,
    documentChanges: 7,
    activeSlide: 0,
    selectedElementIds: [],
  };
  const detail = {
    slideIndex: 1,
    elements: [{ elementId: "1/0", text: "Title 1", paragraphs: [] }],
  };
  const reused = reusableAiObservationForSlide(cache, current, detail);
  assert.equal(reused?.observationCacheHit, true);
  assert.equal(reused?.slides, slides);
  assert.deepEqual(reused?.textDetails, {
    slideIndex: 1,
    elements: [{ elementId: "1/0", paragraphs: [] }],
  });
  assert.equal(
    reusableAiObservationForSlide(
      cache,
      { ...current, documentChanges: 8 },
      detail,
    ),
    null,
  );
  assert.equal(
    reusableAiObservationForSlide(cache, current, { ...detail, elements: [] }),
    null,
  );
  assert.equal(
    reusableAiObservationForSlide(cache, current, {
      ...detail,
      elements: [{ ...detail.elements[0], text: "stale" }],
    }),
    null,
  );
});

test("slide navigation keeps the deck but requires fresh detail for the new active slide", () => {
  const bytes = new Uint8Array([1]);
  const slides = [{ slideIndex: 0 }, { slideIndex: 1 }];
  const cache = {
    bytes,
    revision: "r1",
    documentChanges: 7,
    activeSlide: 0,
    selectedElementIds: [],
    detailSlideIndex: null,
    observation: {
      revision: "r1",
      activeSlide: 0,
      selectedElementIds: [],
      slides,
      textDetails: { slideIndex: 0, elements: [] },
    },
  };
  const current = {
    bytes,
    revision: "r1",
    documentChanges: 7,
    activeSlide: 1,
    selectedElementIds: [],
    detailSlideIndex: null,
  };
  const navigated = navigatedAiObservationCache(cache, current);
  assert.equal(navigated?.activeSlide, 1);
  assert.equal(navigated?.observation.activeSlide, 1);
  assert.equal(navigated?.detailSlideIndex, 0);
  assert.equal(reusableAiObservation(navigated, current), null);
  assert.equal(
    reusableAiObservationForSlide(
      navigated,
      { ...current, detailSlideIndex: 1 },
      { slideIndex: 1, elements: [] },
    )?.textDetails.slideIndex,
    1,
  );
  for (const changed of [
    { documentChanges: 8 },
    { bytes: new Uint8Array([1]) },
    { revision: "r2" },
    { selectedElementIds: ["1/0"] },
  ])
    assert.equal(
      navigatedAiObservationCache(cache, { ...current, ...changed }),
      null,
    );
  assert.equal(
    navigatedAiObservationCache(
      { ...cache, selectedElementIds: ["0/0"] },
      current,
    ),
    null,
  );
});

test("AI observation reuse fails closed on edits, selection, reload and missing listener", () => {
  const bytes = new Uint8Array([1]);
  const observation = {
    revision: "r1",
    slides: [],
    images: [{ slideIndex: 0, pngBytes: [1] }],
  };
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
  assert.equal(
    reusableAiObservation(cache, baseline)?.images,
    observation.images,
  );
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
