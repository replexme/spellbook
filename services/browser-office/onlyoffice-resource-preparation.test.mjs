/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createOnlyOfficeResourcePreparation } from "./onlyoffice/product-resource-preparation.mjs";

const observation={slides:[{elements:[{kind:"chart",objectName:"Owned chart"}]}]};
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");

test("foreign asset receipt cannot be registered in the admitted document",async()=>{
  const registrations=[];
  const prepare=createOnlyOfficeResourcePreparation({
    port:{registerAsset:async asset=>registrations.push(asset),registerChartWorkbook:async()=>{}},
    loadAsset:async()=>({assetId:"foreign"}),
  });
  await assert.rejects(prepare({bytes:new Uint8Array(),observation,commands:[{op:"insert_image",assetId:"requested"}]}),/asset_owner_mismatch/);
  assert.deepEqual(registrations,[]);
});

test("workbooks bind to original owned chart bytes and retain earlier batch labels",async()=>{
  const original=Uint8Array.of(80,75,3),registrations=[],requests=[];
  const input=Uint8Array.of(80,75,1);
  const first={op:"set_chart_data",elementId:"0/0",data:[[2]],columnDescriptions:["New series"]};
  const second={op:"set_chart_data",elementId:"0/0",data:[[5]],columnDescriptions:null};
  const prepare=createOnlyOfficeResourcePreparation({
    port:{registerAsset:async()=>{},registerChartWorkbook:async value=>registrations.push(value)},
    prepareWorkbook:async(bytes,request)=>{
      assert.equal(bytes,input);requests.push(request);
      return {originalWorkbookBytes:original,bytes:Uint8Array.of(80,75,request.data[0][0])};
    },
  });
  await prepare({bytes:input,observation,commands:[first,second]});
  assert.deepEqual(requests[1].columnDescriptions,["New series"]);
  assert.equal(requests[1].shapeName,"Owned chart");
  assert.equal(requests[1].slideIndex,0);
  assert.equal(registrations[1].command,second);
  assert.equal(registrations[1].sourceWorkbookSha256,digest(original));
  assert.deepEqual(registrations[1].bytes,Uint8Array.of(80,75,5));
});

test("unobserved workbook owner is rejected before resource preparation",async()=>{
  let prepared=false;
  const prepare=createOnlyOfficeResourcePreparation({
    port:{registerAsset:async()=>{},registerChartWorkbook:async()=>{}},
    prepareWorkbook:async()=>{prepared=true;},
  });
  await assert.rejects(prepare({bytes:new Uint8Array(),observation,commands:[{op:"set_chart_data",elementId:"0/1",data:[[1]]}]}),/chart_source_owner_required/);
  assert.equal(prepared,false);
});
