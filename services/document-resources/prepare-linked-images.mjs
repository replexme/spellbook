/* SPDX-License-Identifier: MPL-2.0 */
import { fetchLinkedPublicImage } from "./public-image-reader.mjs";
import { inspectPptxLinkedImages } from "../browser-office/ooxml-worker-source.mjs";
import { inspectExternalRaster } from "../browser-office/external-raster.mjs";
import {
  digest,
  validHash,
  sameLink,
  identity,
  maxImageBytes,
  maxDocumentBytes,
  validateOwner,
  validateManifest,
  readLinkedImageManifest,
  readOwnedLinkedImages,
  readOwnedLinkedImage,
  requireSnapshotStore,
} from "./linked-image-snapshots.mjs";
async function abortable(work, signal) {
  signal.throwIfAborted();
  let cancel;
  const stopped = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** The worker calls this with an admitted owned source; callers cannot supply URLs. */
export async function prepareOwnedLinkedImages({
  accountId,
  documentId,
  sourceBytes,
  parentSourceSha256 = null,
  fetchImage = fetchLinkedPublicImage,
  validateImage,
  signal,
  objectStore,
}) {
  const { accountPrefix, getObject, putObjectIfAbsent } =
    requireSnapshotStore(objectStore);
  if (typeof putObjectIfAbsent !== "function")
    throw Error("external_image_atomic_object_store_required");
  validateOwner({ accountId, documentId });
  if (
    !(sourceBytes instanceof Uint8Array) ||
    !sourceBytes.length ||
    sourceBytes.length > 64 * 1024 * 1024
  )
    throw Error("external_image_package_size_invalid");
  if (typeof validateImage !== "function")
    throw Error("external_image_decoder_required");
  sourceBytes = sourceBytes.slice();
  const sourceSha256 = digest(sourceBytes),
    scope = { accountId, documentId, sourceSha256, objectStore };
  const { links, skipped } = inspectPptxLinkedImages(sourceBytes);
  if (!links.length)
    return {
      manifest: {
        schemaVersion: 1,
        accountId,
        documentId,
        sourceSha256,
        images: [],
        skipped,
      },
      reused: 0,
      fetched: 0,
    };
  const prefix = accountPrefix(accountId, documentId) + "/render-resources";
  const manifestObject = prefix + "/sources/" + sourceSha256 + ".json";
  try {
    const existing = validateManifest(
      await readLinkedImageManifest(scope),
      scope,
      links,
    );
    await readOwnedLinkedImages({ ...scope, sourceBytes });
    return { manifest: existing, reused: existing.images.length, fetched: 0 };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let parent = null;
  if (parentSourceSha256 !== null) {
    if (!validHash(parentSourceSha256))
      throw Error("external_image_parent_source_invalid");
    try {
      parent = await readLinkedImageManifest({
        accountId,
        documentId,
        sourceSha256: parentSourceSha256,
        objectStore,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const images = [],
    resolved = new Map(),
    blobs = new Set();
  let reused = 0,
    fetched = 0,
    total = 0;
  for (const link of links) {
    bounded.throwIfAborted();
    const prior = parent?.images.find((image) => image.url === link.url);
    let image = resolved.get(link.url);
    if (!image) {
      const bytes = prior
        ? (
            await readOwnedLinkedImage(
              {
                accountId,
                documentId,
                sourceSha256: parentSourceSha256,
                objectStore,
              },
              prior.sha256,
            )
          ).bytes
        : await abortable(
            () => fetchImage(link.url, { signal: bounded }),
            bounded,
          );
      bounded.throwIfAborted();
      const header = inspectExternalRaster(bytes),
        sha256 = digest(bytes);
      if (
        prior &&
        (sha256 !== prior.sha256 ||
          bytes.length !== prior.byteLength ||
          header.width !== prior.width ||
          header.height !== prior.height ||
          header.contentType !== prior.contentType)
      )
        throw Error("external_image_payload_hash_mismatch");
      if (!prior) {
        const decoded = await abortable(
          () => validateImage(bytes, { signal: bounded }),
          bounded,
        );
        if (
          decoded?.width !== header.width ||
          decoded?.height !== header.height ||
          decoded?.contentType !== header.contentType
        )
          throw Error("external_image_decoded_dimensions_mismatch");
        fetched++;
      }
      image = { ...header, sha256, byteLength: bytes.length };
      resolved.set(link.url, image);
      if (!blobs.has(sha256)) {
        blobs.add(sha256);
        total += bytes.length;
        if (total > maxDocumentBytes)
          throw Error("external_image_document_budget_exceeded");
        if (!prior) {
          await putObjectIfAbsent(
            prefix + "/blobs/" + sha256,
            Buffer.from(bytes),
            header.contentType,
          );
          if (digest(await getObject(prefix + "/blobs/" + sha256)) !== sha256)
            throw Error("external_image_payload_hash_mismatch");
        }
      }
    }
    images.push({ ...link, ...image, linkIdentity: identity(link) });
    if (prior) reused++;
  }
  bounded.throwIfAborted();
  const manifest = {
    schemaVersion: 1,
    accountId,
    documentId,
    sourceSha256,
    images,
    skipped,
  };
  await putObjectIfAbsent(
    manifestObject,
    Buffer.from(JSON.stringify(manifest)),
    "application/json",
  );
  // Racing producers agree on the first committed immutable manifest; never
  // return a losing resolver's different picture as the admitted snapshot.
  const committed = validateManifest(
    await readLinkedImageManifest(scope),
    scope,
    links,
  );
  await readOwnedLinkedImages({ ...scope, sourceBytes });
  return { manifest: committed, reused, fetched };
}
