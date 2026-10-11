import { describe, expect, it } from "vitest";

import { blankDocument } from "./blank-documents";

describe("blank documents", () => {
  it("starts a deck and an InDesign document as their own packages", () => {
    const pptx = blankDocument("pptx")!;
    expect(pptx.fileName.endsWith(".pptx")).toBe(true);
    expect(pptx.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(pptx.bytes.includes(Buffer.from("ppt/presentation.xml"))).toBe(true);
    const idml = blankDocument("idml")!;
    expect(idml.fileName.endsWith(".idml")).toBe(true);
    // IDML: the first, stored entry is the mimetype.
    expect(idml.bytes.subarray(30, 38).toString("latin1")).toBe("mimetype");
    expect(idml.bytes.subarray(38, 81).toString("latin1")).toBe("application/vnd.adobe.indesign-idml-package");
    expect(blankDocument("docx")).toBeNull();
  });
});
