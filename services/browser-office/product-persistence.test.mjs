import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNativeSnapshotVersion,
  directDeletePreservationTarget,
  directMovePreservationTarget,
  directTextGeometryPreservationTarget,
  directTextPreservationTarget,
  isRevisionOnlyNativeSnapshot,
  normalizeDirectEditPersistenceState,
  persistedDirectDeletionMatches,
  persistedDirectSlideTopologyMatches,
  persistedSectionsMatch,
  persistedSlideTopologyMatches,
} from "./harness/product-persistence.mjs";

test("native snapshot must use the observed revision through serialization", () => {
  assert.doesNotThrow(() => assertNativeSnapshotVersion(7, 7, 7));
  assert.throws(() => assertNativeSnapshotVersion(7, 8, 8), /document_changed_during_snapshot/);
  assert.throws(() => assertNativeSnapshotVersion(7, 7, 8), /document_changed_during_snapshot/);
  // Undo back to the same semantic content still advances the event counter.
  assert.throws(() => assertNativeSnapshotVersion(7, 9, 9), /document_changed_during_snapshot/);
  assert.throws(() => assertNativeSnapshotVersion(7, null, null), /document_changed_during_snapshot/);
  assert.throws(() => assertNativeSnapshotVersion("7", 7, 7), /snapshot_version_invalid/);
  // Engines without the event listener continue to require semantic proof.
  assert.doesNotThrow(() => assertNativeSnapshotVersion(null, null, null));
  assert.throws(() => assertNativeSnapshotVersion(null, 7, 8), /document_changed_during_snapshot/);
});

test("empty paragraph provenance cannot widen a direct text edit's scope", () => {
  const before = {
    masters: [],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            parentElementId: null,
            zIndex: 0,
            name: "Title",
            text: "Before",
          },
        ],
      },
      {
        elements: [
          {
            elementId: "1/0",
            parentElementId: null,
            zIndex: 0,
            name: "Empty",
            text: "",
            paragraphFormats: [
              {
                topMargin: 0,
                bottomMargin: 0,
                propertyStates: {
                  topMargin: "DIRECT_VALUE",
                  bottomMargin: "DIRECT_VALUE",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].text = "After";
  after.slides[1].elements[0].paragraphFormats[0].propertyStates = {
    topMargin: "DEFAULT_VALUE",
    bottomMargin: "DEFAULT_VALUE",
  };
  const originals = structuredClone({ before, after });
  const scope = () =>
    directTextPreservationTarget(
      normalizeDirectEditPersistenceState(before),
      normalizeDirectEditPersistenceState(after),
    );
  assert.deepEqual(scope(), {
    op: "replace_text",
    slideIndex: 0,
    name: "Title",
    shapeIndex: 0,
  });
  assert.deepEqual({ before, after }, originals);
  // A real spacing change on that other slide still prevents the text-only
  // merge. Inherited-state metadata must not hide the changed value.
  after.slides[1].elements[0].paragraphFormats[0].topMargin = 400;
  assert.equal(scope(), null);
});

test("deleting one top-level shape scopes the changed slide", () => {
  const first = {
    elementId: "0/0",
    parentElementId: null,
    zIndex: 0,
    name: "Title",
    text: "Remove",
    readingOrder: 0,
  };
  const second = {
    elementId: "0/1",
    parentElementId: null,
    zIndex: 1,
    name: "Body",
    text: "Keep",
    readingOrder: 1,
    paragraphFormats: [{ paragraphId: "old", alignment: "left" }],
  };
  const before = {
    masters: [],
    slides: [
      {
        topLevelElementCount: 2,
        readingOrder: [0, 1],
        accessibilityIssues: [{ elementId: "0/0" }],
        elements: [first, second],
      },
      { elements: [] },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements.shift();
  after.slides[0].topLevelElementCount = 1;
  after.slides[0].readingOrder = [0];
  after.slides[0].accessibilityIssues = [];
  Object.assign(after.slides[0].elements[0], {
    elementId: "0/0",
    zIndex: 0,
    readingOrder: 0,
  });
  after.slides[0].elements[0].paragraphFormats[0].paragraphId = "new";
  assert.deepEqual(directDeletePreservationTarget(before, after), {
    op: "delete_element",
    slideIndex: 0,
    name: "Title",
    shapeIndex: 0,
  });
  after.slides[1].elements.push({ name: "Unrelated" });
  assert.equal(directDeletePreservationTarget(before, after), null);
});

test("a direct deletion accepts only one changed slide and the expected shape identity", () => {
  const before = {
    slides: [
      { elements: [{ name: "Title" }, { name: "Body", fill: "inherited" }] },
    ],
  };
  const live = { slides: [{ elements: [{ name: "Body", fill: "resolved" }] }] };
  const saved = {
    slides: [{ elements: [{ name: "Body", fill: "inherited" }] }],
  };
  const target = {
    op: "delete_element",
    slideIndex: 0,
    shapeIndex: 0,
    name: "Title",
  };
  const report = {
    changedParts: ["ppt/slides/slide1.xml"],
    authoredShapeScopes: [[0, ["Title"]]],
  };
  assert.equal(
    persistedDirectDeletionMatches(before, live, saved, target, report),
    true,
  );
  assert.equal(
    persistedDirectDeletionMatches(before, live, saved, target, {
      ...report,
      changedParts: [
        ...report.changedParts,
        "ppt/slideMasters/slideMaster1.xml",
      ],
    }),
    false,
  );
  assert.equal(
    persistedDirectDeletionMatches(
      before,
      live,
      { slides: [{ elements: [{ name: "Other" }] }] },
      target,
      report,
    ),
    false,
  );
});

test("a slide insertion verifies order and new content without accepting changed old parts", () => {
  const before = {
    slides: [
      { name: "First", elements: [{ text: "A" }] },
      { name: "Second", elements: [{ text: "B" }] },
    ],
  };
  const live = {
    slides: [
      before.slides[0],
      { name: "New", elements: [{ text: "New" }] },
      before.slides[1],
    ],
  };
  const saved = {
    slides: [
      before.slides[0],
      { name: "page2", elements: [{ text: "New" }] },
      before.slides[1],
    ],
  };
  const report = {
    topologyAligned: true,
    topology: { kind: "insert", index: 1 },
    topologyExistingContentChanges: [],
  };
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, saved, report),
    true,
  );
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, saved, {
      ...report,
      topologyExistingContentChanges: ["ppt/slides/slide1.xml"],
    }),
    false,
  );
  saved.slides[1].elements[0].text = "Lost";
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, saved, report),
    false,
  );
});

test("one human shape move scopes preservation without admitting a second edit", () => {
  const before = {
    masters: [{ name: "Shared" }],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            parentElementId: null,
            zIndex: 0,
            name: "Title",
            x: 10,
            y: 20,
          },
        ],
      },
      {
        elements: [
          {
            elementId: "1/0",
            parentElementId: null,
            zIndex: 0,
            name: "Other",
            x: 30,
            y: 40,
          },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].x = 12;
  assert.deepEqual(directMovePreservationTarget(before, after), {
    op: "move",
    slideIndex: 0,
    name: "Title",
    shapeIndex: 0,
  });
  assert.equal(before.slides[0].elements[0].x, 10);
  after.slides[1].elements[0].y = 41;
  assert.equal(directMovePreservationTarget(before, after), null);
  after.slides[1].elements[0].y = 40;
  after.masters[0].name = "Changed";
  assert.equal(directMovePreservationTarget(before, after), null);
});

test("a group translation includes only its unchanged descendants", () => {
  const before = { slides: [{ elements: [
    { elementId: "0/0", parentElementId: null, zIndex: 0, name: "Group", x: 10, y: 20 },
    { elementId: "0/0/0", parentElementId: "0/0", x: 11, y: 21, text: "Child" },
    { elementId: "0/0/0/0", parentElementId: "0/0/0", x: 12, y: 22 },
    { elementId: "0/1", parentElementId: null, zIndex: 1, name: "Other", x: 30, y: 40 },
  ] }] };
  const after = structuredClone(before);
  for (const element of after.slides[0].elements.slice(0, 3)) element.x += 5;
  assert.deepEqual(directMovePreservationTarget(before, after), {
    op: "move", slideIndex: 0, name: "Group", shapeIndex: 0,
  });
  after.slides[0].elements[1].x++;
  assert.equal(directMovePreservationTarget(before, after), null);
  after.slides[0].elements[1].x--;
  after.slides[0].elements[1].text = "Changed";
  assert.equal(directMovePreservationTarget(before, after), null);
  after.slides[0].elements[1].text = "Child";
  after.slides[0].elements[3].x++;
  assert.equal(directMovePreservationTarget(before, after), null);
});

test("a revision-only Office save cannot hide a document or package change", () => {
  const before = { slides: [{ elements: [{ text: "Typed" }] }], masters: [] };
  const sections = [{ id: "A", startSlideIndex: 0 }];
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(
    isRevisionOnlyNativeSnapshot(
      before,
      structuredClone(before),
      sections,
      structuredClone(sections),
      bytes,
      bytes.slice(),
    ),
    true,
  );
  assert.equal(
    isRevisionOnlyNativeSnapshot(
      before,
      { ...before, slides: [] },
      sections,
      sections,
      bytes,
      bytes.slice(),
    ),
    false,
  );
  assert.equal(
    isRevisionOnlyNativeSnapshot(
      before,
      before,
      sections,
      [],
      bytes,
      bytes.slice(),
    ),
    false,
  );
  assert.equal(
    isRevisionOnlyNativeSnapshot(
      before,
      before,
      sections,
      sections,
      bytes,
      new Uint8Array([1, 2, 4]),
    ),
    false,
  );
});

test("typing that resizes one text box keeps a narrow direct edit scope", () => {
  const before = {
    masters: [{ name: "Shared" }],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            parentElementId: null,
            zIndex: 0,
            name: "TextBox",
            text: "Before",
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            paragraphFormats: [],
            runFormatting: {},
          },
        ],
      },
      { elements: [] },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].text = "Before MANUAL";
  after.slides[0].elements[0].width = 35;
  after.slides[0].elements[0].runFormatting = { languages: ["ko-KR"] };
  assert.deepEqual(directTextGeometryPreservationTarget(before, after), {
    op: "replace_text",
    operations: ["replace_text", "resize"],
    slideIndex: 0,
    name: "TextBox",
    shapeIndex: 0,
  });
  after.slides[1].elements.push({ name: "Unexpected" });
  assert.equal(directTextGeometryPreservationTarget(before, after), null);
});

test("typing that materializes inherited formatting stays on one shape", () => {
  const before = {
    masters: [{ name: "Shared" }],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            parentElementId: null,
            zIndex: 0,
            name: "TextBox",
            text: "Before",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            paragraphFormats: [{ alignment: "left" }],
            runFormatting: { languages: [] },
          },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].text = "Before MANUAL";
  after.slides[0].elements[0].paragraphFormats[0].alignment = "center";
  after.slides[0].elements[0].runFormatting.languages = ["ko-KR"];
  assert.deepEqual(directTextGeometryPreservationTarget(before, after), {
    op: "replace_text",
    operations: ["replace_text"],
    slideIndex: 0,
    name: "TextBox",
    shapeIndex: 0,
  });
});

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

test("native insertion checks retained live formatting, indexed references and inserted intent", () => {
  const slide = (index, name, text) => ({
    slideIndex: index,
    name,
    readingOrder: [`${index}/0`],
    elements: [
      {
        elementId: `${index}/0`,
        parentElementId: null,
        childElementIds: [],
        kind: "TextShape",
        name: "Title",
        text,
        x: 10,
        y: 20,
        width: 100,
        height: 60,
        paragraphFormats: [{ paragraphId: `${index}/0:p0`, topMargin: 0 }],
      },
    ],
    animations: {
      roots: [{ animationId: `${index}:a0`, targetElementId: `${index}/0` }],
    },
  });
  const before = { slides: [slide(0, "First", "A"), slide(1, "Second", "B")] };
  const live = {
    slides: [
      slide(0, "regenerated", "A"),
      slide(1, "New", "C"),
      slide(2, "Second", "B"),
    ],
  };
  const reopened = structuredClone(live);
  reopened.slides[0].name = "First";
  reopened.slides[1].name = "page2";
  const report = {
    topologyAligned: true,
    topology: { kind: "insert", index: 1 },
    topologyExistingContentChanges: [],
  };
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, reopened, report),
    true,
  );
  live.slides[2].elements[0].paragraphFormats[0].topMargin = 500;
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, reopened, report),
    false,
    "a concurrent empty paragraph format edit cannot be lost",
  );
  live.slides[2].elements[0].paragraphFormats[0].topMargin = 0;
  before.slides[1].elements[0].connector = {
    startElementId: "1/0", endElementId: "1/1", startGluePoint: 0,
  };
  live.slides[2].elements[0].connector = {
    startElementId: "2/0", endElementId: "2/1", startGluePoint: 0,
  };
  reopened.slides[2].elements[0].connector = structuredClone(live.slides[2].elements[0].connector);
  assert.equal(persistedDirectSlideTopologyMatches(before, live, reopened, report), true,
    "connection addresses shift with their retained slide");
  live.slides[2].elements[0].connector.startElementId = "2/1";
  assert.equal(persistedDirectSlideTopologyMatches(before, live, reopened, report), false,
    "changing which shape is connected remains an authored change");
  live.slides[2].elements[0].connector.startElementId = "2/0";
  reopened.slides[1].elements[0].x = 100;
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, reopened, report),
    false,
    "new shape position must persist",
  );
  reopened.slides[1].elements[0].x = 11;
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, reopened, report),
    true,
    "existing two-unit engine geometry tolerance remains shared",
  );
});

test("empty paragraph spacing uses observed property states, keeping direct edits mandatory", () => {
  const before = { slides: [{ elements: [{ text: "Old" }] }] };
  const empty = {
    elements: [
      {
        kind: "com.sun.star.presentation.TitleTextShape",
        text: "",
        presentationObject: true,
        emptyPresentationObject: true,
        paragraphFormats: [
          {
            topMargin: 0,
            bottomMargin: 0,
            propertyStates: {
              topMargin: "DEFAULT_VALUE",
              bottomMargin: "DIRECT_VALUE",
            },
          },
        ],
      },
    ],
  };
  const live = { slides: [before.slides[0], empty] };
  const saved = structuredClone(live);
  saved.slides[1].elements[0].paragraphFormats[0].topMargin = 500;
  const report = {
    topologyAligned: true,
    topology: { kind: "insert", index: 1 },
    topologyExistingContentChanges: [],
  };
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, saved, report),
    true,
  );
  live.slides[1].elements[0].paragraphFormats[0].propertyStates.topMargin =
    "DIRECT_VALUE";
  assert.equal(
    persistedDirectSlideTopologyMatches(before, live, saved, report),
    false,
  );
});
