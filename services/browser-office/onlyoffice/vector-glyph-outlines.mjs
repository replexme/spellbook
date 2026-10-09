/* SPDX-License-Identifier: MPL-2.0 */
import {sfntTables} from './document-font-selection.mjs';

// Use the already admitted native FreeType WASM. A separate library owns these
// faces, so neither editor measurement nor its active font state is changed.
export function createOnlyOfficeVectorGlyphOutliner(readTables=sfntTables) {
  const fonts=new Map();let library=0,disposed=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;
    for(const font of fonts.values()){AscFonts.FT_Done_Face(font.face);font.buffer.free();font.paths.clear();}
    fonts.clear();if(library)AscFonts.FT_Done_Library(library);library=0;
  };
  const glyph=(font,code)=>{
    if(disposed)throw Error('onlyoffice_vector_outline_context_closed');
    let entry=fonts.get(font.sha256);
    if(!entry){
      const head=readTables(font.bytes).get('head'),units=head?.byteLength>=20?head.getUint16(18,false):0;
      if(units<16||units>16384)throw Error('onlyoffice_vector_outline_units_invalid');
      library||=AscFonts.FT_CreateLibrary();if(!library)throw Error('onlyoffice_vector_outline_library_failed');
      const buffer=AscFonts.AllocString(font.bytes.length);let face;
      try{buffer.getBuffer().set(font.bytes);face=AscFonts.FT_Open_Face(library,{data:buffer.pointer,len:font.bytes.length},0);if(!face)throw Error('onlyoffice_vector_outline_face_failed');}
      catch(error){buffer.free();throw error;}
      entry={face,buffer,units,paths:new Map()};fonts.set(font.sha256,entry);
    }
    if(!entry.paths.has(code)){
      const gid=AscFonts.FT_SetCMapForCharCode(entry.face,code),mode=AscFonts.FT_Load_Mode;
      if(!gid||AscFonts.FT_Load_Glyph(entry.face,gid,mode.FT_LOAD_NO_SCALE|mode.FT_LOAD_NO_HINTING|mode.FT_LOAD_NO_BITMAP))throw Error('onlyoffice_vector_outline_glyph_failed');
      const commands=[];let contour=false;
      const close=()=>{if(contour){commands.push('Z');contour=false;}};
      const command=(name,...points)=>{if(points.some(point=>!Number.isFinite(point)))throw Error('onlyoffice_vector_outline_coordinate_invalid');commands.push(name+points.join(' '));};
      const painter={start(){},end:close,
        _move_to(x,y){close();command('M',x,y);contour=true;},
        _line_to(x,y){command('L',x,y);},
        _conic_to(cx,cy,x,y){command('Q',cx,cy,x,y);},
        _cubic_to(ax,ay,bx,by,x,y){command('C',ax,ay,bx,by,x,y);}};
      if(!AscFonts.FT_Glyph_Get_Measure(entry.face,commands,painter))throw Error('onlyoffice_vector_outline_measure_failed');
      entry.paths.set(code,commands.join(' '));
    }
    return {path:entry.paths.get(code),units:entry.units};
  };
  return {glyph,dispose};
}
