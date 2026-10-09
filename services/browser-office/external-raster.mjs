/* SPDX-License-Identifier: MPL-2.0 */
// Header limits precede browser decoding; never trust MIME
// supplied by a remote response or resolver.
export function inspectExternalRaster(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 5_000_000
  )
    throw Error("external_image_payload_size_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  let width = 0,
    height = 0,
    contentType,
    extension;
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) &&
    view.getUint32(8) === 13 &&
    text(12, 16) === "IHDR"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    contentType = "image/png";
    extension = "png";
  } else if (bytes.length >= 13 && /^GIF8[79]a$/.test(text(0, 6))) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
    contentType = "image/gif";
    extension = "gif";
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        contentType = "image/jpeg";
        extension = "jpeg";
        break;
      }
      offset += length;
    }
  }
  if (!contentType) throw Error("external_image_payload_format_invalid");
  if (!width || !height || width * height > 16_000_000)
    throw Error("external_image_dimensions_invalid");
  return { width, height, contentType, extension };
}

export async function validateExternalRaster(bytes, { signal } = {}) {
  const info = inspectExternalRaster(bytes);
  if (signal?.aborted) throw Error("external_image_context_closed");
  if (typeof globalThis.createImageBitmap !== "function")
    throw Error("external_image_decoder_required");
  let bitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes], { type: info.contentType }),
      { imageOrientation: "none" },
    );
    if (signal?.aborted) throw Error("external_image_context_closed");
    if (bitmap.width !== info.width || bitmap.height !== info.height)
      throw Error("external_image_decoded_dimensions_mismatch");
    return info;
  } catch (error) {
    if (error.message?.startsWith("external_image_")) throw error;
    throw Error("external_image_decode_failed");
  } finally {
    bitmap?.close();
  }
}
