import assert from "node:assert/strict";
import test from "node:test";

import {
  browserCaptureTargets,
  reusableBrowserImage,
  withBrowserVisualEvidence,
} from "./browser-visual-evidence.mjs";

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
