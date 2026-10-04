/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import {installOnlyOfficeNativeComplements} from "./onlyoffice/native-complements.mjs";

// Reproduce the pinned loader's ReadRunProperties -> CTextPr.Set_FromObject
// boundary. Its original implementation copies only known SDK fields.
for(const deferred of [false,true])test(`native effect import and ${deferred?"deferred bidi":"legacy run"} drawing remain isolated`,()=>{
  const previous=globalThis.window,previousDocument=globalThis.document;
  class TextPr{Set_FromObject(value){this.font=value.font;}Copy(){const result=new TextPr();result.font=this.font;return result;}Merge(value){this.font=value.font;}}
  class Run{Get_CompiledPr(){return {FontSize:12,FontSizeCS:12};}Draw_Elements(state){return state.Graphics.m_oContext.shadowColor;}}
  class ContentDraw{constructor(graphics){this.Graphics=graphics;this.X=3;this.calcY=5;this.yOffset=0;}handleBidiFlow(data){this.X+=2;return this.Graphics.m_oContext.shadowColor;}}
  class Comment{createDuplicate(){return new Comment();}}
  class CommentData{createDuplicate(){return new CommentData();}}
  class Presentation{internalCalculateData(){}}
  class Transition{parseXmlParameters(){}fillXmlParams(){}}
  class Writer{constructor(){this.records=[];this.WriteRunProperties=pr=>{this.written=pr;};this.WriteRecord1=(type,value,write)=>{this.records.push({type,value});write(value);};this.WriteEffectLst=value=>{this.effects=value;};}}
  class Loader{}
  class Xfrm{setOffX(value){this.calls=(this.calls??0)+1;this.offX=value;}}
  class Memory{Init(){}WriteLong(value){this.value=value;}sha256(){return String(this.value);}}
  globalThis.window={Asc:{CAscSlideTransition:Transition,c_oAscSlideTransitionParams:{}},AscCommon:{CMemory:Memory,CBinaryFileWriter:Writer,BinaryPPTYLoader:Loader,CComment:Comment,CCommentData:CommentData},AscCommonWord:{CTextPr:TextPr},AscWord:{Run,ParagraphContentDrawState:deferred?ContentDraw:undefined,g_textPrCache:{getKey:pr=>pr.font??"default"}},AscCommonSlide:{CPresentation:Presentation,fLoadComments(){}},AscFormat:{CXfrm:Xfrm,CEffectProperties:class {}},AscDFH:{historyitem_type_Presentation:65536,historyitem_type_Comment:131072,historyitem_type_ParaRun:196608,changesFactory:{},drawingsChangesMap:{},drawingContentChanges:{},drawingsConstructorsMap:{}}};
  const effect=value=>({value,Write_ToBinary(memory){memory.WriteLong(this.value);},createDuplicate(){return effect(this.value);}});
  try{
    installOnlyOfficeNativeComplements();
    const transform=new Xfrm();transform.setOffX(12);transform.setOffX(12);assert.equal(transform.calls,1);transform.setOffX(13);assert.equal(transform.calls,2);transform.setOffX(13+Number.EPSILON*8);assert.equal(transform.calls,2);transform.setOffX(13+1e-8);assert.equal(transform.calls,3);
    const decoded={font:"Arial",spellbookEffects:effect(75)};
    const cache=window.AscWord.g_textPrCache;
    assert.notEqual(cache.getKey(decoded),cache.getKey({font:"Arial"}));
    assert.notEqual(cache.getKey(decoded),cache.getKey({font:"Arial",spellbookEffects:effect(76)}));
    assert.equal(cache.getKey(decoded),cache.getKey({font:"Arial",spellbookEffects:effect(75)}));
    const imported=new TextPr();imported.Set_FromObject(decoded);
    assert.equal(imported.spellbookEffects.value,75);assert.notEqual(imported.spellbookEffects,decoded.spellbookEffects);
    decoded.spellbookEffects.value=100;assert.equal(imported.spellbookEffects.value,75);
    assert.equal(imported.Copy().spellbookEffects.value,75);
    const writer=new window.AscCommon.CBinaryFileWriter(),detached=writer.WriteRunProperties;
    const effects={outerShdw:{dist:36000}};
    detached({spellbookEffects:{EffectLst:effects}});
    assert.deepEqual(writer.records,[{type:2,value:effects}]);assert.equal(writer.effects,effects);
    const run=new Run();run.Pr={spellbookEffects:{EffectLst:{outerShdw:{color:{color:{RGBA:{R:1,G:2,B:3}}}}}}};
    const context=()=>({canvas:{width:8,height:8},shadowColor:"transparent",shadowOffsetX:0,shadowOffsetY:0,shadowBlur:0,getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},setTransform(){},clearRect(){},save(){this.prior=[this.shadowColor,this.shadowOffsetX,this.shadowOffsetY,this.shadowBlur];},restore(){[this.shadowColor,this.shadowOffsetX,this.shadowOffsetY,this.shadowBlur]=this.prior;},drawImage(...args){this.args=args;this.composedShadow=this.shadowColor;}});
    globalThis.document={createElement:()=>{const target=context();return {width:8,height:8,getContext:()=>target};}};
    const ctx=context(),graphics={m_oContext:ctx};
    const invoke=()=>deferred?new ContentDraw(graphics).handleBidiFlow([{},run],1):run.Draw_Elements({Graphics:graphics});
    assert.equal(invoke(),"transparent");assert.equal(ctx.composedShadow,"rgba(1,2,3,1)");assert.equal(ctx.shadowColor,"transparent");assert.equal(graphics.m_oContext,ctx);
    if(deferred){graphics.m_oFullTransform={TransformPointX:(x,y)=>x*2-y,TransformPointY:(x,y)=>x+y*2};invoke();assert.equal(ctx.args.length,9);assert.equal(ctx.args[1],ctx.args[5]);assert.equal(ctx.args[2],ctx.args[6]);}
    run.Pr.spellbookEffects=null;assert.equal(invoke(),"transparent");
    imported.Set_FromObject({font:"Arial",spellbookEffects:null});assert.equal(imported.spellbookEffects,null);
    const main={fillStyle:"#000000",colors:[],fillRect(){this.colors.push(this.fillStyle);}},overlay={...main,colors:[]};
    const animation={Param:window.Asc.c_oAscSlideTransitionParams.Fade_ThroughWhite,phase:.49,Rect:{x:0,y:2,w:8,h:4},DemonstrationObject:{Canvas:{getContext:()=>main},Overlay:{getContext:()=>overlay}},_getPart(){return this.phase;}};
    const mainFill=main.fillRect,overlayFill=overlay.fillRect;
    let nextPhase=.6;
    const nativeFade=()=>{
      animation.phase=nextPhase;main.fillStyle="#000000";main.fillRect(0,0,8,8);main.fillRect(0,2,8,4);
      overlay.fillStyle="#000000";overlay.fillRect(0,2,8,4);
    };
    animation._startFade=nativeFade;
    window.Asc.editor={WordControl:{DemonstrationManager:{Transition:animation}}};
    window.Asc.c_oAscSlideTransitionParams.Fade_Through_Black=7;
    installOnlyOfficeNativeComplements();
    const unboundFade=animation._startFade;unboundFade();
    assert.deepEqual(main.colors,["#000000","#ffffff"]);assert.deepEqual(overlay.colors,["#000000"]);
    assert.equal(animation.Param,window.Asc.c_oAscSlideTransitionParams.Fade_ThroughWhite);
    nextPhase=.4;animation.IsBackward=true;unboundFade();assert.equal(overlay.colors.at(-1),"#ffffff");
    assert.strictEqual(main.fillRect,mainFill);assert.strictEqual(overlay.fillRect,overlayFill);

  }finally{globalThis.window=previous;globalThis.document=previousDocument;}
});
