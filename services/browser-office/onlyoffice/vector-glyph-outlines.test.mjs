/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';import assert from 'node:assert/strict';
import {createOnlyOfficeVectorGlyphOutliner} from './vector-glyph-outlines.mjs';

test('native outlines retain separate contours, cache glyphs, and release their isolated library',()=>{
 const previous=globalThis.AscFonts,events=[];let calls=0;
 const head=new DataView(new ArrayBuffer(20));head.setUint16(18,2048,false);
 try{
  globalThis.AscFonts={FT_CreateLibrary:()=>{events.push('library');return 1;},AllocString:()=>({pointer:2,getBuffer:()=>new Uint8Array(12),free:()=>events.push('buffer-free')}),FT_Open_Face:()=>3,FT_SetCMapForCharCode:()=>4,FT_Load_Glyph:()=>0,FT_Load_Mode:{FT_LOAD_NO_SCALE:1,FT_LOAD_NO_HINTING:2,FT_LOAD_NO_BITMAP:8},FT_Glyph_Get_Measure(face,worker,painter){calls++;painter.start(worker);painter._move_to(0,0,worker);painter._line_to(100,0,worker);painter._move_to(10,10,worker);painter._conic_to(20,10,20,20,worker);painter.end(worker);return {};},FT_Done_Face:()=>events.push('face-free'),FT_Done_Library:()=>events.push('library-free')};
  const outliner=createOnlyOfficeVectorGlyphOutliner(()=>new Map([['head',head]])),font={bytes:new Uint8Array(12),sha256:'owned-font'};
  const glyph=outliner.glyph(font,65);assert.deepEqual(glyph,{units:2048,path:'M0 0 L100 0 Z M10 10 Q20 10 20 20 Z'});assert.deepEqual(outliner.glyph(font,65),glyph);assert.equal(calls,1);outliner.dispose();outliner.dispose();assert.deepEqual(events,['library','face-free','buffer-free','library-free']);assert.throws(()=>outliner.glyph(font,65),/context_closed/);
 }finally{globalThis.AscFonts=previous;}
});
test('a failed native face releases its buffer and library without creating a usable glyph',()=>{
 const previous=globalThis.AscFonts,events=[],head=new DataView(new ArrayBuffer(20));head.setUint16(18,2048,false);
 try{globalThis.AscFonts={FT_CreateLibrary:()=>1,AllocString:()=>({pointer:2,getBuffer:()=>new Uint8Array(12),free:()=>events.push('buffer-free')}),FT_Open_Face:()=>0,FT_Done_Library:()=>events.push('library-free')};const outliner=createOnlyOfficeVectorGlyphOutliner(()=>new Map([['head',head]]));assert.throws(()=>outliner.glyph({bytes:new Uint8Array(12),sha256:'bad-font'},65),/face_failed/);outliner.dispose();assert.deepEqual(events,['buffer-free','library-free']);}finally{globalThis.AscFonts=previous;}
});
