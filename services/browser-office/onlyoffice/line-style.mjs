/* SPDX-License-Identifier: MPL-2.0 */
// Pinned SDK 9.3 c_oDashType, LineEndType and LineEndSize values.
const dashes = {
  dash: 0,
  dashDot: 1,
  dot: 2,
  lgDash: 3,
  lgDashDot: 4,
  lgDashDotDot: 5,
  solid: 6,
  sysDash: 7,
  sysDashDot: 8,
  sysDashDotDot: 9,
  sysDot: 10,
};
const types = {
  none: 0,
  arrow: 1,
  diamond: 2,
  oval: 3,
  stealth: 4,
  triangle: 5,
};
const sizes = { lg: 0, med: 1, sm: 2 };

export function onlyOfficeLineStylePatch(style) {
  if (!style || typeof style !== "object" || Array.isArray(style))
    throw Error("onlyoffice_product_argument_invalid:lineStyle");
  const result = {};
  if (style.dash != null) {
    if (!Object.hasOwn(dashes, style.dash))
      throw Error("onlyoffice_product_argument_invalid:dash");
    result.dash = dashes[style.dash];
  }
  for (const [key, native] of [
    ["startArrow", "headEnd"],
    ["endArrow", "tailEnd"],
  ]) {
    const arrow = style[key];
    if (arrow == null) continue;
    if (
      !Object.hasOwn(types, arrow.type) ||
      !Object.hasOwn(sizes, arrow.width ?? "med") ||
      !Object.hasOwn(sizes, arrow.length ?? "med")
    )
      throw Error("onlyoffice_product_argument_invalid:" + key);
    result[native] =
      arrow.type === "none"
        ? null
        : {
            type: types[arrow.type],
            w: sizes[arrow.width ?? "med"],
            len: sizes[arrow.length ?? "med"],
          };
  }
  if (!Object.keys(result).length)
    throw Error("onlyoffice_product_argument_invalid:empty_lineStyle");
  return result;
}
