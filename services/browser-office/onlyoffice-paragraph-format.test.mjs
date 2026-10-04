/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import {onlyOfficeParagraphFormat} from "./onlyoffice/paragraph-format.mjs";

test("requested paragraph indents survive native signed EMU truncation",()=>{
  // These include the actual 2mm -> 71999 EMU failure and decimal values
  // whose double-precision product falls on either side of an integer.
  const pairs=[[200,72000],[201,72360],[249.6,89856],[-50,-18000],[-201,-72360],[.001,0],[-.001,0],[100000,36000000],[-100000,-36000000]];
  for(const [requested,emu] of pairs){
    const native=onlyOfficeParagraphFormat({firstLineIndent:requested}).indent.FirstLine;
    const written=Math.trunc(native*36000),reopened=written/36000;
    assert.equal(written,emu);assert.equal(Math.round(native*36000)/36000,reopened);
  }
});
test("paragraph spacing is admitted at the native hundredth-point resolution",()=>{
  const step=.00352777778;
  for(const [requested,points] of [[100,283],[200,567],[0,0],[55880,158400]]){
    const native=onlyOfficeParagraphFormat({topMargin:requested}).spacing.Before;
    const written=Math.trunc(native/step),reopened=written*step;
    assert.equal(written,points);
    assert.equal(Math.round(native*36000)/36000,Math.round(reopened*36000)/36000);
    assert.ok(Math.abs(reopened-requested/100)<=step/2+1e-9);
  }
});
test("unserializable spacing is refused and unspecified paragraph properties stay absent",()=>{
  assert.throws(()=>onlyOfficeParagraphFormat({topMargin:100000}),/spacing_not_serializable/);
  assert.throws(()=>onlyOfficeParagraphFormat({leftMargin:NaN}),/format_invalid/);
  assert.throws(()=>onlyOfficeParagraphFormat(null),/format_invalid/);
  assert.throws(()=>onlyOfficeParagraphFormat({topMargin:-1}),/not_serializable/);
  assert.deepEqual(onlyOfficeParagraphFormat({leftMargin:null,topMargin:null}),{indent:{},spacing:{}});
});
