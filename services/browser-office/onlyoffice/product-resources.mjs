/* SPDX-License-Identifier: MPL-2.0 */
// The editor host owns media transport; the private frame port owns the
// document-scoped receipts. None of these methods is an AI tool.
export function attachOnlyOfficeResourceHost(editor,convertDocument) {
  const key=Symbol.for("spellbook.onlyoffice.resourceHost/v1");
  if(typeof editor?.getMedia!=="function"||typeof editor.captureNativeSnapshot!=="function"||typeof editor.getNativeEditorApi!=="function")throw Error("onlyoffice_product_media_host_unavailable");
  window[key]?.dispose();
  const urls=new Set(),staged=new Map(),digests=new Map(),capture=editor.captureNativeSnapshot;
  const bridge={
    async read(reference){
      const media=editor.getMedia(),entries=[...Object.entries(media),...[...staged].map(([name,item])=>[name,item.url])];
      const url=entries.find(([name,value])=>name===reference||name==="media/"+reference||value===reference)?.[1];
      if(typeof url!=="string"||!url.startsWith("blob:"))throw Error("onlyoffice_product_media_reference_not_owned:"+reference);
      const response=await fetch(url);if(!response.ok)throw Error("onlyoffice_product_media_read_failed");
      const bytes=new Uint8Array(await response.arrayBuffer());if(!bytes.length||bytes.length>25_000_000)throw Error("onlyoffice_product_media_size_invalid");return bytes;
    },
    async fingerprint(reference){
      const media=editor.getMedia(),entries=[...Object.entries(media),...[...staged].map(([name,item])=>[name,item.url])];
      const url=entries.find(([name,value])=>name===reference||name==="media/"+reference||value===reference)?.[1];
      if(typeof url!=="string"||!url.startsWith("blob:"))throw Error("onlyoffice_product_media_reference_not_owned:"+reference);
      if(!digests.has(url))digests.set(url,(async()=>{
        const response=await fetch(url);if(!response.ok)throw Error("onlyoffice_product_media_read_failed");
        const bytes=await response.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>25_000_000)throw Error("onlyoffice_product_media_size_invalid");
        return "sha256:"+Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
      })());
      return digests.get(url);
    },
    async convertWorkbook(bytes){
      if(typeof convertDocument!=="function"||!ArrayBuffer.isView(bytes)||bytes.BYTES_PER_ELEMENT!==1||!bytes.byteLength||bytes.byteLength>25_000_000)
        throw Error("onlyoffice_product_workbook_converter_unavailable");
      const owned=new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength).slice();
      const result=await convertDocument(new File([owned],"owned-chart.xlsx",{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
      try{
        if(result.type!=="cell"||!(result.bin instanceof Uint8Array)||!result.bin.length||result.bin.length>25_000_000||
            String.fromCharCode(...result.bin.subarray(0,5))!=="XLSY;")
          throw Error("onlyoffice_product_workbook_conversion_invalid");
        // Chart record 16 takes the raw worksheet table, whereas document
        // conversion returns a length-checked XLSY base64 file envelope.
        const envelope=new TextDecoder().decode(result.bin);
        const match=/^XLSY;v2;([1-9]\d*);([A-Za-z0-9+/]*={0,2})$/.exec(envelope);
        if(!match||Number(match[1])>25_000_000||match[2].length!==4*Math.ceil(Number(match[1])/3))
          throw Error("onlyoffice_product_workbook_binary_envelope_invalid");
        const decoded=atob(match[2]);
        if(decoded.length!==Number(match[1]))throw Error("onlyoffice_product_workbook_binary_length_invalid");
        return Uint8Array.from(decoded,char=>char.charCodeAt(0));
      }finally{for(const url of Object.values(result.media??{}))URL.revokeObjectURL(url);}
    },
    register(name,bytes,type){
      // The trusted editor frame supplies a view from a different realm.
      // Copy exactly that bounded range into the host realm before checking it.
      if (ArrayBuffer.isView(bytes) && bytes.BYTES_PER_ELEMENT === 1)
        bytes = new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength).slice();
      if(!/^sba_[0-9a-f]{64}\.[a-z0-9]+$/.test(name)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>25_000_000)
        throw Error("onlyoffice_product_media_registration_invalid");
      const media=editor.getMedia(),path="media/"+name;
      if(staged.has(path))return staged.get(path).url;
      if(media[path]){staged.set(path,{url:media[path],original:true});return media[path];}
      if(staged.size>=256||[...staged.values()].reduce((sum,item)=>sum+(item.byteLength??0),0)+bytes.length>64_000_000)
        throw Error("onlyoffice_product_media_cache_limit");
      const url=URL.createObjectURL(new Blob([bytes],{type}));staged.set(path,{url,original:false,byteLength:bytes.length});urls.add(url);return url;
    },
    sync(){
      if(!staged.size)return;
      const model=editor.getNativeEditorApi()?.WordControl?.m_oLogicDocument;
      if(typeof model?.Get_AllImageUrls!=="function")throw Error("onlyoffice_product_media_document_unavailable");
      const used=new Set(model.Get_AllImageUrls());
      const visit=objects=>objects.forEach(shape=>{const media=shape.nvPicPr?.nvPr?.unimedia?.media;if(media)used.add(media);if(shape.spTree)visit(shape.spTree);});
      model.Slides.forEach(slide=>visit(slide.cSld.spTree));
      for(const master of model.slideMasters){visit(master.cSld.spTree);for(const layout of master.sldLayoutLst)visit(layout.cSld.spTree);}
      const media=editor.getMedia();
      for(const [path,value] of staged){
        if(value.original)continue;
        const referenced=used.has(value.url)||used.has(path)||used.has(path.slice(6));
        if(referenced)media[path]=value.url;else if(media[path]===value.url)delete media[path];
      }
    },
    dispose(){editor.captureNativeSnapshot=capture;for(const url of urls)URL.revokeObjectURL(url);urls.clear();staged.clear();digests.clear();if(window[key]===bridge)delete window[key];},
  };
  // Every save entry point captures bytes and media together. Registering an
  // asset stages its transport only; rejected requests and undone insertions
  // must not leave unreferenced files in the next saved package. Retain staged
  // URLs for Redo, activating only live references before this native snapshot.
  editor.captureNativeSnapshot=function(...args){bridge.sync();return capture.apply(this,args);};
  window[key]=bridge;
  window.addEventListener("pagehide",()=>bridge.dispose(),{once:true});
}
async function mediaPoster(bytes,mediaType) {
  const canvas=document.createElement("canvas");canvas.width=256;canvas.height=144;
  const context=canvas.getContext("2d");
  if(!context)throw Error("onlyoffice_product_media_poster_canvas_unavailable");
  context.fillStyle="#f4f4f4";context.fillRect(0,0,256,144);
  let decoded=false;
  if(mediaType.startsWith("video/")){
    const video=document.createElement("video"),url=URL.createObjectURL(new Blob([bytes],{type:mediaType}));
    video.muted=true;video.preload="auto";
    try {
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);video.onloadeddata=null;video.onerror=null;};
        const timer=setTimeout(()=>{cleanup();reject(Error("media_preview_timeout"));},5000);
        video.onloadeddata=()=>{cleanup();resolve();};video.onerror=()=>{cleanup();reject(Error("media_preview_decode_failed"));};video.src=url;video.load();
      });
      if(video.videoWidth&&video.videoHeight){
        const ratio=Math.min(256/video.videoWidth,144/video.videoHeight),width=video.videoWidth*ratio,height=video.videoHeight*ratio;
        context.drawImage(video,(256-width)/2,(144-height)/2,width,height);decoded=true;
      }
    }catch(error){if(!["media_preview_timeout","media_preview_decode_failed"].includes(error.message))throw error;}
    finally {video.removeAttribute("src");video.load();URL.revokeObjectURL(url);}
  }
  if(!decoded){
    context.fillStyle="#666666";
    if(mediaType.startsWith("video/")){context.beginPath();context.moveTo(112,48);context.lineTo(112,96);context.lineTo(154,72);context.closePath();context.fill();}
    else {context.fillRect(88,58,18,28);context.beginPath();context.moveTo(106,58);context.lineTo(132,40);context.lineTo(132,104);context.lineTo(106,86);context.closePath();context.fill();context.strokeStyle="#666666";context.lineWidth=5;for(const radius of [18,30]){context.beginPath();context.arc(130,72,radius,-Math.PI/3,Math.PI/3);context.stroke();}}
  }
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error("onlyoffice_product_media_poster_encoding_failed")),"image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
export async function registerOnlyOfficeDocumentAsset(input) {
  if(!input||typeof input!=="object")throw Error("onlyoffice_product_asset_registration_invalid");
  const key=Symbol.for("spellbook.onlyoffice.documentAssets/v1");
  const model=window.Asc.editor.WordControl.m_oLogicDocument;
  if(window[key]?.model!==model)window[key]={model,receipts:new Map()};
  const assets=window[key].receipts;
  const {assetId,mediaType}=input;
  if(typeof assetId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId))
    throw Error("onlyoffice_product_asset_id_invalid");
  const extensions={"image/png":"png","image/jpeg":"jpg","audio/mpeg":"mp3","audio/wav":"wav","audio/ogg":"ogg","audio/mp4":"m4a","video/mp4":"mp4","video/webm":"webm"};
  const maximum=mediaType?.startsWith("image/")?5_000_000:25_000_000;
  if(!(input.bytes instanceof Uint8Array)&&!(input.bytes instanceof ArrayBuffer)||!input.bytes.byteLength||input.bytes.byteLength>maximum)
    throw Error("onlyoffice_product_asset_size_or_type_invalid");
  const extension=extensions[mediaType],bytes=input.bytes instanceof Uint8Array?input.bytes.slice():new Uint8Array(input.bytes.slice(0));
  if(!extension||!bytes.length||bytes.length>maximum)throw Error("onlyoffice_product_asset_size_or_type_invalid");
  const text=(a,b)=>String.fromCharCode(...bytes.subarray(a,b));
  const signature=mediaType==="image/png"?[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n):
    mediaType==="image/jpeg"?bytes[0]===255&&bytes[1]===216:
    mediaType==="audio/mpeg"?text(0,3)==="ID3"||(bytes[0]===255&&(bytes[1]&224)===224):
    mediaType==="audio/wav"?text(0,4)==="RIFF"&&text(8,12)==="WAVE":
    mediaType==="audio/ogg"?text(0,4)==="OggS":
    mediaType==="video/webm"?[26,69,223,163].every((n,i)=>bytes[i]===n):text(4,8)==="ftyp";
  if(!signature)throw Error("onlyoffice_product_asset_signature_invalid");
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
  if(window.Asc.editor.WordControl.m_oLogicDocument!==model)throw Error("onlyoffice_product_asset_document_changed");
  const previous=assets.get(assetId);
  if(previous){if(previous.sha256!==sha256||previous.mediaType!==mediaType)throw Error("onlyoffice_product_asset_receipt_conflict");return previous;}
  const host=window.parent[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
  if(!host)throw Error("onlyoffice_product_asset_host_required");
  const fileName="sba_"+sha256+"."+extension,url=host.register(fileName,bytes,mediaType);
  window.AscCommon.g_oDocumentUrls.addImageUrl(fileName,url);
  const kind=mediaType.split("/")[0];
  let posterUrl=null,posterPath=null,posterSha256=null;
  if(kind!=="image"){
    if(input.posterBytes!=null&&!(input.posterBytes instanceof Uint8Array))throw Error("onlyoffice_product_media_poster_invalid");
    const poster=input.posterBytes??await mediaPoster(bytes,mediaType);
    if(!poster.length||poster.length>5_000_000||![137,80,78,71,13,10,26,10].every((n,i)=>poster[i]===n))throw Error("onlyoffice_product_media_poster_invalid");
    const posterDigest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",poster)),n=>n.toString(16).padStart(2,"0")).join("");
    posterSha256=posterDigest;posterPath="sba_"+sha256+".png";posterUrl=host.register(posterPath,poster,"image/png");window.AscCommon.g_oDocumentUrls.addImageUrl(posterPath,posterUrl);
  }
  const imageUrl=kind==="image"?url:posterUrl;
  const loader=window.Asc.editor.ImageLoader;
  if(typeof loader?.LoadImagesWithCallback!=="function")throw Error("onlyoffice_product_asset_loader_unavailable");
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("onlyoffice_product_asset_load_timeout")),30000);loader.LoadImagesWithCallback([imageUrl],()=>{clearTimeout(timer);const image=loader.map_image_index[imageUrl]?.Image;image?.naturalWidth?resolve():reject(Error("onlyoffice_product_asset_image_invalid"));});});
  if(window.Asc.editor.WordControl.m_oLogicDocument!==model)throw Error("onlyoffice_product_asset_document_changed");
  const receipt={assetId,sha256,mediaType,kind,url,fileName,posterUrl,posterPath,posterSha256};assets.set(assetId,Object.freeze(receipt));return receipt;
}
export function readOnlyOfficeDocumentAsset(assetId) {
  const state=window[Symbol.for("spellbook.onlyoffice.documentAssets/v1")];
  if(state?.model!==window.Asc.editor.WordControl.m_oLogicDocument)throw Error("onlyoffice_product_asset_document_changed");
  const receipt=state.receipts.get(assetId);
  if(!receipt)throw Error("onlyoffice_product_asset_authority_required");return receipt;
}

// Prepare a transport pair from the target's existing poster and the owned new
// media. Companion filenames must share a basename in the pinned converter.
export async function prepareOnlyOfficeMediaReplacement({assetId,elementId}) {
  const state=window[Symbol.for("spellbook.onlyoffice.documentAssets/v1")],model=window.Asc.editor.WordControl.m_oLogicDocument;
  const receipt=state?.model===model&&state.receipts.get(assetId);if(!receipt)throw Error("onlyoffice_product_asset_authority_required");const [si,...path]=elementId.split("/").map(Number);
  let shape=model.Slides[si];for(const index of path)shape=(shape.cSld?.spTree??shape.spTree)?.[index];
  if(!shape?.blipFill?.RasterImageId)throw Error("onlyoffice_product_media_poster_target_missing");
  const host=window.parent[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
  const poster=await host.read(shape.blipFill.RasterImageId);
  const posterSha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",poster)),n=>n.toString(16).padStart(2,"0")).join("");
  const pairSha=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(receipt.sha256+posterSha256))),n=>n.toString(16).padStart(2,"0")).join("");
  const posterPath="sba_"+pairSha+".png",fileName="sba_"+pairSha+"."+receipt.fileName.split(".").at(-1);
  const mediaBytes=await host.read(receipt.url),url=host.register(fileName,mediaBytes,receipt.mediaType),posterUrl=host.register(posterPath,poster,"image/png");
  window.AscCommon.g_oDocumentUrls.addImageUrl(fileName,url);window.AscCommon.g_oDocumentUrls.addImageUrl(posterPath,posterUrl);
  await new Promise(resolve=>window.Asc.editor.ImageLoader.LoadImagesWithCallback([posterUrl],resolve));
  if(window.Asc.editor.WordControl.m_oLogicDocument!==model)throw Error("onlyoffice_product_asset_document_changed");
  const bound=Object.freeze({...receipt,fileName,url,posterPath,posterUrl,posterSha256});
  state.replacements??=new Map();state.replacements.set(assetId+":"+elementId,bound);return bound;
}
export function readOnlyOfficeMediaReplacement(assetId,elementId){
  const state=window[Symbol.for("spellbook.onlyoffice.documentAssets/v1")];
  if(state?.model!==window.Asc.editor.WordControl.m_oLogicDocument)throw Error("onlyoffice_product_asset_document_changed");
  const receipt=state.replacements?.get(assetId+":"+elementId);if(!receipt)throw Error("onlyoffice_product_media_replacement_authority_required");return receipt;
}
