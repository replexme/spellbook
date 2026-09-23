import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import { accountPrefix, getObject, putObject } from "./storage";
import type { Session } from "./models";

export const IMAGE_ASSET_MAX_BYTES = 5_000_000;
export const MEDIA_ASSET_MAX_BYTES = 25_000_000;
export const ASSET_UPLOAD_MAX_BYTES = MEDIA_ASSET_MAX_BYTES;
const assetIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssetContentType =
  | "image/png"
  | "image/jpeg"
  | "audio/mpeg"
  | "audio/wav"
  | "audio/ogg"
  | "audio/mp4"
  | "video/mp4"
  | "video/webm";

const extensionByContentType: Record<AssetContentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function normalizedClaimedType(value: string): string {
  return value === "audio/x-wav" ? "audio/wav" : value;
}

function mediaContentType(data: Buffer): AssetContentType | "iso-media" | "" {
  if (data.length < 12) return "";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WAVE"
  )
    return "audio/wav";
  if (data.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (
    data.toString("ascii", 0, 3) === "ID3" ||
    (data[0] === 0xff && (data[1]! & 0xe0) === 0xe0)
  )
    return "audio/mpeg";
  if (
    data[0] === 0x1a &&
    data[1] === 0x45 &&
    data[2] === 0xdf &&
    data[3] === 0xa3
  )
    return "video/webm";
  if (data.toString("ascii", 4, 8) === "ftyp") return "iso-media";
  return "";
}

export function imageInfo(data: Buffer) {
  let width = 0,
    height = 0,
    contentType: "image/png" | "image/jpeg" | "" = "";
  if (
    data.length >= 33 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
    contentType = "image/png";
  } else if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        contentType = "image/jpeg";
        break;
      }
      offset += length;
    }
  }
  if (
    !contentType ||
    !width ||
    !height ||
    width * height > 16_000_000 ||
    data.length > IMAGE_ASSET_MAX_BYTES
  )
    throw new HttpError(400, "image_requires_png_or_jpeg_under_5mb_and_16mp");
  return { width, height, contentType };
}

export function assetInfo(
  data: Buffer,
  claimedType: string,
): {
  width: number;
  height: number;
  contentType: AssetContentType;
  kind: "image" | "media";
} {
  const normalized = normalizedClaimedType(claimedType);
  if (normalized === "image/png" || normalized === "image/jpeg") {
    const info = imageInfo(data);
    if (info.contentType !== normalized)
      throw new HttpError(400, "asset_content_type_mismatch");
    return { ...info, kind: "image" as const };
  }
  if (data.length > MEDIA_ASSET_MAX_BYTES)
    throw new HttpError(413, "media_too_large");
  const detected = mediaContentType(data);
  const contentType =
    detected === "iso-media" && ["audio/mp4", "video/mp4"].includes(normalized)
      ? (normalized as AssetContentType)
      : detected;
  if (!contentType || contentType !== normalized)
    throw new HttpError(400, "unsupported_or_invalid_media");
  return {
    width: 0,
    height: 0,
    contentType: contentType as AssetContentType,
    kind: "media",
  };
}

export async function uploadAsset(
  session: Session,
  documentId: string,
  file: File,
) {
  await ensureSchema();
  const [document] =
    await db()`select id from spellbook_documents where id = ${documentId} and account_id = ${session.accountId}`;
  if (!document) throw new HttpError(404, "document_not_found");
  if (file.size > ASSET_UPLOAD_MAX_BYTES)
    throw new HttpError(413, "asset_too_large");
  const data = Buffer.from(await file.arrayBuffer());
  return saveAsset(
    session.accountId,
    documentId,
    data,
    file.name.slice(0, 200),
    file.type,
  );
}

export async function getAsset(
  session: Session,
  documentId: string,
  assetId: string,
) {
  await ensureSchema();
  if (!assetIdPattern.test(assetId))
    throw new HttpError(404, "asset_not_found");
  const [asset] = await db()`
    select a.object_name, a.content_type
    from spellbook_assets a
    join spellbook_documents d on d.id=a.document_id
    where a.id=${assetId} and a.document_id=${documentId}
      and d.account_id=${session.accountId}
  `;
  if (!asset) throw new HttpError(404, "asset_not_found");
  return {
    data: await getObject(asset.object_name),
    contentType: asset.content_type as string,
  };
}

export async function saveImageAsset(
  accountId: string,
  documentId: string,
  data: Buffer,
  fileName: string,
) {
  return saveAsset(
    accountId,
    documentId,
    data,
    fileName,
    imageInfo(data).contentType,
  );
}

// Ownership is decided before anything about the upload, so a caller who does
// not own the document learns nothing from validation errors.
async function requireOwnedDocument(accountId: string, documentId: string) {
  await ensureSchema();
  const [document] =
    await db()`select id from spellbook_documents where id = ${documentId} and account_id = ${accountId}`;
  if (!document) throw new HttpError(404, "document_not_found");
}

export async function saveAsset(
  accountId: string,
  documentId: string,
  data: Buffer,
  fileName: string,
  claimedType: string,
) {
  await requireOwnedDocument(accountId, documentId);
  if (data.length > ASSET_UPLOAD_MAX_BYTES)
    throw new HttpError(413, "asset_too_large");
  const info = assetInfo(data, claimedType);
  const id = randomUUID();
  if (info.kind === "image") {
    try {
      await sharp(data, {
        limitInputPixels: 16_000_000,
        failOn: "warning",
      }).stats();
    } catch {
      throw new HttpError(400, "invalid_image_data");
    }
  }
  const extension = extensionByContentType[info.contentType];
  const object = `${accountPrefix(accountId, documentId)}/assets/${id}.${extension}`;
  await putObject(object, data, info.contentType);
  const safeFileName =
    fileName
      .replace(/[\u0000-\u001f\u007f/\\]/gu, "-")
      .trim()
      .slice(0, 200) || `asset.${extension}`;
  await db()`insert into spellbook_assets (id, document_id, file_name, object_name, content_type, width, height) values (${id}, ${documentId}, ${safeFileName}, ${object}, ${info.contentType}, ${info.width}, ${info.height})`;
  return { assetId: id, fileName: safeFileName, ...info };
}

// Compatibility entry point for callers that promise an image-only flow.
// Keep this narrower than uploadAsset so an existing image-generation caller
// cannot accidentally start accepting audio or video after the shared storage
// boundary was widened.
export async function uploadImage(
  session: Session,
  documentId: string,
  file: File,
) {
  await requireOwnedDocument(session.accountId, documentId);
  if (!normalizedClaimedType(file.type).startsWith("image/"))
    throw new HttpError(400, "image_requires_png_or_jpeg_under_5mb_and_16mp");
  return uploadAsset(session, documentId, file);
}
export const getImageAsset = getAsset;
