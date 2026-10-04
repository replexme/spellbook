/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { ensureOnlyOfficeSectionHistory } from "./onlyoffice/section-history.mjs";
test("missing section-array history uses the pinned native content primitive without overriding other owners", () => {
  const previous = globalThis.window;
  const model = { Sections: [{ Id: "section-0" }] };
  const native = class NativeContent {};
  globalThis.window = {
    Asc: { editor: { WordControl: { m_oLogicDocument: model } } },
    AscFormat: {},
    AscDFH: {
      CChangesDrawingsContent: native,
      historyitem_Presentation_AddSection: 1,
      historyitem_Presentation_RemoveSection: 2,
      changesFactory: {},
      drawingContentChanges: {},
    },
  };
  try {
    ensureOnlyOfficeSectionHistory();
    const d = window.AscDFH;
    assert.strictEqual(d.changesFactory[1], native);
    assert.strictEqual(d.changesFactory[2], native);
    assert.strictEqual(d.drawingContentChanges[1](model), model.Sections);
    assert.strictEqual(d.drawingContentChanges[2](model), model.Sections);
    assert.doesNotThrow(ensureOnlyOfficeSectionHistory);
    d.changesFactory[2] = class OtherOwner {};
    assert.throws(ensureOnlyOfficeSectionHistory, /history_collision/);
  } finally {
    globalThis.window = previous;
  }
});
