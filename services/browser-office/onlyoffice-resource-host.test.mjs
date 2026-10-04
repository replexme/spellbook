/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";import assert from "node:assert/strict";import vm from "node:vm";
import {attachOnlyOfficeResourceHost} from "./onlyoffice/product-resources.mjs";

test("foreign editor-frame byte views register only their owned range",async()=>{
  const prior=globalThis.window;globalThis.window={addEventListener(){}};
  const editor={getMedia:()=>({}),captureNativeSnapshot(){},getNativeEditorApi:()=>({})};
  const bytes=vm.runInNewContext('new Uint8Array([99,1,2,88]).subarray(1,3)');
  assert.equal(bytes instanceof Uint8Array,false);
  try{
    attachOnlyOfficeResourceHost(editor);
    const host=window[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
    const url=host.register("sba_"+"a".repeat(64)+".png",bytes,"image/png");bytes.fill(7);
    assert.deepEqual(new Uint8Array(await(await fetch(url)).arrayBuffer()),Uint8Array.of(1,2));host.dispose();
  }finally{globalThis.window=prior;}
});
