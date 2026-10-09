/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareOnlyOfficeNativeMetafile } from "./native-metafile-images.mjs";

const origin = "http://127.0.0.1:4100";
const preview = "blob:" + origin + "/preview";
const original = "blob:" + origin + "/original";
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
const bytes = Uint8Array.from({length:108}, (_, index) => index);
const ownedUrls = {
  "media/display6image1.svg": preview,
  "media/display6image1.emf": original,
};

test("ordinary SVG and program images do not request a native decoder", async () => {
  const fetchBytes = () => assert.fail("unexpected read");
  assert.equal(await prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls:{"media/image1.svg":preview}, fetchBytes,
  }), null);
  assert.equal(await prepareOnlyOfficeNativeMetafile("data:image/svg+xml,...", {
    origin, ownedUrls, fetchBytes,
  }), null);
});

test("native decoding uses the exact owned bytes and records their identity", async () => {
  let reads = 0, encodes = 0;
  const signal = new AbortController().signal;
  const result = await prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls, signal,
    fetchBytes:async (url, options) => {
      reads++;assert.equal(url, original);assert.strictEqual(options.signal, signal);
      return new Response(bytes);
    },
    renderSvg:input => {encodes++;assert.deepEqual(input, bytes);return svg;},
  });
  assert.equal(reads, 1);assert.equal(encodes, 1);
  assert.deepEqual(result, {
    source:svg, sourceName:"media/display6image1.emf", sourceBytes:bytes.length,
    sourceSha256:createHash("sha256").update(bytes).digest("hex"),
  });
  assert.deepEqual(bytes, Uint8Array.from({length:108}, (_, index) => index));
});

test("ambiguous and foreign original references fail before any read", async () => {
  const fetchBytes = () => assert.fail("unsafe read");
  await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls:{...ownedUrls,"media/display6image1.wmf":"blob:"+origin+"/other"},
    fetchBytes,
  }), /source_ambiguous/);
  for (const url of ["https://example.com/original.emf","blob:http://127.0.0.1:41001/other","blob:null/other"]) {
    await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
      origin, ownedUrls:{...ownedUrls,"media/display6image1.emf":url}, fetchBytes,
    }), /source_not_owned/);
  }
});

test("a missing native API cannot fall back to a stale derived preview", async () => {
  await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls, fetchBytes:() => assert.fail("unexpected read"),
  }), /native_api_unavailable/);
});

test("read and byte bounds are checked before native decoding", async () => {
  const renderSvg = () => assert.fail("invalid bytes reached native code");
  await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls, renderSvg, fetchBytes:async () => new Response("failed", {status:500}),
  }), /source_read_failed/);
  for (const size of [0,17,25_000_001]) {
    await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
      origin, ownedUrls, renderSvg, fetchBytes:async () => new Response(new Uint8Array(size)),
    }), /input_size_invalid/);
  }
});

test("disposal aborts pending owned reads before any native allocation", async () => {
  const controller = new AbortController();
  await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
    origin, ownedUrls, signal:controller.signal,
    fetchBytes:async () => {controller.abort();return new Response(bytes);},
    renderSvg:() => assert.fail("disposed context decoded bytes"),
  }), {name:"AbortError"});
});

test("native exceptions and oversized outputs cannot silently display an old SVG", async () => {
  const options = {origin, ownedUrls, fetchBytes:async () => new Response(bytes)};
  await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
    ...options, renderSvg:() => {throw Error("native parse failed");},
  }), /native parse failed/);
  for (const source of ["",null,"x".repeat(8*1024*1024+1)]) {
    await assert.rejects(prepareOnlyOfficeNativeMetafile(preview, {
      ...options, renderSvg:() => source,
    }), /output_size_invalid/);
  }
});
