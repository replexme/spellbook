/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
import {preserveOriginalPptxParts} from './ooxml-worker-source.mjs';
const part='ppt/slides/slide1.xml',related='ppt/slides/_rels/slide1.xml.rels';
const p='http://schemas.openxmlformats.org/presentationml/2006/main',a='http://schemas.openxmlformats.org/drawingml/2006/main';
async function fixture(){
 const original=unzipSync(new Uint8Array(await fs.readFile(new URL('../../eval/public/fixtures/general-native-surface.pptx',import.meta.url))));
 const picture='<p:pic><p:nvPicPr><p:cNvPr id="501" name="Linked picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="authorExternal"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="36000" cy="72000"/></a:xfrm></p:spPr></p:pic>';
 original[part]=strToU8(strFromU8(original[part]).replace('</p:spTree>',picture+'</p:spTree>'));
 original[related]=strToU8(strFromU8(original[related]).replace('</Relationships>','<Relationship Id="authorExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://media.example/image.png" TargetMode="External"/></Relationships>'));
 const baseline={...original,
  [part]:strToU8(strFromU8(original[part]).replace('r:link="authorExternal"','r:embed="nativeImage"').replace('x="914400"','x="914499"').replace('cx="36000"','cx="35999"')),
  [related]:strToU8(strFromU8(original[related]).replace('Id="authorExternal"','Id="nativeImage"').replace('Target="https://media.example/image.png" TargetMode="External"','Target="../media/projected.png"')),
  'ppt/media/projected.png':Uint8Array.of(137,80,78,71,13,10,26,10),
 };
 return {original,baseline};
}
const save=(original,baseline,edited)=>preserveOriginalPptxParts(zipSync(original),zipSync(baseline),zipSync(edited),null);
const document=entries=>new DOMParser().parseFromString(strFromU8(entries[part]),'application/xml');
function expectOnlySlideChange(original,result){
 assert.deepEqual(result.report.changedParts,[part]);
 const saved=unzipSync(result.bytes);
 assert.deepEqual(Object.keys(saved).sort(),Object.keys(original).sort());
 for(const [name,bytes] of Object.entries(original))if(name!==part)assert.deepEqual(saved[name],bytes,name);
 assert.match(strFromU8(saved[part]),/r:link="authorExternal"/);
 assert.doesNotMatch(strFromU8(saved[part]),/nativeImage/);
 return saved;
}
test('human move preserves untouched external picture and applies delta to authored position',async()=>{
 const {original,baseline}=await fixture();
 const edited={...baseline,[part]:strToU8(strFromU8(baseline[part]).replace('x="914499"','x="950499"'))};
 const saved=expectOnlySlideChange(original,save(original,baseline,edited));
 const shape=document(saved).getElementsByTagNameNS(p,'sp')[0];
 assert.equal(shape.getElementsByTagNameNS(a,'off')[0].getAttribute('x'),'950400');
});
test('human linked-picture move and resize retain original relationship and import rounding',async()=>{
 const {original,baseline}=await fixture();
 const edited={...baseline,[part]:strToU8(strFromU8(baseline[part]).replace('x="1000" y="2000"','x="1500" y="1000"').replace('cx="35999" cy="72000"','cx="53999" cy="90000"'))};
 const saved=expectOnlySlideChange(original,save(original,baseline,edited));
 const shape=document(saved).getElementsByTagNameNS(p,'pic')[0],off=shape.getElementsByTagNameNS(a,'off')[0],ext=shape.getElementsByTagNameNS(a,'ext')[0];
 assert.equal(off.getAttribute('x'),'1500');assert.equal(off.getAttribute('y'),'1000');
 assert.equal(ext.getAttribute('cx'),'54000');assert.equal(ext.getAttribute('cy'),'90000');
});
test('geometry preservation refuses to conceal replaced image bytes or retargeted relationships',async()=>{
 const {original,baseline}=await fixture();
 const moved={...baseline,[part]:strToU8(strFromU8(baseline[part]).replace('x="914499"','x="950499"'))};
 assert.throws(()=>save(original,baseline,{...moved,'ppt/media/projected.png':Uint8Array.of(1,2,3)}),/relationship remapping/);
 const theme=Object.keys(baseline).find(name=>/^ppt\/theme\/[^/]+\.xml$/.test(name));
 assert.throws(()=>save(original,baseline,{...moved,[theme]:strToU8(strFromU8(baseline[theme]).replace('</a:theme>','<!-- changed linked dependency --></a:theme>'))}),/relationship remapping/);
 const retargeted=save(original,baseline,{...moved,[related]:strToU8(strFromU8(baseline[related]).replace('projected.png','other.png')),'ppt/media/other.png':baseline['ppt/media/projected.png']});
 const saved=unzipSync(retargeted.bytes);
 assert.match(strFromU8(saved[related]),/other\.png/);
 assert.match(strFromU8(saved[part]),/r:embed="nativeImage"/);
 assert.deepEqual(saved['ppt/media/other.png'],baseline['ppt/media/projected.png']);
});
test('geometry preservation cannot absorb text, appearance, rotation or ambiguous shape identities',async()=>{
 const {original,baseline}=await fixture();
 const moved=strFromU8(baseline[part]).replace('x="914499"','x="950499"');
 for(const xml of [moved.replace('Spellbook 검증 العربية','Changed text'),moved.replace('2563EB','AABBCC'),moved.replace('<a:xfrm>','<a:xfrm rot="60000">'),moved.replace('name="Linked picture"','name="TextBox 1"')]){
  assert.notEqual(xml,moved);
  assert.throws(()=>save(original,baseline,{...baseline,[part]:strToU8(xml)}),/relationship remapping/);
 }
});
