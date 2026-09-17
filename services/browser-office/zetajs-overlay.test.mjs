import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { applyZetaJsOverlay } from "./zetajs-overlay.mjs";

const pinnedSourcePath = new URL("./runtime/zeta.js", import.meta.url);

test("ZetaJS overlay handles the complete typedef class without changing other cases", () => {
  const source =
    "function translateTypeDescription(td) {\n" +
    "  switch (td.getTypeClass()) {\n" +
    "      case Module.uno.com.sun.star.uno.TypeClass.ANY:\n" +
    "        return Module.uno_Type.Any();\n" +
    "      default: return null;\n" +
    "  }\n" +
    "}\n";
  const patched = applyZetaJsOverlay(source);
  assert.match(patched, /TypeClass\.TYPEDEF:[\s\S]*?getReferencedType\(\)/u);
  assert.match(patched, /default: return null/u);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test(
  "ZetaJS overlay resolves typedef members through their referenced UNO type",
  {
    skip: !existsSync(pinnedSourcePath),
  },
  () => {
    const original = readFileSync(pinnedSourcePath, "utf8");
    const patched = applyZetaJsOverlay(original);
    assert.equal(patched.length > original.length, true);
    assert.match(patched, /TypeClass\.TYPEDEF:[\s\S]*?getReferencedType\(\)/u);
    assert.throws(() => applyZetaJsOverlay(patched), /already contains/u);
    assert.doesNotThrow(() => new vm.Script(patched));
  },
);

test("ZetaJS overlay fails closed when the pinned source shape changes", () => {
  assert.throws(
    () => applyZetaJsOverlay("const unrelated = true;"),
    /anchor has drifted/u,
  );
  assert.throws(() => applyZetaJsOverlay(null), /must be text/u);
});
