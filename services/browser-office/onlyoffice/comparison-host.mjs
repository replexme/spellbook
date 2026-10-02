/* SPDX-License-Identifier: MPL-2.0 */

// Both basic and typed comparison runs use this one real component save
// callback, authored-source preservation worker and final format repair path.
export function createOnlyOfficeComparisonHost({
  origin: inputOrigin,
  preserveSource = false,
  repairStructure = false,
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
let editor,dirty=false,writeCount=0,error=null;
window.__ONLYOFFICE_SAVE_E2E__={getStatus:()=>({ready:editor?.getState().status==='ready',dirty,writeCount,error}),save:async()=>{const file=await editor.save('pptx');return {fileName:file.name,size:file.size};},destroy:async()=>editor?.destroy()};
window.__comparisonStructuralRepairs=[];
window.__comparisonPreservations=[];
let noEditBytes=null;
const preserveEnabled=${JSON.stringify(preserveSource)};
const preservationWorker=preserveEnabled?new Worker('/comparison-repair.js',{type:'module'}):null;
const preserve=payload=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();preservationWorker.onmessage=({data})=>{if(data.requestId!==requestId)return;if(data.error)reject(new Error(data.error));else resolve({bytes:new Uint8Array(data.bytes),report:data.report});};preservationWorker.onerror=event=>reject(new Error(event.message));preservationWorker.postMessage({requestId,operation:'preserve-native',...payload});});
try {
 const file=new File([await (await fetch('/compare.pptx',{cache:'no-store'})).arrayBuffer()],'compare.pptx',{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
 const original=${repairStructure ? "new Uint8Array(await (await fetch('/original.pptx',{cache:'no-store'})).arrayBuffer())" : "null"};
 const repair=${repairStructure ? "(await import('/comparison-repair.js')).repairCandidatePptxStructure" : "null"};
 editor=await createOfficeEditor(document.querySelector('#editor'),{hostUrl:${JSON.stringify(new URL("/office-host.html", origin.origin).href)},file,fileName:file.name,mode:'edit',saveBehavior:'callback',onDirtyChange:value=>dirty=value,onError:e=>error=e.message,onSave:async file=>{if(window.__comparisonRejectSave)throw new Error('comparison_host_write_rejected');let bytes=new Uint8Array(await file.arrayBuffer());if(window.__comparisonCaptureBaseline){noEditBytes=bytes;window.__comparisonSaved=bytes;return true;}if(preserveEnabled){if(!noEditBytes||!window.__comparisonIntent)throw new Error('comparison_source_preservation_intent_missing');const started=performance.now(),result=await preserve({bytes:original,noEditBytes,editedBytes:bytes,...window.__comparisonIntent});bytes=result.bytes;window.__comparisonPreservations.push({ms:performance.now()-started,...result.report});}if(repair){const started=performance.now(),result=repair(original,bytes);bytes=result.bytes;window.__comparisonStructuralRepairs.push({ms:performance.now()-started,...result.report});}window.__comparisonSaved=bytes;if(window.__holdSave){window.__heldSave=true;await new Promise(resolve=>window.__releaseSave=resolve);}writeCount++;return true;}});
}catch(e){error=e.message;}
</script>`;
}
