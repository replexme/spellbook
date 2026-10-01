/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  applyZetaByteSequenceOverlay,
  applyZetaJsOverlay,
} from "./zetajs-overlay.mjs";

const pinnedSourcePath = new URL("./runtime/zeta.js", import.meta.url);
const available = existsSync(pinnedSourcePath);
function translator(source) {
  const start = source.indexOf("    function translateFromEmbind(");
  const end = source.indexOf("    function translateFromAny(", start);
  assert(start >= 0 && end > start);
  const TypeClass = Object.fromEntries(
    [
      "BOOLEAN",
      "TYPE",
      "ANY",
      "SEQUENCE",
      "STRUCT",
      "EXCEPTION",
      "INTERFACE",
      "BYTE",
      "LONG",
    ].map((value) => [value, value]),
  );
  return vm.runInNewContext(
    `${source.slice(start, end)}; translateFromEmbind`,
    {
      Module: { uno: { com: { sun: { star: { uno: { TypeClass } } } } } },
    },
  );
}
function convert(fn, values, kind, precise, clean, throwAt = -1) {
  const calls = { size: 0, get: 0, type: 0, deleteValue: 0, deleteType: 0 };
  const val = {
    size() {
      calls.size++;
      return values.length;
    },
    get(i) {
      calls.get++;
      if (i === throwAt) throw new Error("native read failed");
      return values[i];
    },
    delete() {
      calls.deleteValue++;
    },
  };
  const component = {
    getTypeClass() {
      calls.type++;
      return kind;
    },
    delete() {
      calls.deleteType++;
    },
  };
  const type = {
    getTypeClass: () => "SEQUENCE",
    getSequenceComponentType: () => component,
  };
  return { calls, run: () => Array.from(fn(val, type, precise, clean)) };
}

test(
  "pinned byte conversion preserves all signed values, Array representation, precision and native ownership",
  { skip: !available },
  () => {
    const source = readFileSync(pinnedSourcePath, "utf8");
    const before = translator(source),
      after = translator(applyZetaByteSequenceOverlay(source));
    for (const values of [[], Array.from({ length: 256 }, (_, i) => i - 128)])
      for (const precise of [false, true])
        for (const clean of [false, true]) {
          const old = convert(before, values, "BYTE", precise, clean),
            next = convert(after, values, "BYTE", precise, clean);
          assert.deepEqual(next.run(), old.run());
          assert.deepEqual(next.calls, {
            size: 1,
            get: values.length,
            type: 1,
            deleteValue: Number(clean),
            deleteType: 1,
          });
        }
  },
);

test(
  "non-byte sequence conversions retain numeric and boolean semantics",
  { skip: !available },
  () => {
    const source = readFileSync(pinnedSourcePath, "utf8"),
      before = translator(source),
      after = translator(applyZetaByteSequenceOverlay(source));
    for (const kind of ["LONG", "BOOLEAN"])
      for (const precise of [false, true]) {
        assert.deepEqual(
          convert(after, [-1, 0, 1, 12345], kind, precise, true).run(),
          convert(before, [-1, 0, 1, 12345], kind, precise, true).run(),
        );
      }
  },
);

test(
  "failed byte reads release owned sequence and component type exactly once",
  { skip: !available },
  () => {
    const fn = translator(
      applyZetaByteSequenceOverlay(readFileSync(pinnedSourcePath, "utf8")),
    );
    for (const clean of [false, true]) {
      const next = convert(fn, [1, 2, 3], "BYTE", false, clean, 1);
      assert.throws(next.run, /native read failed/u);
      assert.equal(next.calls.deleteType, 1);
      assert.equal(next.calls.deleteValue, Number(clean));
    }
  },
);

test(
  "byte overlay rejects unknown, duplicated and already patched source",
  { skip: !available },
  () => {
    const source = readFileSync(pinnedSourcePath, "utf8");
    const patched = applyZetaByteSequenceOverlay(source);
    assert.doesNotThrow(() => new vm.Script(patched));
    assert.throws(
      () => applyZetaByteSequenceOverlay(source + source),
      /drifted/u,
    );
    assert.throws(
      () => applyZetaByteSequenceOverlay(patched),
      /already contains/u,
    );
    assert.throws(
      () => applyZetaByteSequenceOverlay("unknown source"),
      /drifted/u,
    );
    assert.throws(() => applyZetaByteSequenceOverlay(null), /must be text/u);
  },
);

test(
  "byte and typedef overlays compose on the pinned runtime",
  { skip: !available },
  () => {
    const original = readFileSync(pinnedSourcePath, "utf8");
    const patched = applyZetaByteSequenceOverlay(applyZetaJsOverlay(original));
    assert.doesNotThrow(() => new vm.Script(patched));
    assert.match(patched, /TypeClass\.TYPEDEF/u);
  },
);
