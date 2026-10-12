import registry from "../../../../contracts/document-formats.json";

export type DocumentFormatId = "pptx" | "idml" | "docx" | "spellbook";
export type DocumentFormatAvailability =
  | "beta"
  | "experimental"
  | "planned"
  | "unsupported";

export interface DocumentFormat {
  id: DocumentFormatId;
  label: string;
  availability: DocumentFormatAvailability;
  extensions: string[];
  mimeTypes: string[];
  maxBytes: number;
  editor: {
    kind: "wopi" | "native" | "none";
    wopiApp: string | null;
    wopiAction: string | null;
  };
  semantics: {
    unit: string;
    rootCollection: string;
    outputKind: string;
  };
}

const formats = registry.formats as DocumentFormat[];

export function documentFormats(): readonly DocumentFormat[] {
  return formats;
}

export function documentFormat(id: DocumentFormatId): DocumentFormat {
  const format = formats.find((candidate) => candidate.id === id);
  if (!format) throw new Error(`Unknown document format: ${id}`);
  return format;
}

export function availableDocumentFormatForFile(
  fileName: string,
): DocumentFormat | null {
  const normalized = fileName.trim().toLowerCase();
  return (
    formats.find(
      (format) =>
        ["beta", "experimental"].includes(format.availability) &&
        format.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}

export const currentPresentationFormat = documentFormat("pptx");

/** A document's format by its stored id; rows from before formats were recorded are PowerPoint. */
export function documentFormatOf(id: string | null | undefined): DocumentFormat {
  return formats.find((format) => format.id === id) ?? currentPresentationFormat;
}

/** Formats the browser document view opens: PowerPoint decks and InDesign (IDML) documents. */
export const browserViewFormatIds: readonly DocumentFormatId[] = ["pptx", "idml"];

/** Extensions and media types the file picker offers (formats that can be imported). */
export const importAccept = formats
  .filter((format) => ["beta", "experimental"].includes(format.availability))
  .flatMap((format) => [...format.extensions, ...format.mimeTypes])
  .join(",");

/** The format of a document file, by its extension (PowerPoint when unknown). */
export function documentFormatForName(name: string): DocumentFormat {
  const lower = name.trim().toLowerCase();
  return formats.find((f) => f.extensions.some((e) => lower.endsWith(e))) ?? currentPresentationFormat;
}

/** The media type of a document file, by its extension (PowerPoint when unknown). */
export function contentTypeForName(name: string): string {
  return documentFormatForName(name).mimeTypes[0]!;
}

const programs: Record<DocumentFormatId, string> = {
  pptx: "PowerPoint",
  idml: "InDesign",
  docx: "Word",
  spellbook: "Spellbook",
};

/** The program people make and open files of this format in. */
export function documentProgram(format: DocumentFormat): string {
  return programs[format.id];
}

/** What a file of this format is called ("PowerPoint 프레젠테이션", "InDesign 문서"). */
export function documentKind(format: DocumentFormat): string {
  return format.id === "pptx" ? "PowerPoint 프레젠테이션" : `${programs[format.id]} 문서`;
}

/** How its pages are counted ("장" for slides, "쪽" for pages). */
export function documentCountWord(format: DocumentFormat): string {
  return format.semantics.unit === "slide" ? "장" : "쪽";
}

/** Media types of the formats the browser document view opens. */
export const browserViewMediaTypes: readonly string[] = formats
  .filter((format) => browserViewFormatIds.includes(format.id))
  .flatMap((format) => format.mimeTypes);

/** `name` without its document extension (.pptx, .idml). */
export function documentBaseName(name: string): string {
  const lower = name.toLowerCase();
  const extension = formats.flatMap((format) => format.extensions).find((e) => lower.endsWith(e));
  return extension ? name.slice(0, -extension.length) : name;
}
