import { describe, expect, it } from "vitest";
import { aiEditLimits, engineSupports } from "./ai-edit-limits";

const slides = [
  { slideIndex: 0, elements: [{ graphicKind: "table" }] },
  { slideIndex: 1, elements: [{ graphicKind: "diagram" }, { graphicKind: "ole" }] },
  {
    slideIndex: 2,
    elements: [{ graphicKind: "chart", externalData: true }, { graphicKind: "chart" }, {}],
  },
  { slideIndex: 3, elements: [{ graphicKind: "diagram" }] },
];

describe("aiEditLimits", () => {
  it("lists only limits that hold on every engine when the engine is unknown", () => {
    expect(aiEditLimits(slides, null)).toEqual([
      { kind: "linked_chart", count: 1, slides: [2] },
      { kind: "ole", count: 1, slides: [1] },
    ]);
  });

  it("adds SmartArt and table content on an engine without those edits", () => {
    const stock = { patchLevel: "stock", supportedOperations: [] };
    expect(aiEditLimits(slides, stock)).toEqual([
      { kind: "diagram", count: 2, slides: [1, 3] },
      { kind: "table", count: 1, slides: [0] },
      { kind: "linked_chart", count: 1, slides: [2] },
      { kind: "ole", count: 1, slides: [1] },
    ]);
  });

  it("drops what a patched engine can edit", () => {
    const patched = { patchLevel: "undo-v30", supportedOperations: [] };
    expect(aiEditLimits(slides, patched).map((limit) => limit.kind)).toEqual([
      "linked_chart",
      "ole",
    ]);
  });

  it("trusts operations a browser runtime reports it supports", () => {
    const browser = { patchLevel: "browser-stock", supportedOperations: ["set_table_cell"] };
    expect(engineSupports(browser, "set_table_cell")).toBe(true);
    expect(engineSupports(browser, "set_smartart_node")).toBe(false);
    expect(engineSupports(browser, "replace_text")).toBe(true);
  });
});
