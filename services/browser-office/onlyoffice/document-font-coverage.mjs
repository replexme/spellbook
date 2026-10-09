/* SPDX-License-Identifier: MPL-2.0 */
import {sfntTables} from './document-font-selection.mjs';
const overlaps = (start,end) => start<=end&&[[0x1100,0x11ff],[0x3130,0x318f],[0xa960,0xa97f],[0xac00,0xd7af],[0xd7b0,0xd7ff]].some(([a,b])=>start<=b&&end>=a);
export function sfntContainsHangul(fontBytes){
  const cmap=sfntTables(fontBytes).get('cmap');if(!cmap||cmap.byteLength<4)return false;
  const count=cmap.getUint16(2,false);if(count>256||4+8*count>cmap.byteLength)throw Error('document_font_cmap_directory_invalid');
  for(let i=0;i<count;i++){const off=cmap.getUint32(8+i*8,false);if(off+2>cmap.byteLength)throw Error('document_font_cmap_offset_invalid');const format=cmap.getUint16(off,false);
    if(format===4){if(off+14>cmap.byteLength)throw Error('document_font_cmap4_invalid');const length=cmap.getUint16(off+2,false),x2=cmap.getUint16(off+6,false),n=x2/2;if(x2%2||length<16+8*n||off+length>cmap.byteLength)throw Error('document_font_cmap4_invalid');const ends=off+14,starts=ends+2*n+2;for(let j=0;j<n;j++)if(overlaps(cmap.getUint16(starts+2*j,false),cmap.getUint16(ends+2*j,false)))return true;
    }else if(format===12||format===13){if(off+16>cmap.byteLength)throw Error('document_font_cmap12_invalid');const length=cmap.getUint32(off+4,false),n=cmap.getUint32(off+12,false);if(n>1_000_000||length<16+12*n||off+length>cmap.byteLength)throw Error('document_font_cmap12_invalid');for(let j=0;j<n;j++)if(overlaps(cmap.getUint32(off+16+12*j,false),cmap.getUint32(off+20+12*j,false)))return true;}
  }return false;
}
