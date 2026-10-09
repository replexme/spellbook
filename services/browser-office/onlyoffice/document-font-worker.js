/* Document-scoped worker using the unmodified admitted ONLYOFFICE FreeType engine.
 * Face-info ABI fields follow sdkjs/common/libfont/engine.js, CFaceInfo.load.
 * The native engine and its original AGPL notices remain unchanged. */
self.window=self;
self.document={currentScript:{src:new URL('/sdkjs/common/libfont/engine/fonts.js',self.location.href).href}};
let ready=false;
self.AscFonts={onLoadModule(){if(!ready&&AscFonts.FT_GetFaceInfo){ready=true;self.postMessage({ready:true});}}};
importScripts('/sdkjs/common/libfont/engine/fonts.js');
self.onmessage=async ({data})=>{
  let library=0,buffer,face=0,errorObject;const started=performance.now();
  try {
    const [{default:createDecoder},{sfntContainsHangul}]=await Promise.all([import('/eot/eot-decoder.mjs'),import('/document-font-coverage.mjs')]);
    const decoder=await createDecoder({print:()=>{},printErr:()=>{}});let input=0,slots=0,output=0,bytes;
    try{const raw=new Uint8Array(data.bytes);if(raw.length<36||raw.length>32*1024*1024)throw Error('embedded_font_input_size_invalid');input=decoder._malloc(raw.length);slots=decoder._malloc(8);if(!input||!slots)throw Error('embedded_font_allocation_failed');decoder.HEAPU8.set(raw,input);decoder.HEAPU32.fill(0,slots>>>2,(slots>>>2)+2);const code=decoder._sb_decode_eot(input,raw.length,slots,slots+4);output=decoder.HEAPU32[slots>>>2];const size=decoder.HEAPU32[(slots+4)>>>2];if(code!==0||!output||size<12||size>32*1024*1024||output+size>decoder.HEAPU8.length)throw Error('embedded_font_decode_failed');bytes=decoder.HEAPU8.slice(output,output+size);}finally{if(output)decoder._sb_free(output);if(input)decoder._free(input);if(slots)decoder._free(slots);}
    if(data.requiresHangul&&!sfntContainsHangul(bytes)){self.postMessage({skipped:'embedded_font_hangul_coverage_missing'});return;}

    if(bytes.length<12||bytes.length>32*1024*1024)throw Error('native_face_size_invalid');
    library=AscFonts.FT_CreateLibrary();if(!library)throw Error('native_font_library_failed');
    buffer=AscFonts.AllocString(bytes.length);if(!buffer.pointer)throw Error('native_font_allocation_failed');buffer.getBuffer().set(bytes);
    face=AscFonts.FT_Open_Face(library,buffer.pointer,bytes.length,0);if(!face)throw Error('native_face_open_failed');
    let view,offset=0;
    const reader={init(bytes){view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);offset=0;}};
    const integer=(unsigned=false)=>{if(offset+4>view.byteLength)throw Error('native_face_info_truncated');const value=unsigned?view.getUint32(offset,true):view.getInt32(offset,true);offset+=4;return value;};
    const string=()=>{let text='';for(let n=0;n<230;n++){const code=integer();if(!code)return text;if(code<0||code>0x10ffff)throw Error('native_face_info_invalid_string');text+=String.fromCodePoint(code);}throw Error('native_face_info_string_too_long');};
    errorObject=AscFonts.FT_GetFaceInfo(face,reader);if(errorObject.error)throw Error('native_face_info_failed');
    const info={};
    for(const key of ['units_per_EM','ascender','descender','height','face_flags','num_faces','num_glyphs','num_charmaps','style_flags','face_index'])info[key]=integer(key==='units_per_EM');
    info.family_name=string();info.style_name=string();
    for(const key of ['os2_version','os2_usWeightClass','os2_fsSelection','os2_usWinAscent','os2_usWinDescent','os2_usDefaultChar','os2_sTypoAscender','os2_sTypoDescender','os2_sTypoLineGap','os2_ulUnicodeRange1','os2_ulUnicodeRange2','os2_ulUnicodeRange3','os2_ulUnicodeRange4','os2_ulCodePageRange1','os2_ulCodePageRange2','os2_nSymbolic','header_yMin','header_yMax'])info[key]=integer(key.includes('ulUnicode')||key.includes('ulCodePage'));
    const count=integer();if(count<0||count>64)throw Error('native_face_info_sizes_invalid');info.monochromeSizes=Array.from({length:count},()=>integer());
    self.postMessage({loaded:true,info,bytes:bytes.buffer,elapsedMs:performance.now()-started},[bytes.buffer]);
  } catch(e) {self.postMessage({error:String(e.message??e),elapsedMs:performance.now()-started});}
  finally {if(errorObject&&!errorObject.error)errorObject.free();if(face)AscFonts.FT_Done_Face(face);buffer?.free();if(library)AscFonts.FT_Done_Library(library);}
};
