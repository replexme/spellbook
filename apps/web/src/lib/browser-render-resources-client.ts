import type { LinkedImageManifest } from "../../../../services/document-resources/linked-image-snapshots.mjs";
export interface BrowserRenderResources {
  manifest: LinkedImageManifest;
  assets: Array<
    LinkedImageManifest["images"][number] & {
      sourceSha256: string;
      bytes: ArrayBuffer;
    }
  >;
}
const hash = async (bytes: ArrayBuffer) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");

/** Download each private image once. URLs are constructed from this document. */
export async function readBrowserRenderResources(
  contentApiBase: string,
  revision: string,
  documentId: string,
  manifest: LinkedImageManifest | null,
): Promise<BrowserRenderResources | null> {
  if (!manifest) return null;
  if (
    manifest.documentId !== documentId ||
    !revision.endsWith(`:${manifest.sourceSha256}"`) ||
    manifest.images.length > 64
  )
    throw Error("browser_render_resource_identity_mismatch");
  const records = [
    ...new Map(manifest.images.map((image) => [image.sha256, image])).values(),
  ];
  if (records.reduce((n, image) => n + image.byteLength, 0) > 32_000_000)
    throw Error("browser_render_resource_size_invalid");
  const blobs = new Map<string, ArrayBuffer>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, records.length) }, async () => {
      while (next < records.length) {
        const image = records[next++]!;
        if (
          !/^[a-f0-9]{64}$/.test(image.sha256) ||
          !Number.isSafeInteger(image.byteLength) ||
          image.byteLength < 1 ||
          image.byteLength > 5_000_000
        )
          throw Error("browser_render_resource_identity_mismatch");
        const response = await fetch(
          `${contentApiBase}/render-resources?sha256=${image.sha256}`,
          {
            headers: { "if-match": revision },
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (
          !response.ok ||
          response.headers.get("etag") !== revision ||
          response.headers.get("content-type") !== image.contentType
        )
          throw Error("browser_render_resource_download_failed");
        const bytes = await response.arrayBuffer();
        if (
          bytes.byteLength !== image.byteLength ||
          (await hash(bytes)) !== image.sha256
        )
          throw Error("browser_render_resource_identity_mismatch");
        blobs.set(image.sha256, bytes);
      }
    }),
  );
  return {
    manifest,
    assets: manifest.images.map((image) => ({
      ...image,
      sourceSha256: manifest.sourceSha256,
      bytes: blobs.get(image.sha256)!,
    })),
  };
}
