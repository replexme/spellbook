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
  const drawing = {
    Drawing: { Id: "native-1" },
    SetPosition() {
      assert.equal(locked, false);
      if (fail) throw Error("native_setter_failed");
      return this;
    },
  };
  const model = {
    Slides: [{ cSld: { spTree: [{ Id: "native-1" }] } }],
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
    WordControl: { m_oLogicDocument: model, Thumbnails: { SelectPage() {} } },
  };
  globalThis.window = {
    Asc: { editor },
    AscBuilder: {
      Slide: {
        Api: {
          GetPresentation: () => ({
            GetSlideByIndex: () => ({ GetAllDrawings: () => [drawing] }),
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
      slideIndex: 0,
      x: 100,
      y: 200,
    };
    assert.equal(await engine.apply(command), true);
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
