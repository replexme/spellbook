/*
 * Downloads one of the document's stored images or media files for the
 * editor and checks its type, size and leading bytes before the editor
 * inserts it.
 */

export interface EditorAsset {
  mediaType: string;
  bytes: ArrayBuffer;
  fileName: string;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function isEditorAssetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function loadEditorAsset(
  documentId: string,
  assetId: string,
): Promise<EditorAsset> {
  if (!isEditorAssetId(assetId)) throw new Error("invalid_document_asset");
  const response = await fetch(
    new URL(
      `/api/documents/${documentId}/assets/${assetId}`,
      window.location.origin,
    ),
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("asset_download_failed");
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
  if (!mediaType || !EXTENSIONS[mediaType])
    throw new Error("invalid_asset_type");
  const bytes = await response.arrayBuffer();
  const maximumBytes = mediaType.startsWith("image/") ? 5_000_000 : 25_000_000;
  if (!bytes.byteLength || bytes.byteLength > maximumBytes)
    throw new Error("invalid_asset_size");
  const signature = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
  const png =
    signature.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => signature[index] === value,
    );
  const jpeg = signature[0] === 0xff && signature[1] === 0xd8;
  const textAt = (start: number, end: number) =>
    String.fromCharCode(...signature.slice(start, end));
  const mediaSignature =
    (mediaType === "audio/mpeg" &&
      (textAt(0, 3) === "ID3" ||
        (signature[0] === 0xff && (signature[1]! & 0xe0) === 0xe0))) ||
    (mediaType === "audio/wav" &&
      textAt(0, 4) === "RIFF" &&
      textAt(8, 12) === "WAVE") ||
    (mediaType === "audio/ogg" && textAt(0, 4) === "OggS") ||
    (mediaType === "video/webm" &&
      signature[0] === 0x1a &&
      signature[1] === 0x45 &&
      signature[2] === 0xdf &&
      signature[3] === 0xa3) ||
    (["audio/mp4", "video/mp4"].includes(mediaType) && textAt(4, 8) === "ftyp");
  if (
    (mediaType === "image/png" && !png) ||
    (mediaType === "image/jpeg" && !jpeg) ||
    (!mediaType.startsWith("image/") && !mediaSignature)
  )
    throw new Error("invalid_asset_bytes");
  return {
    mediaType,
    bytes,
    fileName: `${assetId}.${EXTENSIONS[mediaType]}`,
  };
}
