/* SPDX-License-Identifier: MPL-2.0 */
import { captureOnlyOfficeNativeChanges } from "./identity-evidence.mjs";
import { observeOnlyOfficeProduct } from "./product-engine.mjs";

const key=Symbol.for("spellbook.onlyoffice.chartWorkbooks/v1");
const frame={evaluate:(callback,argument)=>Promise.resolve(callback(argument))};
function owner(elementId) {
  if(typeof elementId!=="string"||!/^\d+(?:\/\d+)+$/.test(elementId))throw Error("onlyoffice_product_chart_target_invalid");
  const model=window.Asc.editor.WordControl.m_oLogicDocument;
  const [slideIndex,...path]=elementId.split("/").map(Number);
  let shape=model.Slides[slideIndex];
  for(const index of path)shape=(shape?.cSld?.spTree??shape?.spTree)?.[index];
  if(!shape?.isChart?.())throw Error("onlyoffice_product_chart_target_missing");
  return {model,shape};
}
function requestKey(command) {
  if(command?.op!=="set_chart_data")throw Error("onlyoffice_product_chart_request_invalid");
  return JSON.stringify([command.elementId,command.data??null,command.rowDescriptions??null,command.columnDescriptions??null]);
}
// Only the trusted document host registers an owned XLSX workbook, after it has
// prepared the owned XLSX using the original chart's worksheet references. AI
// commands identify their target and requested values; they cannot supply a
// native workbook payload or choose a different chart's embedding.
export async function registerOnlyOfficeChartWorkbook({command,bytes,sourceWorkbookSha256}) {
  const binding=owner(command?.elementId),request=requestKey(command);
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>25_000_000||
      !/^[0-9a-f]{64}$/.test(sourceWorkbookSha256))
    throw Error("onlyoffice_product_chart_workbook_registration_invalid");
  // Convert the owned workbook with the host's existing converter. The
  // pinned presentation converter fails on the XLSXZIP chart record; its
  // native spreadsheet binary record preserves these exact workbook edits.
  if(typeof window.AscCommon.checkOOXMLSignature!=="function"||!window.AscCommon.checkOOXMLSignature(bytes))
    throw Error("onlyoffice_product_chart_workbook_format_invalid");
  const token=captureOnlyOfficeNativeChanges();
  const revision=(await observeOnlyOfficeProduct(frame)).revision;
  const owned=bytes.slice();
  const host=window.parent[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
  if(typeof host?.convertWorkbook!=="function")throw Error("onlyoffice_product_chart_workbook_converter_required");
  const converted=await host.convertWorkbook(owned);
  if(!ArrayBuffer.isView(converted)||converted.BYTES_PER_ELEMENT!==1)throw Error("onlyoffice_product_chart_workbook_conversion_invalid");
  const payload=new Uint8Array(converted.buffer,converted.byteOffset,converted.byteLength).slice();
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",payload)),value=>value.toString(16).padStart(2,"0")).join("");
  const current=owner(command.elementId);
  if(current.model!==binding.model||current.shape!==binding.shape||captureOnlyOfficeNativeChanges()!==token||(await observeOnlyOfficeProduct(frame)).revision!==revision)
    throw Error("onlyoffice_product_chart_document_changed");
  if(window[key]?.model!==binding.model)window[key]={model:binding.model,receipts:new Map()};
  const receipt={request,nativeId:binding.shape.Id,changeToken:token,revision,sha256,sourceWorkbookSha256,bytes:payload};
  window[key].receipts.set(request,receipt);
  return {elementId:command.elementId,sha256,sourceWorkbookSha256,byteLength:payload.length};
}
export async function readOnlyOfficeChartWorkbook(command) {
  const current=owner(command?.elementId),state=window[key];
  const receipt=state?.receipts.get(requestKey(command));
  if(state?.model!==current.model||!receipt||receipt.nativeId!==current.shape.Id||
      receipt.changeToken!==captureOnlyOfficeNativeChanges()||receipt.revision!==(await observeOnlyOfficeProduct(frame)).revision)
    throw Error("onlyoffice_product_chart_workbook_authority_required");
  return {bytes:receipt.bytes.slice(),receipt:{sha256:receipt.sha256,sourceWorkbookSha256:receipt.sourceWorkbookSha256,nativeId:receipt.nativeId}};
}
