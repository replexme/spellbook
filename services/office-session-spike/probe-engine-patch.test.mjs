import assert from "node:assert/strict";
import test from "node:test";

import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";

test("probe milestone accepts exact server and browser patch lines", () => {
  const original = process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL;
  try {
    delete process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL;
    assert.equal(probeEnginePatchVersion("undo-v30"), 30);
    assert.equal(probeEnginePatchVersion("browser-undo-v29"), 29);
    assert.equal(probeEnginePatchVersion("undo-v0"), 0);
    assert.equal(probeEnginePatchVersion("unrelated-v99"), 0);
    process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL = "browser-undo-v29";
    assert.equal(probeEnginePatchVersion("browser-undo-v29"), 29);
    assert.equal(probeEnginePatchVersion("undo-v29"), 0);
  } finally {
    if (original === undefined)
      delete process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL;
    else process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL = original;
  }
});
