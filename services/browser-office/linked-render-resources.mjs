/* SPDX-License-Identifier: MPL-2.0 */
import {
  inspectPptxLinkedImages,
  preparePptxLinkedRenderInput,
} from "./ooxml-worker-source.mjs";
import { inspectExternalRaster } from "./external-raster.mjs";
const sha = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
const same = (a, b) =>
  ["ownerPart", "relationshipPart", "relationshipId", "url"].every(
    (key) => a[key] === b[key],
  );
const asBytes = (value) =>
  value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;

/** Only an initial admitted file may establish the document's private pictures. */
export async function createPptxRenderResourceContext(input, snapshot) {
  const bytes = input.slice(),
    sourceSha256 = await sha(bytes),
    { links } = inspectPptxLinkedImages(bytes);
  const owned = new Map(),
    blobs = new Map();
  let closed = false,
    total = 0;
  if (links.length) {
    if (
      snapshot?.manifest?.sourceSha256 !== sourceSha256 ||
      !Array.isArray(snapshot.assets)
    )
      throw Error("external_image_source_binding_mismatch");
    for (const link of links) {
      const asset = snapshot.assets.find((value) => same(value, link)),
        data = asBytes(asset?.bytes);
      if (
        !data ||
        asset.sourceSha256 !== sourceSha256 ||
        !snapshot.manifest.images.some(
          (value) => same(value, link) && value.sha256 === asset.sha256,
        )
      )
        throw Error("external_image_source_binding_mismatch");
      const header = inspectExternalRaster(data);
      if ((await sha(data)) !== asset.sha256)
        throw Error("external_image_payload_hash_mismatch");
      const prior = owned.get(link.url);
      if (prior && prior.sha256 !== asset.sha256)
        throw Error("external_image_url_snapshot_ambiguous");
      if (!prior) {
        if (!blobs.has(asset.sha256)) {
          total += data.length;
          blobs.set(asset.sha256, data.slice());
        }
        owned.set(link.url, {
          ...header,
          sha256: asset.sha256,
          bytes: blobs.get(asset.sha256),
        });
      }
      if (total > 32_000_000)
        throw Error("external_image_document_budget_exceeded");
    }
  }
  return {
    async forInput(input) {
      if (closed) throw Error("external_image_context_closed");
      const bytes = input.slice(),
        sourceSha256 = await sha(bytes),
        { links, skipped } = inspectPptxLinkedImages(bytes);
      const assets = links.map((link) => {
        const image = owned.get(link.url);
        if (!image) throw Error("external_image_snapshot_relationship_missing");
        return { ...link, ...image, sourceSha256 };
      });
      return {
        manifest: {
          schemaVersion: 1,
          sourceSha256,
          images: assets.map(({ bytes, ...image }) => ({
            ...image,
            byteLength: bytes.length,
          })),
          skipped,
        },
        assets,
      };
    },
    close() {
      closed = true;
      for (const image of owned.values()) image.bytes.fill(0);
      owned.clear();
      blobs.clear();
    },
  };
}

/** Fonts are prepared from the original file; only the converter sees this projection. */
export async function preparePptxRenderInput(input, snapshot, { signal } = {}) {
  if (!input) return input;
  const bytes = new Uint8Array(input),
    { links } = inspectPptxLinkedImages(bytes);
  if (!links.length) return input;
  const sourceSha256 = await sha(bytes);
  if (
    snapshot?.manifest?.sourceSha256 !== sourceSha256 ||
    !Array.isArray(snapshot.assets)
  )
    throw Error("external_image_source_binding_mismatch");
  const prepared = await preparePptxLinkedRenderInput(bytes, {
    signal,
    resolveImage: async (request) => {
      const asset = snapshot.assets.find((value) => same(value, request));
      if (!asset) throw Error("external_image_snapshot_relationship_missing");
      return { ...asset, bytes: asBytes(asset.bytes) };
    },
  });
  return prepared.bytes.buffer;
}
