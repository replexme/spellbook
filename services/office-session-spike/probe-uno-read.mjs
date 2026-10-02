import { closeNativeProbe } from "./probe-raw-snapshots.mjs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const detailSlideIndex = process.argv[3] ? Number(process.argv[3]) : null;
const expectedFamily = process.argv[4] ?? null;
if (detailSlideIndex !== null && !Number.isInteger(detailSlideIndex))
  throw new Error("detail slide index must be an integer");
if (
  expectedFamily !== null &&
  !["chart", "smartart-fallback", "animation", "picture"].includes(
    expectedFamily,
  )
)
  throw new Error(`unsupported expected family: ${expectedFamily}`);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 60_000;
  while (
    !page
      .frames()
      .some((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      )
  ) {
    if (Date.now() >= deadline)
      throw new Error("Native editor extension did not connect.");
    await page.waitForTimeout(250);
  }
  const state = await page.evaluate(async (input) => {
    const launch = window.__spellbookLaunch;
    const response = await fetch("/native/probe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${launch.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "observe",
        detailSlideIndex: input,
      }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }, detailSlideIndex);
  if (
    !Array.isArray(state.masters) ||
    state.masters.length === 0 ||
    state.slides.some((slide) => !Number.isInteger(slide.masterIndex))
  )
    throw new Error(
      "Master/theme observation is missing from the live document.",
    );

  const elements = state.slides.flatMap((slide) => slide.elements);
  const summary = { expectedFamily };
  if (expectedFamily === "chart") {
    const chart = elements.find((element) => element.chart)?.chart;
    if (
      !chart ||
      chart.rowCount !== 4 ||
      chart.columnCount !== 3 ||
      chart.chartTypes.length === 0 ||
      chart.chartTypes.every((type) => type.series.length === 0) ||
      JSON.stringify(chart.data) !==
        JSON.stringify([
          [4.3, 2.4, 2],
          [2.5, 4.4, 2],
          [3.5, 1.8, 3],
          [4.5, 2.8, 5],
        ])
    )
      throw new Error(
        "Structured chart data observation does not match the fixture.",
      );
    Object.assign(summary, {
      chartTypeCount: chart.chartTypes.length,
      seriesCount: chart.chartTypes.reduce(
        (total, type) => total + type.series.length,
        0,
      ),
      rowCount: chart.rowCount,
      columnCount: chart.columnCount,
      truncated: chart.truncated,
    });
  }
  if (expectedFamily === "smartart-fallback") {
    const diagram = elements.find((element) => element.diagram)?.diagram;
    if (
      !diagram?.importedAsGroup ||
      diagram.semanticModelAvailable ||
      !diagram.sourcePreservationDataAvailable ||
      diagram.childCount < 1
    )
      throw new Error(
        "SmartArt fallback/preservation observation does not match the fixture.",
      );
    Object.assign(summary, diagram);
  }
  if (expectedFamily === "animation") {
    const animatedSlide = state.slides.find(
      (slide) => slide.animations?.nodeCount > 1,
    );
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      node.children.forEach(visit);
    };
    animatedSlide?.animations.roots.forEach(visit);
    if (
      !animatedSlide ||
      animatedSlide.animations.truncated ||
      !nodes.some((node) => node.target?.elementId) ||
      !nodes.some((node) => Object.keys(node.preset).length > 0)
    )
      throw new Error(
        "Animation order, preset or stable target observation is missing.",
      );
    Object.assign(summary, {
      slideIndex: animatedSlide.slideIndex,
      nodeCount: animatedSlide.animations.nodeCount,
      targetedNodeCount: nodes.filter((node) => node.target?.elementId).length,
      presetNodeCount: nodes.filter(
        (node) => Object.keys(node.preset).length > 0,
      ).length,
    });
  }
  if (expectedFamily === "picture") {
    const pictures = elements.filter((element) => element.picture);
    if (
      pictures.length < 1 ||
      pictures.some(
        (element) =>
          element.picture.sourcePixelSize.width <= 0 ||
          element.picture.sourcePixelSize.height <= 0 ||
          element.picture.sourceSize.width <= 0 ||
          element.picture.sourceSize.height <= 0,
      ) ||
      elements.some(
        (element) =>
          String(element.kind).endsWith("TextShape") && element.picture,
      )
    )
      throw new Error(
        "Picture observation is missing source dimensions or labels a text shape as a picture.",
      );
    Object.assign(summary, {
      pictureCount: pictures.length,
      pictureNames: pictures.map((element) => element.objectName),
      pictureShapeTypes: pictures.map((element) => element.kind),
      croppedPictureCount: pictures.filter((element) =>
        Object.values(element.picture.crop).some((value) => value !== 0),
      ).length,
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      expectedFamily
        ? {
            enginePatchLevel: state.engine?.patchLevel,
            revision: state.revision,
            slideCount: state.slides.length,
            masterCount: state.masters.length,
            themedMasterCount: state.masters.filter((master) => master.theme)
              .length,
            ...summary,
          }
        : {
            ...state,
            images: state.images.map((image) => ({
              slideIndex: image.slideIndex,
              byteLength: image.pngBytes.length,
            })),
          },
      null,
      2,
    )}\n`,
  );
} finally {
  await closeNativeProbe(browser, "uno-read");
}
