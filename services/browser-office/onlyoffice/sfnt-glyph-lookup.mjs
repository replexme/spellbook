/* SPDX-License-Identifier: MPL-2.0 */
import { sfntTables } from './document-font-selection.mjs';

// Resolve actual glyph IDs rather than assuming that a cmap range has ink.
// The same bounded SFNT directory reader also validates document font records.
export function createSfntGlyphLookup(bytes, readTables = sfntTables) {
  const cmap = readTables(bytes).get('cmap'), maps = [];
  if (!cmap || cmap.byteLength < 4) throw Error('vector_font_cmap_missing');
  const count = cmap.getUint16(2, false);
  if (count > 256 || 4 + 8 * count > cmap.byteLength) throw Error('vector_font_cmap_invalid');
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const platform = cmap.getUint16(4 + 8 * i, false), encoding = cmap.getUint16(6 + 8 * i, false);
    if (platform !== 0 && !(platform === 3 && [0, 1, 10].includes(encoding))) continue;
    const offset = cmap.getUint32(8 + 8 * i, false);
    if (seen.has(offset)) continue;
    seen.add(offset);
    if (offset + 2 > cmap.byteLength) throw Error('vector_font_cmap_offset_invalid');
    const format = cmap.getUint16(offset, false);
    const minimum = {0:262, 4:16, 6:10, 12:16, 13:16}[format];
    if (!minimum) continue;
    if (offset + minimum > cmap.byteLength) throw Error('vector_font_cmap_truncated');
    const length = format >= 12 ? cmap.getUint32(offset + 4, false) : cmap.getUint16(offset + 2, false);
    if (length < minimum || length > cmap.byteLength - offset) throw Error('vector_font_cmap_length_invalid');
    const view = new DataView(cmap.buffer, cmap.byteOffset + offset, length);
    if (format === 4) {
      const twice = view.getUint16(6, false), n = twice / 2;
      if (twice % 2 || n < 1 || 16 + 8 * n > length) throw Error('vector_font_cmap4_invalid');
      const ends = 14, starts = ends + 2 * n + 2, deltas = starts + 2 * n, offsets = deltas + 2 * n;
      for (let j=0;j<n;j++) if (view.getUint16(starts+2*j,false)>view.getUint16(ends+2*j,false) || j && view.getUint16(ends+2*j,false)<=view.getUint16(ends+2*(j-1),false)) throw Error('vector_font_cmap4_segments_invalid');
      maps.push(code => {
        if (code > 0xffff) return 0;
        for (let j=0;j<n;j++) {
          if (code > view.getUint16(ends+2*j,false)) continue;
          const start=view.getUint16(starts+2*j,false); if (code < start) return 0;
          const delta=view.getInt16(deltas+2*j,false), distance=view.getUint16(offsets+2*j,false);
          if (!distance) return (code+delta)&0xffff;
          const location=offsets+2*j+distance+2*(code-start);
          if (location+2>length) throw Error('vector_font_cmap4_glyph_invalid');
          const glyph=view.getUint16(location,false); return glyph ? (glyph+delta)&0xffff : 0;
        }
        return 0;
      });
    } else if (format === 12 || format === 13) {
      const n=view.getUint32(12,false);
      if (n>1_000_000 || 16+12*n>length) throw Error('vector_font_cmap12_invalid');
      for(let j=0;j<n;j++) if(view.getUint32(16+12*j,false)>view.getUint32(20+12*j,false) || view.getUint32(20+12*j,false)>0x10ffff || j&&view.getUint32(16+12*j,false)<=view.getUint32(20+12*(j-1),false)) throw Error('vector_font_cmap12_groups_invalid');
      maps.push(code=>{
        let lo=0,hi=n-1;
        while(lo<=hi){const j=(lo+hi)>>>1,start=view.getUint32(16+12*j,false),end=view.getUint32(20+12*j,false);if(code<start)hi=j-1;else if(code>end)lo=j+1;else return view.getUint32(24+12*j,false)+(format===12?code-start:0);}
        return 0;
      });
    } else if (format === 6) {
      const start=view.getUint16(6,false),n=view.getUint16(8,false);
      if(10+2*n>length)throw Error('vector_font_cmap6_invalid');
      maps.push(code=>code>=start&&code<start+n?view.getUint16(10+2*(code-start),false):0);
    } else maps.push(code=>code<256?view.getUint8(6+code):0);
  }
  if (!maps.length) throw Error('vector_font_cmap_unsupported');
  return code => Number.isInteger(code) && code >= 0 && code <= 0x10ffff && maps.some(map => map(code) !== 0);
}
