/* SPDX-License-Identifier: MPL-2.0 */
import {documentFontSelectionRecord} from './document-font-selection.mjs';
const key=Symbol.for('spellbook.onlyoffice.documentFonts/v1');
const encode=bytes=>{let s='';for(let p=0;p<bytes.length;p+=8192)s+=String.fromCharCode(...bytes.subarray(p,p+8192));return btoa(s);};
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const integer=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
const join=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;};
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const script=catalog=>Object.entries(catalog).map(([name,value])=>`window[${JSON.stringify(name)}] = ${JSON.stringify(value)};`).join('\n');
export function readPublicFontCatalog(source){
  const catalog={};for(const name of ['__all_fonts_js_version__','__fonts_files','__fonts_infos','__fonts_ranges','g_fonts_selection_bin']){
    const match=source.match(new RegExp('window\\["'+name+'"\\]\\s*=\\s*([\\s\\S]*?);'));
    if(!match)throw Error('document_font_public_catalog_missing');catalog[name]=JSON.parse(match[1]);
  }
  if(catalog.__all_fonts_js_version__!==2||!Array.isArray(catalog.__fonts_files)||!Array.isArray(catalog.__fonts_infos)||!Array.isArray(catalog.__fonts_ranges)||typeof catalog.g_fonts_selection_bin!=='string')throw Error('document_font_public_catalog_invalid');return catalog;
}
function runWorker(url,data,{ready=false,timeoutMs=20000,processingMs=5000,workers,signal}={}){
  if(signal?.aborted)return Promise.reject(Error('document_font_context_closed'));
  return new Promise((resolve,reject)=>{const worker=new Worker(url,url==='/comparison-repair.js'?{type:'module'}:undefined);workers?.add(worker);let timer;
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();workers?.delete(worker);error?reject(error):resolve(value);};
    const abort=()=>finish(Error('document_font_context_closed'));signal?.addEventListener('abort',abort,{once:true});
    const startTimer=duration=>{clearTimeout(timer);timer=setTimeout(()=>finish(Error('document_font_worker_timeout')),duration);};
    const send=()=>{const transfer=data.bytes?[data.bytes]:[];worker.postMessage(data,transfer);startTimer(processingMs);};
    worker.onerror=()=>finish(Error('document_font_worker_failed'));
    worker.onmessage=({data:reply})=>{if(ready&&reply.ready){send();return;}if(reply.error)finish(Error(reply.error));else finish(null,reply);};
    startTimer(timeoutMs);if(!ready)send();
  });
}
export async function prepareOnlyOfficeDocumentFonts(buffer){
  window[key]?.dispose();
  const workers=new Set(),controller=new AbortController(),assets=Object.create(null),report={admitted:[],skipped:[]};let wrapper,disposed=false;
  const context={catalog:null,assets,report,dispose(){if(disposed)return;disposed=true;controller.abort();for(const worker of workers)worker.terminate();workers.clear();for(const asset of Object.values(assets))asset.bytes?.fill(0);for(const name of Object.keys(assets))delete assets[name];context.catalog=null;if(window.Worker===wrapper)window.Worker=NativeWorker;if(window[key]===context)delete window[key];}};
  const active=()=>{if(disposed||window[key]!==context)throw Error('document_font_context_closed');};
  const NativeWorker=window.Worker;window[key]=context;
  window.addEventListener('pagehide',()=>context.dispose(),{once:true});
  if(!buffer)return context;
  const bytes=buffer instanceof ArrayBuffer?new Uint8Array(buffer):ArrayBuffer.isView(buffer)?new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength):null;
  if(!bytes||bytes.length>64*1024*1024)throw Error('document_font_source_size_invalid');
  // The package reader is shared with saved-artifact preservation. Only ZIP
  // presentations can carry this font contract; native binary inputs stay native.
  if(bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b)return context;
  const started=performance.now(),inspected=await runWorker('/comparison-repair.js',{requestId:1,operation:'embedded-fonts',bytes:bytes.slice().buffer},{workers,signal:controller.signal,processingMs:20000});active();
  report.skipped.push(...inspected.report.skipped);
  if(!inspected.report.faces.length){report.elapsedMs=performance.now()-started;return context;}
  report.sourceSha256=await sha(bytes);active();
  const fetchPublic=async path=>{const r=await fetch(path,{signal:controller.signal});if(!r.ok)throw Error('document_font_public_program_unavailable');return r;};
  const manifest=await (await fetchPublic('/onlyoffice-browser-font-assets.json')).json();
  for(const path of [manifest.allFonts,manifest.fontSelection,manifest.fontSourceMap])if(typeof path!=='string'||path.startsWith('/')||path.split('/').includes('..')||/[?#\\]/.test(path))throw Error('document_font_public_path_invalid');
  const [catalog,map,selection]=await Promise.all([fetchPublic('/'+manifest.allFonts).then(r=>r.text()).then(readPublicFontCatalog),fetchPublic('/'+manifest.fontSourceMap).then(r=>r.json()),fetchPublic('/'+manifest.fontSelection).then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b))]);
  active();if(catalog.__fonts_files.length!==manifest.fonts.length||map.fonts.length!==manifest.fonts.length)throw Error('document_font_public_binding_invalid');
  const view=new DataView(selection.buffer,selection.byteOffset,selection.byteLength);let end=4;const originalCount=view.getUint32(0,true);if(originalCount>10000)throw Error('document_font_selection_count_invalid');
  for(let i=0;i<originalCount;i++){if(end+4>selection.length)throw Error('document_font_selection_truncated');const size=view.getUint32(end,true);if(size<4||size>selection.length-end)throw Error('document_font_selection_record_invalid');end+=size;}
  const records=[],seen=new Set();let decodedBytes=0;
  for(const face of inspected.report.faces){
    try{
      const result=await runWorker('/document-font-worker.js',{bytes:face.bytes.buffer,requiresHangul:face.requiresHangul},{ready:true,workers,signal:controller.signal});active();
      if(result.skipped){report.skipped.push({typeface:face.typeface,style:face.style,reason:result.skipped});continue;}
      if(!result.loaded||!result.info||!result.bytes)throw Error('document_font_native_info_missing');
      const font=new Uint8Array(result.bytes);decodedBytes+=font.length;if(decodedBytes>64*1024*1024)throw Error('document_font_decoded_budget_exceeded');
      const digest=await sha(font);active();if(seen.has(digest))continue;seen.add(digest);
      const index=catalog.__fonts_files.length,id='document-'+digest+'.ttf',file='fonts/'+id,source='/working/document-fonts/'+digest+'.ttf';
      const record=documentFontSelectionRecord({fontBytes:font,nativeInfo:result.info,sourcePath:source});records.push(record.record);catalog.__fonts_files.push(id);manifest.fonts.push(file);map.fonts.push({source,file,index,originalIndex:index});
      let info=catalog.__fonts_infos.find(i=>i[0]===record.family);if(!info){info=[record.family,-1,-1,-1,-1,-1,-1,-1,-1];catalog.__fonts_infos.push(info);}const flags=result.info.style_flags,slot=(flags&2)?((flags&1)?7:5):((flags&1)?3:1);info[slot]=index;info[slot+1]=result.info.face_index;
      assets['/'+file]={bytes:font,type:'application/octet-stream'};report.admitted.push({typeface:face.typeface,style:face.style,sha256:digest,bytes:font.length});
    }catch(error){active();report.skipped.push({typeface:face.typeface,style:face.style,reason:error.message});}
  }
  if(records.length){const core=join([integer(originalCount+records.length),selection.subarray(4,end),...records]);catalog.g_fonts_selection_bin=encode(core);context.catalog=catalog;
    const put=(path,bytes,type)=>assets['/'+path]={bytes:typeof bytes==='string'?new TextEncoder().encode(bytes):bytes,type};
    put('onlyoffice-browser-font-assets.json',JSON.stringify(manifest),'application/json');put('onlyoffice-browser-font-source-map.json',JSON.stringify(map),'application/json');put(manifest.fontSelection,join([core,selection.subarray(end)]),'application/octet-stream');put('server/FileConverter/bin/AllFonts.js',script({...catalog,__fonts_files:map.fonts.map(f=>f.source)}),'text/javascript');
    // Only the native converter Worker receives this document's private font
    // bytes. Program fetches and public fonts retain their existing cache path.
    wrapper=class extends NativeWorker{constructor(url,options){super(url,options);if(new URL(String(url),location.href).pathname!=='/wasm/x2t/conversion-worker-lKNm6_YF.js')return;const post=this.postMessage.bind(this);this.postMessage=(data,transfer)=>post(data?.protocol==='onlyoffice-browser-conversion-v1'?{...data,documentFonts:assets}:data,transfer);}};window.Worker=wrapper;
  }
  report.elapsedMs=performance.now()-started;return context;
}
// Called in the SDK frame's first <head> script, before AllFonts/native init.
export function installOnlyOfficeDocumentFontCatalog(){
  const context=window.parent[Symbol.for('spellbook.onlyoffice.documentFonts/v1')];if(!context?.catalog)return;
  const catalog=context.catalog;window[Symbol.for('spellbook.onlyoffice.documentFonts/v1')]=context;
  for(const name of ['__fonts_files','__fonts_infos','g_fonts_selection_bin'])Object.defineProperty(window,name,{configurable:true,get:()=>catalog[name],set:()=>{}});
}
// Called after the pinned native SDK defines its stream/font-loader classes.
export function installOnlyOfficeDocumentFontLoader(){
  const context=window[Symbol.for('spellbook.onlyoffice.documentFonts/v1')];if(!context?.catalog)return;
  const prototype=AscFonts.CFontFileLoader.prototype,original=prototype.LoadFontAsync;
  prototype.LoadFontAsync=function(basePath,callback){const asset=context.assets['/fonts/'+this.Id];if(!asset)return original.call(this,basePath,callback);if(this.Status===0)return true;this.LoadFontFromData(asset.bytes);if(callback)callback();if(this.externalCallback)this.externalCallback();return true;};
}
export function patchOnlyOfficeDocumentFontConversionWorker(source){
  return `let __documentFonts=null;const __programFetch=self.fetch.bind(self);self.addEventListener('message',event=>{if(event.data?.protocol==='onlyoffice-browser-conversion-v1'&&event.data.documentFonts)__documentFonts=event.data.documentFonts;});self.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,self.location.href),asset=url.origin===self.location.origin&&(!init?.method||init.method==='GET')&&__documentFonts?.[url.pathname];if(asset)return Promise.resolve(new Response(asset.bytes,{status:200,headers:{'content-type':asset.type,'cache-control':'no-store'}}));return __programFetch(input,init);};\n`+source;
}
