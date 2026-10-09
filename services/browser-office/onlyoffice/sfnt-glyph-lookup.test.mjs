/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {createSfntGlyphLookup} from './sfnt-glyph-lookup.mjs';

test('admitted public text and reviewed symbols have actual glyphs, absent and invalid codes do not',async()=>{
  const text=createSfntGlyphLookup(await fs.readFile(new URL('./distribution/fonts/008.ttf',import.meta.url)));
  for(const code of [32,65,103,110,0x00e9])assert.equal(text(code),true);
  for(const code of [-1,0x110000,3.4,0xe607])assert.equal(text(code),false);
  const symbols=createSfntGlyphLookup(await fs.readFile(new URL('./symbol-font/SpellbookSymbols-Regular.ttf',import.meta.url)));
  for(let code=0xe600;code<=0xe608;code++)assert.equal(symbols(code),true);
  for(const code of [65,103,110,0xe609])assert.equal(symbols(code),false);
});
test('malformed cmap ranges and truncated glyph offsets cannot count as coverage',()=>{
  const make=()=>{const bytes=new Uint8Array(52),v=new DataView(bytes.buffer);v.setUint16(2,1,false);v.setUint16(4,3,false);v.setUint16(6,1,false);v.setUint32(8,12,false);v.setUint16(12,4,false);v.setUint16(14,40,false);v.setUint16(18,4,false);v.setUint16(26,65,false);v.setUint16(28,0xffff,false);v.setUint16(32,65,false);v.setUint16(34,0xffff,false);v.setInt16(36,-64,false);v.setInt16(38,1,false);return {v,read:()=>new Map([['cmap',v]])};};
  const good=make(),lookup=createSfntGlyphLookup(null,good.read);assert.equal(lookup(65),true);assert.equal(lookup(64),false);assert.equal(lookup(0xffff),false);
  const badRange=make();badRange.v.setUint16(32,66,false);assert.throws(()=>createSfntGlyphLookup(null,badRange.read),/segments_invalid/);
  const badOffset=make();badOffset.v.setUint16(40,200,false);assert.throws(()=>createSfntGlyphLookup(null,badOffset.read)(65),/glyph_invalid/);
});
