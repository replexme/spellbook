/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {materializeOnlyOfficeNativeGeometry} from './onlyoffice/native-geometry.mjs';
import {executeOnlyOfficeExtendedCommand} from './onlyoffice/extended-commands.mjs';

test('inherited geometry is materialized only for the bound object and retains rotation, flips and autofit',()=>{
  const target={Id:'target',spPr:{},x:42.33,y:31.18,extX:254,extY:66.32,rot:0.25,flipH:true,flipV:false};
  const other={...target,Id:'other',spPr:{}};
  const calls=[];
  const editor={WordControl:{m_oLogicDocument:{Slides:[{cSld:{spTree:[target,other]}}]}},isGroupActions:()=>true,executeGroupActionsStart:()=>calls.push('start'),executeGroupActionsEnd:()=>calls.push('end')};
  globalThis.window={Asc:{editor},AscBuilder:{Slide:{Api:{GetPresentation:()=>({CreateNewHistoryPoint:()=>calls.push('history')})}}},AscFormat:{CheckSpPrXfrm(shape,retainAutofit){assert.strictEqual(shape,target);assert.equal(retainAutofit,true);const transform={};for(const key of ['offX','offY','extX','extY','rot','flipH','flipV'])transform['set'+key[0].toUpperCase()+key.slice(1)]=value=>{transform[key]=value;};shape.spPr.xfrm=transform;}}};
  try {
    assert.equal(materializeOnlyOfficeNativeGeometry({op:'move',nativeId:target.Id}),true);
    for(const [key,value] of [['offX',target.x],['offY',target.y],['extX',target.extX],['extY',target.extY],['rot',target.rot],['flipH',target.flipH],['flipV',undefined]])assert.equal(target.spPr.xfrm[key],value);
    assert.equal(other.spPr.xfrm,undefined);
    assert.deepEqual(calls,['start','history','end']);
    assert.equal(materializeOnlyOfficeNativeGeometry({op:'move',nativeId:target.Id}),false);
  } finally {delete globalThis.window;}
});

test('multi-object preflight retains the canonical nullable slide index and binds its derived native index separately',()=>{
  const shapes=[{Id:'a'},{Id:'b'}],slide={Id:'slide',cSld:{spTree:shapes}};
  const api={GetPresentation:()=>({GetSlideByIndex:()=>({Slide:slide})})};
  globalThis.window={Asc:{editor:{WordControl:{m_oLogicDocument:{Slides:[slide]}}}},AscBuilder:{Slide:{Api:api},GetApiDrawing:()=>({})},AscFormat:{},AscCommon:{History:{}}};
  try {
    for(const op of ['align','distribute']) {
      if(op==='distribute')shapes.push({Id:'c'});
      const command={op,slideIndex:null,elementId:null,elementIds:shapes.map((_,index)=>'0/'+index),alignment:'left',axis:'horizontal'};
      const prepared=executeOnlyOfficeExtendedCommand({command,phase:'preflight',batchSize:1});
      for(const key of Object.keys(command))assert.deepEqual(prepared[key],command[key]);
      assert.equal(prepared.nativeSlideIndex,0);
      assert.deepEqual(prepared.nativeIds,shapes.map(shape=>shape.Id));
    }
  } finally {delete globalThis.window;}
});
