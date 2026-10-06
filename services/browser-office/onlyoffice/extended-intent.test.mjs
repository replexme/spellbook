/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergedOnlyOfficeTableParagraphs } from "./extended-intent.mjs";
test("table merge converts only intermediate cell transport terminators and preserves authored runs", () => {
  const cell = (text) => [
      { text: text + "\t", runs: [{ text, style: { GetBold: true } }] },
    ],
    cells = [cell("A"), cell("B\t"), cell("C")],
    before = structuredClone(cells);
  const result = mergedOnlyOfficeTableParagraphs(cells);
  assert.deepEqual(
    result.map((p) => p.text),
    ["A\r\n", "B\t\r\n", "C\t"],
  );
  assert.deepEqual(
    result.map((p) => p.runs),
    cells.map((c) => c[0].runs),
  );
  result[0].runs[0].style.GetBold = false;
  assert.deepEqual(cells, before);
});
test("native merge discards its single initial empty cell body without dropping later authored paragraphs", () => {
  const empty = [{ text: "\t", runs: [] }],
    full = [{ text: "A\t", runs: [{ text: "A" }] }];
  assert.deepEqual(mergedOnlyOfficeTableParagraphs([empty, full]), full);
  assert.deepEqual(mergedOnlyOfficeTableParagraphs([empty, empty]), empty);
});
