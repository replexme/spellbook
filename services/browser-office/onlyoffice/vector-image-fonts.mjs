/* SPDX-License-Identifier: MPL-2.0 */
import { createSfntGlyphLookup } from './sfnt-glyph-lookup.mjs';
import { sfntTables } from './document-font-selection.mjs';
import {createOnlyOfficeVectorGlyphOutliner} from './vector-glyph-outlines.mjs';
import {prepareOnlyOfficeNativeMetafile} from './native-metafile-images.mjs';

// This changes only the decoded display image. The native RasterImageId and
// source SVG/WMF/EMF bytes remain the authority for history and PPTX export.
export async function bindOnlyOfficeSvgFonts(source, {catalog, readFace, pickFont, glyphs, outlineGlyph}) {
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
  const ns = 'http://www.w3.org/2000/svg';
  if (xml.getElementsByTagName('parsererror').length || xml.documentElement.namespaceURI !== ns || xml.documentElement.localName !== 'svg') throw Error('onlyoffice_vector_svg_invalid');
  const elements = [...xml.querySelectorAll('text,tspan,textPath')];
  if (!elements.length) return {source, fonts:[], mappedGlyphs:0};
  const normalize = name => name.trim().toLowerCase();
  const infos = new Map(catalog.__fonts_infos.map(row => [normalize(row[0]), row]));
  const tables = new Map();
  for (const glyph of glyphs) {
    const family=glyph.family.toLowerCase().replaceAll(' ', '');
    if (!tables.has(family)) tables.set(family,new Map());
    tables.get(family).set(glyph.code,glyph.targetCodePoint);
  }
  const inherit=(element,name)=>{
    for(let node=element;node?.nodeType===1;node=node.parentNode){const value=node.style?.getPropertyValue(name)||node.getAttribute(name);if(value&&value!=='inherit')return value;}
    return null;
  };
  const originalStyles=new Map(elements.map(element=>[element,Object.fromEntries(['font-family','font-style','font-weight','font-size'].map(name=>[name,inherit(element,name)]))]));
  const faces = new Map(), usedFaces = new Set(), embeddedFaces=new Set(),outlinePaths=new Map(),outlineDefs=xml.createElementNS(ns,'defs'); let mappedGlyphs=0,outlinedGlyphs=0;
  const faceFor = async (row,style) => {
    const bold=Boolean(style&1),italic=Boolean(style&2),slots=bold&&italic?[7,5,3,1]:bold?[5,1,7,3]:italic?[3,1,7,5]:[1,3,5,7];
    const slot=slots.find(index=>row[index]>=0);
    if (!slot || row[slot+1]!==0) throw Error('onlyoffice_vector_font_face_unsupported');
    const key=row[slot]+':'+slot;
    if(!faces.has(key)) faces.set(key,(async()=>{
      const face=await readFace(row[slot]);
      return {bytes:face.bytes,sha256:face.sha256,covers:face.covers,get base64(){return face.base64;},alias:'SpellbookVectorFont'+faces.size,family:row[0],style:slot===3||slot===7?'italic':'normal',weight:slot===5||slot===7?'bold':'normal'};
    })());
    return faces.get(key);
  };
  for (const element of elements) {
    const textNodes=[...element.childNodes].filter(node=>node.nodeType===3||node.nodeType===4);
    if(!textNodes.some(node=>node.textContent.length))continue;
    const original=originalStyles.get(element),family=original['font-family'];
    // Converter vectors name their font explicitly. Do not silently resolve
    // a stylesheet-only family using the machine's browser default font.
    if(!family)throw Error('onlyoffice_vector_font_family_missing');
    const names=family.match(/'[^']*'|"[^"]*"|[^,]+/g)?.map(name=>name.trim().replace(/^['"]|['"]$/g,''))??[];
    const first=names[0],legacy=tables.get(first?.toLowerCase().replaceAll(' ',''));
    const weight=original['font-weight']??'normal',italic=/^(italic|oblique)/.test(original['font-style']??'normal');
    const style=(weight==='bold'||weight==='bolder'||Number(weight)>=600?1:0)|(italic?2:0);
    let row=infos.get(normalize(first??''));
    if(legacy&&!row){
      row=infos.get('spellbook symbols');if(!row)throw Error('onlyoffice_vector_symbol_font_missing');
      for(const node of textNodes)node.textContent=[...node.textContent].map(character=>{
        const point=character.codePointAt(0),code=point>=0xf020&&point<=0xf0ff?point-0xf000:point;
        if(code===32||/^[\r\n\t]$/.test(character))return character;
        const target=legacy.get(code);if(!target)throw Error('onlyoffice_vector_legacy_glyph_unreviewed');
        mappedGlyphs++;return String.fromCodePoint(target);
      }).join('');
    }else row??=names.map(name=>infos.get(normalize(name))).find(Boolean)??infos.get(normalize(pickFont(first,style)??''));
    if(!row)throw Error('onlyoffice_vector_font_selection_missing');
    const primary=await faceFor(row,style),selected=[primary];
    const codes=[...new Set(textNodes.flatMap(node=>[...node.textContent].map(character=>character.codePointAt(0))))];
    for(const code of codes){
      if([9,10,13].includes(code)||code===0x200c||code===0x200d||code>=0xfe00&&code<=0xfe0f)continue;
      if(selected.some(face=>face.covers(code)))continue;
      if(legacy&&row===infos.get(normalize(first??''))&&code<=0xff&&primary.covers(code+0xf000)){
        for(const node of textNodes)node.textContent=[...node.textContent].map(character=>character.codePointAt(0)===code?String.fromCodePoint(code+0xf000):character).join('');
        continue;
      }
      // Use the native program's Unicode-family table, then other admitted
      // faces. Coverage is checked before embedding, so OS fallback cannot
      // supply an unowned glyph. Missing coverage is an explicit failure.
      const ranges=catalog.__fonts_ranges??[];let preferred;
      for(let i=0;i+2<ranges.length;i+=3)if(code>=ranges[i]&&code<=ranges[i+1]){preferred=catalog.__fonts_infos[ranges[i+2]];break;}
      let found;
      for(const fallback of [...new Set([preferred,...catalog.__fonts_infos].filter(Boolean))]){
        const face=await faceFor(fallback,style);if(face.covers(code)){found=face;break;}
      }
      if(!found)throw Error('onlyoffice_vector_glyph_coverage_missing');
      if(!selected.includes(found))selected.push(found);
    }
    const aliases=selected.map(face=>'"'+face.alias+'"').join(',');
    for(const face of selected)usedFaces.add(face);
    // Native metafile vectors already carry one absolute position per ASCII
    // glyph. Outline those exact placements; complex/implicit text keeps its
    // browser shaping, bound to the same private/public font bytes instead.
    const characters=[...textNodes.map(node=>node.textContent).join('')];
    const numbers=name=>{const value=element.getAttribute(name);return value?.trim()?value.trim().split(/[\s,]+/).map(Number):[];};
    const xs=numbers('x'),ys=numbers('y'),size=Number(original['font-size']);
    const canOutline=outlineGlyph&&element.localName==='text'&&!element.children.length&&!xml.querySelector('style')&&
      xs.length===characters.length&&(ys.length===1||ys.length===characters.length)&&xs.every(Number.isFinite)&&ys.every(Number.isFinite)&&Number.isFinite(size)&&size>0&&
      ['dx','dy','rotate','textLength','lengthAdjust'].every(name=>!element.hasAttribute(name))&&
      ['text-anchor','direction','writing-mode','dominant-baseline','alignment-baseline'].every(name=>!inherit(element,name)||['start','ltr','horizontal-tb','auto','alphabetic'].includes(inherit(element,name)))&&
      characters.every(character=>{const code=character.codePointAt(0);return code>=32&&code<=126||code>=0xe600&&code<=0xe608||Boolean(legacy)&&code>=0xf020&&code<=0xf0ff;})&&
      selected.every(face=>face.style===(italic?'italic':'normal')&&face.weight===((style&1)?'bold':'normal'));
    if(canOutline){
      const group=xml.createElementNS(ns,'g');for(const attribute of element.attributes)group.setAttributeNS(attribute.namespaceURI,attribute.name,attribute.value);
      for(const [index,character] of characters.entries()){
        const code=character.codePointAt(0),face=selected.find(item=>item.covers(code));
        const outline=outlineGlyph(face,code);if(!outline?.path&&code!==32)throw Error('onlyoffice_vector_outline_empty');
        if(outline.path){
          const key=face.sha256+':'+code;let id=outlinePaths.get(key);
          if(!id){let serial=outlinePaths.size;do{id='SpellbookVectorGlyph'+serial++;}while(xml.querySelector('[id="'+id+'"]'));const path=xml.createElementNS(ns,'path');path.setAttribute('id',id);path.setAttribute('d',outline.path);outlineDefs.appendChild(path);outlinePaths.set(key,id);}
          const use=xml.createElementNS(ns,'use');use.setAttribute('href','#'+id);const scale=size/outline.units;use.setAttribute('transform',`translate(${xs[index]} ${ys.length===1?ys[0]:ys[index]}) scale(${scale} ${-scale})`);group.appendChild(use);
        }
        outlinedGlyphs++;
      }
      element.replaceWith(group);continue;
    }
    for(const face of selected)embeddedFaces.add(face);
    element.setAttribute('font-family',aliases);
    element.style.setProperty('font-family',aliases,'important');
  }
  const used=[...usedFaces],embedded=[...embeddedFaces];
  if(embedded.reduce((total,face)=>total+face.bytes.length,0)>48*1024*1024)throw Error('onlyoffice_vector_font_budget_exceeded');
  const defs=xml.createElementNS(ns,'defs'),style=xml.createElementNS(ns,'style');
  if(embedded.length){style.textContent=embedded.map(face=>`@font-face{font-family:"${face.alias}";font-style:${face.style};font-weight:${face.weight};src:url("data:font/ttf;base64,${face.base64}");}`).join('\n');defs.appendChild(style);xml.documentElement.insertBefore(defs,xml.documentElement.firstChild);}
  if(outlinePaths.size)xml.documentElement.insertBefore(outlineDefs,xml.documentElement.firstChild);
  return {source:new XMLSerializer().serializeToString(xml),mappedGlyphs,outlinedGlyphs,fonts:used.map(face=>({family:face.family,sha256:face.sha256,bytes:face.bytes.length,style:face.style,weight:face.weight,embedded:embeddedFaces.has(face)}))};
}

export function installOnlyOfficeVectorImageFonts(glyphs,bindSvg=bindOnlyOfficeSvgFonts,glyphLookup=createSfntGlyphLookup,readTables=sfntTables,createOutliner=createOnlyOfficeVectorGlyphOutliner,prepareMetafile=prepareOnlyOfficeNativeMetafile) {
  const key=Symbol.for('spellbook.onlyoffice.vectorImageFonts/v1');
  if(window[key])return;
  const loader=window.AscCommon?.g_image_loader,native=loader?.loadImageByUrl;
  if(typeof native!=='function')throw Error('onlyoffice_vector_image_loader_unavailable');
  const privateContext=window.parent[Symbol.for('spellbook.onlyoffice.documentFonts/v1')];
  const catalog=window[Symbol.for('spellbook.onlyoffice.fontCatalog/v1')],cache=new Map(),fontCache=new Map(),urls=new Set(),controller=new AbortController();
  if(!catalog)throw Error('onlyoffice_vector_font_catalog_unavailable');
  let disposed=false,offDispose;
  const report={images:[],errors:[]};
  const outliner=createOutliner(readTables);
  const active=()=>{if(disposed)throw Error('onlyoffice_vector_context_closed');};
  const base64=bytes=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);};
  const readFace=index=>{
    if(!fontCache.has(index))fontCache.set(index,(async()=>{
      const file=catalog.__fonts_files?.[index];
      if(typeof file!=='string'||!/^[-a-zA-Z0-9_.]+\.(ttf|otf)$/.test(file))throw Error('onlyoffice_vector_font_file_invalid');
      const pathname='/fonts/'+file,privateAsset=privateContext?.assets[pathname];
      let bytes=privateAsset?.bytes;
      if(!bytes){const response=await fetch(pathname,{signal:controller.signal});if(!response.ok)throw Error('onlyoffice_vector_font_load_failed');bytes=new Uint8Array(await response.arrayBuffer());}
      active();if(bytes.length<12||bytes.length>32*1024*1024)throw Error('onlyoffice_vector_font_size_invalid');
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');active();
      let encoded;return {bytes,sha256:digest,get base64(){return encoded??=base64(bytes);},covers:glyphLookup(bytes,readTables)};
    })());
    return fontCache.get(index);
  };
  const prepare=url=>{
    if(!cache.has(url))cache.set(url,(async()=>{
      const response=await fetch(url,{signal:controller.signal});
      const blob=await response.blob();active();
      if(!blob.type.toLowerCase().includes('image/svg+xml'))return url;
      if(blob.size>8*1024*1024)throw Error('onlyoffice_vector_svg_size_invalid');
      const metafile=await prepareMetafile(url,{ownedUrls:window.AscCommon.g_oDocumentUrls?.urls,origin:location.origin,signal:controller.signal});active();
      const source=metafile?.source??await blob.text();active();
      const bound=await bindSvg(source,{catalog,readFace,glyphs,outlineGlyph:outliner.glyph,pickFont:(name,style)=>AscFonts.g_fontApplication.GetFontInfo(name,style)?.Name});
      active();if(!bound.fonts.length&&!metafile)return url;
      const prepared=URL.createObjectURL(new Blob([bound.source],{type:'image/svg+xml'}));urls.add(prepared);
      const nativeMetafile=metafile?{sourceName:metafile.sourceName,sourceSha256:metafile.sourceSha256,sourceBytes:metafile.sourceBytes}:undefined;
      report.images.push({mappedGlyphs:bound.mappedGlyphs,outlinedGlyphs:bound.outlinedGlyphs,fonts:bound.fonts,sourceBytes:blob.size,displayBytes:new Blob([bound.source]).size,...(nativeMetafile?{nativeMetafile}:{})});
      return prepared;
    })());
    return cache.get(url);
  };
  const wrapped=function(image,url,disableCrypto){
    if(disposed||this.isBlockchainSupport&&disableCrypto!==true||typeof url!=='string'||urls.has(url)||!url.startsWith('blob:'+location.origin+'/')&&!/^data:image\/svg\+xml[;,]/i.test(url))return native.apply(this,arguments);
    prepare(url).then(prepared=>{active();native.call(this,image,prepared,disableCrypto);}).catch(error=>{
      if(disposed)return;
      report.errors.push({code:String(error.message??error)});
      const errors=window.Asc?.c_oAscError;
      if(errors)loader.Api?.sendEvent?.('asc_onError',errors.ID.Unknown,errors.Level.Critical);
      // Use the existing image error lifecycle, but never display its raw SVG
      // using unowned system fonts after a preparation failure.
      native.call(this,image,'data:image/png;base64,',disableCrypto);
    });
  };
  const dispose=()=>{if(disposed)return;disposed=true;controller.abort();offDispose?.();outliner.dispose();for(const url of urls)URL.revokeObjectURL(url);urls.clear();cache.clear();fontCache.clear();if(loader.loadImageByUrl===wrapped)loader.loadImageByUrl=native;if(window[key]?.dispose===dispose)delete window[key];};
  loader.loadImageByUrl=wrapped;window[key]={report,dispose};
  offDispose=privateContext?.onDispose?.(dispose);window.addEventListener('pagehide',dispose,{once:true});
}
