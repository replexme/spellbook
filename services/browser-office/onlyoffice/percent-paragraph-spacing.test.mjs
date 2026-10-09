import test from 'node:test';
import assert from 'node:assert/strict';
import {installOnlyOfficePercentParagraphSpacing} from './percent-paragraph-spacing.mjs';
test('font change and Undo recompute derived percentage spacing while point spacing and authored values survive',()=>{
 const previous=globalThis.window,calls=[];
 class Shape{
  recalculateDocContent(content,body,skip,token){
   const spacing=content.Content[0].CompiledPr.Pr.ParaPr.Spacing;
   calls.push({skip,before:spacing.Before,after:spacing.After,body,token});
   if(!skip){
    if(spacing.BeforePct&&spacing.Before===0)spacing.Before=content.lineHeight*spacing.BeforePct/100000;
    if(spacing.AfterPct&&spacing.After===0)spacing.After=content.lineHeight*spacing.AfterPct/100000;
    return this.recalculateDocContent(content,body,true,token);
   }
   return spacing.Before+spacing.After;
  }
 }
 globalThis.window={AscFormat:{CShape:Shape}};
 try{
  const authored={BeforePct:20000,Before:0,After:5},before=JSON.stringify(authored);
  const spacing={BeforePct:20000,Before:2.7,After:5};
  const content={lineHeight:10,Content:[{Pr:{Spacing:authored},CompiledPr:{Pr:{ParaPr:{Spacing:spacing}}}}]},shape=new Shape(),body={},token={};
  installOnlyOfficePercentParagraphSpacing();const installed=Shape.prototype.recalculateDocContent;installOnlyOfficePercentParagraphSpacing();assert.strictEqual(Shape.prototype.recalculateDocContent,installed);
  assert.equal(shape.recalculateDocContent(content,body,false,token),7);
  assert.equal(calls[0].before,0);assert.equal(calls[1].before,2);assert.equal(calls[1].after,5);assert.strictEqual(calls[1].body,body);assert.strictEqual(calls[1].token,token);
  content.lineHeight=15;assert.equal(shape.recalculateDocContent(content,body,false,token),8);assert.equal(spacing.Before,3);
  content.lineHeight=10;assert.equal(shape.recalculateDocContent(content,body,false,token),7);assert.equal(JSON.stringify(authored),before);
  spacing.BeforePct=0;spacing.Before=99;shape.recalculateDocContent(content,body,false,token);assert.equal(spacing.Before,0);
  delete spacing.BeforePct;spacing.Before=4;shape.recalculateDocContent(content,body,false,token);assert.equal(spacing.Before,4);
 }finally{globalThis.window=previous;}
});
test('native reflow error remains visible and no unrelated content is changed',()=>{
 const previous=globalThis.window;class Shape{recalculateDocContent(){throw Error('native reflow failed');}}
 globalThis.window={AscFormat:{CShape:Shape}};
 try{installOnlyOfficePercentParagraphSpacing();assert.throws(()=>new Shape().recalculateDocContent({Content:[{}]},null,false),/native reflow failed/);}finally{globalThis.window=previous;}
});
