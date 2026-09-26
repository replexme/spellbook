import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { createHarnessServer } from "./server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cycles = Number(process.argv[process.argv.indexOf("--cycles") + 1] ?? 5);
const runtimeDirectory = process.argv[process.argv.indexOf("--candidate-runtime") + 1];
const outputRoot = path.resolve(process.argv[process.argv.indexOf("--output") + 1] ?? "artifacts/browser-office/ox-undo");
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 20 || !runtimeDirectory) throw new Error("Invalid verifier arguments.");
await mkdir(outputRoot, { recursive: true });
const fixture = new Uint8Array(await readFile(path.join(root, "eval/public/downloads/ox-typical.pptx")));
assert.deepEqual(Object.keys(unzipSync(fixture)).filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)), ["ppt/slideMasters/slideMaster1.xml"]);
const admitted = await admitCandidateRuntime({ runtimeDirectory });
const server = createHarnessServer({ runtimeRoot: admitted.runtimeDirectory, runtimeIdentity: admitted.runtimeIdentity, upstream: admitted.upstream });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const report = { input: "ox-typical.pptx", sourceMasters: 1, cycles: [] };
const timeout = 180_000;

async function waitEvent(page, match) {
  await page.waitForFunction((expected) => globalThis.__oxHost.events.some((event) => event.type === "error" || Object.entries(expected).every(([key, value]) => event[key] === value)), match, { timeout });
  const result = await page.evaluate((expected) => globalThis.__oxHost.events.find((event) => Object.entries(expected).every(([key, value]) => event[key] === value)) ?? globalThis.__oxHost.events.find((event) => event.type === "error"), match);
  if (!result || result.type === "error" || result.error) throw new Error(String(result?.error ?? "product_host_error"));
  return result;
}
async function task(page, request) {
  const id = crypto.randomUUID();
  await page.evaluate(({ id, request }) => globalThis.__oxHost.port.postMessage({ id, request }), { id, request });
  return (await waitEvent(page, { id })).value;
}
async function runCycle(index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`, { waitUntil: "domcontentloaded", timeout });
    await page.waitForFunction(() => ["runtime-ready", "error"].includes(document.body.dataset.state), null, { timeout });
    const runtimeError = await page.evaluate(() => document.body.dataset.state === "error" ? document.body.dataset.error : null);
    if (runtimeError) throw new Error(`Runtime failed: ${runtimeError}`);
    await page.evaluate((hostOrigin) => {
      const channel = new MessageChannel();
      const events = [];
      channel.port1.onmessage = (event) => events.push(event.data);
      channel.port1.start();
      globalThis.__oxHost = { port: channel.port1, events };
      window.postMessage({ type: "spellbook.browser-office-connect", protocolVersion: 1 }, hostOrigin, [channel.port2]);
    }, origin);
    await waitEvent(page, { type: "ready" });
    await page.evaluate(({ bytes, index }) => {
      const payload = Uint8Array.from(bytes);
      globalThis.__oxHost.port.postMessage({ type: "open", requestId: `open-${index}`, documentId: `ox-undo-${index}`, fileName: "ox-typical.pptx", revision: '"baseline:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', maxBytes: 64 * 1024 * 1024, bytes: payload.buffer }, [payload.buffer]);
    }, { bytes: Array.from(fixture), index });
    await waitEvent(page, { type: "open-complete", requestId: `open-${index}` });
    const before = await task(page, { operation: "observe", captureSlideIndexes: [] });
    const target = before.slides[0].elements.find((element) => element.parentElementId === null && typeof element.text === "string" && element.text.includes("Typical Presentation"));
    assert.ok(target, "Expected first-slide title not observed.");
    const changed = await task(page, { operation: "edit", expectedRevision: before.revision, expectedSlides: JSON.stringify(before.slides), command: { op: "replace_text", elementId: target.elementId, text: "AI 수정" }, permission: { mode: "document", slideIndexes: [], elementIds: [] }, suppressCapture: true });
    assert.equal(changed.slides[0].elements.find((element) => element.elementId === target.elementId).text, "AI 수정");
    await page.waitForTimeout(25_000);
    await task(page, { operation: "reveal", slideIndex: 0, elementId: target.elementId });
    await page.keyboard.press("F2");
    await page.waitForTimeout(800);
    await page.keyboard.press("End");
    await page.keyboard.type(" 사람", { delay: 60 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(25_000);
    const typed = await task(page, { operation: "observe", captureSlideIndexes: [] });
    assert.match(typed.slides[0].elements.find((element) => element.elementId === target.elementId).text, /AI 수정 사람/);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(25_000);
    const once = await task(page, { operation: "observe", captureSlideIndexes: [] });
    assert.equal(once.slides[0].elements.find((element) => element.elementId === target.elementId).text, "AI 수정");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(25_000);
    const twice = await task(page, { operation: "observe", captureSlideIndexes: [] });
    assert.equal(twice.revision, before.revision);
    const previous = await page.evaluate(() => globalThis.__oxHost.events.length);
    await page.evaluate(() => globalThis.__oxHost.port.postMessage({ type: "command", messageId: "Action_Save", values: { Notify: true } }));
    await page.waitForFunction((prior) => globalThis.__oxHost.events.slice(prior).some((event) => event.type === "save" || event.type === "error"), previous, { timeout });
    const saved = await page.evaluate((prior) => globalThis.__oxHost.events.slice(prior).find((event) => event.type === "save" || event.type === "error"), previous);
    if (saved.type === "error") throw new Error(String(saved.error));
    const bytes = await page.evaluate((requestId) => Array.from(new Uint8Array(globalThis.__oxHost.events.find((event) => event.type === "save" && event.requestId === requestId).bytes)), saved.requestId);
    const file = path.join(outputRoot, `cycle-${index}.pptx`);
    await writeFile(file, Uint8Array.from(bytes));
    const pptx = unzipSync(Uint8Array.from(bytes));
    assert.match(strFromU8(pptx["ppt/slides/slide1.xml"]), /Typical Presentation/);
    assert.deepEqual(errors, []);
    return { status: "passed", sourceRevisionRestored: true, savedBytes: bytes.length, output: file, readMetrics: { initial: before.readMetrics, edit: changed.readMetrics, afterTyping: typed.readMetrics, afterUndo: once.readMetrics, afterSecondUndo: twice.readMetrics } };
  } finally {
    await context.close();
  }
}
try {
  for (let index = 1; index <= cycles; index++) {
    const started = Date.now();
    try {
      const outcome = await runCycle(index);
      report.cycles.push({ index, elapsedMs: Date.now() - started, ...outcome });
      console.log(`ox-undo cycle ${index}: passed`);
    } catch (error) {
      report.cycles.push({ index, elapsedMs: Date.now() - started, status: "failed", error: String(error) });
      console.error(`ox-undo cycle ${index}: ${String(error)}`);
    }
    await writeFile(path.join(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
} finally {
  await browser.close();
  server.close();
}
if (report.cycles.some((cycle) => cycle.status !== "passed")) process.exitCode = 1;
