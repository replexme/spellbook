/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs/promises';import {zipSync,strToU8} from 'fflate';
import {inspectPptxEmbeddedFonts} from '../ooxml-worker-source.mjs';
import {readPublicFontCatalog,installOnlyOfficeDocumentFontCatalog,installOnlyOfficeDocumentFontLoader,prepareOnlyOfficeDocumentFonts} from './document-fonts.mjs';
const p='http://schemas.openxmlformats.org/presentationml/2006/main',a='http://schemas.openxmlformats.org/drawingml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function fixture({permissions=8,target='fonts/font1.fntdata',external=false,entity=false}={}){
 const bytes=new Uint8Array(48),v=new DataView(bytes.buffer);v.setUint32(0,48,true);v.setUint32(4,12,true);v.setUint16(32,permissions,true);v.setUint16(34,0x504c,true);
 return zipSync({'ppt/presentation.xml':strToU8(`${entity?'<!DOCTYPE x [<!ENTITY evil "bad">]>':''}<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:embeddedFontLst><p:embeddedFont><p:font typeface="Example"/><p:regular r:id="font1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>`),'ppt/_rels/presentation.xml.rels':strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="font1" Target="${target}"${external?' TargetMode="External"':''}/></Relationships>`),'ppt/fonts/font1.fntdata':bytes,'ppt/slides/slide1.xml':strToU8(`<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:sp><p:txBody><a:p><a:r><a:rPr><a:ea typeface="Example"/></a:rPr><a:t>한글</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`)});
}
test('extracts only owned editable font relationships and tracks Hangul requirements',()=>{
 const report=inspectPptxEmbeddedFonts(fixture());assert.equal(report.faces.length,1);assert.equal(report.faces[0].requiresHangul,true);assert.equal(report.faces[0].part,'ppt/fonts/font1.fntdata');assert.equal(report.skipped.length,0);
 for(const options of [{external:true},{target:'../fonts/font1.fntdata'},{target:'https://fonts.invalid/private.fntdata'}])assert.equal(inspectPptxEmbeddedFonts(fixture(options)).faces.length,0);
 for(const permissions of [2,4,0x208]){const rejected=inspectPptxEmbeddedFonts(fixture({permissions}));assert.equal(rejected.faces.length,0);assert.equal(rejected.skipped[0].reason,'embedded_font_editing_not_allowed');}
 assert.throws(()=>inspectPptxEmbeddedFonts(fixture({entity:true})),/Unsafe XML/);
});
test('presentations without embedded fonts do not parse unrelated slide XML',()=>{
 const input=zipSync({'ppt/presentation.xml':strToU8(`<p:presentation xmlns:p="${p}"/>`),'ppt/_rels/presentation.xml.rels':strToU8('<Relationships/>'),'ppt/slides/slide1.xml':strToU8('<invalid')});assert.deepEqual(inspectPptxEmbeddedFonts(input),{faces:[],skipped:[]});
});
test('reads the admitted public catalog as data without evaluating program text',async()=>{
 const source=await fs.readFile(new URL('./distribution/sdkjs/common/AllFonts.js',import.meta.url),'utf8');const c=readPublicFontCatalog(source);assert.equal(c.__fonts_files.length,20);assert.equal(c.__fonts_infos.length,6);assert.throws(()=>readPublicFontCatalog('window["__fonts_files"] = fetch("/private");'),/catalog|JSON|Unexpected/);
});
test('native private font loader consumes the document stream and delegates public fonts',()=>{
 const oldWindow=globalThis.window,oldFonts=globalThis.AscFonts,key=Symbol.for('spellbook.onlyoffice.documentFonts/v1'),catalog={__fonts_files:['document-private.ttf'],__fonts_infos:[['Example',0,0,-1,-1,-1,-1,-1,-1]],g_fonts_selection_bin:'AA=='},bytes=new Uint8Array([1,2,3]);let publicLoads=0,callbacks=0;
 class Loader{constructor(id){this.Id=id;this.Status=-1;}LoadFontAsync(){publicLoads++;return false;}LoadFontFromData(data){assert.equal(data,bytes);this.Status=0;}}
 try{globalThis.window={parent:{[key]:{catalog,assets:{'/fonts/document-private.ttf':{bytes}}}}};globalThis.AscFonts={CFontFileLoader:Loader};installOnlyOfficeDocumentFontCatalog();window.__fonts_files=['incorrect public overwrite'];assert.equal(window.__fonts_files,catalog.__fonts_files);installOnlyOfficeDocumentFontLoader();const privateFace=new Loader('document-private.ttf');assert.equal(privateFace.LoadFontAsync('/fonts/',()=>callbacks++),true);assert.equal(callbacks,1);assert.equal(privateFace.LoadFontAsync('/fonts/',()=>callbacks++),true);assert.equal(callbacks,1);assert.equal(new Loader('000.ttf').LoadFontAsync('/fonts/'),false);assert.equal(publicLoads,1);
 }finally{globalThis.window=oldWindow;globalThis.AscFonts=oldFonts;}
});
test('closing a document cancels pending font work and clears its private buffers',async()=>{
 const oldWindow=globalThis.window,oldWorker=globalThis.Worker,key=Symbol.for('spellbook.onlyoffice.documentFonts/v1');let terminated=0;
 class PendingWorker{postMessage(){}terminate(){terminated++;}}
 try{globalThis.Worker=PendingWorker;globalThis.window={Worker:PendingWorker,addEventListener(){}};
  const opening=prepareOnlyOfficeDocumentFonts(new Uint8Array([0x50,0x4b,3,4]).buffer),context=window[key],privateBytes=new Uint8Array([1,2,3]);let disposed=0;context.onDispose(()=>{disposed++;assert.equal(privateBytes[0],1);});const remove=context.onDispose(()=>{throw Error('removed disposable ran');});remove();context.assets['private']={bytes:privateBytes};context.dispose();assert.equal(disposed,1);context.dispose();assert.equal(disposed,1);context.onDispose(()=>disposed++);assert.equal(disposed,2);
  await assert.rejects(opening,/document_font_context_closed/);assert(terminated>=1);assert.deepEqual([...privateBytes],[0,0,0]);assert.equal(window[key],undefined);
 }finally{globalThis.window=oldWindow;globalThis.Worker=oldWorker;}
});
test('public catalog survives native deletion of import globals for vector font selection',()=>{
 const previous=globalThis.window,key=Symbol.for('spellbook.onlyoffice.fontCatalog/v1');
 try{globalThis.window={parent:{}};installOnlyOfficeDocumentFontCatalog();const files=['000.ttf'],infos=[['Carlito',0,0,-1,-1,-1,-1,-1,-1]];window.__fonts_files=files;window.__fonts_infos=infos;window.__fonts_ranges=[32,127,0];delete window.__fonts_files;delete window.__fonts_infos;assert.strictEqual(window[key].__fonts_files,files);assert.strictEqual(window[key].__fonts_infos,infos);assert.deepEqual(window[key].__fonts_ranges,[32,127,0]);}finally{globalThis.window=previous;}
});
