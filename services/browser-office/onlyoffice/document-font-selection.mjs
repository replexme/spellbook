/* SPDX-License-Identifier: MPL-2.0 */
// Pinned native font_selection v2 record contract.
// Layout: core/DesktopEditor/fontengine/ApplicationFonts.cpp::ToBuffer.
export function sfntTables(bytes) {
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(b.length<12||![0x00010000,0x4f54544f,0x74727565].includes(view.getUint32(0,false)))throw Error('document_font_sfnt_unsupported');
  const count=view.getUint16(4,false);if(count<1||count>256||12+count*16>b.length)throw Error('document_font_table_directory_invalid');
  const tables=new Map();for(let i=0;i<count;i++){const o=12+i*16,name=String.fromCharCode(...b.subarray(o,o+4)),offset=view.getUint32(o+8,false),length=view.getUint32(o+12,false);if(offset>b.length||length>b.length-offset||tables.has(name))throw Error('document_font_table_bounds_invalid');tables.set(name,new DataView(b.buffer,b.byteOffset+offset,length));}
  return tables;
}
function aliases(tables,family) {
  const names=tables.get('name');if(!names||names.byteLength<6)return[];const count=names.getUint16(2,false),strings=names.getUint16(4,false);if(count>4096||6+count*12>names.byteLength||strings>names.byteLength)throw Error('document_font_names_invalid');const result=new Set();
  for(let i=0;i<count;i++){const o=6+i*12;if(names.getUint16(o,false)!==3||names.getUint16(o+6,false)!==1)continue;const encoding=names.getUint16(o+2,false);if(encoding!==1&&encoding!==10)continue;const length=names.getUint16(o+8,false),start=strings+names.getUint16(o+10,false);if(length>1024||length%2||start>names.byteLength||length>names.byteLength-start)throw Error('document_font_name_bounds_invalid');let s='';for(let p=start;p<start+length;p+=2)s+=String.fromCharCode(names.getUint16(p,false));if(s&&s!==family)result.add(s);}
  return [...result];
}
const join=chunks=>{const out=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let p=0;for(const c of chunks){out.set(c,p);p+=c.length;}return out;};
const integer=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
const string=s=>{const b=new TextEncoder().encode(s);if(!b.length||b.length>4096)throw Error('document_font_selection_string_invalid');return join([integer(b.length),b]);};
export function documentFontSelectionRecord({fontBytes,nativeInfo,sourcePath}) {
  if(!/^\/working\/document-fonts\/[a-f0-9-]+\.(ttf|otf)$/.test(sourcePath))throw Error('document_font_source_path_invalid');
  const tables=sfntTables(fontBytes),os2=tables.get('OS/2'),head=tables.get('head');if(!os2||os2.byteLength<78||!head||head.byteLength<54)throw Error('document_font_metrics_missing');
  const family=nativeInfo.family_name;if(typeof family!=='string'||!family.length||nativeInfo.num_faces!==1||nativeInfo.face_index!==0)throw Error('document_font_native_face_unsupported');
  const units=head.getUint16(18,false);if(units<16||units>16384||nativeInfo.units_per_EM!==units)throw Error('document_font_units_invalid');
  const body=new Uint8Array(76),v=new DataView(body.buffer),style=nativeInfo.style_flags;
  [nativeInfo.face_index,(style&1)?1:0,(style&2)?1:0,(nativeInfo.face_flags&4)?1:0,10].forEach((n,i)=>v.setInt32(i*4,n,true));
  body.set(new Uint8Array(os2.buffer,os2.byteOffset+32,10),20);
  [42,46,50,54,78,82].forEach((o,i)=>v.setUint32(30+i*4,o+4<=os2.byteLength?os2.getUint32(o,false):0,true));
  const metric=(offset,minimumLength=offset+2)=>os2.byteLength>=minimumLength?Math.trunc(os2.getInt16(offset,false)*1000/units):0;
  const values=[os2.getUint16(4,false),os2.getUint16(6,false),os2.getInt16(30,false),tables.has('CFF ')?2:1,metric(2),metric(68),metric(70),metric(72),metric(86),metric(88),os2.getUint16(8,false)];
  values.forEach((n,i)=>{if(i===0||i===1||i===10)v.setUint16(54+i*2,n,true);else{if(n<-32768||n>32767)throw Error('document_font_normalized_metric_invalid');v.setInt16(54+i*2,n,true);}});
  const alternativeNames=aliases(tables,family);const record=join([integer(0),string(family),integer(alternativeNames.length),...alternativeNames.map(string),string(sourcePath),body]);new DataView(record.buffer).setUint32(0,record.length,true);
  return {record,body,family,aliases:alternativeNames,values};
}
