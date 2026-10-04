/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";import assert from "node:assert/strict";import vm from "node:vm";
import {attachOnlyOfficeResourceHost} from "./onlyoffice/product-resources.mjs";

test("foreign editor-frame byte views register only their owned range",async()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const editor={getMedia:()=>({}),captureNativeSnapshot(){},getNativeEditorApi:()=>({})};
  const bytes=vm.runInNewContext('new Uint8Array([99,1,2,88]).subarray(1,3)');
  assert.equal(bytes instanceof Uint8Array,false);
  try{
    attachOnlyOfficeResourceHost(editor);
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
    const url=host.register("sba_"+"a".repeat(64)+".png",bytes,"image/png");bytes.fill(7);
    assert.deepEqual(new Uint8Array(await(await fetch(url)).arrayBuffer()),Uint8Array.of(1,2));host.dispose();
  }finally{globalThis.window=prior;}
});

test("owned workbook conversion strips only the checked native file envelope",async()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const editor={getMedia:()=>({}),captureNativeSnapshot(){},getNativeEditorApi:()=>({})};
  let size=3;
  try{
    attachOnlyOfficeResourceHost(editor,async file=>{
      assert.equal(file.name,"owned-chart.xlsx");assert.deepEqual(new Uint8Array(await file.arrayBuffer()),Uint8Array.of(80,75));
      return {type:"cell",bin:new TextEncoder().encode(`XLSY;v2;${size};AQID`),media:{}};
    });
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
    assert.deepEqual(await host.convertWorkbook(Uint8Array.of(80,75)),Uint8Array.of(1,2,3));
    size=2;await assert.rejects(host.convertWorkbook(Uint8Array.of(80,75)),/binary_length_invalid/);host.dispose();
  }finally{globalThis.window=prior;}
});

 test("media identities use owned bytes across converter filename changes",async()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const url=URL.createObjectURL(new Blob([Uint8Array.of(1,2,3)])),media={"media/image1.png":url};
  try{
    attachOnlyOfficeResourceHost({getMedia:()=>media,captureNativeSnapshot(){},getNativeEditorApi:()=>({})});
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
    const before=await host.fingerprint("image1.png");delete media["media/image1.png"];media["media/renamed.png"]=url;
    assert.equal(await host.fingerprint("renamed.png"),before);assert.match(before,/^sha256:[0-9a-f]{64}$/);
    await assert.rejects(host.fingerprint("https://example.com/unowned.png"),/reference_not_owned/);
    const changed=host.register("sba_"+"b".repeat(64)+".png",Uint8Array.of(3,2,1),"image/png");
    assert.notEqual(await host.fingerprint(changed),before);host.dispose();
  }finally{URL.revokeObjectURL(url);globalThis.window=prior;}
});

test("converter-local media masks stage bytes and Undo removes their transport",()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const media={},name="sba_"+"c".repeat(64)+".wav",shape={nvPicPr:{nvPr:{unimedia:{media:"/working/media/"+name}}}};
  const model={Get_AllImageUrls:()=>[],Slides:[{cSld:{spTree:[shape]}}],slideMasters:[]};
  try{
    attachOnlyOfficeResourceHost({getMedia:()=>media,captureNativeSnapshot(){},getNativeEditorApi:()=>({WordControl:{m_oLogicDocument:model}})});
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")],url=host.register(name,Uint8Array.of(1,2,3),"audio/wav");
    host.sync();assert.equal(media["media/"+name],url);
    shape.nvPicPr.nvPr.unimedia=null;host.sync();assert.equal(media["media/"+name],undefined);
    shape.nvPicPr.nvPr.unimedia={media:"/working/media/"+name};host.sync();assert.equal(media["media/"+name],url);host.dispose();
  }finally{globalThis.window=prior;}
});


test("native mask files activate only the live poster's owned companion",()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const media={},base="sba_"+"d".repeat(64);let used=[];
  const model={Get_AllImageUrls:()=>used,Slides:[],slideMasters:[]};
  try{
    attachOnlyOfficeResourceHost({getMedia:()=>media,captureNativeSnapshot(){},getNativeEditorApi:()=>({WordControl:{m_oLogicDocument:model}})});
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
    const audio=host.register(base+".wav",Uint8Array.of(1,2),"audio/wav"),poster=host.register(base+".png",Uint8Array.of(3,4),"image/png");
    used=[poster];host.sync();assert.equal(media["media/"+base+".wav"],audio);
    used=[];host.sync();assert.deepEqual(media,{});
    used=[poster];host.sync();assert.equal(media["media/"+base+".wav"],audio);host.dispose();
  }finally{globalThis.window=prior;}
});
