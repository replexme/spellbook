import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDocumentPersistenceDelta,
  assertExactPersistence,
  assertPersistenceDelta,
  documentPersistenceDeltaDifferences,
  firstPersistenceDeltaDifference,
  firstPersistenceDifference,
  intendedDocumentMutationDifferences,
  normalizeDocumentPersistenceState,
  persistenceStateFromObservation,
  persistenceDeltaDifferences,
} from "./persistence-evidence.mjs";

test("product persistence admission checks changed semantics across save/reopen", () => {
  const before = {
    slides: [{ elements: [{ objectName: "Title", text: "Before", x: 100 }] }],
    masters: [],
  };
  const expected = structuredClone(before);
  expected.slides[0].elements[0].text = "After";
  const observed = structuredClone(expected);
  observed.slides[0].elements[0].x = 101;
  assert.deepEqual(
    intendedDocumentMutationDifferences({ before, expected, observed }),
    [],
    "Unedited import geometry belongs to package/visual preservation, not mutation intent",
  );
  observed.slides[0].elements[0].text = "Before";
  assert.deepEqual(
    intendedDocumentMutationDifferences({ before, expected, observed }).map(
      ({ path, invariant }) => ({ path, invariant }),
    ),
    [
      {
        path: "$.slides[0].elements[0].text",
        invariant: "intended-change",
      },
    ],
  );
});

test("product persistence admission compares rebuilt animation containers in their saved form", () => {
  const indefinite = { trigger: null, offset: null, repeat: 0 };
  const effect = (duration) => ({
    nodeType: 1,
    semanticNodeType: 1,
    preset: { id: "ooo-entrance-appear" },
    duration: null,
    end: null,
    fill: 3,
    restart: 0,
    children: [
      {
        nodeType: 5,
        semanticNodeType: null,
        preset: {},
        duration,
        end: null,
        fill: 0,
        restart: 0,
        children: [],
      },
    ],
  });
  const tree = ({
    rootDuration,
    rootRestart,
    sequenceDuration,
    containerFill,
    effectDuration,
  }) => ({
    nodeType: 1,
    semanticNodeType: 5,
    preset: {},
    duration: rootDuration,
    end: null,
    fill: 0,
    restart: rootRestart,
    children: [
      {
        nodeType: 2,
        semanticNodeType: 4,
        preset: {},
        duration: sequenceDuration,
        end: null,
        fill: 0,
        restart: 0,
        children: [
          {
            nodeType: 1,
            semanticNodeType: null,
            preset: {},
            duration: null,
            end: null,
            fill: containerFill,
            restart: 0,
            children: [effect(effectDuration)],
          },
        ],
      },
    ],
  });
  const state = (roots) => ({
    slides: [{ animations: { roots } }],
    masters: [],
  });
  const before = state([]);
  // LibreOffice's rebuilt sequence, as the live document holds it.
  const expected = state([
    tree({
      rootDuration: null,
      rootRestart: 0,
      sequenceDuration: null,
      containerFill: 0,
      effectDuration: 0.5,
    }),
  ]);
  // The same sequence after a PPTX save and reopen.
  const observed = state([
    tree({
      rootDuration: indefinite,
      rootRestart: 3,
      sequenceDuration: indefinite,
      containerFill: 3,
      effectDuration: 0.5,
    }),
  ]);
  assert.deepEqual(
    intendedDocumentMutationDifferences({ before, expected, observed }),
    [],
  );
  const changedEffect = state([
    tree({
      rootDuration: indefinite,
      rootRestart: 3,
      sequenceDuration: indefinite,
      containerFill: 3,
      effectDuration: 1,
    }),
  ]);
  assert.deepEqual(
    intendedDocumentMutationDifferences({
      before,
      expected,
      observed: changedEffect,
    }).map(({ path }) => path),
    [
      "$.slides[0].animations.roots[0].children[0].children[0].children[0].children[0].duration",
    ],
  );
});

test("product persistence admission refuses missing observed state", () => {
  assert.throws(
    () =>
      intendedDocumentMutationDifferences({
        before: { slides: [], masters: [] },
        expected: { slides: [], masters: [] },
        observed: { slides: [] },
      }),
    /requires before, expected and reopened slide\/master states/u,
  );
});

test("product persistence admission refuses an unobservable snapshot", () => {
  const state = {
    slides: [{ name: "Slide 1" }],
    masters: [],
    sections: [],
  };
  assert.throws(
    () =>
      intendedDocumentMutationDifferences({
        before: state,
        expected: structuredClone(state),
        observed: structuredClone(state),
      }),
    /no observable intended change/u,
  );
});

test("product persistence admission includes authored section changes", () => {
  const before = { slides: [], masters: [], sections: [] };
  const expected = {
    slides: [],
    masters: [],
    sections: [{ id: "A", name: "Part A", startSlideIndex: 0 }],
  };
  assert.deepEqual(
    intendedDocumentMutationDifferences({
      before,
      expected,
      observed: before,
    }).map(({ path, invariant }) => ({ path, invariant })),
    [{ path: "$.sections.length", invariant: "intended-change" }],
  );
});

test("persistence comparison ignores object key insertion order", () => {
  assert.equal(
    firstPersistenceDifference(
      { slide: { width: 10, height: 20 } },
      { slide: { height: 20, width: 10 } },
    ),
    null,
  );
});

test("persistence comparison reports the first structural value path", () => {
  assert.deepEqual(
    firstPersistenceDifference(
      { slides: [{ animations: { effects: [{ delay: 0.4 }] } }] },
      { slides: [{ animations: { effects: [{ delay: 0 }] } }] },
    ),
    {
      path: "$.slides[0].animations.effects[0].delay",
      expected: 0.4,
      observed: 0,
    },
  );
  assert.throws(
    () => assertExactPersistence([1, 2], [1], "Persistence failed."),
    /First difference at \$\.length: expected 1, observed 2/,
  );
});

test("delta comparison accepts normal no-op serialization changes", () => {
  assert.equal(
    firstPersistenceDeltaDifference(
      { masters: [{ shapeCount: 5 }] },
      { masters: [{ shapeCount: 5 }] },
      { masters: [{ shapeCount: 3 }] },
      { masters: [{ shapeCount: 3 }] },
    ),
    null,
  );
});

test("delta comparison requires an intended edit to survive save", () => {
  const states = {
    before: { slides: [{ transition: { duration: 0.75 } }] },
    expected: { slides: [{ transition: { duration: 1.25 } }] },
    baseline: { slides: [{ transition: { duration: 0.75 } }] },
  };
  assert.doesNotThrow(() =>
    assertPersistenceDelta(
      {
        ...states,
        observed: { slides: [{ transition: { duration: 1.25 } }] },
      },
      "Persistence failed.",
    ),
  );
  assert.throws(
    () =>
      assertPersistenceDelta(
        {
          ...states,
          observed: { slides: [{ transition: { duration: 0.75 } }] },
        },
        "Persistence failed.",
      ),
    /intended-change failed at \$\.slides\[0\]\.transition\.duration.*1\.25.*0\.75/,
  );
});

test("delta comparison rejects collateral changes after normalization", () => {
  assert.throws(
    () =>
      assertPersistenceDelta(
        {
          before: {
            slides: [{ transition: { duration: 0.75 } }],
            masters: [{ shapeCount: 5 }],
          },
          expected: {
            slides: [{ transition: { duration: 1.25 } }],
            masters: [{ shapeCount: 5 }],
          },
          baseline: {
            slides: [{ transition: { duration: 0.75 } }],
            masters: [{ shapeCount: 3 }],
          },
          observed: {
            slides: [{ transition: { duration: 1.25 } }],
            masters: [{ shapeCount: 2 }],
          },
        },
        "Persistence failed.",
      ),
    /unchanged-after-normalization failed at \$\.masters\[0\]\.shapeCount.*3.*2/,
  );
});

test("document delta comparison refuses incomplete four-state evidence", () => {
  assert.throws(
    () =>
      assertDocumentPersistenceDelta(
        { persistenceExpected: { slides: [], masters: [] } },
        { slides: [], masters: [] },
        "Persistence failed.",
      ),
    /requires before, expected, no-op baseline and reopened/,
  );
});

test("delta comparison applies OOXML millisecond canonicalization only to raw animation times", () => {
  const compareAt = (path) =>
    firstPersistenceDeltaDifference(0.001, 0.0015, 0.001, 0.001, path);
  assert.equal(
    compareAt("$.slides[0].animations.roots[0].children[0].duration"),
    null,
  );
  assert.deepEqual(compareAt("$.slides[0].animations.effects[0].duration"), {
    path: "$.slides[0].animations.effects[0].duration",
    expected: 0.0015,
    observed: 0.001,
    invariant: "intended-change",
  });
});

test("delta comparison accepts only two-edge quantization on persisted geometry", () => {
  const compareAt = (path, observed = 1001) =>
    firstPersistenceDeltaDifference(900, 1000, 900, observed, path);
  assert.equal(compareAt("$.slides[0].elements[0].height"), null);
  assert.equal(
    compareAt("$.slides[0].elements[0].table.rowHeights[1]", 999),
    null,
  );
  assert.equal(compareAt("$.slides[0].elements[0].height", 1002), null);
  assert.equal(compareAt("$.masters[0].width", 1001), null);
  assert.equal(compareAt("$.slides[0].height", 1002), null);
  assert.deepEqual(compareAt("$.masters[0].width", 1003), {
    path: "$.masters[0].width",
    expected: 1000,
    observed: 1003,
    invariant: "intended-change",
  });
  assert.deepEqual(compareAt("$.slides[0].elements[0].height", 1003), {
    path: "$.slides[0].elements[0].height",
    expected: 1000,
    observed: 1003,
    invariant: "intended-change",
  });
  assert.deepEqual(compareAt("$.slides[0].elements[0].fillColor"), {
    path: "$.slides[0].elements[0].fillColor",
    expected: 1000,
    observed: 1001,
    invariant: "intended-change",
  });
});

test("document persistence compares masters by semantics rather than relationship order", () => {
  const before = {
    masters: [
      { masterIndex: 0, name: "Title", layout: 0, shapeCount: 4 },
      { masterIndex: 1, name: "Blank", layout: 20, shapeCount: 3 },
    ],
    slides: [{ masterIndex: 1, masterName: "Blank", name: "page1" }],
  };
  const reordered = {
    masters: [
      { masterIndex: 0, name: "Blank", layout: 20, shapeCount: 3 },
      { masterIndex: 1, name: "Title", layout: 0, shapeCount: 4 },
    ],
    slides: [{ masterIndex: 0, masterName: "Blank", name: "page1" }],
  };
  const report = {
    persistenceBefore: before,
    persistenceExpected: before,
    persistenceBaseline: reordered,
  };
  assert.deepEqual(normalizeDocumentPersistenceState(before), {
    masters: [
      { name: "Blank", layout: 20 },
      { name: "Title", layout: 0 },
    ],
    slides: [{ masterName: "Blank", name: "page1" }],
  });
  assert.doesNotThrow(() =>
    assertDocumentPersistenceDelta(report, reordered, "Persistence failed."),
  );
});

test("document persistence ignores materialized master counts but rejects stable semantic changes and extras", () => {
  const state = {
    masters: [
      {
        masterIndex: 0,
        name: "Blank",
        layout: 20,
        shapeCount: 3,
        backgroundColor: 16777215,
      },
    ],
    slides: [{ masterIndex: 0, masterName: "Blank", name: "page1" }],
  };
  const report = {
    persistenceBefore: state,
    persistenceExpected: state,
    persistenceBaseline: state,
  };
  const modified = structuredClone(state);
  modified.masters[0].shapeCount = 5;
  assert.deepEqual(documentPersistenceDeltaDifferences(report, modified), []);
  modified.masters[0].backgroundColor = 0;
  assert.deepEqual(
    documentPersistenceDeltaDifferences(report, modified).map(
      ({ path, invariant }) => ({ path, invariant }),
    ),
    [
      {
        path: "$.masters[0].backgroundColor",
        invariant: "unchanged-after-normalization",
      },
    ],
  );
  const extra = structuredClone(state);
  extra.masters.push({
    masterIndex: 1,
    name: "Default",
    layout: 20,
    shapeCount: 5,
    backgroundColor: 16777215,
  });
  assert.throws(
    () => assertDocumentPersistenceDelta(report, extra, "Persistence failed."),
    /\$\.masters\.length/,
  );
});

test("document persistence excludes regenerated observation diagnostics but not stored values", () => {
  const before = {
    masters: [],
    slides: [
      {
        slideIndex: 0,
        layoutIssues: [{ code: "old" }],
        elements: [
          {
            elementId: "0/0",
            stableId: "session-a",
            alignedWith: ["0/1"],
            overlapsWith: [],
            x: 10,
            fillColor: 255,
          },
        ],
      },
    ],
  };
  const regenerated = structuredClone(before);
  regenerated.slides[0].layoutIssues = [{ code: "new" }];
  Object.assign(regenerated.slides[0].elements[0], {
    stableId: "session-b",
    alignedWith: [],
    overlapsWith: ["0/2"],
  });
  const report = {
    persistenceBefore: before,
    persistenceExpected: before,
    persistenceBaseline: structuredClone(regenerated),
  };
  assert.doesNotThrow(() =>
    assertDocumentPersistenceDelta(report, regenerated, "Persistence failed."),
  );
  regenerated.slides[0].elements[0].fillColor = 0;
  assert.throws(
    () =>
      assertDocumentPersistenceDelta(
        report,
        regenerated,
        "Persistence failed.",
      ),
    /fillColor/,
  );
});

test("authored property masks follow uniquely named shapes after reordering", () => {
  const authored = {
    masters: [],
    slides: [
      {
        slideIndex: 0,
        name: "Slide A",
        elements: [
          {
            elementId: "0/0",
            objectName: "Authored shape",
            propertyStates: { x: 0 },
            x: 100,
            fillStyle: "FillStyle.NONE",
            fill: 123,
          },
          {
            elementId: "0/1",
            objectName: "Inherited shape",
            propertyStates: { x: 1 },
            x: 200,
            fillStyle: "FillStyle.SOLID",
            fill: 456,
          },
        ],
      },
    ],
  };
  const reordered = structuredClone(authored);
  reordered.slides[0].elements.reverse();
  reordered.slides[0].elements[0].elementId = "0/0";
  reordered.slides[0].elements[0].x = 201;
  reordered.slides[0].elements[1].elementId = "0/1";
  const normalized = normalizeDocumentPersistenceState(reordered, {
    authoredBy: authored,
  });
  const [inherited, direct] = normalized.slides[0].elements;
  assert.equal(inherited.objectName, "Inherited shape");
  assert.equal(inherited.x, undefined);
  assert.equal(inherited.fill, 456);
  assert.equal(direct.objectName, "Authored shape");
  assert.equal(direct.x, 100);
  assert.equal(direct.fill, undefined);
});

test("ambiguous named shapes retain observed values instead of borrowing a mask", () => {
  const authored = {
    masters: [],
    slides: [
      {
        slideIndex: 0,
        elements: [
          { objectName: "Duplicate", propertyStates: { x: 1 }, x: 10 },
          { objectName: "Duplicate", propertyStates: { x: 1 }, x: 20 },
        ],
      },
    ],
  };
  const observed = structuredClone(authored);
  observed.slides[0].elements[0].x = 30;
  const normalized = normalizeDocumentPersistenceState(observed, {
    authoredBy: authored,
  });
  assert.equal(normalized.slides[0].elements[0].x, 30);
});

test("document persistence compares authored properties and ignores recalculated defaults", () => {
  const state = (fill, lineColor, fillState, lineState) => ({
    masters: [],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            kind: "com.sun.star.drawing.RectangleShape",
            geometryType: "rect",
            objectName: "Rectangle 1",
            name: "Rectangle 1",
            text: "",
            fill,
            lineColor,
            propertyStates: {
              fill: fillState,
              lineColor: lineState,
            },
          },
        ],
      },
    ],
  });
  const expected = state(
    0xff9900,
    0x123456,
    "com.sun.star.beans.PropertyState.DIRECT_VALUE",
    "com.sun.star.beans.PropertyState.DEFAULT_VALUE",
  );
  const reopened = state(
    0xff9900,
    0x654321,
    "com.sun.star.beans.PropertyState.DIRECT_VALUE",
    "com.sun.star.beans.PropertyState.DIRECT_VALUE",
  );
  assert.deepEqual(
    normalizeDocumentPersistenceState(reopened, { authoredBy: expected }),
    normalizeDocumentPersistenceState(expected),
  );

  reopened.slides[0].elements[0].fill = 0;
  assert.notDeepEqual(
    normalizeDocumentPersistenceState(reopened, { authoredBy: expected }),
    normalizeDocumentPersistenceState(expected),
  );
});

test("document persistence ignores a dormant color while preserving its active style", () => {
  const state = (fill) => ({
    masters: [],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            kind: "com.sun.star.drawing.TextShape",
            geometryType: "rect",
            name: "Text Box 1",
            objectName: "Text Box 1",
            text: "Text",
            fillStyle: "com.sun.star.drawing.FillStyle.NONE",
            fill,
            propertyStates: {
              fillStyle: "com.sun.star.beans.PropertyState.DEFAULT_VALUE",
              fill: "com.sun.star.beans.PropertyState.DIRECT_VALUE",
            },
          },
        ],
      },
    ],
  });
  const expected = state(0xffffff);
  const reopened = state(0x3465a4);
  assert.deepEqual(
    normalizeDocumentPersistenceState(reopened, { authoredBy: expected }),
    normalizeDocumentPersistenceState(expected),
  );
});

test("document persistence canonicalizes editable drawing shape services by geometry", () => {
  const normalize = (kind) =>
    normalizeDocumentPersistenceState({
      masters: [],
      slides: [
        {
          elements: [
            {
              elementId: "0/0",
              kind,
              geometryType: "ellipse",
              objectName: "Oval 1",
              name: "Oval 1",
              text: "",
            },
          ],
        },
      ],
    });
  assert.deepEqual(
    normalize("com.sun.star.drawing.EllipseShape"),
    normalize("com.sun.star.drawing.CustomShape"),
  );
});

test("document persistence canonicalizes only empty engine-generated layout placeholders", () => {
  const placeholder = (name, objectName, defaults) => ({
    elementId: "0/0",
    name,
    objectName,
    kind: "com.sun.star.presentation.OutlinerShape",
    text: "",
    fontFamily: defaults.fontFamily,
    color: defaults.color,
    textAutoGrowWidth: defaults.textAutoGrowWidth,
    textWordWrap: defaults.textWordWrap,
    width: 100,
    height: 50,
  });
  const before = {
    masters: [],
    slides: [
      {
        elements: [
          placeholder("Subtitle 2", "Subtitle 2", {
            fontFamily: "Calibri",
            color: 0,
            textAutoGrowWidth: false,
            textWordWrap: true,
          }),
        ],
      },
    ],
  };
  const expected = {
    masters: [],
    slides: [
      {
        elements: [
          placeholder("unnamed-com.sun.star.presentation.OutlinerShape", "", {
            fontFamily: "Calibri",
            color: 0,
            textAutoGrowWidth: true,
            textWordWrap: false,
          }),
        ],
      },
    ],
  };
  const serialized = {
    masters: [],
    slides: [
      {
        elements: [
          placeholder("PlaceHolder 2", "PlaceHolder 2", {
            fontFamily: "Calibri",
            color: 0,
            textAutoGrowWidth: false,
            textWordWrap: true,
          }),
        ],
      },
    ],
  };
  assert.doesNotThrow(() =>
    assertDocumentPersistenceDelta(
      {
        persistenceBefore: before,
        persistenceExpected: expected,
        persistenceBaseline: before,
      },
      serialized,
      "Persistence failed.",
    ),
  );

  const userNamed = structuredClone(serialized);
  userNamed.slides[0].elements[0].name = "Revenue placeholder";
  userNamed.slides[0].elements[0].objectName = "Revenue placeholder";
  assert.equal(
    normalizeDocumentPersistenceState(userNamed).slides[0].elements[0].name,
    "Revenue placeholder",
  );
  assert.throws(
    () =>
      assertDocumentPersistenceDelta(
        {
          persistenceBefore: serialized,
          persistenceExpected: serialized,
          persistenceBaseline: serialized,
        },
        userNamed,
        "Persistence failed.",
      ),
    /Persistence failed/u,
  );
});

test("document persistence treats empty editable content placeholder representations as equivalent", () => {
  const state = (kind, name, objectName) => ({
    masters: [],
    slides: [
      {
        elements: [
          {
            elementId: "0/0",
            name,
            objectName,
            kind,
            text: "",
            presentationObject: true,
            emptyPresentationObject: true,
            width: 100,
            height: 50,
          },
        ],
      },
    ],
  });
  const inMemory = state(
    "com.sun.star.presentation.OLE2Shape",
    "unnamed-com.sun.star.presentation.OLE2Shape",
    "",
  );
  const reopened = state(
    "com.sun.star.presentation.OutlinerShape",
    "PlaceHolder 2",
    "PlaceHolder 2",
  );
  assert.deepEqual(
    normalizeDocumentPersistenceState(inMemory),
    normalizeDocumentPersistenceState(reopened),
  );

  const flattened = structuredClone(reopened);
  flattened.slides[0].elements[0].kind =
    "com.sun.star.drawing.GraphicObjectShape";
  flattened.slides[0].elements[0].presentationObject = false;
  flattened.slides[0].elements[0].emptyPresentationObject = false;
  assert.notDeepEqual(
    normalizeDocumentPersistenceState(inMemory),
    normalizeDocumentPersistenceState(flattened),
  );
});

test("document persistence compares standard transition state, not derived UI projections", () => {
  const expected = normalizeDocumentPersistenceState({
    slides: [
      {
        slideIndex: 0,
        transition: {
          type: 37,
          subtype: 101,
          direction: true,
          duration: 0.75,
          fadeColor: 0,
          effect: "com.sun.star.presentation.FadeEffect.DISSOLVE",
          speed: "com.sun.star.presentation.AnimationSpeed.FAST",
        },
      },
    ],
    masters: [],
  });
  const observed = normalizeDocumentPersistenceState({
    slides: [
      {
        slideIndex: 0,
        transition: {
          type: 37,
          subtype: 101,
          direction: true,
          duration: 0.75,
          fadeColor: 0,
          effect: "com.sun.star.presentation.FadeEffect.NONE",
          speed: "com.sun.star.presentation.AnimationSpeed.MEDIUM",
        },
      },
    ],
    masters: [],
  });
  assert.deepEqual(observed, expected);
});

test("document persistence ignores dormant formatting on merged continuation cells only", () => {
  const state = {
    masters: [],
    slides: [
      {
        elements: [
          {
            table: {
              cellDetails: [
                [
                  {
                    row: 0,
                    column: 0,
                    text: "visible",
                    merged: false,
                    rowSpan: 2,
                    columnSpan: 1,
                    fillColor: 10,
                  },
                ],
                [
                  {
                    row: 1,
                    column: 0,
                    text: "",
                    merged: true,
                    rowSpan: 1,
                    columnSpan: 1,
                    fillColor: 20,
                    borders: { top: { color: 30 } },
                  },
                ],
              ],
            },
          },
        ],
      },
    ],
  };
  const reopened = structuredClone(state);
  reopened.slides[0].elements[0].table.cellDetails[1][0].fillColor = 99;
  reopened.slides[0].elements[0].table.cellDetails[1][0].borders.top.color = 88;
  const report = {
    persistenceBefore: state,
    persistenceExpected: state,
    persistenceBaseline: state,
  };
  assert.doesNotThrow(() =>
    assertDocumentPersistenceDelta(report, reopened, "Persistence failed."),
  );
  reopened.slides[0].elements[0].table.cellDetails[0][0].fillColor = 99;
  assert.throws(
    () =>
      assertDocumentPersistenceDelta(report, reopened, "Persistence failed."),
    /cellDetails\[0\]\[0\]\.fillColor/,
  );
});

test("persistence state uses detailed paragraph portions after a range edit", () => {
  const observed = {
    masters: [],
    slides: [
      {
        elements: [
          { elementId: "0/0", text: "stale compact text" },
          { elementId: "0/1", text: "untouched" },
        ],
      },
    ],
    textDetails: {
      slideIndex: 0,
      elements: [
        {
          elementId: "0/0",
          paragraphs: [
            { portions: [{ text: "first" }, { text: " run" }] },
            { portions: [{ text: "second" }] },
          ],
        },
      ],
    },
  };
  assert.deepEqual(persistenceStateFromObservation(observed), {
    masters: [],
    slides: [
      {
        elements: [
          { elementId: "0/0", text: "first run\nsecond" },
          { elementId: "0/1", text: "untouched" },
        ],
      },
    ],
  });
});

test("persistence diagnostics collect the complete bounded difference set", () => {
  const differences = persistenceDeltaDifferences({
    before: { value: 1, untouched: "a" },
    expected: { value: 2, untouched: "a" },
    baseline: { value: 1, untouched: "b" },
    observed: { value: 3, untouched: "c" },
  });
  assert.deepEqual(
    differences.map(({ path, invariant }) => ({ path, invariant })),
    [
      { path: "$.untouched", invariant: "unchanged-after-normalization" },
      { path: "$.value", invariant: "intended-change" },
    ],
  );
});
