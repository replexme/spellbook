/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { inspectPptxLinkedImages } from "./ooxml-worker-source.mjs";
import {
  createPptxRenderResourceContext,
  preparePptxRenderInput,
} from "./linked-render-resources.mjs";
const input = new Uint8Array(
  await fs.readFile(
    new URL(
      "../../eval/public/downloads/ox-linked-picture.pptx",
      import.meta.url,
    ),
  ),
);
const gif = Uint8Array.from(
  Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = sha(input),
  links = inspectPptxLinkedImages(input).links;
const asset = { ...links[0], bytes: gif, sha256: sha(gif), sourceSha256 };
const snapshot = () => ({
  manifest: { sourceSha256, images: [{ ...links[0], sha256: sha(gif) }] },
  assets: [{ ...asset, bytes: gif.slice() }],
});
function changed(part, update) {
  const entries = unzipSync(input);
  entries[part] = strToU8(update(strFromU8(entries[part])));
  return zipSync(entries, { level: 6 });
}
test("initial owned source admits the image, while changed source and corrupted bytes fail", async () => {
  const context = await createPptxRenderResourceContext(input, snapshot());
  const state = await context.forInput(input);
  assert.equal(state.manifest.sourceSha256, sourceSha256);
  assert.equal(state.assets[0].sha256, sha(gif));
  context.close();
  await assert.rejects(
    createPptxRenderResourceContext(input, {
      ...snapshot(),
      manifest: { ...snapshot().manifest, sourceSha256: "a".repeat(64) },
    }),
    /source_binding_mismatch/,
  );
  const corrupt = snapshot();
  corrupt.assets[0].bytes[corrupt.assets[0].bytes.length - 1] = 0;
  await assert.rejects(
    createPptxRenderResourceContext(input, corrupt),
    /payload_hash_mismatch/,
  );
});
test("edited source gets a current source receipt without refetching or changing author input", async () => {
  const context = await createPptxRenderResourceContext(input, snapshot());
  const child = changed("docProps/core.xml", (xml) =>
    xml.replace(
      "</cp:coreProperties>",
      "<cp:keywords>child</cp:keywords></cp:coreProperties>",
    ),
  );
  const state = await context.forInput(child);
  assert.equal(state.manifest.sourceSha256, sha(child));
  assert.equal(state.assets[0].sourceSha256, sha(child));
  assert.equal(state.assets[0].sha256, sha(gif));
  assert.equal(sha(input), sourceSha256);
  context.close();
});
test("duplicate or moved image relationships reuse the initially owned URL", async () => {
  const child = changed("ppt/slides/_rels/slide1.xml.rels", (xml) =>
    xml.replace('Id="rId2"', 'Id="rId28"'),
  );
  const entries = unzipSync(child);
  entries["ppt/slides/slide1.xml"] = strToU8(
    strFromU8(entries["ppt/slides/slide1.xml"]).replace(
      'r:link="rId2"',
      'r:link="rId28"',
    ),
  );
  const moved = zipSync(entries, { level: 6 }),
    context = await createPptxRenderResourceContext(input, snapshot()),
    state = await context.forInput(moved);
  assert.equal(state.assets[0].relationshipId, "rId28");
  assert.equal(state.assets[0].sha256, sha(gif));
  context.close();
});
test("a newly authored URL cannot use unrelated prior image bytes", async () => {
  const context = await createPptxRenderResourceContext(input, snapshot());
  const changedUrl = changed("ppt/slides/_rels/slide1.xml.rels", (xml) =>
    xml.replace(
      "http://www.google.com/intl/en/images/logo.gif",
      "https://new.example.test/image.gif",
    ),
  );
  await assert.rejects(
    context.forInput(changedUrl),
    /snapshot_relationship_missing/,
  );
  context.close();
});
test("context close wipes its private copy and rejects all further use", async () => {
  const source = snapshot(),
    context = await createPptxRenderResourceContext(input, source),
    state = await context.forInput(input);
  context.close();
  assert.ok(state.assets[0].bytes.every((value) => value === 0));
  assert.deepEqual(source.assets[0].bytes, gif);
  await assert.rejects(context.forInput(input), /context_closed/);
});
test("ordinary source is passed to the converter byte-for-byte without image resources", async () => {
  const ordinary = changed("ppt/slides/slide1.xml", (xml) =>
    xml.replace(/r:link="[^"]+"/g, ""),
  );
  const context = await createPptxRenderResourceContext(ordinary, null);
  assert.equal((await context.forInput(ordinary)).assets.length, 0);
  assert.equal(
    await preparePptxRenderInput(ordinary.buffer, null),
    ordinary.buffer,
  );
  context.close();
});
