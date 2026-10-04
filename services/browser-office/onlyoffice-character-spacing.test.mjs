import assert from "node:assert/strict";
import test from "node:test";
import { onlyOfficeCharacterSpacingTwips } from "./onlyoffice/character-spacing.mjs";

test("pinned native spacing conversion survives the PPTX writer for every supported hundredth", () => {
  assert.equal(Math.trunc(((25.4 / 72 / 20) * 40 * 7200) / 25.4), 199);
  for (let wanted = -10000; wanted <= 10000; wanted++) {
    const twips = onlyOfficeCharacterSpacingTwips(wanted / 100);
    const mm = (25.4 / 72 / 20) * twips;
    assert.equal(Math.trunc((mm * 7200) / 25.4), wanted || 0);
    assert.ok(Math.abs(twips - wanted / 5) < 1e-10);
  }
});

test("unsupported precision and non-numeric spacing fail before native edits", () => {
  for (const points of [NaN, Infinity, "2", null, 0.001, 100.01, -100.01])
    assert.throws(
      () => onlyOfficeCharacterSpacingTwips(points),
      /argument_invalid/,
    );
});
