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
    GetWidth: () => 7200000,
    GetHeight: () => 3600000,
  };
  const window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: { Slides: slides.map((s) => s.Slide) },
        },
      },
    },
    AscBuilder: { Slide: { Api: { GetPresentation: () => presentation } } },
  };
  const frame = {
    evaluate: (fn) =>
      Promise.resolve(vm.runInNewContext(`(${fn})()`, { window })),
  };
  return { frame, slides, presentation };
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
