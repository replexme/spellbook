/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureOnlyOfficeNativeChanges as capture,
  approveOnlyOfficeNativeChanges as approve,
  verifyOnlyOfficeManualChanges as verify,
} from "./onlyoffice/identity-evidence.mjs";

test("approval covers captured identity changes; later mixed edits refuse until native Undo", () => {
  const previous = globalThis.window;
  const history = { Points: [], Index: -1 };
  globalThis.window = {
    AscCommon: { History: history },
    AscDFH: { historyitem_CNvPr_SetId: 7 },
    Asc: { editor: { WordControl: { m_oLogicDocument: {} } } },
  };
  const item = (position, type = 7) => ({
    Data: { Type: type },
    Binary: { Pos: position, Len: 1 },
  });
  try {
    const approved = item(0);
    history.Points.push({ Items: [approved] });
    history.Index = 0;
    const observed = capture();
    const hidden = item(1),
      visible = item(2, 9);
    history.Points.push({ Items: [hidden, visible] });
    history.Index = 1;
    approve(observed);
    assert.throws(verify, /product_unobserved_native_edit/);
    history.Index = 0;
    verify(); // Undo removes the unsupported point.
    history.Index = -1;
    verify();
    history.Index = 0;
    verify(); // Redo of approved duplication remains admitted.
    const captured = capture();
    approve(captured);
    window.Asc.editor.WordControl.m_oLogicDocument = {};
    assert.throws(() => approve(captured), /evidence_missing/);
    capture();
    assert.throws(verify, /product_unobserved_native_edit/);
  } finally {
    globalThis.window = previous;
  }
});
