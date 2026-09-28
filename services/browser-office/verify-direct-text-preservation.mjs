import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { createHarnessServer } from "./server.mjs";

function requiredFlag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing ${name} <path>.`);
  return path.resolve(process.argv[index + 1]);
}

const inputPath = requiredFlag("--input");
const runtimeDirectory = requiredFlag("--candidate-runtime");
const outputRoot = requiredFlag("--output");
const productionTiming = process.argv.includes("--production-timing");
const aiFirst = process.argv.includes("--ai-first");
const input = new Uint8Array(await readFile(inputPath));
const runtime = await admitCandidateRuntime({ runtimeDirectory });
await mkdir(outputRoot, { recursive: true });
const server = createHarnessServer({
  runtimeRoot: runtime.runtimeDirectory,
  runtimeIdentity: runtime.runtimeIdentity,
  upstream: runtime.upstream,
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 684 } });
const errors = [];
const firstTitleText = (slideBytes) => {
  const document = new DOMParser().parseFromString(
    strFromU8(slideBytes),
    "application/xml",
  );
  const shape = document.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "sp",
  )[0];
  assert.ok(shape, "First slide needs a title shape");
  return [
    ...shape.getElementsByTagNameNS(
      "http://schemas.openxmlformats.org/drawingml/2006/main",
      "t",
    ),
  ]
    .map((node) => node.textContent ?? "")
    .join("");
};
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

async function eventOf(type, previousCount = 0) {
  await page.waitForFunction(
    ({ expectedType, count }) => {
      const events = globalThis.__spellbookProductHost?.events ?? [];
      return (
        events.some((event) => event.type === "error") ||
        events.filter((event) => event.type === expectedType).length > count
      );
    },
    { expectedType: type, count: previousCount },
    { timeout: 300_000 },
  );
  const result = await page.evaluate(
    ({ expectedType, count }) => {
      const events = globalThis.__spellbookProductHost.events;
      const failure = events.find((event) => event.type === "error");
      if (failure) return { error: failure.error };
      return events.filter((event) => event.type === expectedType)[count];
    },
    { expectedType: type, count: previousCount },
  );
  if (result.error) throw new Error(result.error);
  return result;
}

async function nativeCall(request) {
  const id = `local-observe-${Date.now()}-${Math.random()}`;
  await page.evaluate(
    ({ taskId, task }) =>
      globalThis.__spellbookProductHost.port.postMessage({
        id: taskId,
        request: task,
      }),
    { taskId: id, task: request },
  );
  await page.waitForFunction(
    (taskId) =>
      globalThis.__spellbookProductHost.events.some(
        (event) => event.id === taskId || event.type === "error",
      ),
    id,
    { timeout: 120_000 },
  );
  const result = await page.evaluate((taskId) => {
    const events = globalThis.__spellbookProductHost.events;
    return (
      events.find((event) => event.id === taskId) ??
      events.find((event) => event.type === "error")
    );
  }, id);
  if (result.error) throw new Error(result.error);
  return result.value;
}

async function observeTitle() {
  const observed = await nativeCall({
    operation: "observe",
    captureSlideIndexes: [],
  });
  return observed?.slides?.[0]?.elements?.[0]?.text;
}

async function waitForCompleteTitle() {
  let lastText;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lastText = await observeTitle();
    if (lastText?.includes("MANUAL")) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `The direct title input did not complete: ${JSON.stringify(lastText)}.`,
  );
}

try {
  await page.goto(
    `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`,
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  await page.waitForFunction(
    () => ["runtime-ready", "error"].includes(document.body.dataset.state),
    null,
    { timeout: 180_000 },
  );
  const state = await page.evaluate(() => document.body.dataset.state);
  assert.equal(state, "runtime-ready");
  await page.evaluate((hostOrigin) => {
    const events = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => events.push(event.data);
    channel.port1.start();
    globalThis.__spellbookProductHost = { events, port: channel.port1 };
    window.postMessage(
      { type: "spellbook.browser-office-connect", protocolVersion: 1 },
      hostOrigin,
      [channel.port2],
    );
  }, origin);
  await eventOf("ready");
  await page.evaluate((source) => {
    const bytes = Uint8Array.from(source);
    globalThis.__spellbookProductHost.port.postMessage(
      {
        type: "open",
        requestId: "local-direct-text-open",
        documentId: "local-direct-text-preservation",
        fileName: "direct-text-preservation.pptx",
        revision:
          '"baseline:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        maxBytes: 64 * 1024 * 1024,
        bytes: bytes.buffer,
      },
      [bytes.buffer],
    );
  }, Array.from(input));
  const opened = await eventOf("open-complete");
  assert.ok(opened.slideCount > 1);
  let aiSaved = null;
  let modelViewBytes = null;
  if (aiFirst) {
    const before = await nativeCall({
      operation: "observe",
      captureSlideIndexes: [],
    });
    const view = before.modelView;
    assert.ok(view?.detailSlideIndexes?.includes(0));
    modelViewBytes = {
      complete: Buffer.byteLength(JSON.stringify(before.slides)),
      outline: Buffer.byteLength(JSON.stringify(view)),
      focused: Buffer.byteLength(
        JSON.stringify({
          ...view,
          slideCount: view.slides.length,
          slides: view.slides.filter((slide) =>
            view.detailSlideIndexes.includes(slide.slideIndex),
          ),
        }),
      ),
    };
    const first = before.slides[0].elements[0];
    const last = before.slides.at(-1).elements[0];
    const changed = await nativeCall({
      operation: "edit_batch",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      commands: [
        {
          op: "replace_text",
          elementId: first.elementId,
          text: `1. 2026 분기 실적 보고 — 매출과 비용`,
        },
        {
          op: "replace_text",
          elementId: last.elementId,
          text: `60. 2026 분기 실적 보고 — 매출과 비용`,
        },
      ],
      permission: { mode: "document", elementIds: [], slideIndexes: [] },
      suppressCapture: true,
    });
    assert.notEqual(changed.revision, before.revision);
    assert.equal(changed.readMetrics?.fullCount, 1);
    assert.equal(changed.readMetrics?.slidesScanned, opened.slideCount + 1);
    const aiSaveCount = await page.evaluate(
      () =>
        globalThis.__spellbookProductHost.events.filter(
          (event) => event.type === "save",
        ).length,
    );
    await page.evaluate(() =>
      globalThis.__spellbookProductHost.port.postMessage({
        type: "command",
        messageId: "Action_Save",
        values: { Notify: true },
      }),
    );
    const aiSave = await eventOf("save", aiSaveCount);
    assert.ok(
      await page.evaluate(
        () =>
          performance.getEntriesByName("spellbook-native-read:save-cache-hit")
            .length > 0,
      ),
      "The unchanged AI result should save without reading every slide again.",
    );
    aiSaved = Uint8Array.from(
      await page.evaluate((requestId) => {
        const event = globalThis.__spellbookProductHost.events.find(
          (candidate) =>
            candidate.type === "save" && candidate.requestId === requestId,
        );
        return Array.from(new Uint8Array(event.bytes));
      }, aiSave.requestId),
    );
    await page.evaluate(
      (requestId) =>
        globalThis.__spellbookProductHost.port.postMessage({
          type: "save-result",
          requestId,
          ok: true,
          revision: '"local-ai-saved"',
        }),
      aiSave.requestId,
    );
    await eventOf("save-response");
    await page.evaluate(() =>
      globalThis.__spellbookProductHost.port.postMessage({
        type: "command",
        messageId: "Action_GoToPage",
        values: { Page: 1 },
      }),
    );
    await page.waitForTimeout(1000);
  }
  if (!productionTiming) await page.waitForTimeout(1000);
  const canvas = page.locator("#qtcanvas");
  const box = await canvas.boundingBox();
  assert.ok(box, "Canvas is visible");
  await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.33);
  if (!productionTiming) await page.waitForTimeout(1000);
  await page.keyboard.press("F2");
  if (!productionTiming) await page.waitForTimeout(1000);
  await page.keyboard.press("End");
  await page.keyboard.type(" MANUAL", { delay: 80 });
  if (!productionTiming) await waitForCompleteTitle();
  await page.keyboard.press("Escape");
  if (!productionTiming) await waitForCompleteTitle();
  const beforeSaveCount = await page.evaluate(
    () =>
      globalThis.__spellbookProductHost.events.filter(
        (event) => event.type === "save",
      ).length,
  );
  await page.evaluate(() =>
    globalThis.__spellbookProductHost.port.postMessage({
      type: "command",
      messageId: "Action_Save",
      values: { Notify: true },
    }),
  );
  const save = await eventOf("save", beforeSaveCount);
  const output = Uint8Array.from(
    await page.evaluate((requestId) => {
      const event = globalThis.__spellbookProductHost.events.find(
        (candidate) =>
          candidate.type === "save" && candidate.requestId === requestId,
      );
      return Array.from(new Uint8Array(event.bytes));
    }, save.requestId),
  );
  const outputPath = path.join(outputRoot, "direct-text-saved.pptx");
  await writeFile(outputPath, output);
  await page.screenshot({
    path: path.join(outputRoot, "direct-text-saved.png"),
  });
  const beforeParts = unzipSync(aiSaved ?? input);
  const afterParts = unzipSync(output);
  const slideNames = Object.keys(beforeParts).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/u.test(name),
  );
  assert.equal(slideNames.length, opened.slideCount);
  const previousTitle = firstTitleText(beforeParts["ppt/slides/slide1.xml"]);
  const savedTitle = firstTitleText(afterParts["ppt/slides/slide1.xml"]);
  assert.equal(savedTitle.split(" MANUAL").length, 2);
  assert.equal(savedTitle.replace(" MANUAL", ""), previousTitle);
  for (const name of slideNames.filter(
    (name) => name !== "ppt/slides/slide1.xml",
  ))
    assert.deepEqual(afterParts[name], beforeParts[name], `${name} changed`);
  for (const name of Object.keys(beforeParts).filter((part) =>
    /^ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(part),
  ))
    assert.deepEqual(afterParts[name], beforeParts[name], `${name} changed`);
  process.stdout.write(
    JSON.stringify({
      result: "pass",
      slideCount: slideNames.length,
      preservedSlides: slideNames.length - 1,
      ...(aiFirst
        ? {
            aiEditReads: { full: 1, slidesScanned: opened.slideCount + 1 },
            modelViewBytes,
          }
        : {}),
      outputPath,
    }) + "\n",
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(outputRoot, "direct-text-failure.png") })
    .catch(() => {});
  const events = await page
    .evaluate(() =>
      (globalThis.__spellbookProductHost?.events ?? []).map((event) => ({
        type: event.type,
        requestId: event.requestId,
        error: event.error,
      })),
    )
    .catch(() => []);
  throw new Error(
    `${error.message}; events=${JSON.stringify(events)}; browserErrors=${JSON.stringify(errors)}`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
