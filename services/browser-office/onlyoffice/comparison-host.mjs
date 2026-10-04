/* SPDX-License-Identifier: MPL-2.0 */

// Both basic and typed comparison runs use this one real component save
// callback, authored-source preservation worker and final format repair path.
export function createOnlyOfficeComparisonHost({
  origin: inputOrigin,
  preserveSource = false,
  repairStructure = false,
  authorizeArtifact = false,
}) {
  const origin = new URL(inputOrigin);
  if (!["127.0.0.1", "localhost"].includes(origin.hostname))
    throw new Error("A loopback candidate origin is required.");
  if (preserveSource && !repairStructure)
    throw new Error(
      "Authored-source preservation requires final structure repair.",
    );
  return `<!doctype html><meta charset="utf-8"><style>html,body,#editor{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="editor"></div><script type="module">
import {createOfficeEditor} from ${JSON.stringify(new URL("/npm/public-api.js", origin.origin).href)};
let editor,dirty=false,writeCount=0,error=null,saveContext=null;
const save=async()=>{
 if(saveContext)throw new Error('comparison_save_in_flight');
 const context={captureBaseline:!!window.__comparisonCaptureBaseline,retainPreservationBaseline:!!window.__comparisonRetainPreservationBaseline,reject:!!window.__comparisonRejectSave,hold:!!window.__holdSave,intent:structuredClone(window.__comparisonIntent??null),original,noEditBytes};
 saveContext=context;
 try{const file=await editor.save('pptx');return {fileName:file.name,size:file.size};}finally{if(saveContext===context)saveContext=null;}
};
window.__ONLYOFFICE_SAVE_E2E__={getStatus:()=>({ready:editor?.getState().status==='ready',dirty,writeCount,error}),save,destroy:async()=>editor?.destroy()};
window.__comparisonStructuralRepairs=[];
window.__comparisonPreservations=[];
let noEditBytes=null,original=null;
const preserveEnabled=${JSON.stringify(preserveSource)};
const preservationWorker=preserveEnabled?new Worker('/comparison-repair.js',{type:'module'}):null;
const pendingPreservations=new Map();
if(preservationWorker){
 preservationWorker.onmessage=({data})=>{const pending=pendingPreservations.get(data.requestId);if(!pending)return;pendingPreservations.delete(data.requestId);if(data.error)pending.reject(new Error(data.error));else pending.resolve({bytes:new Uint8Array(data.bytes),report:data.report});};
 preservationWorker.onerror=event=>{for(const pending of pendingPreservations.values())pending.reject(new Error(event.message));pendingPreservations.clear();};
}
const preserve=payload=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();pendingPreservations.set(requestId,{resolve,reject});try{preservationWorker.postMessage({requestId,operation:'preserve-native',...payload});}catch(error){pendingPreservations.delete(requestId);reject(error);}});
try {
 const file=new File([await (await fetch('/compare.pptx',{cache:'no-store'})).arrayBuffer()],'compare.pptx',{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
 original=${repairStructure ? "new Uint8Array(await (await fetch('/original.pptx',{cache:'no-store'})).arrayBuffer())" : "null"};
 const repair=${repairStructure ? "(await import('/comparison-repair.js')).repairCandidatePptxStructure" : "null"};
 editor=await createOfficeEditor(document.querySelector('#editor'),{hostUrl:${JSON.stringify(new URL("/office-host.html", origin.origin).href)},file,fileName:file.name,mode:'edit',saveBehavior:'callback',onDirtyChange:value=>dirty=value,onError:e=>error=e.message,onSave:async file=>{const context=saveContext;if(!context)throw new Error('comparison_save_context_missing');if(context.reject)throw new Error('comparison_host_write_rejected');const rawBytes=new Uint8Array(await file.arrayBuffer());let bytes=rawBytes;if(context.captureBaseline){if(context.retainPreservationBaseline){if(!context.noEditBytes)throw new Error('comparison_source_baseline_missing');}else noEditBytes=rawBytes;window.__comparisonSaved=bytes;return true;}if(preserveEnabled){if(!context.noEditBytes||!context.intent)throw new Error('comparison_source_preservation_intent_missing');const started=performance.now(),result=await preserve({bytes:context.original,noEditBytes:context.noEditBytes,editedBytes:rawBytes,...context.intent});bytes=result.bytes;window.__comparisonPreservations.push({ms:performance.now()-started,...result.report});}if(repair){const started=performance.now(),result=repair(context.original,bytes);bytes=result.bytes;window.__comparisonStructuralRepairs.push({ms:performance.now()-started,...result.report});}${authorizeArtifact ? "if(typeof window.__ONLYOFFICE_PRODUCT_ADMIT__!=='function')throw new Error('product_artifact_authority_missing');if(await window.__ONLYOFFICE_PRODUCT_ADMIT__(Array.from(bytes))!==true)throw new Error('product_artifact_not_approved');" : ""}window.__comparisonSaved=bytes;if(context.hold){window.__heldSave=true;await new Promise(resolve=>window.__releaseSave=resolve);}writeCount++;if(preserveEnabled){original=bytes;noEditBytes=rawBytes;}return true;}});
}catch(e){error=e.message;}
</script>`;
}
