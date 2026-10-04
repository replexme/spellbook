/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import {installOnlyOfficeNativeComplements} from "./onlyoffice/native-complements.mjs";

// Reproduce the pinned loader's ReadRunProperties -> CTextPr.Set_FromObject
// boundary. Its original implementation copies only known SDK fields.
test("decoded run effects survive the native text-property import copy",()=>{
  const previous=globalThis.window;
  class TextPr{Set_FromObject(value){this.font=value.font;}Copy(){const result=new TextPr();result.font=this.font;return result;}Merge(value){this.font=value.font;}}
  class Run{Draw_Elements(){}}
  class Comment{createDuplicate(){return new Comment();}}
  class CommentData{createDuplicate(){return new CommentData();}}
  class Presentation{internalCalculateData(){}}
  class Transition{parseXmlParameters(){}fillXmlParams(){}}
  class Writer{}
  class Loader{}
  globalThis.window={Asc:{CAscSlideTransition:Transition,c_oAscSlideTransitionParams:{}},AscCommon:{CBinaryFileWriter:Writer,BinaryPPTYLoader:Loader,CComment:Comment,CCommentData:CommentData},AscCommonWord:{CTextPr:TextPr},AscWord:{Run},AscCommonSlide:{CPresentation:Presentation,fLoadComments(){}},AscFormat:{CEffectProperties:class {}},AscDFH:{historyitem_type_Presentation:65536,historyitem_type_Comment:131072,historyitem_type_ParaRun:196608,changesFactory:{},drawingsChangesMap:{},drawingContentChanges:{},drawingsConstructorsMap:{}}};
  const effect=value=>({value,createDuplicate(){return effect(this.value);}});
  try{
    installOnlyOfficeNativeComplements();
    const decoded={font:"Arial",spellbookEffects:effect(75)};
    const imported=new TextPr();imported.Set_FromObject(decoded);
    assert.equal(imported.spellbookEffects.value,75);assert.notEqual(imported.spellbookEffects,decoded.spellbookEffects);
    decoded.spellbookEffects.value=100;assert.equal(imported.spellbookEffects.value,75);
    assert.equal(imported.Copy().spellbookEffects.value,75);
    imported.Set_FromObject({font:"Arial",spellbookEffects:null});assert.equal(imported.spellbookEffects,null);
  }finally{globalThis.window=previous;}
});
