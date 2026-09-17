// SPDX-License-Identifier: MPL-2.0

const typeDescriptionAnchor =
  "      case Module.uno.com.sun.star.uno.TypeClass.ANY:\n" +
  "        return Module.uno_Type.Any();\n";

const typedefCase =
  "      case Module.uno.com.sun.star.uno.TypeClass.TYPEDEF:\n" +
  "        {\n" +
  "          const indirect = Module.uno.com.sun.star.reflection.XIndirectTypeDescription.query(td);\n" +
  "          const referenced = indirect.getReferencedType();\n" +
  "          indirect.delete();\n" +
  "          return translateTypeDescriptionAndDelete(referenced);\n" +
  "        }\n";

export function applyZetaJsOverlay(source) {
  if (typeof source !== "string")
    throw new TypeError("Pinned ZetaJS source must be text.");
  const first = source.indexOf(typeDescriptionAnchor);
  if (first < 0 || source.indexOf(typeDescriptionAnchor, first + 1) >= 0)
    throw new Error("Pinned ZetaJS type-description anchor has drifted.");
  if (source.includes(typedefCase))
    throw new Error("Pinned ZetaJS already contains the typedef overlay.");
  return source.replace(
    typeDescriptionAnchor,
    typeDescriptionAnchor + typedefCase,
  );
}
