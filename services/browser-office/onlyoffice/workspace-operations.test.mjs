/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertServiceObservation,
  assertWorkspacePermission,
  undoOnlyOfficeTurn,
  onlyOfficeTextDetails,
} from "./workspace-operations.mjs";
const observation = {
  revision: "r1",
  slides: [
    {
      slideIndex: 0,
      elements: [{ elementId: "0/0", text: "A\n" }],
      onlyoffice: {
        drawings: [
          {
            paragraphs: [
              {
                text: "A\r\n",
                runs: [
                  { text: "A", style: { GetBold: true, GetFontSize: 24 } },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
};
test("complete observed slides and revision form the stale-state boundary", () => {
  assertServiceObservation(observation, {
    expectedRevision: "r1",
    expectedSlides: JSON.stringify(observation.slides),
  });
  assert.throws(
    () =>
      assertServiceObservation(observation, {
        expectedRevision: "r1",
        expectedSlides: "[]",
      }),
    /stale/,
  );
});
test("selection scope cannot mutate a foreign element or document", () => {
  const ops = {
    move: { target: "element" },
    set_sections: { target: "document" },
  };
  assertWorkspacePermission(
    [{ op: "move", elementId: "0/0" }],
    { mode: "selection", elementIds: ["0/0"] },
    ops,
  );
  for (const command of [
    { op: "move", elementId: "0/1" },
    { op: "set_sections" },
  ])
    assert.throws(
      () =>
        assertWorkspacePermission(
          [command],
          { mode: "selection", elementIds: ["0/0"] },
          ops,
        ),
      /permission/,
    );
});
test("failed target undo restores exact original history position", async () => {
  let position = 2;
  const session = {
    observe: async () => ({ revision: "r" + position }),
    status: () => ({ undo: position }),
    undo: async () => {
      position--;
      return true;
    },
    redo: async () => {
      position++;
      return true;
    },
  };
  await assert.rejects(
    undoOnlyOfficeTurn(session, {
      steps: 1,
      expectedRevision: "r2",
      targetRevision: "different",
    }),
    /undo_result_mismatch$/,
  );
  assert.equal(position, 2);
});
test("text offsets address authored text and canonical half-point font size", () => {
  const detail = onlyOfficeTextDetails(observation, {
    slideIndex: 0,
    expectedElements: [{ elementId: "0/0", text: "A\n" }],
  });
  const p = detail.elements[0].paragraphs[0];
  assert.equal(p.endOffset, 2);
  assert.equal(p.portions[0].fontSize, 12);
  assert.equal(p.portions[0].bold, true);
  assert.throws(
    () =>
      onlyOfficeTextDetails(observation, {
        slideIndex: 0,
        expectedElements: [{ elementId: "0/0", text: "B" }],
      }),
    /stale/,
  );
});

test("moving a slide requires every affected slide in the allowed scope", () => {
  const ops = { move_slide: { target: "slide" } },
    command = { op: "move_slide", slideIndex: 0, targetSlideIndex: 2 };
  assert.throws(
    () =>
      assertWorkspacePermission(
        [command],
        { mode: "slides", slideIndexes: [0, 2] },
        ops,
      ),
    /permission/,
  );
  assertWorkspacePermission(
    [command],
    { mode: "slides", slideIndexes: [0, 1, 2] },
    ops,
  );
});
