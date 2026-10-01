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

// BYTE scalars already map to signed JavaScript Numbers. Resolve the constant
// type/length once, preserving the public Array representation and ownership.
const byteSequenceAnchor =
  "          const td = type.getSequenceComponentType();\n" +
  "          const arr = [];\n" +
  "          for (let i = 0; i !== val.size(); ++i) {";
const byteSequenceReplacement =
  "          const td = type.getSequenceComponentType();\n" +
  "          if (td.getTypeClass() === Module.uno.com.sun.star.uno.TypeClass.BYTE) {\n" +
  "            try {\n" +
  "              const size = val.size();\n" +
  "              const bytes = new Array(size);\n" +
  "              for (let i = 0; i !== size; ++i) bytes[i] = val.get(i);\n" +
  "              return bytes;\n" +
  "            } finally {\n" +
  "              if (cleanUpVal) val.delete();\n" +
  "              td.delete();\n" +
  "            }\n" +
  "          }\n" +
  "          const arr = [];\n" +
  "          for (let i = 0; i !== val.size(); ++i) {";

export function applyZetaByteSequenceOverlay(source) {
  if (typeof source !== "string")
    throw new TypeError("Pinned ZetaJS source must be text.");
  if (source.includes(byteSequenceReplacement))
    throw new Error(
      "Pinned ZetaJS already contains the byte sequence overlay.",
    );
  const first = source.indexOf(byteSequenceAnchor);
  if (first < 0 || source.indexOf(byteSequenceAnchor, first + 1) >= 0)
    throw new Error("Pinned ZetaJS byte sequence anchor has drifted.");
  return source.replace(byteSequenceAnchor, () => byteSequenceReplacement);
}
