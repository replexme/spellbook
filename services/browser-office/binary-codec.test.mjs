/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { encodeBinary, decodeBinary } from "./binary-codec.mjs";
test("compact JSON transport retains every byte across chunk boundaries", () => {
  const bytes = Uint8Array.from({ length: 100001 }, (_, i) => i % 256);
  assert.deepEqual(decodeBinary(encodeBinary(bytes)), bytes);
  assert.deepEqual(
    decodeBinary(encodeBinary(new Uint8Array())),
    new Uint8Array(),
  );
});
test("binary transport rejects nonbinary input, invalid data and oversized packages", () => {
  assert.throws(() => encodeBinary([1, 2]), /binary_transfer_invalid/);
  assert.throws(
    () => encodeBinary(new Uint8Array(64 * 1024 * 1024 + 1)),
    /binary_transfer_invalid/,
  );
  assert.throws(() => decodeBinary(null), /binary_transfer_invalid/);
  assert.throws(() => decodeBinary("invalid#"));
});
