/* SPDX-License-Identifier: MPL-2.0 */

// SDK 9.3 converts twips to millimetres, then truncates mm*7200/25.4
// when writing PPTX's hundredths of a point. For 2pt the ordinary conversion
// writes 199 instead of 200. Choose the nearest floating-point input that
// survives that exact writer; never change the requested OOXML integer.
export function onlyOfficeCharacterSpacingTwips(points) {
  if (
    !Number.isFinite(points) ||
    points < -100 ||
    points > 100 ||
    Math.abs(points * 100 - Math.round(points * 100)) > 1e-8
  )
    throw Error("onlyoffice_product_argument_invalid:spacing");
  const wanted = Math.round(points * 100);
  let twips = points * 20;
  for (let attempt = 0; attempt < 8; attempt++) {
    const millimetres = (25.4 / 72 / 20) * twips;
    if (Math.trunc((millimetres * 7200) / 25.4) === wanted) return twips;
    twips += Math.sign(points) * Math.max(Math.abs(twips), 1) * Number.EPSILON;
  }
  throw Error("onlyoffice_product_spacing_not_serializable");
}
