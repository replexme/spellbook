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


test("generated field rendering keeps native history while ordinary changes of the same type remain authored",()=>{
  const previous=globalThis.window,history={Points:[],Index:0},derived=new WeakSet();
  globalThis.window={AscCommon:{History:history},AscDFH:{historyitem_CNvPr_SetId:7},Asc:{editor:{WordControl:{m_oLogicDocument:{}}}},[Symbol.for("spellbook.onlyoffice.derivedFieldHistory/v1")]:derived};
  const item=(position,type)=>({Data:{Type:type},Binary:{Pos:position,Len:1}});
  try {
    const authored=item(0,9),generated=item(1,55);derived.add(generated.Data);history.Points.push({Items:[authored,generated]});
    const before=capture();assert.equal(before,"[1,0,1]");
    const painted=item(2,55);derived.add(painted.Data);history.Points[0].Items.push(painted);
    assert.equal(capture(),before);assert.equal(history.Points[0].Items.length,3);
    history.Points[0].Items.push(item(3,55));assert.notEqual(capture(),before);
    const unobserved=item(4,7);history.Points[0].Items.push(unobserved);approve(before);
    assert.throws(verify,/product_unobserved_native_edit/);
  } finally {globalThis.window=previous;}
});
