/* SPDX-License-Identifier: MPL-2.0 */
// PPTX crop percentages have three decimal places. Canonicalize only floating
// point noise around those exact decimals; retain any real sub-unit difference.
export function onlyOfficeCropObservation(rectangle) {
  return rectangle == null
    ? null
    : Object.fromEntries(
        Object.entries(rectangle).map(([key, value]) => {
          const decimal = Math.round(value * 1000) / 1000;
          return [
            key,
            Number.isFinite(value) &&
            Math.abs(value - decimal) <=
              Math.max(Math.abs(value), 100) * Number.EPSILON * 8
              ? decimal
              : value,
          ];
        }),
      );
}
