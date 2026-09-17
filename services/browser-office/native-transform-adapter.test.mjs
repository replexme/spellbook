import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { upstreamManifest } from "./libreoffice/upstream.mjs";

const source = readFileSync(
  new URL("./harness/native-transform-adapter.js", import.meta.url),
  "utf8",
);
const runtimeAdmissionSource = readFileSync(
  new URL("./harness/runtime-admission.js", import.meta.url),
  "utf8",
);
const officeThreadSource = readFileSync(
  new URL("./harness/office-thread.js", import.meta.url),
  "utf8",
);
const nativeCapabilities = JSON.parse(
  readFileSync(
    new URL("../../contracts/native-edit-capabilities.json", import.meta.url),
    "utf8",
  ),
);
const completeNativeOperationSurface = Object.values(
  nativeCapabilities.operationGroups,
).flat();

function loadFactory() {
  const context = {
    spellbookMutationContracts: Object.fromEntries(
      Object.entries(nativeCapabilities.mutationModel.operations).map(
        ([operation, contract]) => [
          operation,
          {
            ...contract,
            domain:
              nativeCapabilities.mutationModel.families[contract.family].domain,
          },
        ],
      ),
    ),
  };
  vm.runInNewContext(runtimeAdmissionSource, context, {
    filename: "runtime-admission.js",
  });
  vm.runInNewContext(source, context, {
    filename: "native-transform-adapter.js",
  });
  return context.createSpellbookBrowserNativeAdapter;
}

test("runtime admission follows a verified identity shape without a frozen patch revision", () => {
  const context = {};
  vm.runInNewContext(runtimeAdmissionSource, context, {
    filename: "runtime-admission.js",
  });
  const admitted = {
    buildReady: true,
    buildCommit: upstreamManifest.source.candidateCommit,
    candidateCommit: upstreamManifest.source.candidateCommit,
    patchLevel: upstreamManifest.sourceCandidate.patchLevel,
    patchSeriesSha256: upstreamManifest.sourceCandidate.patchSeriesSha256,
  };
  assert.equal(context.spellbookBrowserRuntimeAdmitted(admitted), true);
  assert.equal(
    context.spellbookBrowserRuntimeAdmitted({ ...admitted, buildReady: false }),
    false,
  );
  assert.equal(
    context.spellbookBrowserRuntimeAdmitted({
      ...admitted,
      buildCommit: "different",
    }),
    false,
  );
  assert.equal(
    context.spellbookBrowserRuntimeAdmitted({
      ...admitted,
      patchSeriesSha256: "invalid",
    }),
    false,
  );
});

function fixture() {
  let activePage;
  let contextOpen = false;
  const undoTitles = [];
  const writes = [];
  const mutations = [];
  const undo = {
    enterUndoContext(title) {
      assert.equal(contextOpen, false);
      contextOpen = true;
      writes.push(["enter", title]);
    },
    leaveUndoContext() {
      assert.equal(contextOpen, true);
      contextOpen = false;
      undoTitles.push("AI presentation edit");
      writes.push(["leave"]);
    },
    getAllUndoActionTitles() {
      return [...undoTitles];
    },
    undo() {
      undoTitles.pop();
      writes.push(["undo"]);
    },
  };
  const shape = (name, initialText = "Alpha Beta\nSecond paragraph") => {
    const paragraphs = initialText.split("\n").map((text, index) => ({
      text,
      properties: {},
      setPropertyValue(property, value) {
        this.properties[property] = value.val;
        mutations.push([
          `${name}-paragraph-${index}`,
          property,
          value.type,
          value.val,
        ]);
      },
    }));
    return {
      name,
      text: initialText,
      properties: {},
      textProperties: {},
      paragraphs,
      getString() {
        return this.text;
      },
      setString(value) {
        this.text = value;
        mutations.push([name, "Text", "string", value]);
      },
      createTextCursor() {
        const target = this;
        let start = 0;
        let end = 0;
        return {
          gotoStart(expand) {
            if (expand) start = 0;
            else start = end = 0;
          },
          gotoEnd(expand) {
            if (expand) end = target.text.length;
            else start = end = target.text.length;
          },
          goRight(count, expand) {
            if (end + count > target.text.length) return false;
            if (expand) end += count;
            else start = end += count;
            return true;
          },
          getString() {
            return target.text.slice(start, end);
          },
          setString(value) {
            target.text =
              target.text.slice(0, start) + value + target.text.slice(end);
            end = start + value.length;
            mutations.push([name, "TextRange", "string", value]);
          },
          setPropertyValue(property, value) {
            target.textProperties[property] = value.val;
            mutations.push([name, property, value.type, value.val]);
          },
        };
      },
      createEnumeration() {
        let index = 0;
        return {
          hasMoreElements: () => index < paragraphs.length,
          nextElement: () => paragraphs[index++],
        };
      },
      setPropertyValue(property, value) {
        this.properties[property] = value.val;
        mutations.push([name, property, value.type, value.val]);
      },
    };
  };
  const page = (name, children) => {
    const notesShape = shape(`${name}-notes`, "Existing notes");
    notesShape.getShapeType = () => "com.sun.star.presentation.NotesShape";
    const notesPage = {
      getCount: () => 1,
      getByIndex: (index) => {
        assert.equal(index, 0);
        return notesShape;
      },
    };
    return {
      name,
      notesShape,
      properties: {},
      getName() {
        return this.name;
      },
      setName(value) {
        this.name = value;
        mutations.push([name, "Name", "string", value]);
      },
      setPropertyValue(property, value) {
        this.properties[property] = value.val;
        mutations.push([name, property, value.type, value.val]);
      },
      getCount() {
        return children.length;
      },
      getByIndex(index) {
        return children[index];
      },
      getNotesPage() {
        return notesPage;
      },
    };
  };
  const firstShape = shape("first-shape");
  const secondShape = shape("second-shape");
  const firstPage = page("Slide 1", [firstShape]);
  const secondPage = page("Slide 2", [secondShape]);
  const pageList = [firstPage, secondPage];
  activePage = firstPage;
  const pages = {
    getCount: () => pageList.length,
    getByIndex: (index) => pageList[index],
    remove: (target) => {
      const index = pageList.indexOf(target);
      assert.ok(index >= 0);
      pageList.splice(index, 1);
      writes.push(["remove", target.name]);
    },
  };
  const controller = {
    getCurrentPage: () => activePage,
    setCurrentPage: (next) => {
      activePage = next;
      writes.push(["page", next.name]);
    },
  };
  const dispatch = (command) => {
    const index = pageList.indexOf(activePage);
    if (command === ".uno:DuplicatePage") {
      const duplicate = page(`${activePage.name} copy`, []);
      pageList.splice(index + 1, 0, duplicate);
      activePage = duplicate;
    } else if (command === ".uno:DeletePage") {
      pageList.splice(index, 1);
      activePage = pageList[Math.min(index, pageList.length - 1)];
    } else if (command === ".uno:MovePageUp") {
      assert.ok(index > 0);
      const [current] = pageList.splice(index, 1);
      pageList.splice(index - 1, 0, current);
    } else if (command === ".uno:MovePageDown") {
      assert.ok(index >= 0 && index < pageList.length - 1);
      const [current] = pageList.splice(index, 1);
      pageList.splice(index + 1, 0, current);
    } else throw new Error(`Unexpected dispatch ${command}`);
    writes.push(["dispatch", command]);
  };
  class Any {
    constructor(type, val) {
      this.type = type;
      this.val = val;
    }
  }
  class GraphicCrop {
    constructor(value) {
      Object.assign(this, value);
    }
  }
  const ClickAction = Object.assign(function ClickAction() {}, {
    NONE: "none",
    DOCUMENT: "document",
    BOOKMARK: "bookmark",
    NEXTPAGE: "next",
    PREVPAGE: "previous",
    FIRSTPAGE: "first",
    LASTPAGE: "last",
    STOPPRESENTATION: "stop",
  });
  const presentation = { ClickAction };
  const FontSlant = Object.assign(function FontSlant() {}, {
    NONE: "none",
    ITALIC: "italic",
  });
  const awt = {
    FontSlant,
    FontStrikeout: { NONE: 0, SINGLE: 1 },
    FontUnderline: { NONE: 0, SINGLE: 1 },
  };
  const ParagraphAdjust = Object.assign(function ParagraphAdjust() {}, {
    LEFT: "left",
    RIGHT: "right",
    BLOCK: "justify",
    CENTER: "center",
  });
  const style = { ParagraphAdjust };
  const LineStyle = Object.assign(function LineStyle() {}, {
    NONE: "none",
    SOLID: "solid",
    DASH: "dash",
  });
  const drawing = { LineStyle };
  const text = {
    GraphicCrop,
    WritingMode2: { LR_TB: 0, RL_TB: 1, TB_RL: 2 },
  };
  const uno = {
    Any,
    type: {
      string: "string",
      boolean: "boolean",
      byte: "byte",
      short: "short",
      long: "long",
      float: "float",
      double: "double",
      enum: (value) =>
        value === FontSlant
          ? "enum:FontSlant"
          : value === ParagraphAdjust
            ? "enum:ParagraphAdjust"
            : value === LineStyle
              ? "enum:LineStyle"
              : "enum:ClickAction",
      struct: () => "struct:GraphicCrop",
    },
    idl: {
      com: {
        sun: { star: { awt, drawing, presentation, style, text } },
      },
    },
  };
  const factory = loadFactory();
  const runtimeIdentity = {
    buildReady: true,
    buildCommit: "candidate",
    candidateCommit: "candidate",
    patchLevel: upstreamManifest.sourceCandidate.patchLevel,
    patchSeriesSha256: "a".repeat(64),
  };
  return {
    adapter: factory({ uno, runtimeIdentity }),
    factory,
    uno,
    controller,
    dispatch,
    model: { getUndoManager: () => undo },
    pages,
    firstPage,
    secondPage,
    firstShape,
    secondShape,
    writes,
    mutations,
  };
}

test("browser adapter advertises the complete bounded PPTX operation surface", () => {
  const { adapter } = fixture();
  assert.deepEqual(
    Array.from(adapter.supportedOperations).sort(),
    [...completeNativeOperationSurface].sort(),
  );
  assert.equal(
    adapter.supportedOperations.length,
    nativeCapabilities.aiExposure.operationCount,
  );
  assert.equal(
    adapter.engineIdentity.patchLevel,
    upstreamManifest.sourceCandidate.patchLevel,
  );
  assert.equal(adapter.engineIdentity.engineImage, "browser-wasm");
});

test("browser runtime decodes image and media assets without exposing model URLs", () => {
  for (const operation of [
    "insert_image",
    "replace_image",
    "insert_media",
    "replace_media",
  ])
    assert.match(officeThreadSource, new RegExp(`"${operation}"`, "u"));
  assert.match(officeThreadSource, /assetSignatureIsValid/u);
  assert.match(officeThreadSource, /GraphicProvider\.create/u);
  assert.match(officeThreadSource, /dispatch\("InsertAVMedia"/u);
  assert.match(officeThreadSource, /"SpellbookReplaceObject"/u);
  assert.match(officeThreadSource, /FS\.unlink\(path\)/u);
});

test("browser adapter exposes only stock slide lifecycle on an unbuilt runtime", () => {
  const runtime = fixture();
  const adapter = runtime.factory({
    uno: runtime.uno,
    runtimeIdentity: {
      buildReady: false,
      buildCommit: "stock",
      candidateCommit: "candidate",
      patchLevel: upstreamManifest.sourceCandidate.patchLevel,
    },
  });
  assert.deepEqual(Array.from(adapter.supportedOperations), []);
  assert.equal(adapter.engineIdentity, null);
  assert.equal(adapter.supportsTransform([{ JumpToSlide: 0 }]), true);
  assert.equal(adapter.supportsTransform([{ DuplicateSlide: 0 }]), true);
  assert.equal(adapter.supportsTransform([{ DeleteSlide: 0 }]), false);
  assert.equal(adapter.supportsTransform([{ RenameSlide: "Renamed" }]), false);
});

test("browser adapter claims only complete admitted transform lists", () => {
  const { adapter } = fixture();
  assert.equal(
    adapter.supportsTransform([
      { JumpToSlide: 1 },
      { RenameSlide: "Target slide" },
    ]),
    true,
  );
  assert.equal(
    adapter.supportsTransform([{ JumpToSlide: 1 }, { DuplicateSlide: 1 }]),
    true,
  );
  assert.equal(adapter.supportsTransform([]), false);
});

test("browser adapter routes stock slide lifecycle through Impress commands", () => {
  const runtime = fixture();
  const stockAdapter = runtime.factory({
    uno: runtime.uno,
    runtimeIdentity: {
      buildReady: false,
      buildCommit: "stock",
      candidateCommit: "candidate",
      patchLevel: upstreamManifest.sourceCandidate.patchLevel,
    },
  });
  assert.equal(stockAdapter.supportsTransform([{ DuplicateSlide: 0 }]), true);
  stockAdapter.transformSlides({
    commands: [{ DuplicateSlide: 0 }],
    ...runtime,
  });
  assert.equal(runtime.pages.getCount(), 3);
  stockAdapter.transformSlides({
    commands: [{ "MoveSlide.2": 0 }],
    ...runtime,
  });
  assert.equal(runtime.controller.getCurrentPage().name, "Slide 2");
  assert.deepEqual(
    runtime.writes.filter(([kind]) => ["dispatch", "remove"].includes(kind)),
    [
      ["dispatch", ".uno:DuplicatePage"],
      ["dispatch", ".uno:MovePageUp"],
      ["dispatch", ".uno:MovePageUp"],
    ],
  );
});

test("browser adapter deletes a slide only after native structure admission", () => {
  const runtime = fixture();
  const admittedAdapter = runtime.factory({
    uno: runtime.uno,
    runtimeIdentity: {
      buildReady: true,
      buildCommit: "candidate",
      candidateCommit: "candidate",
      patchLevel: upstreamManifest.sourceCandidate.patchLevel,
      patchSeriesSha256: "a".repeat(64),
      nativeSlideStructureReady: true,
    },
  });
  assert.equal(admittedAdapter.supportsTransform([{ DeleteSlide: 1 }]), true);
  admittedAdapter.transformSlides({
    commands: [{ DeleteSlide: 1 }],
    ...runtime,
  });
  assert.equal(runtime.pages.getCount(), 1);
  assert.deepEqual(
    runtime.writes.filter(([kind]) => kind === "remove"),
    [["remove", "Slide 2"]],
  );
});

test("browser adapter preflights a complete list before mutating", () => {
  const runtime = fixture();
  assert.throws(
    () =>
      runtime.adapter.transformSlides({
        commands: [
          { RenameSlide: "Must not apply" },
          { UnsupportedMutation: true },
        ],
        ...runtime,
      }),
    /Unsupported browser native transform/u,
  );
  assert.equal(runtime.firstPage.name, "Slide 1");
  assert.deepEqual(runtime.writes, []);
  assert.deepEqual(runtime.mutations, []);
});

test("browser adapter follows virtual navigation and groups page changes", () => {
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      { RenameSlide: "Target slide" },
      { SetSlideVisible: false },
      {
        SetSlideTransition: {
          Type: 37,
          Subtype: 101,
          Direction: true,
          FadeColor: 0,
          Duration: 1.5,
        },
      },
    ],
    ...runtime,
  });
  assert.equal(runtime.firstPage.name, "Slide 1");
  assert.equal(runtime.secondPage.name, "Target slide");
  assert.equal(runtime.secondPage.properties.Visible, false);
  assert.equal(runtime.secondPage.properties.TransitionType, 37);
  assert.equal(runtime.secondPage.properties.TransitionDuration, 1.5);
  assert.deepEqual(runtime.writes, [
    ["enter", "AI presentation edit"],
    ["page", "Slide 2"],
    ["leave"],
  ]);
});

test("browser adapter writes only bounded object, crop and interaction fields", () => {
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      {
        "SetObjectProperties.0": {
          FillTransparence: 37,
          LineColor: 0x123456,
          LineTransparence: 43,
          LineWidth: 200,
          LineStyle: 2,
          LineDashName: "Fine Dashed",
          LineStartName: "Arrow",
          LineEndName: "Square",
          RotateAngle: 1_500,
          TextLeftDistance: 420,
          Shadow: true,
          MoveProtect: true,
        },
      },
      {
        "SetGraphicCrop.0": { Left: 1, Top: 2, Right: 3, Bottom: 4 },
      },
      {
        "SetObjectInteraction.0": {
          Action: "internal_slide",
          TargetSlideIndex: 0,
        },
      },
    ],
    ...runtime,
  });
  assert.equal(runtime.secondShape.properties.TextLeftDistance, 420);
  assert.equal(runtime.secondShape.properties.FillTransparence, 37);
  assert.equal(runtime.secondShape.properties.LineColor, 0x123456);
  assert.equal(runtime.secondShape.properties.LineTransparence, 43);
  assert.equal(runtime.secondShape.properties.LineWidth, 200);
  assert.equal(runtime.secondShape.properties.LineStyle, "dash");
  assert.equal(runtime.secondShape.properties.LineDashName, "Fine Dashed");
  assert.equal(runtime.secondShape.properties.LineStartName, "Arrow");
  assert.equal(runtime.secondShape.properties.LineEndName, "Square");
  assert.equal(runtime.secondShape.properties.RotateAngle, 1_500);
  assert.deepEqual(
    runtime.mutations.filter(([, property]) =>
      [
        "FillTransparence",
        "LineColor",
        "LineTransparence",
        "LineWidth",
        "RotateAngle",
      ].includes(property),
    ),
    [
      ["second-shape", "FillTransparence", "short", 37],
      ["second-shape", "LineColor", "long", 0x123456],
      ["second-shape", "LineTransparence", "short", 43],
      ["second-shape", "LineWidth", "long", 200],
      ["second-shape", "RotateAngle", "long", 1_500],
    ],
  );
  assert.equal(runtime.secondShape.properties.Shadow, true);
  assert.equal(runtime.secondShape.properties.MoveProtect, true);
  assert.deepEqual(
    { ...runtime.secondShape.properties.GraphicCrop },
    { Left: 1, Top: 2, Right: 3, Bottom: 4 },
  );
  assert.equal(runtime.secondShape.properties.OnClick, "bookmark");
  assert.equal(runtime.secondShape.properties.Bookmark, "Slide 1");
});

test("browser adapter writes bounded slide metadata and paragraph formatting", () => {
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      {
        SetSlideProperties: {
          IsFooterVisible: true,
          FooterText: "Confidential",
          IsPageNumberVisible: true,
          IsDateTimeVisible: true,
          IsDateTimeFixed: true,
          DateTimeText: "2026-09-16",
          DateTimeFormat: 3,
          HighResDuration: 12.5,
          IsBackgroundObjectsVisible: false,
        },
      },
      {
        "SetParagraphProperties.0": {
          Paragraph: 1,
          LeftMargin: 1200,
          RightMargin: 300,
          FirstLineIndent: -200,
          TopMargin: 100,
          BottomMargin: 200,
          Direction: "right-to-left",
        },
      },
    ],
    ...runtime,
  });

  assert.deepEqual(runtime.secondPage.properties, {
    IsFooterVisible: true,
    FooterText: "Confidential",
    IsPageNumberVisible: true,
    IsDateTimeVisible: true,
    IsDateTimeFixed: true,
    DateTimeText: "2026-09-16",
    DateTimeFormat: 3,
    HighResDuration: 12.5,
    Change: 1,
    IsBackgroundObjectsVisible: false,
  });
  assert.deepEqual(runtime.secondShape.paragraphs[1].properties, {
    ParaLeftMargin: 1200,
    ParaRightMargin: 300,
    ParaFirstLineIndent: -200,
    ParaTopMargin: 100,
    ParaBottomMargin: 200,
    WritingMode: 1,
  });
  assert.deepEqual(runtime.writes, [
    ["enter", "AI presentation edit"],
    ["page", "Slide 2"],
    ["leave"],
  ]);
});

test("browser adapter rejects unsupported PPTX last-line alignment before writing", () => {
  const runtime = fixture();
  assert.throws(
    () =>
      runtime.adapter.transformSlides({
        commands: [
          { JumpToSlide: 1 },
          {
            "SetParagraphProperties.0": {
              Paragraph: 1,
              LastLineAlignment: "right",
            },
          },
        ],
        ...runtime,
      }),
    /Browser paragraph properties contains an unsupported field/u,
  );
  assert.deepEqual(runtime.writes, []);
  assert.deepEqual(runtime.mutations, []);
});

test("browser adapter rejects negative paragraph margins but allows a negative first-line indent", () => {
  for (const field of ["LeftMargin", "RightMargin"]) {
    const runtime = fixture();
    assert.throws(
      () =>
        runtime.adapter.transformSlides({
          commands: [
            { JumpToSlide: 1 },
            { "SetParagraphProperties.0": { Paragraph: 1, [field]: -1 } },
          ],
          ...runtime,
        }),
      new RegExp(`Browser paragraph ${field} is invalid`, "u"),
    );
    assert.deepEqual(runtime.mutations, []);
  }
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      { "SetParagraphProperties.0": { Paragraph: 1, FirstLineIndent: -200 } },
    ],
    ...runtime,
  });
  assert.equal(
    runtime.secondShape.paragraphs[1].properties.ParaFirstLineIndent,
    -200,
  );
});

test("browser adapter preserves an explicit manual slide advance choice", () => {
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      {
        SetSlideProperties: {
          AutoAdvance: false,
        },
      },
    ],
    ...runtime,
  });
  assert.deepEqual(runtime.secondPage.properties, {
    Change: 0,
  });
});

test("browser adapter rejects a manual slide with an unrepresentable duration", () => {
  const runtime = fixture();
  assert.throws(
    () =>
      runtime.adapter.transformSlides({
        commands: [
          { JumpToSlide: 1 },
          {
            SetSlideProperties: {
              HighResDuration: 8.25,
              AutoAdvance: false,
            },
          },
        ],
        ...runtime,
      }),
    /requires automatic advance/u,
  );
  assert.deepEqual(runtime.secondPage.properties, {});
});

test("browser adapter source uses the generated browser UNO enum shape", () => {
  assert.doesNotMatch(
    source,
    /FontSlant_|FontUnderline_|FontStrikeout_|ParagraphAdjust_|ClickAction_/u,
  );
});

test("browser adapter writes text, formatting and notes in one native Undo group", () => {
  const runtime = fixture();
  runtime.adapter.transformSlides({
    commands: [
      { JumpToSlide: 1 },
      {
        "SetTextRange.0": {
          Paragraph: 0,
          Start: 0,
          End: 5,
          ExpectedText: "Alpha",
          Text: "Gamma",
        },
      },
      {
        "SetTextProperties.0": {
          Bold: true,
          FontColor: 0x123456,
          Italic: true,
          FontFamily: "Aptos",
          FontHeightPoints: 20,
          Kerning: 35,
          Escapement: 33,
          EscapementHeight: 58,
          ParagraphAlignment: "center",
          Strikethrough: true,
          Underline: true,
        },
      },
      { SetNotes: "Updated speaker notes" },
    ],
    ...runtime,
  });

  assert.equal(runtime.secondShape.text, "Gamma Beta\nSecond paragraph");
  assert.equal(runtime.secondPage.notesShape.text, "Updated speaker notes");
  assert.equal(runtime.secondShape.textProperties.CharWeight, 150);
  assert.equal(runtime.secondShape.textProperties.CharWeightAsian, 150);
  assert.equal(runtime.secondShape.textProperties.CharPosture, "italic");
  assert.equal(runtime.secondShape.textProperties.CharFontName, "Aptos");
  assert.equal(runtime.secondShape.textProperties.CharHeight, 20);
  assert.equal(runtime.secondShape.textProperties.CharKerning, 20);
  assert.equal(runtime.secondShape.textProperties.CharEscapement, 33);
  assert.equal(runtime.secondShape.textProperties.CharEscapementHeight, 58);
  assert.equal(runtime.secondShape.textProperties.CharColor, 0x123456);
  assert.equal(runtime.secondShape.textProperties.CharStrikeout, 1);
  assert.equal(runtime.secondShape.textProperties.CharUnderline, 1);
  assert.equal(runtime.secondShape.textProperties.ParaAdjust, "center");
  assert.deepEqual(runtime.writes, [
    ["enter", "AI presentation edit"],
    ["page", "Slide 2"],
    ["leave"],
  ]);
});

test("browser adapter closes and rolls back a failed native Undo group", () => {
  const runtime = fixture();
  const original = runtime.secondShape.setPropertyValue;
  runtime.secondShape.setPropertyValue = function setPropertyValue(
    name,
    value,
  ) {
    original.call(this, name, value);
    if (name === "Shadow") throw new Error("synthetic native failure");
  };
  assert.throws(
    () =>
      runtime.adapter.transformSlides({
        commands: [
          { JumpToSlide: 1 },
          { "SetObjectProperties.0": { Shadow: true } },
        ],
        ...runtime,
      }),
    /synthetic native failure/u,
  );
  assert.deepEqual(runtime.writes, [
    ["enter", "AI presentation edit"],
    ["page", "Slide 2"],
    ["leave"],
    ["undo"],
  ]);
});
