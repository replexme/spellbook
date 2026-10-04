/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { onlyOfficeOpacityNative } from "./onlyoffice/opacity.mjs";
test("every OOXML opacity integer survives the pinned writer without quantization loss", () => {
  for (let wanted = 0; wanted <= 100000; wanted++) {
    const native = onlyOfficeOpacityNative(wanted / 1000);
    assert.equal(Math.trunc((native * 100000) / 255), wanted);
    assert.ok(Math.abs(native - (wanted * 255) / 100000) < 1e-10);
  }
});
test("invalid opacity fails before edits", () => {
  for (const value of [NaN, Infinity, "40", null, -0.001, 100.001, 37.1234])
    assert.throws(() => onlyOfficeOpacityNative(value), /argument_invalid/);
});
