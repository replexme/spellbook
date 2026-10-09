/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';import test from 'node:test';
import {installOnlyOfficeLegacySymbolBullets} from './legacy-symbol-bullets.mjs';
import recipe from './symbol-font/font-recipe.json' with {type:'json'};

function setup(authored,{originalFont=false,programFont=true,embeddedOriginal=false}={}) {
  const old={window:globalThis.window,AscFonts:globalThis.AscFonts,AscFormat:globalThis.AscFormat};
  class Para{Get_PresentationBullet(){return {...authored};}}
  globalThis.window={AscCommonWord:{CParaPr:Para},__fonts_infos:programFont?[[recipe.family]]:[]};
  globalThis.AscFonts={g_font_infos:originalFont?[{Name:authored.m_sFont}]:[]};
  globalThis.AscFormat={numbering_presentationnumfrmt_Char:1};
  if(embeddedOriginal)window[Symbol.for('spellbook.onlyoffice.documentFonts/v1')]={catalog:{__fonts_infos:[[authored.m_sFont],[recipe.family]]}};
  installOnlyOfficeLegacySymbolBullets(recipe.glyphs);
  return {derive:()=>new Para().Get_PresentationBullet(),close(){for(const [name,value] of Object.entries(old)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}};
}
test('qualified ASCII and legacy PUA bullets derive compatible glyphs without changing authored properties',()=>{
  for(const glyph of recipe.glyphs)for(const cp of [glyph.code,0xf000+glyph.code]){
    const authored={m_nType:1,m_bFontTx:false,m_sFont:glyph.family.replace('2',' 2').replace('3',' 3'),m_sChar:String.fromCodePoint(cp),m_dSize:0.75,m_bSizePct:true,m_bSizeTx:false};
    const before={...authored},session=setup(authored);
    try{const result=session.derive();assert.notEqual(result,authored);assert.equal(result.m_sFont,recipe.family);assert.equal(result.m_sChar,String.fromCodePoint(glyph.targetCodePoint));assert.equal(result.m_dSize,before.m_dSize);assert.deepEqual(authored,before);}finally{session.close();}
  }
});
test('available public or document fonts retain priority, and absent program font fails closed',()=>{
  const authored={m_nType:1,m_bFontTx:false,m_sFont:'Wingdings',m_sChar:'l'};
  for(const options of [{originalFont:true},{embeddedOriginal:true},{programFont:false}]){
    const session=setup(authored,options);try{assert.deepEqual(session.derive(),authored);}finally{session.close();}
  }
});
test('multi-character, unreviewed, inherited and other-family bullets remain exact',()=>{
  const base={m_nType:1,m_bFontTx:false,m_sFont:'Wingdings',m_sChar:'l'};
  for(const change of [{m_sChar:'ll'},{m_sChar:'x'},{m_bFontTx:true},{m_sFont:'Arial'},{m_nType:2},{m_sChar:''}]){
    const authored={...base,...change},session=setup(authored);try{assert.deepEqual(session.derive(),authored);}finally{session.close();}
  }
});
