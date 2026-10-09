/* SPDX-License-Identifier: MPL-2.0 */
// The converter retains original metafiles next to its derived SVG previews.
// Decode those owned originals through the initialized native drawing module;
// the existing SVG font gate then owns typography and document disposal.
export async function prepareOnlyOfficeNativeMetafile(
  previewUrl,
  { ownedUrls, origin, signal, fetchBytes = globalThis.fetch, renderSvg } = {},
) {
  const entries = Object.entries(ownedUrls ?? {});
  const previews = entries.filter(
    ([name, url]) => url === previewUrl && /\.svg$/i.test(name),
  );
  const sources = new Map();
  for (const [preview] of previews) {
    const stem = preview.slice(0, -4);
    for (const [name, url] of entries) {
      if (
        name.slice(0, -4) === stem &&
        /\.(emf|wmf)$/i.test(name)
      ) sources.set(url, { name, url });
    }
  }
  if (!sources.size) return null;
  if (sources.size !== 1)
    throw Error("onlyoffice_metafile_source_ambiguous");
  const { name, url } = sources.values().next().value;
  if (
    typeof origin !== "string" ||
    typeof url !== "string" ||
    !url.startsWith("blob:" + origin + "/")
  ) throw Error("onlyoffice_metafile_source_not_owned");
  signal?.throwIfAborted();
  const encode = renderSvg ?? globalThis.AscFonts?.RenderMetafileSvg;
  if (typeof encode !== "function")
    throw Error("onlyoffice_metafile_native_api_unavailable");
  const response = await fetchBytes(url, { signal });
  if (!response.ok) throw Error("onlyoffice_metafile_source_read_failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  if (bytes.length < 18 || bytes.length > 25_000_000)
    throw Error("onlyoffice_metafile_input_size_invalid");
  const sourceSha256 = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ].map(byte => byte.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  const source = encode(bytes);
  if (
    typeof source !== "string" ||
    !source.length ||
    new TextEncoder().encode(source).length > 8 * 1024 * 1024
  ) throw Error("onlyoffice_metafile_output_size_invalid");
  return { source, sourceName: name, sourceSha256, sourceBytes: bytes.length };
}
