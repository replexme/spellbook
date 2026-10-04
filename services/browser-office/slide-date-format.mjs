/* SPDX-License-Identifier: MPL-2.0 */
// Canonical DateTimeFormat uses the existing LibreOffice date/time nibbles.
// Enum source: https://github.com/LibreOffice/core/blob/master/include/editeng/flditem.hxx
// Export mapping: oox/source/export/drawingml.cxx, GetDatetimeTypeFromDateTime.
export function slideDateFieldType(format) {
  if(!Number.isSafeInteger(format)||format<0||format>255)throw Error("invalid_slide_date_format");
  const date=format&15,time=format>>>4;
  const dateType={2:"datetime1",3:"datetime2",4:"datetime1",5:"datetime1",6:"datetime5",7:"datetime3",8:"datetime2",9:"datetime2"}[date]??null;
  const timeType={2:"datetime11",3:"datetime10",4:"datetime11",5:"datetime11",6:"datetime12",7:"datetime13",8:"datetime13",9:"datetime12",10:"datetime13",11:"datetime13"}[time]??null;
  if(dateType&&timeType)return ["datetime11","datetime13"].includes(timeType)?"datetime9":"datetime8";
  if(!dateType&&!timeType)throw Error("unsupported_slide_date_format");
  return dateType??timeType;
}
