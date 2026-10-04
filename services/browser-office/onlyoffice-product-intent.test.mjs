/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { verifyOnlyOfficeProductIntent } from "./onlyoffice/product-intent.mjs";
function document() {
  const elements = [0, 1].map((i) => ({
    elementId: "0/" + i,
    kind: "shape",
    text: "old\r\n",
    x: i * 1000,
    y: 100,
    width: 500,
    height: 300,
    objectName: "shape" + i,
    onlyoffice: { text: "old\r\n", ownName: "shape" + i },
    elements: [],
  }));
  const drawings = elements.map((e) => ({
    name: e.objectName,
    text: e.text,
    GetRotation: 0,
    GetFlipH: false,
    GetFlipV: false,
    paragraphs: [
      {
        text: e.text,
        runs: [
          {
            text: "old",
            style: {
              GetFontSize: 48,
              GetBold: false,
              fonts: ["Arial", "Arial", "Arial", "Arial"],
            },
          },
        ],
      },
    ],
  }));
  return {
    revision: "before",
    slides: [
      {
        elements,
        onlyoffice: { drawings },
        narrow: {
          drawingStyle: elements.map((e) => ({
            name: e.objectName,
            fill: null,
            line: null,
          })),
          wordArt: elements.map((e) => ({ name: e.objectName, preset: null })),
          table: [],
        },
      },
    ],
    masters: [],
    sections: [],
  };
}
const text = (doc, value) => {
  doc.slides[0].elements[0].text = value + "\r\n";
  doc.slides[0].elements[0].onlyoffice.text = value + "\r\n";
  const drawing = doc.slides[0].onlyoffice.drawings[0];
  drawing.text = value + "\r\n";
  drawing.paragraphs[0].text = value + "\r\n";
  drawing.paragraphs[0].runs[0].text = value;
};
for (const [op, args, property, wanted] of [
  ["set_character_spacing", { spacing: 2 }, "characterSpacing", 2],
  ["set_script_position", { script: "normal" }, "GetVertAlign", "baseline"],
  [
    "set_script_position",
    { script: "superscript" },
    "GetVertAlign",
    "superscript",
  ],
  ["set_script_position", { script: "subscript" }, "GetVertAlign", "subscript"],
])
  test(
    op +
      " verifies every run and preserves other formatting: " +
      JSON.stringify(args),
    () => {
      const before = document(),
        after = structuredClone(before);
      const style =
        after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style;
      style[property] = wanted;
      const command = { op, elementId: "0/0", ...args };
      verifyOnlyOfficeProductIntent(before, after, [command]);
      style.GetBold = true;
      assert.throws(
        () => verifyOnlyOfficeProductIntent(before, after, [command]),
        /unrequested_change/,
      );
      style.GetBold = false;
      style[property] = "wrong";
      assert.throws(
        () => verifyOnlyOfficeProductIntent(before, after, [command]),
        /intent_mismatch/,
      );
    },
  );
test("a persisted wrong font size is rejected as a requested-effect failure", () => {
  const before = document(),
    after = structuredClone(before);
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetFontSize = 40;
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, after, [
        { op: "font_size", elementId: "0/0", size: 32 },
      ]),
    /intent_mismatch:font_size/,
  );
});
test("changing an untargeted element cannot be admitted with a correct target move", () => {
  const before = document(),
    after = structuredClone(before);
  after.slides[0].elements[0].x = 500;
  after.slides[0].elements[1].x = 1200;
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, after, [
        { op: "move", elementId: "0/0", x: 500, y: 100 },
      ]),
    /unrequested_change/,
  );
});
test("text replacement retains its original style and significant trailing whitespace", () => {
  const before = document(),
    after = structuredClone(before);
  text(after, "new  ");
  verifyOnlyOfficeProductIntent(before, after, [
    { op: "replace_text", elementId: "0/0", text: "new  " },
  ]);
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, after, [
        { op: "replace_text", elementId: "0/0", text: "new" },
      ]),
    /intent_mismatch:text/,
  );
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetFontSize =
    null;
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, after, [
        { op: "replace_text", elementId: "0/0", text: "new  " },
      ]),
    /text_style_lost/,
  );
});
test("replacement and explicit formatting in one request have their combined intended effect", () => {
  const before = document(),
    after = structuredClone(before);
  text(after, "new");
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetFontSize = 64;
  verifyOnlyOfficeProductIntent(before, after, [
    { op: "replace_text", elementId: "0/0", text: "new" },
    { op: "font_size", elementId: "0/0", size: 32 },
  ]);
});

test("native adapter retains the artifact rebinding port used after Undo and Redo", async () => {
  const { createOnlyOfficeProductEngine, onlyOfficePersistenceState } =
    await import("./onlyoffice/product-engine.mjs");
  let bound;
  const engine = createOnlyOfficeProductEngine({
    bindArtifact: async (bytes) => {
      bound = bytes;
    },
  });
  const bytes = Uint8Array.of(1, 2, 3);
  await engine.bindArtifact(bytes);
  assert.equal(bound, bytes);
  assert.equal(engine.persistenceState, onlyOfficePersistenceState);
});

test("native setters unlock only synchronously and restore the UI lock on success and failure", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const previousWindow = globalThis.window;
  let locked = true,
    fail = false,
    grouped = true;
  const visitedPages = [];
  const drawing = {
    Drawing: { Id: "native-1" },
    SetPosition() {
      assert.equal(locked, false);
      if (fail) throw Error("native_setter_failed");
      return this;
    },
  };
  const model = {
    Slides: [0, 1, 2].map(() => ({ cSld: { spTree: [{ Id: "native-1" }] } })),
    Recalculate() {},
    RedrawCurSlide() {},
    Document_UpdateInterfaceState() {},
  };
  const editor = {
    isGroupActions: () => grouped,
    executeGroupActionsStart() {
      locked = false;
    },
    executeGroupActionsEnd() {
      locked = true;
    },
    WordControl: {
      m_oLogicDocument: model,
      GoToPage(index) {
        visitedPages.push(index);
      },
      Thumbnails: {
        SelectPage() {
          throw Error("thumbnail selection is not page navigation");
        },
      },
    },
  };
  globalThis.window = {
    Asc: { editor },
    AscBuilder: {
      GetApiDrawing: () => drawing,
      Slide: {
        Api: {
          GetPresentation: () => ({
            GetSlideByIndex: (index) => ({
              Slide: model.Slides[index],
              GetAllDrawings: () => [drawing],
            }),
            CreateNewHistoryPoint() {},
          }),
        },
      },
    },
    AscCommon: { History: { Get_RecalcData() {}, getGroupChanges() {} } },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({ evaluate: async (fn, payload) => fn(payload) }),
    });
    const command = {
      op: "move",
      nativeId: "native-1",
      slideIndex: 2,
      x: 100,
      y: 200,
    };
    assert.equal(await engine.apply(command), true);
    assert.deepEqual(visitedPages, [2]);
    assert.equal(locked, true);
    fail = true;
    await assert.rejects(engine.apply(command), /native_setter_failed/);
    assert.equal(locked, true);
    grouped = false;
    await assert.rejects(engine.apply(command), /transaction_required/);
    assert.equal(locked, true);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("formatting preserves dynamic field identity even next to an identical plain-text style", () => {
  const before = document();
  const runs = before.slides[0].onlyoffice.drawings[0].paragraphs[0].runs;
  runs.push({
    ...structuredClone(runs[0]),
    text: "<field:slidenum>",
    field: { type: "slidenum", guid: "authored-field" },
  });
  const after = structuredClone(before);
  for (const run of after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs)
    run.style.GetBold = true;
  const command = { op: "bold", elementId: "0/0", bold: true };
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[1].field.guid =
    "replaced-field";
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("private native change evidence tracks authored history, excluding selection, empty points and save state", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const history = { Index: -1, Points: [], SavedIndex: null };
  globalThis.window = { AscCommon: { History: history } };
  const engine = createOnlyOfficeProductEngine({
    getFrame: async () => ({ evaluate: async (fn) => fn() }),
  });
  try {
    const base = await engine.changeToken();
    history.Index = 0;
    history.Points.push({ State: { cursor: 10 }, Items: [] });
    history.SavedIndex = 0;
    assert.equal(await engine.changeToken(), base);
    history.Points[0].Items.push({ Binary: { Pos: 25, Len: 8 } });
    assert.notEqual(await engine.changeToken(), base);
    history.Index = -1;
    assert.equal(await engine.changeToken(), base); // Undo retains future Redo bytes.
    history.Index = 0;
    history.Points[0].Items.push({ Binary: { Pos: 40, Len: 8 } });
    assert.notEqual(await engine.changeToken(), "[1,25,8]");
    history.Points[0].Items.push({});
    await assert.rejects(engine.changeToken(), /change_token_unavailable/);
  } finally {
    globalThis.window = old;
  }
});

test("connector preflight binds the observed native object even when the public list omits it", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const connector = { Id: "native-connector", getObjectType: () => 7 };
  globalThis.window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: { Slides: [{ cSld: { spTree: [connector] } }] },
        },
      },
    },
    AscDFH: { historyitem_type_Cnx: 7 },
    AscBuilder: {
      GetApiDrawing: () => null,
      ApiShape: class {
        constructor(native) {
          this.Drawing = native;
        }
        SetPosition() {}
      },
    },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({
        evaluate: async (fn, argument) => fn(argument),
      }),
    });
    const commands = await engine.preflight([
      { op: "move", elementId: "0/0", x: 500, y: 0 },
    ]);
    assert.equal(commands[0].nativeId, "native-connector");
    assert.equal(commands[0].slideIndex, 0);
    connector.getObjectType = () => 8;
    await assert.rejects(
      engine.preflight([{ op: "move", elementId: "0/0", x: 500, y: 0 }]),
      /target_method_unavailable/,
    );
  } finally {
    globalThis.window = old;
  }
});

test("line-style bindings reject SDK enum disagreement before native editing", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const shape = { Id: "native-line", spPr: { ln: { w: 36000 } } };
  let arrowType = 5;
  globalThis.window = {
    Asc: {
      c_oDashType: { dot: 2 },
      editor: {
        WordControl: {
          m_oLogicDocument: { Slides: [{ cSld: { spTree: [shape] } }] },
        },
      },
    },
    AscBuilder: { GetApiDrawing: () => ({ Drawing: shape, SetOutLine() {} }) },
    AscFormat: {
      EndArrow: class {
        GetTypeCode() {
          return arrowType;
        }
        GetSizeCode(size) {
          return { lg: 0, med: 1, sm: 2 }[size];
        }
      },
    },
  };
  const command = {
    op: "set_line_style",
    elementId: "0/0",
    lineStyle: {
      dash: "dot",
      startArrow: { type: "triangle", width: null, length: "lg" },
      endArrow: null,
    },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({
        evaluate: async (fn, argument) => fn(argument),
      }),
    });
    const [bound] = await engine.preflight([command]);
    assert.deepEqual(bound.nativeLineStyle, {
      dash: 2,
      headEnd: { type: 5, w: 1, len: 0 },
    });
    arrowType = 1;
    await assert.rejects(
      engine.preflight([command]),
      /line_style_sdk_mismatch/,
    );
    arrowType = 5;
    window.Asc.c_oDashType.dot = 23;
    await assert.rejects(
      engine.preflight([command]),
      /line_style_sdk_mismatch/,
    );
  } finally {
    globalThis.window = old;
  }
});

test("line width changes retain authored color, cap and dash and reject ignored setters", () => {
  const before = document();
  before.slides[0].narrow.drawingStyle[0].line = {
    width: 36000,
    color: { R: 20, G: 30, B: 40 },
    cap: 1,
    dash: 4,
  };
  const after = structuredClone(before),
    command = { op: "line_width", elementId: "0/0", size: 2 };
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /intent_mismatch:line_width/,
  );
  after.slides[0].narrow.drawingStyle[0].line.width = 72000;
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].narrow.drawingStyle[0].line.cap = 0;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("paragraph alignment requires the requested value in every paragraph and preserves run formatting", () => {
  const before = document();
  before.slides[0].onlyoffice.drawings[0].paragraphs[0].alignment = "left";
  const after = structuredClone(before),
    command = {
      op: "paragraph_alignment",
      elementId: "0/0",
      alignment: "right",
    };
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /intent_mismatch:paragraph_alignment/,
  );
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].alignment = "right";
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetBold = true;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("alternative text changes only supplied fields and preserves the other object", () => {
  const before = document();
  before.slides[0].elements[0].onlyoffice.title = "title";
  before.slides[0].elements[0].onlyoffice.description = "description";
  const after = structuredClone(before);
  const command = {
    op: "set_alt_text",
    elementId: "0/0",
    title: null,
    description: "changed",
  };
  after.slides[0].elements[0].onlyoffice.description = "changed";
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].elements[0].onlyoffice.title = "lost";
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("rounded twips cannot hide a hundredth-point spacing loss", () => {
  const before = document(),
    after = structuredClone(before);
  const style =
    after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style;
  style.GetSpacing = 40;
  style.characterSpacing = 1.99;
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, after, [
        { op: "set_character_spacing", elementId: "0/0", spacing: 2 },
      ]),
    /intent_mismatch:set_character_spacing/,
  );
});

test("text language normalizes its tag and preserves other run properties", () => {
  const before = document(),
    after = structuredClone(before);
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetLanguage =
    "ko-KR";
  const command = {
    op: "set_text_language",
    elementId: "0/0",
    languageTag: "KO-kr",
  };
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].onlyoffice.drawings[0].paragraphs[0].runs[0].style.GetBold = true;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("object locks compose requested flags and preserve every unsupplied lock", () => {
  const before = document();
  before.slides[0].elements[0].onlyoffice.locks = {
    noMove: false,
    noResize: false,
    noCrop: true,
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].onlyoffice.locks.noMove = true;
  after.slides[0].elements[0].onlyoffice.locks.noResize = true;
  const commands = [
    {
      op: "set_object_lock",
      elementId: "0/0",
      lockPosition: true,
      lockSize: null,
    },
    {
      op: "set_object_lock",
      elementId: "0/0",
      lockPosition: null,
      lockSize: true,
    },
  ];
  verifyOnlyOfficeProductIntent(before, after, commands);
  after.slides[0].elements[0].onlyoffice.locks.noCrop = false;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

test("native text language changes only the primary language and uses native history setters", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const makeRun = () => ({
    primary: 1033,
    bidi: 1025,
    eastAsia: 1041,
    Set_Lang() {
      throw Error("whole language replacement loses other script languages");
    },
    Set_Lang_Val(value) {
      this.primary = value;
    },
  });
  const run = makeRun(),
    end = makeRun();
  const shape = { Id: "native-text", getDocContent: () => ({}) };
  const model = {
    Slides: [{ cSld: { spTree: [shape] } }],
    Recalculate() {},
    RedrawCurSlide() {},
    Document_UpdateInterfaceState() {},
  };
  const drawing = {
    Drawing: shape,
    GetDocContent: () => ({
      GetAllParagraphs: () => [{ Paragraph: { TextPr: end, Content: [run] } }],
    }),
  };
  globalThis.window = {
    Asc: {
      editor: {
        isGroupActions: () => true,
        executeGroupActionsStart() {},
        executeGroupActionsEnd() {},
        WordControl: { m_oLogicDocument: model, GoToPage() {} },
      },
    },
    AscBuilder: {
      GetApiDrawing: () => drawing,
      Slide: {
        Api: {
          GetPresentation: () => ({
            GetSlideByIndex: () => ({ Slide: model.Slides[0] }),
            CreateNewHistoryPoint() {},
          }),
        },
      },
    },
    AscCommon: { History: { Get_RecalcData() {}, getGroupChanges() {} } },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({
        evaluate: async (fn, argument) => fn(argument),
      }),
    });
    await engine.apply({
      op: "set_text_language",
      slideIndex: 0,
      nativeId: "native-text",
      nativeLanguageId: 1042,
    });
    for (const value of [run, end]) {
      assert.equal(value.primary, 1042);
      assert.equal(value.bidi, 1025);
      assert.equal(value.eastAsia, 1041);
    }
  } finally {
    globalThis.window = old;
  }
});

test("image cropping verifies all edges and preserves picture geometry and other objects", () => {
  const before = document();
  before.slides[0].elements[0].kind = "image";
  before.slides[0].elements[0].onlyoffice.crop = null;
  const after = structuredClone(before);
  const command = {
    op: "crop_image",
    elementId: "0/0",
    left: 0.15,
    top: 0.1,
    right: 0.08,
    bottom: 0.06,
  };
  after.slides[0].elements[0].onlyoffice.crop = { l: 15, t: 10, r: 92, b: 94 };
  verifyOnlyOfficeProductIntent(before, after, [command]);
  after.slides[0].elements[0].onlyoffice.crop.r = 90;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
  after.slides[0].elements[0].onlyoffice.crop.r = 92;
  after.slides[0].elements[1].onlyoffice.ownName = "changed";
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, [command]),
    /unrequested_change/,
  );
});

test("slide background replaces its fill while preserving every drawing and other slide", () => {
  const before = document();
  before.slides[0].onlyoffice.background = null;
  before.slides[0].narrow.background = null;
  before.slides.push(structuredClone(before.slides[0]));
  const after = structuredClone(before);
  const color = { R: 39, G: 181, B: 117, A: 255 };
  after.slides[0].onlyoffice.background = {
    reference: null,
    solid: { type: 1, id: null, rgb: color, modifiers: [] },
    transparency: null,
  };
  after.slides[0].narrow.background = color;
  const commands = [
    { op: "set_background", slideIndex: 0, color: 0xff0000 },
    { op: "set_background", slideIndex: 0, color: 0x27b575 },
  ];
  verifyOnlyOfficeProductIntent(before, after, commands);
  after.slides[1].narrow.background = color;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

test("line style composes partial changes and preserves width, color and unsupplied line ends", () => {
  const before = document();
  before.slides[0].narrow.drawingStyle[0].line = {
    width: 36000,
    color: { R: 0, G: 0, B: 0, A: 255 },
    dash: 6,
    headEnd: null,
    tailEnd: { type: 1, w: 1, len: 1 },
    cap: 0,
  };
  const after = structuredClone(before);
  const commands = [
    {
      op: "set_line_style",
      elementId: "0/0",
      lineStyle: { dash: "lgDashDot", startArrow: null, endArrow: null },
    },
    {
      op: "set_line_style",
      elementId: "0/0",
      lineStyle: {
        dash: null,
        startArrow: { type: "triangle", width: null, length: "lg" },
        endArrow: null,
      },
    },
  ];
  const line = after.slides[0].narrow.drawingStyle[0].line;
  line.dash = 4;
  line.headEnd = { type: 5, w: 1, len: 0 };
  verifyOnlyOfficeProductIntent(before, after, commands);
  line.width = 72000;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
  line.width = 36000;
  line.headEnd.len = 2;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

test("clearing one arrow preserves an unsupplied dash and opposite end", () => {
  const before = document();
  before.slides[0].narrow.drawingStyle[0].line = {
    dash: 6,
    headEnd: { type: 5, w: 1, len: 1 },
    tailEnd: { type: 1, w: 1, len: 1 },
  };
  const after = structuredClone(before);
  after.slides[0].narrow.drawingStyle[0].line.headEnd = null;
  verifyOnlyOfficeProductIntent(before, after, [
    {
      op: "set_line_style",
      elementId: "0/0",
      lineStyle: {
        dash: null,
        startArrow: { type: "none", width: null, length: null },
        endArrow: null,
      },
    },
  ]);
});

test("slide metadata commands verify the requested slide and preserve every drawing and other slide", () => {
  const before = document();
  before.slides[0].onlyoffice.name = "original";
  before.slides[0].onlyoffice.visible = true;
  before.slides.push(structuredClone(before.slides[0]));
  const after = structuredClone(before);
  const commands = [
    { op: "rename_slide", slideIndex: 0, name: "renamed" },
    { op: "set_slide_hidden", slideIndex: 0, hidden: true },
  ];
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
  after.slides[0].onlyoffice.name = "renamed";
  after.slides[0].onlyoffice.visible = false;
  verifyOnlyOfficeProductIntent(before, after, commands);
  after.slides[1].onlyoffice.name = "unexpected";
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

for (const op of ["fill_opacity", "line_opacity"])
  test(
    op + " preserves authored color, modifiers and every other line property",
    () => {
      const before = document();
      const style = before.slides[0].narrow.drawingStyle[0];
      const fill = {
        colorType: 3,
        colorId: 5,
        modifiers: [{ name: "shade", val: 40000 }],
        opacity: 100,
      };
      style.fillStyle = structuredClone(fill);
      style.line = {
        color: { R: 10, G: 20, B: 30, A: 255 },
        fillStyle: structuredClone(fill),
        width: 90000,
        dash: 3,
      };
      const after = structuredClone(before);
      const changed = after.slides[0].narrow.drawingStyle[0];
      const field =
        op === "fill_opacity" ? changed.fillStyle : changed.line.fillStyle;
      field.opacity = 37.123;
      const commands = [{ op, elementId: "0/0", opacity: 37.123 }];
      assert.doesNotThrow(() =>
        verifyOnlyOfficeProductIntent(before, after, commands),
      );
      field.colorId = 6;
      assert.throws(
        () => verifyOnlyOfficeProductIntent(before, after, commands),
        /unrequested_change/,
      );
      field.colorId = 5;
      field.opacity = 37.122;
      assert.throws(
        () => verifyOnlyOfficeProductIntent(before, after, commands),
        /intent_mismatch/,
      );
    },
  );

test("opacity preflight admits canonical percentages, not a fraction-only range", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const shape = {
    Id: "shape",
    spPr: { Fill: { fill: { type: 3, color: {} }, createDuplicate() {} } },
  };
  globalThis.window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: { Slides: [{ cSld: { spTree: [shape] } }] },
        },
      },
      c_oAscFill: { FILL_TYPE_SOLID: 3 },
    },
    AscBuilder: { GetApiDrawing: () => ({ SetFill() {} }) },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({ evaluate: async (fn, arg) => fn(arg) }),
    });
    const [bound] = await engine.preflight([
      { op: "fill_opacity", elementId: "0/0", opacity: 37.123 },
    ]);
    assert.equal(bound.nativeId, "shape");
    assert.equal(Math.trunc((bound.nativeOpacity * 100000) / 255), 37123);
    shape.spPr.Fill.fill.type = 4;
    await assert.rejects(
      engine.preflight([
        { op: "fill_opacity", elementId: "0/0", opacity: 37.123 },
      ]),
      /requires_authored_solid_fill/,
    );
  } finally {
    globalThis.window = old;
  }
});

test("speaker notes replace text while preserving run style and all slide contents", () => {
  const before = document();
  const style = { GetFontSize: 24, GetBold: true, fonts: ["Arial"] };
  before.slides[0].onlyoffice.notes = "old notes\r\n";
  before.slides[0].onlyoffice.notesParagraphs = [
    {
      alignment: "left",
      text: "old notes\r\n",
      runs: [{ text: "old notes", style }],
    },
  ];
  const after = structuredClone(before);
  after.slides[0].onlyoffice.notes = "new notes\r\n";
  after.slides[0].onlyoffice.notesParagraphs[0].text = "new notes\r\n";
  after.slides[0].onlyoffice.notesParagraphs[0].runs[0].text = "new notes";
  const command = [
    { op: "set_speaker_notes", slideIndex: 0, text: "new notes" },
  ];
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, command),
  );
  after.slides[0].onlyoffice.notesParagraphs[0].runs[0].style.GetBold = false;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, command),
    /notes_style_lost/,
  );
  after.slides[0].onlyoffice.notesParagraphs[0].runs[0].style.GetBold = true;
  after.slides[0].elements[1].text = "collateral";
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, command),
    /unrequested_change/,
  );
});

test("table text change preserves fonts, fill and neighboring cells", () => {
  const before = document();
  before.slides[0].elements[0].kind = "table";
  const drawing = before.slides[0].onlyoffice.drawings[0];
  drawing.tableLayout = {
    computedHeight: 300,
    authoredFrame: { extY: 300 },
    rowHeights: [{ value: 300, rule: 1 }],
  };
  drawing.tableCells = [["old\r\n", "neighbor\r\n"]];
  const style = { GetFontSize: 24, GetBold: true };
  drawing.tableParagraphs = [
    [
      [{ alignment: "left", text: "old\r\n", runs: [{ text: "old", style }] }],
      [
        {
          alignment: "left",
          text: "neighbor\r\n",
          runs: [{ text: "neighbor", style }],
        },
      ],
    ],
  ];
  before.slides[0].narrow.table = [
    {
      rows: 1,
      cells: [
        [
          { text: "old\r\n", fill: { R: 255, G: 255, B: 0 } },
          { text: "neighbor\r\n", fill: null },
        ],
      ],
    },
  ];
  const after = structuredClone(before);
  const d = after.slides[0].onlyoffice.drawings[0];
  d.tableCells[0][0] = "final\r\n";
  d.tableParagraphs[0][0][0].text = "final\r\n";
  d.tableParagraphs[0][0][0].runs[0].text = "final";
  after.slides[0].narrow.table[0].cells[0][0].text = "final\r\n";
  const commands = ["first", "final"].map((text) => ({
    op: "set_table_cell",
    elementId: "0/0",
    row: 0,
    column: 0,
    text,
  }));
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  d.tableParagraphs[0][0][0].runs[0].style.GetFontSize = 28;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /table_cell_style_lost/,
  );
  d.tableParagraphs[0][0][0].runs[0].style.GetFontSize = 24;
  after.slides[0].narrow.table[0].cells[0][0].fill.R = 10;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

test("table text reflow may change calculated height while authored heights and frame stay strict", () => {
  const before = document();
  before.slides[0].elements[0].kind = "table";
  const d = before.slides[0].onlyoffice.drawings[0];
  d.tableCells = [["old\r\n"]];
  d.tableParagraphs = [
    [
      [
        {
          alignment: "left",
          text: "old\r\n",
          runs: [{ text: "old", style: { GetFontSize: 24 } }],
        },
      ],
    ],
  ];
  d.tableLayout = {
    computedHeight: 300,
    authoredFrame: { extY: 300 },
    rowHeights: [{ value: 300, rule: 1 }],
  };
  before.slides[0].narrow.table = [
    { rows: 1, cells: [[{ text: "old\r\n", fill: null }]] },
  ];
  const after = structuredClone(before);
  const changed = after.slides[0].onlyoffice.drawings[0];
  changed.tableCells[0][0] = "new\r\n";
  changed.tableParagraphs[0][0][0].text = "new\r\n";
  changed.tableParagraphs[0][0][0].runs[0].text = "new";
  after.slides[0].narrow.table[0].cells[0][0].text = "new\r\n";
  after.slides[0].elements[0].height = 400;
  changed.tableLayout.computedHeight = 400;
  const commands = [
    { op: "set_table_cell", elementId: "0/0", row: 0, column: 0, text: "new" },
  ];
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  changed.tableLayout.rowHeights[0].value = 400;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
  changed.tableLayout.rowHeights[0].value = 300;
  changed.tableLayout.computedHeight = 350;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /table_layout_height/,
  );
});

test("text replacement retains the first paragraph's inherited defaults and end style while creating real later paragraphs", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  const runStyle = { TextPr: { FontSize: 32 } },
    endStyle = { TextPr: { FontSize: 9 } };
  const paragraphs = [];
  const makeParagraph = (existing = false) => ({
    text: "",
    inherited: existing,
    end: existing ? endStyle : null,
    Paragraph: {
      Set_Pr(value) {
        assert.equal(existing, false);
        this.props = value;
      },
    },
    GetElement() {
      if (!existing) return null;
      return {
        GetTextPr: () => runStyle,
        SetTextPr: (style) => {
          this.style = style;
          return style;
        },
        AddText: (text) => {
          this.text = text;
          return true;
        },
      };
    },
    GetTextPr: () => endStyle,
    GetParaPr: () => ({ ParaPr: { Copy: () => ({ spacingAfter: 0 }) } }),
    RemoveAllElements() {
      this.text = "";
    },
    SetTextPr(properties) {
      assert.equal(existing, false);
      if (properties === endStyle) this.end = properties;
      else this.style = properties;
      return true;
    },
    AddText(text) {
      if (existing) throw Error("appended a redundant empty run");
      this.text = text;
      return true;
    },
  });
  const first = makeParagraph(true);
  paragraphs.push(first, makeParagraph());
  const content = {
    GetAllParagraphs: () => paragraphs,
    GetElementsCount: () => paragraphs.length,
    GetElement: (i) => paragraphs[i],
    RemoveElement: (i) => {
      paragraphs.splice(i, 1);
      return true;
    },
    Push: (p) => {
      paragraphs.push(p);
      return true;
    },
    RemoveAllElements() {
      throw Error("discarded paragraph inheritance");
    },
  };
  const shape = { Id: "text" };
  const model = {
    Slides: [{ cSld: { spTree: [shape] } }],
    Recalculate() {},
    RedrawCurSlide() {},
    Document_UpdateInterfaceState() {},
  };
  globalThis.window = {
    Asc: {
      editor: {
        isGroupActions: () => true,
        executeGroupActionsStart() {},
        executeGroupActionsEnd() {},
        WordControl: { m_oLogicDocument: model, GoToPage() {} },
      },
    },
    AscBuilder: {
      GetApiDrawing: () => ({ Drawing: shape, GetDocContent: () => content }),
      Slide: {
        Api: {
          CreateParagraph: () => makeParagraph(),
          GetPresentation: () => ({
            GetSlideByIndex: () => ({ Slide: model.Slides[0] }),
            CreateNewHistoryPoint() {},
          }),
        },
      },
    },
    AscCommon: { History: { Get_RecalcData() {}, getGroupChanges() {} } },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({ evaluate: async (fn, arg) => fn(arg) }),
    });
    await engine.apply({
      op: "replace_text",
      slideIndex: 0,
      nativeId: "text",
      text: "First\r\nSecond",
    });
    assert.equal(paragraphs.length, 2);
    assert.equal(paragraphs[0], first);
    assert.equal(first.end, endStyle);
    assert.equal(first.Paragraph.props, undefined);
    assert.deepEqual(
      paragraphs.map((p) => p.text),
      ["First", "Second"],
    );
    assert.equal(paragraphs[1].end, endStyle);
    for (const paragraph of paragraphs) assert.equal(paragraph.style, runStyle);
  } finally {
    globalThis.window = old;
  }
});

test("whole-batch validation finishes before fallback-font loading and waits for the native callback", async () => {
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  const old = globalThis.window;
  let loaded = 0,
    done,
    returned = false;
  const shape = { Id: "text", getDocContent: () => ({}) };
  globalThis.window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: { Slides: [{ cSld: { spTree: [shape] } }] },
        },
      },
    },
    AscBuilder: { GetApiDrawing: () => ({ Drawing: shape }) },
    AscFonts: {
      FontPickerByCharacter: {
        getFontBySymbol(codepoint) {
          assert.ok(
            ["한".codePointAt(0), "글".codePointAt(0)].includes(codepoint),
          );
          return "Noto Sans KR";
        },
      },
      g_map_font_index: { "Noto Sans KR": 5 },
    },
    AscCommon: {
      g_font_loader: {
        LoadFonts(fonts, callback) {
          loaded++;
          assert.deepEqual(fonts, ["Noto Sans KR"]);
          done = callback;
        },
      },
    },
  };
  try {
    const engine = createOnlyOfficeProductEngine({
      getFrame: async () => ({ evaluate: async (fn, arg) => fn(arg) }),
    });
    await assert.rejects(
      engine.preflight([
        { op: "replace_text", elementId: "0/0", text: "한글" },
        { op: "unknown" },
      ]),
      /operation_unavailable/,
    );
    assert.equal(loaded, 0);
    const result = engine
      .preflight([{ op: "replace_text", elementId: "0/0", text: "한글" }])
      .then((value) => {
        returned = true;
        return value;
      });
    await new Promise(setImmediate);
    assert.equal(loaded, 1);
    assert.equal(returned, false);
    done();
    assert.equal((await result)[0].nativeId, "text");
  } finally {
    globalThis.window = old;
  }
});

test("table movement checks the requested authored position and preserves row rules", () => {
  const before = document();
  before.slides[0].elements[0].kind = "table";
  before.slides[0].onlyoffice.drawings[0].tableLayout = {
    authoredFrame: { offX: 100, offY: 200, extX: 400, extY: 300 },
    computedHeight: 300,
    rowHeights: [{ value: 300, rule: 1 }],
  };
  const after = structuredClone(before);
  after.slides[0].elements[0].x = 500;
  after.slides[0].elements[0].y = 600;
  const layout = after.slides[0].onlyoffice.drawings[0].tableLayout;
  layout.authoredFrame.offX = 500;
  layout.authoredFrame.offY = 600;
  const commands = [{ op: "move", elementId: "0/0", x: 500, y: 600 }];
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  layout.authoredFrame.offX = 501;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
  layout.authoredFrame.offX = 500;
  layout.rowHeights[0].value = 400;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});

for (const position of ["front", "forward", "back", "backward"])
  test(`native stacking ${position} preserves the complete original objects`, () => {
    const before = document();
    const index = ["front", "forward"].includes(position) ? 0 : 1;
    const after = structuredClone(before);
    const slide = after.slides[0];
    for (const values of [
      slide.elements,
      slide.onlyoffice.drawings,
      slide.narrow.drawingStyle,
      slide.narrow.wordArt,
    ])
      values.reverse();
    slide.elements.forEach((e, i) => {
      e.elementId = "0/" + i;
    });
    const commands = [{ op: "z_order", elementId: "0/" + index, position }];
    assert.doesNotThrow(() =>
      verifyOnlyOfficeProductIntent(before, after, commands),
    );
    slide.elements[0].onlyoffice.text = "unrequested text";
    assert.throws(
      () => verifyOnlyOfficeProductIntent(before, after, commands),
      /unrequested_change/,
    );
  });

test("stacking uses preflight identities across a batch and does not excuse a wrong order", () => {
  const before = document(),
    after = structuredClone(before);
  const commands = [
    { op: "z_order", elementId: "0/0", position: "front" },
    { op: "z_order", elementId: "0/1", position: "front" },
    { op: "move", elementId: "0/0", x: 123, y: 456 },
  ];
  after.slides[0].elements[0].x = 123;
  after.slides[0].elements[0].y = 456;
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, before, [commands[0]]),
    /intent_mismatch|unrequested_change/,
  );
});

test("reading order permutes all slide objects and preserves table and nested group evidence", () => {
  const before = document();
  before.slides[0].elements[0].kind = "table";
  before.slides[0].narrow.table = [{ name: "authored table", rows: 1 }];
  before.slides[0].onlyoffice.drawings[0].tableCells = [["cell"]];
  before.slides[0].elements[1].kind = "group";
  before.slides[0].elements[1].elements = [
    { elementId: "0/1/0", text: "nested", elements: [] },
  ];
  const after = structuredClone(before),
    slide = after.slides[0];
  for (const array of [
    slide.elements,
    slide.onlyoffice.drawings,
    slide.narrow.drawingStyle,
    slide.narrow.wordArt,
  ])
    array.reverse();
  slide.elements[0].elementId = "0/0";
  slide.elements[0].elements[0].elementId = "0/0/0";
  slide.elements[1].elementId = "0/1";
  const commands = [{ op: "set_reading_order", elementIds: ["0/1", "0/0"] }];
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  slide.narrow.table[0].rows = 2;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
  assert.throws(
    () =>
      verifyOnlyOfficeProductIntent(before, before, [
        { op: "set_reading_order", elementIds: ["0/0", "0/0"] },
      ]),
    /reading_order/,
  );
});

test("row height admits only requested outer size while preserving other rows and borders", () => {
  const before = document();
  before.slides[0].elements[0].kind = "table";
  const layout = {
    computedHeight: 300,
    authoredFrame: { extY: 300 },
    rowHeights: [
      { value: 150, rule: 1, computedHeight: 150, outerInsets: 20 },
      { value: 150, rule: 1, computedHeight: 150, outerInsets: 20 },
    ],
  };
  before.slides[0].onlyoffice.drawings[0].tableLayout = layout;
  const after = structuredClone(before);
  after.slides[0].elements[0].height = 550;
  const changed = after.slides[0].onlyoffice.drawings[0].tableLayout;
  changed.computedHeight = 550;
  changed.rowHeights[0] = {
    value: 380,
    rule: 1,
    computedHeight: 400,
    outerInsets: 20,
  };
  const commands = [300, 400].map((height) => ({
    op: "set_table_row_height",
    elementId: "0/0",
    index: 0,
    height,
  }));
  assert.doesNotThrow(() =>
    verifyOnlyOfficeProductIntent(before, after, commands),
  );
  changed.rowHeights[0].computedHeight = 390;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /table_row_height/,
  );
  changed.rowHeights[0].computedHeight = 400;
  changed.rowHeights[1].value = 200;
  assert.throws(
    () => verifyOnlyOfficeProductIntent(before, after, commands),
    /unrequested_change/,
  );
});
