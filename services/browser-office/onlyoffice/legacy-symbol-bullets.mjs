/* SPDX-License-Identifier: MPL-2.0 */

// Get_PresentationBullet returns a derived drawing object, not the authored CBullet.
export function installOnlyOfficeLegacySymbolBullets(glyphs) {
  const key = Symbol.for('spellbook.onlyoffice.legacySymbolBullets/v1');
  if (window[key]) return;
  const prototype = window.AscCommonWord?.CParaPr?.prototype;
  const original = prototype?.Get_PresentationBullet;
  if (typeof original !== 'function') throw Error('onlyoffice_legacy_symbol_boundary_missing');
  const tables = Object.create(null);
  for (const glyph of glyphs) (tables[glyph.family] ??= Object.create(null))[glyph.code] = glyph.targetCodePoint;
  const normalize = name => name.toLowerCase().replaceAll(' ', '');
  prototype.Get_PresentationBullet = function (...args) {
    const bullet = original.apply(this, args);
    if (!bullet || bullet.m_nType !== AscFormat.numbering_presentationnumfrmt_Char ||
        bullet.m_bFontTx !== false || typeof bullet.m_sFont !== 'string' ||
        typeof bullet.m_sChar !== 'string' || [...bullet.m_sChar].length !== 1) return bullet;
    const family = normalize(bullet.m_sFont), table = tables[family];
    if (!table) return bullet;
    const catalog = window[Symbol.for('spellbook.onlyoffice.documentFonts/v1')]?.catalog ?? window;
    const names = [...(catalog.__fonts_infos ?? []).map(row => row[0]),
      ...(AscFonts.g_font_infos ?? []).map(font => font.Name)];
    const families = new Set(names.filter(name => typeof name === 'string').map(normalize));
    if (families.has(family) || !families.has('spellbooksymbols')) return bullet;
    const point = bullet.m_sChar.codePointAt(0);
    const code = point >= 0xf020 && point <= 0xf0ff ? point - 0xf000 : point;
    const target = table[code];
    if (!target) return bullet;
    bullet.m_sChar = String.fromCodePoint(target);
    bullet.m_sFont = 'Spellbook Symbols';
    return bullet;
  };
  window[key] = true;
}
