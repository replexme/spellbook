/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";

export const comparisonEditMarker = "SBX9F3";

export function assertComparisonMarkerAbsent(bytes) {
  assert(
    !Object.entries(unzipSync(bytes)).some(
      ([name, content]) =>
        name.endsWith(".xml") &&
        strFromU8(content).includes(comparisonEditMarker),
    ),
    "Comparison marker already occurs in input",
  );
}
