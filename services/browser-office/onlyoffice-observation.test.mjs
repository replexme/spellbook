import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { observeOnlyOfficeCandidate } from "./onlyoffice-observation.mjs";

function candidate() {
  const forbidden = () => {
    throw Error("observational getter created content");
  };
  const slides = [0, 1].map((index) => ({
    Slide: {
      cSld: { spTree: [] },
      Layout: { cSld: { name: `layout-${index}` }, type: index },
    },
    GetVisible: () => true,
    GetAllDrawings: () => [],
    GetSlideShowTransition: () => null,
    GetNotes: forbidden,
    GetTimeLine: forbidden,
  }));
  const presentation = {
    GetAllSlides: () => slides,
    GetAllSlideMasters: () => [],
    GetWidth: () => 7200000,
    GetHeight: () => 3600000,
  };
  const window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: {
            Slides: slides.map((s) => s.Slide),
            Sections: [],
          },
        },
      },
    },
    AscBuilder: {
      Slide: { Api: { GetPresentation: () => presentation } },
      GetApiDrawing: (shape) =>
        slides
          .flatMap((slide) => slide.GetAllDrawings())
          .find((drawing) => drawing.Drawing === shape) ?? null,
    },
  };
  const frame = {
    evaluate: (fn) =>
      Promise.resolve(vm.runInNewContext(`(${fn})()`, { window })),
  };
  return { frame, slides, presentation, window };
}

test("candidate observation reads every slide without creating absent notes or timing", async () => {
  const { frame } = candidate();
  const result = JSON.parse(
    JSON.stringify(await observeOnlyOfficeCandidate(frame)),
  );
  assert.equal(result.common.slides.length, 2);
  assert.equal(result.extended.slides.length, 2);
  assert.deepEqual(
    result.narrow.map((slide) => slide.layout.name),
    ["layout-0", "layout-1"],
  );
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.extended.slides[1].notes, null);
  assert.equal(result.extended.width, 200);
});

test("candidate observation records missing and failed read fields explicitly", async () => {
  const { frame, slides } = candidate();
  delete slides[0].GetVisible;
  slides[1].GetVisible = () => {
    throw Error("native read unavailable");
  };
  const result = await observeOnlyOfficeCandidate(frame);
  assert.equal(result.extended.slides[0].visible, null);
  assert.equal(result.extended.slides[1].visible, null);
  assert.deepEqual(Array.from(result.unavailable), [
    "slide0.GetVisible:missing",
    "slide1.GetVisible:native read unavailable",
  ]);
});

test("candidate observation refuses an incomplete or empty slide scope", async () => {
  const { frame, presentation, slides } = candidate();
  presentation.GetAllSlides = () => [slides[0]];
  await assert.rejects(observeOnlyOfficeCandidate(frame), /scope_mismatch/u);
  presentation.GetAllSlides = () => [];
  await assert.rejects(
    observeOnlyOfficeCandidate(frame),
    /slide_observation_unavailable/u,
  );
});

test("text color observation uses native RGB when the pinned getter incorrectly returns black", async () => {
  const { frame, slides, window } = candidate();
  class CRGBColor {
    RGBA = { R: 255, G: 0, B: 0, A: 255 };
  }
  window.AscFormat = { CRGBColor };
  const textPr = {
    TextPr: { Unifill: { fill: { color: { color: new CRGBColor() } } } },
  };
  for (const method of [
    "GetBold",
    "GetItalic",
    "GetUnderline",
    "GetStrikeout",
    "GetFontSize",
    "GetVertAlign",
    "GetSpacing",
    "GetCaps",
    "GetSmallCaps",
    "GetDoubleStrikeout",
    "GetLanguage",
    "GetFontFamily",
  ])
    textPr[method] = () => null;
  textPr.GetColor = () => ({
    GetRGB: () => ({ r: 0, g: 0, b: 0 }),
    IsThemeColor: () => false,
    IsAutoColor: () => false,
  });
  const run = { GetText: () => "red", GetTextPr: () => textPr };
  const paragraph = {
    Paragraph: {Pr:{}},
    GetParaPr: () => ({ GetJc: () => "left" }),
    GetElementsCount: () => 1,
    GetElement: () => run,
    GetText: () => "red",
  };
  const shape = {
    x: 0,
    y: 0,
    extX: 10,
    extY: 10,
    getOwnName: () => "text",
    getDocContent: () => ({ GetText: () => "red" }),
  };
  const drawing = {
    Drawing: shape,
    GetClassType: () => "shape",
    GetDocContent: () => ({ GetAllParagraphs: () => [paragraph] }),
    GetHyperlink: () => null,
  };
  for (const method of [
    "GetPosX",
    "GetPosY",
    "GetWidth",
    "GetHeight",
    "GetRotation",
    "GetFlipH",
    "GetFlipV",
  ])
    drawing[method] = () => 0;
  slides[0].Slide.cSld.spTree = [shape];
  slides[0].GetAllDrawings = () => [drawing];
  const result = await observeOnlyOfficeCandidate(frame);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        result.extended.slides[0].drawings[0].paragraphs[0].runs[0].style.color
          .rgb,
      ),
    ),
    { r: 255, g: 0, b: 0 },
  );
  assert.deepEqual(Array.from(result.unavailable), []);
});

test("drawing RGB reads authored native channels while theme colors retain their resolved channels", async () => {
  const { frame, slides, window } = candidate();
  class CRGBColor {
    RGBA = { R: 255, G: 230, B: 0, A: 255 };
  }
  window.AscFormat = { CRGBColor };
  const fill = {
    fill: {
      color: { color: new CRGBColor(), RGBA: { R: 0, G: 0, B: 0, A: 255 } },
    },
  };
  slides[0].Slide.cSld.Bg = { bgPr: { Fill: fill } };
  slides[1].Slide.cSld.Bg = {
    bgPr: {
      Fill: {
        fill: {
          color: { color: { id: 1 }, RGBA: { R: 17, G: 61, B: 103, A: 255 } },
        },
      },
    },
  };
  const state = await observeOnlyOfficeCandidate(frame);
  assert.deepEqual(JSON.parse(JSON.stringify(state.narrow[0].background)), {
    R: 255,
    G: 230,
    B: 0,
    A: 255,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state.narrow[1].background)), {
    R: 17,
    G: 61,
    B: 103,
    A: 255,
  });
});

test("master, layout, theme and section changes are included without creating absent content", async () => {
  const { frame, presentation, window } = candidate();
  const master = {
    cSld: { name: "master", spTree: [] },
    sldLayoutLst: [{ cSld: { name: "layout", spTree: [] }, type: 3 }],
    Theme: {
      name: "theme",
      themeElements: {
        clrScheme: { name: "palette", colors: Array.from({length:14}, (_,id)=>({color:{type:3,id}})) },
        fontScheme: {
          name: "fonts",
          majorFont: { latin: "Arial", ea: "", cs: "" },
          minorFont: { latin: "Arial", ea: "", cs: "" },
        },
      },
    },
  };
  presentation.GetAllSlideMasters = () => [{ Master: master }];
  window.Asc.editor.WordControl.m_oLogicDocument.Sections = [
    { name: "Section A", startIndex: 0, guid: "section-guid" },
  ];
  const before = await observeOnlyOfficeCandidate(frame);
  assert.equal(before.extended.masters[0].layouts[0].name, "layout");
  assert.equal(before.extended.masters[0].theme.fonts.major.latin, "Arial");
  assert.deepEqual(Array.from(before.extended.masters[0].theme.colors.values,color=>color.id), [0,1,2,3,4,5,8,9,10,11,12,13]);
  assert.equal(before.extended.sections[0].name, "Section A");
  master.Theme.name = "modified theme";
  assert.notDeepEqual(
    (await observeOnlyOfficeCandidate(frame)).extended,
    before.extended,
  );
  delete window.Asc.editor.WordControl.m_oLogicDocument.Sections;
  assert.ok(
    (await observeOnlyOfficeCandidate(frame)).unavailable.includes(
      "presentation.sections:missing",
    ),
  );
});

test("dynamic field definitions are stable across rendered cache changes and remain distinct from literal text", async () => {
  const { frame, slides, window } = candidate();
  window.AscFormat = { CRGBColor: class {} };
  let rendered = "1\r\n";
  const run = {
    Run: { FieldType: "slidenum", Guid: "field-guid" },
    GetText: () => rendered.trim(),
    GetTextPr: () =>
      new Proxy(
        {},
        { get: (_target, name) => (name === "TextPr" ? {} : () => null) },
      ),
  };
  const paragraph = {
    Paragraph: {Pr:{}},
    GetParaPr: () => ({ GetJc: () => "left" }),
    GetElementsCount: () => 1,
    GetElement: () => run,
    GetText: () => rendered,
  };
  const content = { GetText: () => rendered };
  const drawing = {
    Drawing: { getOwnName: () => "number", getDocContent: () => content },
    GetClassType: () => "shape",
    GetDocContent: () => ({ GetAllParagraphs: () => [paragraph] }),
    GetHyperlink: () => null,
  };
  for (const method of [
    "GetPosX",
    "GetPosY",
    "GetWidth",
    "GetHeight",
    "GetRotation",
    "GetFlipH",
    "GetFlipV",
  ])
    drawing[method] = () => 0;
  slides[0].GetAllDrawings = () => [drawing];
  slides[0].Slide.cSld.spTree = [drawing.Drawing];
  const before = (await observeOnlyOfficeCandidate(frame)).extended.slides[0]
    .drawings[0];
  rendered = "<#>\r\n";
  const reopened = (await observeOnlyOfficeCandidate(frame)).extended.slides[0]
    .drawings[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify(before)),
    JSON.parse(JSON.stringify(reopened)),
  );
  assert.equal(before.text, "<field:slidenum>\r\n");
  run.Run.FieldType = null;
  assert.notDeepEqual(
    JSON.parse(
      JSON.stringify(
        (await observeOnlyOfficeCandidate(frame)).extended.slides[0]
          .drawings[0],
      ),
    ),
    JSON.parse(JSON.stringify(before)),
  );
});

test("one synchronous native read retains connectors omitted by the public drawing list", async () => {
  const { frame, slides, window } = candidate();
  window.AscDFH = { historyitem_type_Cnx: 7 };
  window.AscFormat = {
    LOCKS_MASKS: { noMove: 1024, noResize: 4096, noCrop: 16777216 },
  };
  const shape = {
    getObjectType: () => 7,
    getOwnName: () => "connector",
    getCNvProps: () => ({
      title: "accessible connector",
      descr: "connects two nodes",
    }),
    getLockValue: (mask) => mask !== 4096,
    x: 0,
    y: 0,
    extX: 10,
    extY: 10,
    isShape: () => true,
  };
  window.AscBuilder.ApiShape = class {
    constructor(native) {
      this.Drawing = native;
    }
    GetClassType() {
      return "shape";
    }
    GetHyperlink() {
      return null;
    }
  };
  for (const method of [
    "GetPosX",
    "GetPosY",
    "GetWidth",
    "GetHeight",
    "GetRotation",
    "GetFlipH",
    "GetFlipV",
  ])
    window.AscBuilder.ApiShape.prototype[method] = () => 0;
  slides[0].Slide.cSld.spTree = [shape];
  assert.equal(slides[0].GetAllDrawings().length, 0);
  const evaluate = frame.evaluate;
  let calls = 0;
  frame.evaluate = (fn) => {
    calls++;
    return evaluate(fn);
  };
  const result = await observeOnlyOfficeCandidate(frame);
  assert.equal(calls, 1);
  assert.equal(result.common.slides[0].shapes[0].type, "connector");
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.common.slides[0].shapes[0].locks)),
    { noMove: true, noResize: false, noCrop: true },
  );
  assert.equal(result.common.slides[0].shapes[0].title, "accessible connector");
  assert.equal(
    result.common.slides[0].shapes[0].description,
    "connects two nodes",
  );
  assert.equal(result.extended.slides[0].drawings[0].type, "connector");
  assert.equal(result.narrow[0].drawingStyle.length, 1);
  assert.equal(result.unavailable.length, 0);
});

test("chart series type is read from its containing native chart instead of a broken parent getter", async () => {
  const { frame, slides } = candidate();
  const series = { idx: 0, parent: {} };
  const chart = { series: [series], getChartType: () => 42 };
  const shape = {
    x: 0,
    y: 0,
    extX: 10,
    extY: 10,
    getOwnName: () => "chart",
    isChart: () => true,
  };
  const drawing = {
    Drawing: shape,
    Chart: {
      chart: { plotArea: { charts: [chart], axId: [] } },
      getAllSeries: () => [series],
    },
    GetClassType: () => "chart",
    GetChartType: () => "bar",
    GetAllSeries: () => [
      {
        GetChartType: () => {
          throw Error("broken native parent getter");
        },
      },
    ],
    GetHyperlink: () => null,
  };
  for (const method of [
    "GetPosX",
    "GetPosY",
    "GetWidth",
    "GetHeight",
    "GetRotation",
    "GetFlipH",
    "GetFlipV",
  ])
    drawing[method] = () => 0;
  slides[0].Slide.cSld.spTree = [shape];
  slides[0].GetAllDrawings = () => [drawing];
  const result = await observeOnlyOfficeCandidate(frame);
  assert.equal(result.extended.slides[0].drawings[0].series[0].chartType, 42);
  assert.equal(result.unavailable.length, 0);
});
