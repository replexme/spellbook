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
  const { createOnlyOfficeProductEngine } = await import(
    "./onlyoffice/product-engine.mjs"
  );
  let bound;
  const engine = createOnlyOfficeProductEngine({
    bindArtifact: async (bytes) => {
      bound = bytes;
    },
  });
  const bytes = Uint8Array.of(1, 2, 3);
  await engine.bindArtifact(bytes);
  assert.equal(bound, bytes);
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
