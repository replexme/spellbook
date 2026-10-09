/* SPDX-License-Identifier: MPL-2.0 */
import { createHash } from "node:crypto";
import { inspectExternalRaster } from "../browser-office/external-raster.mjs";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const sameLink = (a, b) =>
  ["ownerPart", "relationshipPart", "relationshipId", "url"].every(
    (key) => a[key] === b[key],
  );
export const identity = (value) =>
  digest(
    Buffer.from(
      JSON.stringify([
        value.ownerPart,
        value.relationshipPart,
        value.relationshipId,
        value.url,
      ]),
    ),
  );
export const maxImageBytes = 5_000_000,
  maxDocumentBytes = 32_000_000;

export function validateOwner({ accountId, documentId }) {
  if (
    typeof accountId !== "string" ||
    !accountId ||
    accountId.length > 2000 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      documentId ?? "",
    )
  )
    throw Error("external_image_owner_required");
}
export function validateManifest(
  value,
  { accountId, documentId, sourceSha256 },
  links = null,
) {
  if (
    value?.schemaVersion !== 1 ||
    value.accountId !== accountId ||
    value.documentId !== documentId ||
    value.sourceSha256 !== sourceSha256 ||
    !Array.isArray(value.images) ||
    value.images.length > 64
  )
    throw Error("external_image_manifest_binding_mismatch");
  const seen = new Set(),
    blobs = new Set();
  let total = 0;
  for (const image of value.images) {
    if (
      !validHash(image.sha256) ||
      !validHash(image.linkIdentity) ||
      image.linkIdentity !== identity(image) ||
      seen.has(image.linkIdentity) ||
      !Number.isSafeInteger(image.byteLength) ||
      image.byteLength < 1 ||
      image.byteLength > maxImageBytes
    )
      throw Error("external_image_manifest_invalid");
    seen.add(image.linkIdentity);
    if (!blobs.has(image.sha256)) {
      blobs.add(image.sha256);
      total += image.byteLength;
    }
  }
  if (total > maxDocumentBytes)
    throw Error("external_image_document_budget_exceeded");
  if (
    links &&
    (value.images.length !== links.length ||
      links.some(
        (link) => !value.images.some((image) => sameLink(image, link)),
      ))
  )
    throw Error("external_image_manifest_relationship_mismatch");
  return value;
}

/** Index reads neither the original PPTX nor every image payload. */
export async function readLinkedImageManifest({
  accountId,
  documentId,
  sourceSha256,
  sourceBytes,
  objectStore,
}) {
  const { accountPrefix, getObject, objectHead } =
    requireSnapshotStore(objectStore);
  validateOwner({ accountId, documentId });
  if (
    !validHash(sourceSha256) ||
    (sourceBytes !== undefined &&
      (!(sourceBytes instanceof Uint8Array) ||
        digest(sourceBytes) !== sourceSha256))
  )
    throw Error("external_image_source_binding_mismatch");
  const prefix = accountPrefix(accountId, documentId) + "/render-resources";
  const name = prefix + "/sources/" + sourceSha256 + ".json",
    head = await objectHead(name, 0);
  if (!head) {
    const error = Error("external_image_snapshot_missing");
    error.code = "ENOENT";
    throw error;
  }
  if (head.size > 1_000_000)
    throw Error("external_image_manifest_size_invalid");
  return validateManifest(JSON.parse((await getObject(name)).toString()), {
    accountId,
    documentId,
    sourceSha256,
  });
}

async function readManifestImage(scope, manifest, image) {
  const { accountPrefix, getObject, objectHead } = requireSnapshotStore(
    scope.objectStore,
  );
  const prefix =
    accountPrefix(scope.accountId, scope.documentId) + "/render-resources";
  const head = await objectHead(prefix + "/blobs/" + image.sha256, 0);
  if (!head || head.size !== image.byteLength)
    throw Error("external_image_payload_hash_mismatch");
  const bytes = await getObject(prefix + "/blobs/" + image.sha256);
  if (digest(bytes) !== image.sha256)
    throw Error("external_image_payload_hash_mismatch");
  const header = inspectExternalRaster(bytes);
  if (
    header.width !== image.width ||
    header.height !== image.height ||
    header.contentType !== image.contentType
  )
    throw Error("external_image_manifest_dimensions_mismatch");
  return { ...image, sourceSha256: manifest.sourceSha256, bytes };
}
export async function readOwnedLinkedImage(scope, sha256) {
  if (!validHash(sha256)) throw Error("external_image_hash_invalid");
  const manifest = await readLinkedImageManifest(scope),
    image = manifest.images.find((value) => value.sha256 === sha256);
  if (!image) throw Error("external_image_snapshot_relationship_missing");
  return readManifestImage(scope, manifest, image);
}
/** Native conversion uses each content-addressed payload once per document. */
export async function readOwnedLinkedImages(scope) {
  const manifest = await readLinkedImageManifest(scope),
    blobs = new Map(),
    assets = [];
  for (const image of manifest.images) {
    if (!blobs.has(image.sha256))
      blobs.set(image.sha256, await readManifestImage(scope, manifest, image));
    assets.push({
      ...image,
      sourceSha256: manifest.sourceSha256,
      bytes: blobs.get(image.sha256).bytes,
    });
  }
  return { manifest, assets };
}

export function requireSnapshotStore(store) {
  for (const key of ["accountPrefix", "getObject", "objectHead"])
    if (typeof store?.[key] !== "function")
      throw Error("external_image_object_store_required");
  return store;
}
