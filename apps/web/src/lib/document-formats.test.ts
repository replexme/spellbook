import { describe, expect, it } from "vitest";

import {
  availableDocumentFormatForFile,
  browserViewFormatIds,
  contentTypeForName,
  currentPresentationFormat,
  documentBaseName,
  documentFormatOf,
  documentFormats,
  importAccept,
} from "./document-formats";

describe("document format registry", () => {
  it("keeps the current PPTX vertical available", () => {
    expect(availableDocumentFormatForFile("deck.PPTX")?.id).toBe("pptx");
    expect(currentPresentationFormat.editor.kind).toBe("browser");
  });

  it("opens InDesign documents in the browser document view", () => {
    expect(availableDocumentFormatForFile("issue.IDML")?.id).toBe("idml");
    expect(browserViewFormatIds).toEqual(["pptx", "idml"]);
    expect(importAccept).toContain(".idml");
    expect(contentTypeForName("issue.idml")).toBe("application/vnd.adobe.indesign-idml-package");
    expect(contentTypeForName("deck.pptx")).toBe(currentPresentationFormat.mimeTypes[0]);
  });

  it("treats rows without a known format as PowerPoint", () => {
    expect(documentFormatOf(null).id).toBe("pptx");
    expect(documentFormatOf("idml").extensions).toEqual([".idml"]);
  });

  it("drops only a document extension from a name", () => {
    expect(documentBaseName("Spring issue.idml")).toBe("Spring issue");
    expect(documentBaseName("Deck.PPTX")).toBe("Deck");
    expect(documentBaseName("notes.txt")).toBe("notes.txt");
  });

  it("does not expose planned adapters as implemented features", () => {
    expect(availableDocumentFormatForFile("draft.docx")).toBeNull();
    expect(availableDocumentFormatForFile("book.spellbook")).toBeNull();
    expect(
      documentFormats().filter((format) => format.availability === "planned"),
    ).toHaveLength(2);
  });
});
