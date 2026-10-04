/* SPDX-License-Identifier: MPL-2.0 */
// Browser diagnostics cross a JSON transport. Keep package bytes compact;
// production in-browser artifact authority receives Uint8Array directly.
const maximumBytes = 64 * 1024 * 1024;
export function encodeBinary(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > maximumBytes)
    throw Error("binary_transfer_invalid");
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export function decodeBinary(value) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximumBytes / 3) * 4
  )
    throw Error("binary_transfer_invalid");
  const text = atob(value);
  if (text.length > maximumBytes) throw Error("binary_transfer_invalid");
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
