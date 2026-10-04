/* SPDX-License-Identifier: MPL-2.0 */
// Diagnostic raster evidence, never a substitute for exact file/model admission.
// A reopened image edge can round an RGB channel by one level. Limit both the
// magnitude and affected area; alpha, dimensions and larger differences fail.
export function compareCanvasPixels(expected, actual, before, after) {
  if (expected.width !== actual.width || expected.height !== actual.height)
    throw Error("canvas_dimensions_changed");
  const pixels = expected.width * expected.height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    before.length !== pixels * 4 ||
    after.length !== before.length
  )
    throw Error("canvas_pixels_incomplete");
  let changedPixels = 0,
    maximumChannelDelta = 0,
    alphaDifferences = 0;
  for (let offset = 0; offset < before.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(
        before[offset + channel] - after[offset + channel],
      );
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      changed ||= delta > 0;
      if (channel === 3 && delta) alphaDifferences++;
    }
    if (changed) changedPixels++;
  }
  const maximumChangedPixels = Math.floor(pixels / 10000);
  const result = {
    pixels,
    changedPixels,
    maximumChannelDelta,
    alphaDifferences,
    byteIdentical: changedPixels === 0,
    maximumChangedPixels,
    scope: "document-canvas-without-transient-selection",
  };
  if (
    maximumChannelDelta > 1 ||
    alphaDifferences ||
    changedPixels > maximumChangedPixels
  )
    throw Error("canvas_rendering_changed:" + JSON.stringify(result));
  return result;
}
