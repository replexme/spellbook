/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { compareCanvasPixels } from "./canvas-pixel-evidence.mjs";
const meta = { width: 200, height: 100 };
test("raster comparison reports bounded RGB rounding without claiming byte identity", () => {
  const before = new Uint8Array(200 * 100 * 4).fill(100),
    after = before.slice();
  assert.equal(
    compareCanvasPixels(meta, meta, before, after).byteIdentical,
    true,
  );
  after[0]++;
  const result = compareCanvasPixels(meta, meta, before, after);
  assert.equal(result.changedPixels, 1);
  assert.equal(result.maximumChannelDelta, 1);
  assert.equal(result.byteIdentical, false);
});
test("a lost pixel, alpha change, widespread color change or shifted outline cannot pass", () => {
  const before = new Uint8Array(200 * 100 * 4).fill(100);
  for (const change of [
    (a) => {
      a[0] += 2;
    },
    (a) => {
      a[3]++;
    },
    (a) => {
      a[0]++;
      a[4]++;
      a[8]++;
    },
    (a) => {
      a[0] = 0;
      a[4] = 200;
    },
  ]) {
    const after = before.slice();
    change(after);
    assert.throws(
      () => compareCanvasPixels(meta, meta, before, after),
      /canvas_rendering_changed/,
    );
  }
  assert.throws(
    () =>
      compareCanvasPixels(meta, { width: 201, height: 100 }, before, before),
    /dimensions_changed/,
  );
  assert.throws(
    () => compareCanvasPixels(meta, meta, before.subarray(1), before),
    /pixels_incomplete/,
  );
});
