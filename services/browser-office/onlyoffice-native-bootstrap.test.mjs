/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapOnlyOfficeNativeComplements } from "./onlyoffice/native-complements.mjs";

test("early SDK loader construction cannot install before native class registration",()=>{
  const prior=globalThis.window;
  let native=0,installed=0;
  class Loader {constructor(){native++;}}
  globalThis.window={AscCommon:{BinaryPPTYLoader:Loader}};
  try{
    bootstrapOnlyOfficeNativeComplements(()=>{installed++;});
    const early=new window.AscCommon.BinaryPPTYLoader();
    assert(early instanceof Loader);assert.equal(installed,0);
    window.AscCommonWord={CTextPr:class {}};window.AscWord={Run:class {}};
    window.Asc={CAscSlideTransition:class {}};
    window.AscCommon.CBinaryFileWriter=class {};
    window.AscCommonSlide={CPresentation:class {},fLoadComments(){}};
    assert(new window.AscCommon.BinaryPPTYLoader() instanceof Loader);
    assert.equal(installed,1);
    new window.AscCommon.BinaryPPTYLoader();
    assert.equal(installed,1);assert.equal(native,3);
  }finally{globalThis.window=prior;}
});
