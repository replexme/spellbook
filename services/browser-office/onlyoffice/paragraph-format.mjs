/* SPDX-License-Identifier: MPL-2.0 */
// The pinned PPTY writer truncates indents in EMU and paragraph spacing in
// hundredths of a point. Commit the nearest representable native value before
// observation, rather than silently losing it on export or loosening readback.
export function onlyOfficeParagraphFormat(format) {
  if (!format || typeof format !== "object" || Array.isArray(format)) throw Error("onlyoffice_product_paragraph_format_invalid");
  const native = {indent:{},spacing:{}};
  const serializable = (value, toUnits, fromUnits, maxUnits = Infinity) => {
    if (!Number.isFinite(value)) throw Error("onlyoffice_product_paragraph_format_invalid");
    const units = Math.round(toUnits(value / 100)) || 0;
    if (units > maxUnits || maxUnits !== Infinity && value < 0) throw Error("onlyoffice_product_paragraph_spacing_not_serializable");
    let mm = fromUnits(units);
    for(let attempt=0;Math.trunc(toUnits(mm))!==units && attempt<8;attempt++)
      mm += Math.sign(units) * Math.max(Math.abs(mm),1) * Number.EPSILON;
    if (Math.trunc(toUnits(mm))!==units) throw Error("onlyoffice_product_paragraph_format_not_serializable");
    return mm;
  };
  for(const [key,field] of [["leftMargin","Left"],["rightMargin","Right"],["firstLineIndent","FirstLine"]])
    if(format[key]!=null)native.indent[field]=serializable(format[key],mm=>mm*36000,units=>units/36000);
  for(const [key,field] of [["topMargin","Before"],["bottomMargin","After"]])
    if(format[key]!=null)native.spacing[field]=serializable(format[key],mm=>mm/0.00352777778,units=>units*0.00352777778,158400);
  return native;
}
