import assert from "node:assert/strict";
import test from "node:test";

import {
  documentStatesEquivalent,
  firstDocumentStateDifference,
  quantizedGeometryEquivalent,
  revisionDocumentState,
  undoDocumentStateEquivalent,
} from "./document-state-evidence.mjs";

test("document state treats two edge-quantization units as the same element outline", () => {
  const expected = {
    slides: [
      {
        elements: [
          {
            x: 1_000,
            y: 2_000,
            width: 9_000,
            height: 4_500,
            table: { rowHeights: [2_250, 2_250], columnWidths: [4_500] },
          },
        ],
      },
    ],
  };
  const actual = structuredClone(expected);
  actual.slides[0].elements[0].width = 8_999;
  actual.slides[0].elements[0].height = 4_498;
  actual.slides[0].elements[0].table.rowHeights[0] = 2_248;

  assert.equal(documentStatesEquivalent(expected.slides, actual.slides), true);
  assert.equal(quantizedGeometryEquivalent(1_000, 999), true);
  assert.equal(quantizedGeometryEquivalent(1_000, 998), true);
  assert.equal(quantizedGeometryEquivalent(1_000, 997), false);
  assert.equal(
    firstDocumentStateDifference(
      [{ width: 33_967, height: 19_050 }],
      [{ width: 33_968, height: 19_050 }],
    ),
    null,
  );
  assert.deepEqual(
    firstDocumentStateDifference([{ width: 33_967 }], [{ width: 33_970 }]),
    { path: "slides[0].width", expected: 33_967, actual: 33_970 },
  );
});

test("document state keeps meaningful geometry and non-geometry values exact", () => {
  assert.deepEqual(
    firstDocumentStateDifference(
      [{ elements: [{ width: 9_000, text: "before" }] }],
      [{ elements: [{ width: 8_997, text: "before" }] }],
    ),
    { path: "slides[0].elements[0].width", expected: 9_000, actual: 8_997 },
  );
  assert.deepEqual(
    firstDocumentStateDifference(
      [{ elements: [{ sourcePixelSize: { width: 100 } }] }],
      [{ elements: [{ sourcePixelSize: { width: 99 } }] }],
    ),
    {
      path: "slides[0].elements[0].sourcePixelSize.width",
      expected: 100,
      actual: 99,
    },
  );
  assert.ok(
    firstDocumentStateDifference(
      [{ elements: [{ text: "before" }] }],
      [{ elements: [{ text: "after" }] }],
    ),
  );
});

test("Undo state ignores diagnostic master shape counts but keeps authored revision and slides", () => {
  const expected = {
    revision: "semantic-v1",
    masters: [{ name: "Master", shapeCount: 4 }],
    slides: [{ elements: [{ text: "Original" }] }],
  };
  const diagnosticDrift = structuredClone(expected);
  diagnosticDrift.masters[0].shapeCount = 5;
  assert.equal(undoDocumentStateEquivalent(expected, diagnosticDrift), true);

  const authoredMasterChange = structuredClone(diagnosticDrift);
  authoredMasterChange.revision = "semantic-v2";
  assert.equal(
    undoDocumentStateEquivalent(expected, authoredMasterChange),
    false,
  );

  const slideChange = structuredClone(diagnosticDrift);
  slideChange.slides[0].elements[0].text = "Changed";
  assert.equal(undoDocumentStateEquivalent(expected, slideChange), false);
});

test("revision state leaves out a master's shape count and live element handles", () => {
  const state = (shapeCount, stableId, text) => ({
    slides: [
      { slideIndex: 0, elements: [{ elementId: "0/0", stableId, text }] },
    ],
    masters: [{ masterIndex: 0, name: "Title Slide", shapeCount }],
  });
  assert.deepEqual(
    revisionDocumentState(state(4, "a", "Title")),
    revisionDocumentState(state(5, "b", "Title")),
  );
  assert.notDeepEqual(
    revisionDocumentState(state(4, "a", "Title")),
    revisionDocumentState(state(4, "a", "Other")),
  );
});

test("layout issue bounds follow the element geometry quantization", () => {
  const slides = (x) => [
    {
      elements: [{ elementId: "0/0", x, y: 0, width: 10, height: 10 }],
      layoutIssues: [{ kind: "out_of_slide_bounds", bounds: { x, y: 0 } }],
    },
  ];
  assert.equal(
    firstDocumentStateDifference(slides(-1794), slides(-1795)),
    null,
  );
  assert.notEqual(
    firstDocumentStateDifference(slides(-1794), slides(-1800)),
    null,
  );
});
