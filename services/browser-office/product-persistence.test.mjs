import assert from "node:assert/strict";
import test from "node:test";

import {
  directTextPreservationTarget,
  persistedSectionsMatch,
  persistedSlideTopologyMatches,
} from "./harness/product-persistence.mjs";

test("direct human title input scopes preservation to one named shape", () => {
  const before = {
    masters: [{ name: "Author master", backgroundColor: 0xffffff }],
    slides: [
      {
        elements: [
          {
            elementId: "0/1",
            parentElementId: null,
            zIndex: 1,
            name: "Title",
            text: "Before",
          },
        ],
      },
      {
        elements: [
          {
            elementId: "1/1",
            parentElementId: null,
            zIndex: 1,
            name: "Other",
            text: "Keep",
          },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].text = "After";
  assert.deepEqual(directTextPreservationTarget(before, after), {
    op: "replace_text",
    slideIndex: 0,
    name: "Title",
    shapeIndex: 1,
  });
  assert.equal(before.slides[0].elements[0].text, "Before");
  after.slides[1].elements[0].text = "Another edit";
  assert.equal(directTextPreservationTarget(before, after), null);
  after.slides[1].elements[0].text = "Keep";
  after.masters[0].backgroundColor = 0;
  assert.equal(directTextPreservationTarget(before, after), null);
  after.masters[0].backgroundColor = 0xffffff;
  after.slides[0].elements[0].name = "Different shape";
  assert.equal(directTextPreservationTarget(before, after), null);
});

test("filling an empty title remains one direct text edit", () => {
  const before = {
    masters: [],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            parentElementId: null,
            zIndex: 0,
            name: "Title 1",
            text: "",
            emptyPresentationObject: true,
            paragraphFormats: [{ alignment: null }],
            runFormatting: { caseMaps: [], languages: [] },
          },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].text = "First title";
  after.slides[0].elements[0].emptyPresentationObject = false;
  after.slides[0].elements[0].paragraphFormats[0].alignment = 3;
  after.slides[0].elements[0].runFormatting = {
    caseMaps: [0],
    languages: ["en-US"],
  };
  assert.deepEqual(directTextPreservationTarget(before, after), {
    op: "replace_text",
    slideIndex: 0,
    name: "Title 1",
    shapeIndex: 0,
  });
  after.slides[0].elements[0].emptyPresentationObject = true;
  assert.equal(directTextPreservationTarget(before, after), null);
});

const opening = {
  id: "{11111111-1111-4111-8111-111111111111}",
  name: "Opening",
  startSlideIndex: 0,
};
const details = {
  id: "{22222222-2222-4222-8222-222222222222}",
  name: "Details",
  startSlideIndex: 1,
};

test("a package-only section edit must persist exact identity and order", () => {
  assert.equal(persistedSectionsMatch([], [], 2), true);
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [
        { ...opening, slideCount: 1 },
        { ...details, slideCount: 1 },
      ],
      2,
    ),
    true,
  );
  assert.equal(
    persistedSectionsMatch([opening, details], [details, opening], 2),
    false,
  );
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [opening, { ...details, name: "Changed" }],
      2,
    ),
    false,
  );
  assert.equal(persistedSectionsMatch([opening], [], 2), false);
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [
        { ...opening, slideCount: 1 },
        { ...details, slideCount: 0 },
      ],
      2,
    ),
    false,
  );
});

test("slide topology checks identity and order, not just the slide count", () => {
  const before = ["256", "257", "258"];
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "move_slide", slideIndex: 0, insertIndex: 2 },
      before,
      ["257", "258", "256"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "move_slide", slideIndex: 0, insertIndex: 2 },
      before,
      before,
    ),
    false,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "delete_slide", slideIndex: 1 },
      before,
      ["256", "258"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "delete_slide", slideIndex: 1 },
      before,
      ["257", "258"],
    ),
    false,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "duplicate_slide", slideIndex: 0, insertIndex: 1 },
      before,
      ["256", "259", "257", "258"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches({ op: "add_slide", insertIndex: 1 }, before, [
      "256",
      "257",
      "257",
      "258",
    ]),
    false,
  );
});
