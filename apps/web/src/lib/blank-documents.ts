import { BLANK_IDML_BASE64, BLANK_PPTX_BASE64 } from "./blank-documents.data";
import type { DocumentFormatId } from "./document-formats";

/** What a new, empty document of each format starts as: its file name and bytes. */
export function blankDocument(formatId: DocumentFormatId): { fileName: string; bytes: Buffer } | null {
  switch (formatId) {
    case "pptx":
      return { fileName: "새 프레젠테이션.pptx", bytes: Buffer.from(BLANK_PPTX_BASE64, "base64") };
    case "idml":
      return { fileName: "새 InDesign 문서.idml", bytes: Buffer.from(BLANK_IDML_BASE64, "base64") };
    default:
      return null;
  }
}
