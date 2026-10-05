import assert from "node:assert/strict";
import test from "node:test";

import {
  browserCaptureTargets,
  retainBrowserImages,
  reusableBrowserImage,
  withBrowserVisualEvidence,
} from "./browser-visual-evidence.mjs";
import { readOnlyAiObservationAfterMutation, reusableAiObservation } from "./ai-observation-view.mjs";

test("reusing an exact model without pictures still requires fresh requested visual evidence", () => {
  const current = { bytes: Uint8Array.of(1), revision: "r1", detailSlideIndex: null, documentChanges: 1, activeSlide: 0, selectedElementIds: [] };
  const mutation = withBrowserVisualEvidence({ slides: [{}], activeSlide: 0, changedSlideIndexes: [0] }, []);
  assert.equal(mutation.visualEvidenceComplete, false);
  const cache = { ...current, observation: readOnlyAiObservationAfterMutation(mutation) };
  const cached = reusableAiObservation(cache, current);
  const targets = browserCaptureTargets({ operation: "observe" }, cached);
  assert.deepEqual(targets, [0]);
  assert.equal(reusableBrowserImage(cached, 0), null);
  assert.equal(withBrowserVisualEvidence(cached, [], targets).visualEvidenceComplete, false);
  assert.equal(withBrowserVisualEvidence(cached, [{ slideIndex: 0, pngBytes: [137] }], targets).visualEvidenceComplete, true);
  assert.equal(reusableAiObservation(cache, { ...current, documentChanges: 2 }), null);
});

const observation = {
  slides: [{}, {}, {}],
  activeSlide: 1,
  textDetails: { slideIndex: 1 },
  changedSlideIndexes: [2, 0],
};

test("browser observations capture requested slides and validate bounds", () => {
  assert.deepEqual(
    browserCaptureTargets({ operation: "observe" }, observation),
    [1],
  );
  assert.deepEqual(
    browserCaptureTargets(
      { operation: "observe", captureSlideIndexes: [2, 0, 2] },
      observation,
    ),
    [0, 2],
  );
  assert.deepEqual(
    browserCaptureTargets(
      { operation: "observe", captureSlideIndexes: [] },
      observation,
    ),
    [],
  );
  assert.throws(
    () =>
      browserCaptureTargets(
        { operation: "observe", captureSlideIndexes: [3] },
        observation,
      ),
    /invalid_capture_slide_indexes/u,
  );
});

test("previously rendered slides are retained only within a bounded cache", () => {
  const image = (slideIndex) => ({ slideIndex, pngBytes: [137, 80, 78, 71] });
  const first = retainBrowserImages([image(0), image(1)], [image(2)], 2);
  assert.deepEqual(first.map((value) => value.slideIndex), [1, 2]);
  const revisited = retainBrowserImages(first, [image(1)], 2);
  assert.deepEqual(revisited.map((value) => value.slideIndex), [2, 1]);
});

test("only a validated unchanged observation can reuse its captured slide", () => {
  const image = { slideIndex: 1, pngBytes: [137, 80, 78, 71] };
  const cached = { observationCacheHit: true, images: [image] };
  assert.equal(reusableBrowserImage(cached, 1), image);
  assert.equal(reusableBrowserImage(cached, 0), null);
  assert.equal(
    reusableBrowserImage({ ...cached, observationCacheHit: false }, 1),
    null,
  );
  assert.equal(
    reusableBrowserImage(
      { observationCacheHit: true, images: [{ slideIndex: 1, pngBytes: [] }] },
      1,
    ),
    null,
  );
});

test("browser edits require evidence for every changed slide", () => {
  assert.deepEqual(
    browserCaptureTargets({ operation: "edit" }, observation),
    [0, 2],
  );
  assert.deepEqual(
    browserCaptureTargets(
      { operation: "edit", suppressCapture: true },
      observation,
    ),
    [],
  );
  assert.equal(
    withBrowserVisualEvidence(observation, [{ slideIndex: 0 }])
      .visualEvidenceComplete,
    false,
  );
  assert.equal(
    withBrowserVisualEvidence(observation, [
      { slideIndex: 0 },
      { slideIndex: 2 },
    ]).visualEvidenceComplete,
    true,
  );
  assert.equal(
    withBrowserVisualEvidence(
      { ...observation, changedSlideIndexes: [] },
      [],
      [1],
    ).visualEvidenceComplete,
    false,
  );
});
