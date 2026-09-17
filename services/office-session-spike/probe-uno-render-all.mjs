import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  installNativeBridgeTrace,
  waitForNativeBridge,
} from "./native-bridge-probe.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : null;
const expectedPatchLevel =
  process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL ?? null;
const requestSave = process.env.SPELLBOOK_PROBE_SAVE === "1";

if (!outputDirectory)
  throw new Error("Usage: node probe-uno-render-all.mjs URL OUTPUT_DIRECTORY");

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await installNativeBridgeTrace(page);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
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
      throw new Error(
        `Native editor extension did not connect: ${JSON.stringify({ browserErrors: browserErrors.slice(-20) })}`,
      );
    await page.waitForTimeout(250);
  }

  const observe = (detailSlideIndex = null, captureSlideIndexes = undefined) =>
    page.evaluate(
      async ({ requestedSlideIndex, requestedCaptureSlideIndexes }) => {
        const launch = window.__spellbookLaunch;
        const response = await fetch("/native/probe", {
          method: "POST",
          headers: {
            authorization: `Bearer ${launch.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            operation: "observe",
            detailSlideIndex: requestedSlideIndex,
            ...(requestedCaptureSlideIndexes
              ? { captureSlideIndexes: requestedCaptureSlideIndexes }
              : {}),
          }),
        });
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error ?? `HTTP ${response.status}`);
        return value;
      },
      {
        requestedSlideIndex: detailSlideIndex,
        requestedCaptureSlideIndexes: captureSlideIndexes,
      },
    );

  const initial = await observe();
  if (expectedPatchLevel && initial.engine?.patchLevel !== expectedPatchLevel)
    throw new Error(
      `Expected ${expectedPatchLevel}, got ${initial.engine?.patchLevel}.`,
    );
  if (!Array.isArray(initial.slides) || initial.slides.length === 0)
    throw new Error("The editor returned no slides.");

  const images = new Map(
    (initial.images ?? []).map((image) => [image.slideIndex, image]),
  );
  const remainingSlideIndexes = initial.slides
    .map((_, slideIndex) => slideIndex)
    .filter((slideIndex) => !images.has(slideIndex));
  for (let offset = 0; offset < remainingSlideIndexes.length; offset += 8) {
    const requested = remainingSlideIndexes.slice(offset, offset + 8);
    const captured = await observe(null, requested);
    if (captured.revision !== initial.revision)
      throw new Error("The document changed during slide capture.");
    for (const image of captured.images ?? [])
      images.set(image.slideIndex, image);
  }

  const slides = [];
  for (let slideIndex = 0; slideIndex < initial.slides.length; slideIndex++) {
    const image = images.get(slideIndex);
    if (!image?.pngBytes?.length)
      throw new Error(`Slide ${slideIndex + 1} returned no PNG evidence.`);
    await writeFile(
      path.join(outputDirectory, `slide-${slideIndex + 1}.png`),
      Buffer.from(image.pngBytes),
      { mode: 0o600 },
    );
    const slide = initial.slides[slideIndex];
    slides.push({
      slideIndex,
      name: slide.name,
      hidden: slide.hidden,
      layout: slide.layout,
      masterName: slide.masterName,
      elementCount: slide.elements?.length ?? 0,
      layoutIssues: slide.layoutIssues ?? [],
    });
  }

  if (requestSave) {
    await waitForNativeBridge(page);
    await requestNativeProbeSave(page);
    await page.waitForTimeout(1_000);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        enginePatchLevel: initial.engine?.patchLevel,
        slideCount: slides.length,
        masterCount: initial.masters?.length ?? 0,
        slides,
        saveRequested: requestSave,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
