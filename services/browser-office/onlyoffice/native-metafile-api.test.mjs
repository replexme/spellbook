/* SPDX-License-Identifier: MPL-2.0 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the exact preferred-source API addition, including failure cleanup;
// do not substitute a second implementation of the production wrapper.
const patch=await fs.readFile(new URL('./patches/0023-native-metafile-pie-and-owned-render-api.patch',import.meta.url),'utf8');
const added=patch.split('+++ b/core/DesktopEditor/fontengine/js/engine/module_js.js\n')[1]
  .split('\n').filter(line=>line.startsWith('+')).map(line=>line.slice(1)).join('\n');
const source=added.slice(added.indexOf('AscFonts.RenderMetafileSvg ='));
function setup(overrides={}) {
  const calls=[],heap=new Uint8Array(2048),encoded=new TextEncoder().encode('<svg/>');
  heap.set(encoded,1024);
  const Module={HEAPU8:heap,
    _Zlib_Malloc:size=>(calls.push(['malloc',size]),128),
    _Zlib_Free:pointer=>calls.push(['free',pointer]),
    _Image_GetFormat:()=>21,
    _Raster_Encode:(pointer,size,type)=>(calls.push(['encode',pointer,size,type]),512),
    _Raster_GetEncodedSize:()=>encoded.length,
    _Raster_GetEncodedBuffer:()=>1024,
    _Raster_DestroyEncodedData:pointer=>calls.push(['destroy',pointer]),
    ...overrides,
  };
  const AscFonts={};vm.runInNewContext(source,{AscFonts,Module,ArrayBuffer,Uint8Array,TextDecoder});
  return {render:AscFonts.RenderMetafileSvg,calls,heap};
}
test('native metafile API decodes the precise input view and releases both buffers',()=>{
  const {render,calls,heap}=setup();
  const input=new Uint8Array(40);input.fill(9);input.fill(7,5,25);
  assert.equal(render(input.subarray(5,25)),'<svg/>');
  assert.deepEqual([...heap.slice(128,148)],Array(20).fill(7));
  assert.deepEqual(calls,[['malloc',20],['encode',128,20,24],['destroy',512],['free',128]]);
});
test('native metafile API frees allocations on format, encode, bounds and decode failures',()=>{
  for(const [overrides,error,hasEncoded] of [
    [{_Image_GetFormat:()=>3},/format_invalid/,false],
    [{_Raster_Encode:()=>0},/encode_failed/,false],
    [{_Raster_GetEncodedSize:()=>0},/output_size_invalid/,true],
    [{_Raster_GetEncodedSize:()=>8388609},/output_size_invalid/,true],
    [{_Raster_GetEncodedBuffer:()=>0},/output_size_invalid/,true],
    [{_Raster_GetEncodedBuffer:()=>2046},/output_size_invalid/,true],
    [{_Image_GetFormat:()=>{throw Error('native-format-failure');}},/native-format-failure/,false],
  ]){
    const {render,calls}=setup(overrides);assert.throws(()=>render(new Uint8Array(18)),error);
    assert.deepEqual(calls.filter(([id])=>['destroy','free'].includes(id)),[...(hasEncoded?[['destroy',512]]:[]),['free',128]]);
  }
  const broken=setup();broken.heap[1024]=255;
  assert.throws(()=>broken.render(new Uint8Array(18)),/encoded data|encoding/i);
  assert.deepEqual(broken.calls.slice(-2),[['destroy',512],['free',128]]);
  const oom=setup({_Zlib_Malloc:()=>0});assert.throws(()=>oom.render(new Uint8Array(18)),/allocation_failed/);assert.deepEqual(oom.calls,[]);
  const shortHeap=setup({HEAPU8:new Uint8Array(4)});assert.throws(()=>shortHeap.render(new Uint8Array(18)),/bounds|offset/i);assert.deepEqual(shortHeap.calls.slice(-1),[['free',128]]);
});
test('native metafile API rejects invalid or oversized inputs before allocation',()=>{
  const {render,calls}=setup();
  for(const input of [null,[],new Uint8Array(17),new Uint16Array(18),new DataView(new ArrayBuffer(18)),new Uint8Array(25000001)])
    assert.throws(()=>render(input),/input_size_invalid/);
  assert.deepEqual(calls,[]);
});
