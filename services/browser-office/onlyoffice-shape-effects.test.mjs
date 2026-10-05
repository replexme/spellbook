/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {installOnlyOfficeShapeEffects} from './onlyoffice/shape-effects.mjs';
function fixture(){
  const previous={window:globalThis.window,document:globalThis.document},nodes=[],canvases=[];
  class Node{constructor(name){this.name=name;this.attributes={};this.childNodes=[];this.style={};nodes.push(this);}setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name];}appendChild(node){this.childNodes.push(node);}replaceChildren(){this.childNodes=[];}}
  const context=canvas=>({canvas,filter:'none',globalAlpha:1,globalCompositeOperation:'source-over',draws:[],fills:[],stack:[],matrix:{a:1,b:0,c:0,d:1,e:0,f:0},save(){this.stack.push({filter:this.filter,globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation,matrix:this.matrix});},restore(){Object.assign(this,this.stack.pop());},getTransform(){return this.matrix;},setTransform(...value){this.matrix=value.length===1?value[0]:value;},clearRect(){this.fills=[];},fillRect(...args){this.fills.push(args);},drawImage(canvas,...args){this.draws.push({canvas,filter:this.filter,args});}});
  const canvas=()=>{const result={width:100,height:80};const ctx=context(result);result.getContext=()=>ctx;canvases.push(result);return result;};
  class Base{drawShdw(graphics){this.shadowCalls=(this.shadowCalls??0)+1;graphics.m_oContext.fillRect(24,24,40,30);}}
  class Shape extends Base{draw(graphics,...args){this.drawCalls=(this.drawCalls??0)+1;this.nativeContext=graphics.m_oContext;this.args=args;this.drawShdw(graphics);if(this.fail)throw this.fail;graphics.m_oContext.fillRect(20,20,40,30);return 23;}getParentObjects(){return {theme:'theme',slide:'slide',layout:'layout',master:'master'};}getColorMap(){return 'map';}}
  globalThis.window={AscFormat:{CShape:Shape,CGraphicObjectBase:Base}};
  globalThis.document={createElement:canvas,createElementNS:(_,name)=>new Node(name),documentElement:new Node('html')};
  const main=canvas(),ctx=main.getContext(),graphics={m_oContext:ctx,m_oCoordTransform:{sx:4},isBoundsChecker:()=>false};
  installOnlyOfficeShapeEffects();
  return {Shape,graphics,ctx,nodes,canvases,close(){globalThis.window=previous.window;globalThis.document=previous.document;}};
}
test('ordinary and zero-radius shapes retain the original native draw path',()=>{
 const f=fixture();try{for(const effects of [null,{glow:{rad:0},softEdge:{rad:0},outerShdw:{blurRad:0}}]){
  const shape=new f.Shape();shape.spPr={effectProps:{EffectLst:effects}};
  assert.equal(shape.draw(f.graphics,'transform'),23);assert.strictEqual(shape.nativeContext,f.ctx);assert.equal(shape.drawCalls,1);assert.deepEqual(shape.args,['transform']);
 }assert.equal(f.canvases.length,1);}finally{f.close();}
});
test('native pixels feed inward soft edges and color-resolved glow without changing authored properties',()=>{
 const f=fixture();try{
  let resolved;const color={color:{RGBA:{R:1,G:2,B:3,A:255}},createDuplicate(){return {Calculate(...args){resolved=args;this.RGBA={R:36,G:88,B:255,A:178};}};}};
  const shape=new f.Shape();shape.spPr={effectProps:{EffectLst:{glow:{rad:36000,color},softEdge:{rad:18000}}}};
  const properties=JSON.stringify(shape.spPr);f.ctx.filter='caller-filter';const matrix=f.ctx.getTransform();
  assert.equal(shape.draw(f.graphics,undefined,undefined,0),23);assert.notStrictEqual(shape.nativeContext,f.ctx);assert.equal(shape.drawCalls,1);assert.equal(shape.shadowCalls,1);
  assert.equal(JSON.stringify(shape.spPr),properties);assert.equal(f.ctx.filter,'caller-filter');assert.equal(f.ctx.globalAlpha,1);assert.equal(f.ctx.stack.length,0);assert.strictEqual(f.graphics.m_oContext,f.ctx);
  assert.deepEqual(resolved,['theme','slide','layout','master',{R:0,G:0,B:0,A:255},'map']);
  const filter=f.nodes.find(node=>node.name==='filter');assert.equal(filter.attributes.width,'100');assert.equal(filter.attributes.height,'80');
  const primitives=filter.childNodes;assert(primitives.some(n=>n.name==='feFuncA')===false);assert.equal(primitives[0].childNodes[0].attributes.slope,'255');
  assert.equal(primitives.find(n=>n.name==='feMorphology'&&n.attributes.operator==='erode').attributes.radius,'1');
  assert.equal(primitives.find(n=>n.name==='feFlood').attributes['flood-color'],'rgb(36,88,255)');
  assert.equal(f.ctx.draws.at(-1).filter,'url(#'+filter.attributes.id+')');assert.deepEqual(f.ctx.getTransform(),matrix);
 }finally{f.close();}
});
test('shadow blur reuses native transforms and compositing does not double-draw the shadow',()=>{
 const f=fixture();try{const shape=new f.Shape();shape.spPr={effectProps:{EffectLst:{outerShdw:{blurRad:36000}}}};
  assert.equal(shape.draw(f.graphics),23);assert.equal(shape.shadowCalls,1);assert.equal(shape.drawCalls,1);
  assert.equal(f.ctx.draws[0].filter,'blur(2px)');assert.equal(f.ctx.draws[1].filter,'none');assert.equal(f.ctx.filter,'none');
 }finally{f.close();}
});
test('native draw failure restores its context, clip and reentrant guards for the next draw',()=>{
 const f=fixture();try{const shape=new f.Shape(),failure=Error('native drawing failed');let clips=0;
  Object.assign(f.graphics,{SaveGrState(){clips++;},AddClipRect(...args){assert.deepEqual(args,[1,2,3,4]);},RestoreGrState(){clips--;}});
  shape.getClipRect=()=>({x:1,y:2,w:3,h:4});shape.spPr={effectProps:{EffectLst:{softEdge:{rad:18000}}}};shape.fail=failure;
  assert.throws(()=>shape.draw(f.graphics),error=>error===failure);assert.strictEqual(f.graphics.m_oContext,f.ctx);assert.equal(clips,0);assert.equal(f.ctx.filter,'none');
  delete shape.fail;assert.equal(shape.draw(f.graphics),23);assert.equal(clips,0);assert.equal(shape.shadowCalls,2);assert.equal(shape.drawCalls,2);assert.notStrictEqual(shape.nativeContext,f.ctx);
 }finally{f.close();}
});

test('pending recalculation, partial redraw exclusions and animation delegation do not allocate canvas surfaces',()=>{
 const f=fixture();try{for(const mode of ['recalculate','outside','animation']){
  const shape=new f.Shape();shape.spPr={effectProps:{EffectLst:{glow:{rad:36000}}}};
  if(mode==='recalculate')shape.checkNeedRecalculate=()=>true;
  if(mode==='outside'){shape.bounds={};f.graphics.updatedRect={isIntersectOther:()=>false};}
  if(mode==='animation')f.graphics.animationDrawer={};
  assert.equal(shape.draw(f.graphics),23);assert.strictEqual(shape.nativeContext,f.ctx);
  delete f.graphics.updatedRect;delete f.graphics.animationDrawer;
 }assert.equal(f.canvases.length,1);}finally{f.close();}
});
test('bounds include glow and shadow halos while preserving earlier objects and restoring after failures',()=>{
 const f=fixture();try{
  const shape=new f.Shape();
  shape.spPr={effectProps:{EffectLst:{glow:{rad:36000},outerShdw:{blurRad:72000}}}};
  window.AscFormat.CBoundsController=class{constructor(){this.min_x=65535;this.min_y=65535;this.max_x=-65535;this.max_y=-65535;}};
  const previous={min_x:-10,min_y:-5,max_x:0,max_y:0};f.graphics.Bounds=previous;f.graphics.isBoundsChecker=()=>true;
  f.graphics.m_oContext.fillRect=()=>Object.assign(f.graphics.Bounds,{min_x:10,min_y:20,max_x:30,max_y:40});
  assert.equal(shape.draw(f.graphics),23);assert.strictEqual(f.graphics.Bounds,previous);
  assert.deepEqual(previous,{min_x:-10,min_y:-5,max_x:33,max_y:43});assert.equal(f.canvases.length,1);
  shape.fail=Error('bounds fail');assert.throws(()=>shape.draw(f.graphics),/bounds fail/);assert.strictEqual(f.graphics.Bounds,previous);
 }finally{f.close();}
});
