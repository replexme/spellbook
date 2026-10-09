/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {bindOnlyOfficeSvgFonts,installOnlyOfficeVectorImageFonts} from './vector-image-fonts.mjs';
import {createSfntGlyphLookup} from './sfnt-glyph-lookup.mjs';
import {sfntTables} from './document-font-selection.mjs';
import recipe from './symbol-font/font-recipe.json' with {type:'json'};

test('SVG fonts preserve original priority, qualified symbols, per-character positions and shaping context without OS names',async()=>{
 const fontFiles=['distribution/fonts/008.ttf','distribution/fonts/009.ttf','symbol-font/SpellbookSymbols-Regular.ttf'];
 const fonts=await Promise.all(fontFiles.map(async file=>(await fs.readFile(new URL('./'+file,import.meta.url))).toString('base64')));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<canvas width="400" height="160"></canvas>');
  const result=await page.evaluate(async ({bind,lookup,tables,glyphs,fonts})=>{
   const binder=eval('('+bind+')'),makeLookup=eval('('+lookup+')'),readTables=eval('('+tables+')');
   const fontData=fonts.map(value=>{const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return {bytes,base64:value,sha256:'test-face',covers:makeLookup(bytes,readTables)};});
   const catalog={__fonts_infos:[['Liberation Sans',0,0,1,0,-1,-1,-1,-1],['Spellbook Symbols',2,0,-1,-1,-1,-1,-1,-1]],__fonts_ranges:[32,127,0]};
   const source='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="white"/><g font-family="\'Arial\',\'Liberation Sans\'"><text x="10 30" y="45" font-size="32">AB</text><text x="10" y="85" font-size="32" font-style="italic">Text</text></g><text x="180 250" y="100" font-size="60" font-family="\'Webdings\',\'Noto Sans Arabic\'">ng</text></svg>';
   const options={catalog,readFace:index=>fontData[index],pickFont:()=> 'Liberation Sans',glyphs};
   const bound=await binder(source,options),xml=new DOMParser().parseFromString(bound.source,'image/svg+xml');
   const outlined=await binder(source,{...options,outlineGlyph:()=>({path:'M0 0 L100 0 L100 100 Z',units:1000})}),outlineXml=new DOMParser().parseFromString(outlined.source,'image/svg+xml');
   const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(bound.source)));await image.decode();document.querySelector('canvas').getContext('2d').drawImage(image,0,0);
   let rejected;try{await binder(source.replace('>ng<','>nx<'),options);}catch(error){rejected=error.message;}
   const privateCatalog={...catalog,__fonts_infos:[['Arial',0,0,1,0,-1,-1,-1,-1],...catalog.__fonts_infos]};
   const priority=await binder(source.replace('>ng<','>ng<').replace("'Webdings','Noto Sans Arabic'","'Liberation Sans'"),{...options,catalog:privateCatalog});
   const nested=await binder('<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Arial" font-size="20">A<tspan>B</tspan></text></svg>',{...options,catalog:privateCatalog});if(nested.fonts.some(font=>font.family!=='Arial'))throw Error('nested_original_font_lost');
   return {mapped:bound.mappedGlyphs,fonts:bound.fonts,positions:[...xml.querySelectorAll('text')].map(t=>({x:t.getAttribute('x'),y:t.getAttribute('y'),text:t.textContent,family:t.getAttribute('font-family')})),priority:priority.fonts.map(f=>f.family),sourceUnchanged:source.includes('>ng<'),rejected,png:document.querySelector('canvas').toDataURL(),outlined:{glyphs:outlined.outlinedGlyphs,paths:[...outlineXml.querySelectorAll('use')].map(path=>path.getAttribute('transform')),remainingTexts:[...outlineXml.querySelectorAll('text')].map(t=>t.textContent),fonts:outlined.fonts}};
  },{bind:bindOnlyOfficeSvgFonts.toString(),lookup:createSfntGlyphLookup.toString(),tables:sfntTables.toString(),glyphs:recipe.glyphs,fonts});
  assert.equal(result.mapped,2);assert.equal(result.sourceUnchanged,true);assert.equal(result.rejected,'onlyoffice_vector_legacy_glyph_unreviewed');
  assert.deepEqual(result.positions.map(t=>[t.x,t.y]),[['10 30','45'],['10','85'],['180 250','100']]);assert.equal(result.positions[2].text,'\ue607\ue608');
  assert(result.positions.every(t=>/^"SpellbookVectorFont/.test(t.family)));assert(result.fonts.some(f=>f.style==='italic'));assert(result.priority.includes('Arial'));
  assert(result.png.startsWith('data:image/png;base64,'));
  assert.equal(result.outlined.glyphs,4);assert.deepEqual(result.outlined.remainingTexts,['Text']);assert.deepEqual(result.outlined.paths,['translate(10 45) scale(0.032 -0.032)','translate(30 45) scale(0.032 -0.032)','translate(180 100) scale(0.06 -0.06)','translate(250 100) scale(0.06 -0.06)']);assert.equal(result.outlined.fonts.filter(font=>font.embedded).length,1);assert.equal(result.outlined.fonts.find(font=>font.embedded).style,'italic');
 }finally{await browser.close();}
});

test('image preparation deduplicates native sources and disposes private display resources with the document',async()=>{
 const previous={window:globalThis.window,location:globalThis.location,fetch:globalThis.fetch},key=Symbol.for('spellbook.onlyoffice.vectorImageFonts/v1'),fontKey=Symbol.for('spellbook.onlyoffice.fontCatalog/v1');
 const calls=[],events=[],revoked=[],font=new Uint8Array(await fs.readFile(new URL('./symbol-font/SpellbookSymbols-Regular.ttf',import.meta.url))),originalFont=font.slice();let disposeCallback,bindCount=0,fetchCount=0;
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
 try{
  URL.createObjectURL=()=> 'blob:http://local/display';URL.revokeObjectURL=url=>revoked.push(url);
  const loader={loadImageByUrl(image,url){calls.push({image,url});}};
  globalThis.location={origin:'http://local'};globalThis.window={parent:{[Symbol.for('spellbook.onlyoffice.documentFonts/v1')]:{assets:{'/fonts/document-private.ttf':{bytes:font}},onDispose(callback){disposeCallback=callback;return()=>events.push('unregister');}}},AscCommon:{g_image_loader:loader},[fontKey]:{__fonts_files:['document-private.ttf']},addEventListener(name,callback){events.push(name);}};
  globalThis.fetch=async()=>{fetchCount++;return new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}});};
  const native=loader.loadImageByUrl;
  installOnlyOfficeVectorImageFonts([],async(source,{readFace})=>{bindCount++;const face=await readFace(0);assert.equal(face.bytes,font);return {source:'<svg/>',fonts:[{sha256:face.sha256}],mappedGlyphs:0};},()=>()=>true,()=>new Map());
  const authored='blob:http://local/source',a={},b={};loader.loadImageByUrl(a,authored);loader.loadImageByUrl(b,authored);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(fetchCount,1);assert.equal(bindCount,1);assert.equal(calls.length,2);assert(calls.every(call=>call.url==='blob:http://local/display'));assert.equal(authored,'blob:http://local/source');assert.deepEqual(window[key].report.errors,[]);
  loader.loadImageByUrl(a,'https://foreign/vector.svg');assert.equal(calls.at(-1).url,'https://foreign/vector.svg');assert.equal(fetchCount,1);
  disposeCallback();assert.deepEqual(revoked,['blob:http://local/display']);assert.equal(window[key],undefined);assert.equal(loader.loadImageByUrl,native);assert.deepEqual(font,originalFont);assert(events.includes('unregister'));
 }finally{globalThis.window=previous.window;globalThis.location=previous.location;globalThis.fetch=previous.fetch;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
