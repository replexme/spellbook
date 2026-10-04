/* SPDX-License-Identifier: MPL-2.0 */
// SDK 9.3 writes alpha as trunc(transparent * 100000 / 255).
// Canonical opacity is percent; OOXML preserves thousandths of a percent.
export function onlyOfficeOpacityNative(percent) {
  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    Math.abs(percent * 1000 - Math.round(percent * 1000)) > 1e-7
  )
    throw Error("onlyoffice_product_argument_invalid:opacity");
  const wanted = Math.round(percent * 1000);
  let alpha = (percent * 255) / 100;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (Math.trunc((alpha * 100000) / 255) === wanted) return alpha;
    alpha += Math.max(Math.abs(alpha), 1) * Number.EPSILON;
  }
  throw Error("onlyoffice_product_opacity_not_serializable");
}
