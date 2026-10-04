/* SPDX-License-Identifier: MPL-2.0 */
import { prepareChartWorkbookMutation } from "../ooxml-worker-source.mjs";

// Runs in the trusted document host. Use the artifact admitted by the common
// session, never a model-supplied path, embedding, URL, or workbook payload.
export function createOnlyOfficeResourcePreparation({port,loadAsset,prepareWorkbook=prepareChartWorkbookMutation}) {
  if(typeof port?.registerChartWorkbook!=="function"||typeof port.registerAsset!=="function")
    throw Error("onlyoffice_product_resource_port_required");
  return async ({bytes,observation,commands})=>{
    const registered=new Set(), chartRequests=new Map();
    for(const command of commands){
      if(["insert_image","replace_image","insert_media","replace_media"].includes(command.op)&&!registered.has(command.assetId)){
        if(typeof loadAsset!=="function")throw Error("onlyoffice_product_asset_loader_required");
        const asset=await loadAsset(command.assetId);
        if(asset?.assetId!==command.assetId)throw Error("onlyoffice_product_asset_owner_mismatch");
        await port.registerAsset(asset);registered.add(command.assetId);
      }
      if(command.op!=="set_chart_data")continue;
      const [slideIndex,...path]=command.elementId.split("/").map(Number);
      let element=observation.slides[slideIndex];
      for(const index of path)element=element?.elements?.[index];
      if(element?.kind!=="chart"||typeof element.objectName!=="string"||!element.objectName)
        throw Error("onlyoffice_product_chart_source_owner_required");
      // Later commands for the same chart retain earlier requested worksheet
      // edits in this batch, while each private receipt still binds to the
      // exact canonical request used by native preflight.
      const combined={...(chartRequests.get(command.elementId)??{})};
      for(const key of ["data","rowDescriptions","columnDescriptions"])
        if(command[key]!=null)combined[key]=command[key];
      chartRequests.set(command.elementId,combined);
      const prepared=await prepareWorkbook(bytes,{...command,...combined,slideIndex,shapeName:element.objectName});
      if(!(prepared.originalWorkbookBytes instanceof Uint8Array)||!(prepared.bytes instanceof Uint8Array))
        throw Error("onlyoffice_product_chart_source_workbook_required");
      const sourceWorkbookSha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",prepared.originalWorkbookBytes)),value=>value.toString(16).padStart(2,"0")).join("");
      await port.registerChartWorkbook({command,bytes:prepared.bytes,sourceWorkbookSha256});
    }
  };
}
