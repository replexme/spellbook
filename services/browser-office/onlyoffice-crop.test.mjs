/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { onlyOfficeCropObservation } from "./onlyoffice/crop.mjs";
test("crop observation removes machine precision noise but preserves real authored differences", () => {
  assert.deepEqual(onlyOfficeCropObservation({ r: 89.06899999999999 }), {
    r: 89.069,
  });
  assert.deepEqual(onlyOfficeCropObservation({ r: 89.07 }), { r: 89.07 });
  assert.deepEqual(onlyOfficeCropObservation({ r: 89.06900001 }), {
    r: 89.06900001,
  });
  assert.equal(onlyOfficeCropObservation(null), null);
  for (let i = 0; i <= 100000; i++) {
    const value = i / 1000;
    assert.equal(
      onlyOfficeCropObservation({ r: 100 - (100 - value) }).r,
      value,
    );
  }
});
