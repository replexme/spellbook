import { captureStableOnlyOfficeBaseline } from "./onlyoffice-baseline.mjs";
import { observeOnlyOfficeCandidate } from "./onlyoffice-observation.mjs";
/* SPDX-License-Identifier: MPL-2.0 */
import { createOnlyOfficeComparisonHost } from "./onlyoffice/comparison-host.mjs";
import {
  comparisonEditMarker as editMarker,
  assertComparisonMarkerAbsent,
} from "./comparison-input.mjs";
// Diagnostic candidate adapter, deliberately separate from production engine
// admission. Private documents/results belong outside the repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { readRepositoryIdentity } from "./repository-identity.mjs";
import { buildHarness } from "./build-harness.mjs";

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name}`);
  }
  return process.argv[i + 1];
};
const inputPath = path.resolve(flag("--input"));
const outputRoot = path.resolve(flag("--output"));
const candidateRoot = path.resolve(flag("--candidate-root"));
const origin = new URL(flag("--origin"));
const preserveSource = process.argv.includes("--preserve-source");
const repairStructure =
  preserveSource || process.argv.includes("--repair-structure");
const readbackStatePath = flag("--readback-state", null);
const readbackSlide = Number(flag("--readback-slide", "0"));
assert(Number.isInteger(readbackSlide) && readbackSlide >= 0);
assert(
  ["127.0.0.1", "localhost"].includes(origin.hostname),
  "Local candidate origin required",
);
const scenarios = flag(
  "--scenarios",
  "roundtrip,type,type-move,move,delete,newslide,dupslide,delslide,save-failure",
).split(",");
const known = [
  "roundtrip",
  "type",
  "type-move",
  "move",
  "delete",
  "newslide",
  "dupslide",
  "delslide",
  "save-failure",
  "late-save-ack",
];
assert(
  scenarios.every((s) => known.includes(s)) &&
    new Set(scenarios).size === scenarios.length,
);
if (preserveSource) {
  assert(
    !readbackStatePath,
    "Source preservation must start from the authored input",
  );
}
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
if (repairStructure) await buildHarness();
const source = await readFile(inputPath);
if (!readbackStatePath) assertComparisonMarkerAbsent(source);
const expectedStateBytes = readbackStatePath
  ? await readFile(path.resolve(readbackStatePath))
  : null;
const expectedState = expectedStateBytes
  ? JSON.parse(expectedStateBytes.toString("utf8")).edited
  : null;
if (readbackStatePath) {
  assert(
    Array.isArray(expectedState?.slides),
    "Readback requires captured edited state",
  );
  assert.deepEqual(
    scenarios,
    ["roundtrip"],
    "Readback must not execute edits or saves",
  );
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidate = readRepositoryIdentity(candidateRoot);
const integration = readRepositoryIdentity(
  path.resolve(import.meta.dirname, "../.."),
);
const packageDelta = (bytes) => {
  const before = unzipSync(source),
    after = unzipSync(bytes);
  const changed = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter(
    (k) =>
      !before[k] ||
      !after[k] ||
      !Buffer.from(before[k]).equals(Buffer.from(after[k])),
  );
  return {
    changedPartCount: changed.length,
    changedParts: changed,
    existingSlidesChanged: changed.filter(
      (k) => before[k] && /^ppt\/slides\/slide\d+\.xml$/u.test(k),
    ).length,
    existingDesignPartsChanged: changed.filter(
      (k) => before[k] && /^ppt\/(slideMasters|slideLayouts|theme)\//u.test(k),
    ).length,
    markerInPackage: Object.entries(after).some(
      ([k, v]) =>
        /^ppt\/slides\/slide\d+\.xml$/u.test(k) &&
        strFromU8(v).includes(editMarker),
    ),
  };
};
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  inputName: path.basename(inputPath),
  inputSha256: sha(source),
  sourceBytes: source.length,
  candidate,
  integration,
  timingScope: preserveSource
    ? "candidate export including shared original-part preservation worker, final structural repair and host callback; excludes independent SDK validation and product admission"
    : repairStructure
      ? "candidate readiness / export including browser repair and host callback; excludes original-part preservation and runtime clean reconciliation"
      : "candidate readiness / raw export including host callback; excludes product preservation and runtime clean reconciliation",
  inputSetup:
    "version-pinned internal SDK selects the target; text and arrow/delete edits use headless browser keyboard",
  expectedStateSha256: expectedStateBytes ? sha(expectedStateBytes) : null,
  readbackScope: readbackStatePath
    ? "read-only reopen against captured kinds/text/geometry; excludes complete source preservation and product admission"
    : null,
  cases: [],
  engineApiMethods: null,
  externalRequestCount: 0,
  savePipeline: preserveSource
    ? "authored-source preservation precedes final structural repair in the actual save callback; excludes complete typed-feature and product admission"
    : repairStructure
      ? "browser structural repair of exported artifact; excludes original-part preservation and complete product admission"
      : "raw candidate export",
};
const browser = await chromium.launch({
  headless: true,
  args: [
    "--host-resolver-rules=MAP localhost 127.0.0.1",
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
});
let served = source;
// Own diagnostic host using the candidate's public component API. It never
// patches vendor code or depends on a locally modified save-demo callback.
const diagnosticHost = createOnlyOfficeComparisonHost({
  origin: origin.origin,
  preserveSource,
  repairStructure,
});
// Real loopback HTTP gives Chromium a local address space for the host iframe.
const repairBundle = repairStructure
  ? await readFile(path.join(import.meta.dirname, "runtime/ooxml-worker.js"))
  : null;
const diagnosticServer = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/compare.html") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(diagnosticHost);
  } else if (pathname === "/comparison-repair.js" && repairBundle) {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(repairBundle);
  } else if (pathname === "/compare.pptx" || pathname === "/original.pptx") {
    response.writeHead(200, {
      "content-type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "cache-control": "no-store",
    });
    response.end(pathname === "/original.pptx" ? source : served);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) =>
  diagnosticServer.listen(0, "127.0.0.1", resolve),
);
const diagnosticOrigin = `http://127.0.0.1:${diagnosticServer.address().port}`;
async function snapshot(frame) {
  const observed = await observeOnlyOfficeCandidate(frame);
  return {
    ...observed.common,
    features: observed.extended,
    native: observed.narrow,
    unavailable: observed.unavailable,
  };
}

function differences(expected, actual, at = "document", results = []) {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > 0.02) results.push(at);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) results.push(`${at}.length`);
    expected.forEach((v, i) =>
      differences(v, actual[i], `${at}[${i}]`, results),
    );
  } else if (
    expected &&
    typeof expected === "object" &&
    actual &&
    typeof actual === "object"
  ) {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)]))
      differences(expected[k], actual[k], `${at}.${k}`, results);
  } else if (expected !== actual) results.push(at);
  return results;
}
async function open(page) {
  const start = performance.now();
  await page.goto(`${diagnosticOrigin}/compare.html`);
  await page.waitForFunction(
    () => {
      const status = window.__ONLYOFFICE_SAVE_E2E__?.getStatus();
      return status?.ready || status?.error;
    },
    null,
    { timeout: 180_000 },
  );
  const startupError = await page.evaluate(
    () => window.__ONLYOFFICE_SAVE_E2E__?.getStatus().error,
  );
  if (startupError) throw new Error(startupError);
  const frame = page
    .frames()
    .find((f) => f.url().includes("/presentationeditor/"));
  assert(frame, "Candidate editor frame missing");
  return { frame, ms: performance.now() - start };
}
async function save(page) {
  return page.evaluate(async () => {
    const start = performance.now();
    const result = await window.__ONLYOFFICE_SAVE_E2E__.save("pptx");
    const bytes = window.__comparisonSaved;
    if (!bytes)
      throw new Error(
        "Candidate comparison callback did not capture saved bytes",
      );
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.slice(i, i + 32768));
    return {
      metadata: result,
      ms: performance.now() - start,
      base64: btoa(binary),
      structuralRepairs: window.__comparisonStructuralRepairs ?? [],
      preservations: window.__comparisonPreservations ?? [],
    };
  });
}
try {
  for (const scenario of scenarios) {
    served = source;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const item = { scenario, errors: [], requestFailures: [], stage: "open" };
    report.cases.push(item);
    page.on("pageerror", (e) => item.errors.push(e.message));
    page.on("requestfailed", (r) =>
      item.requestFailures.push({
        url: new URL(r.url()).pathname,
        error: r.failure()?.errorText,
      }),
    );
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (
        /^https?:$/u.test(u.protocol) &&
        !["localhost", "127.0.0.1"].includes(u.hostname) &&
        !u.hostname.endsWith(".localhost")
      )
        report.externalRequestCount++;
    });
    try {
      let { frame, ms } = await open(page);
      item.openMs = ms;
      const before = await snapshot(frame);
      item.originalSlideCount = before.slides.length;
      if (expectedState) {
        item.stage = "preserved-package-readback";
        item.reopenDifferences = differences(expectedState, before);
        assert(
          readbackSlide < before.slides.length,
          "Readback slide unavailable",
        );
        await frame.evaluate(
          (index) => window.Asc.editor.WordControl.GoToPage(index),
          readbackSlide,
        );
        await page.waitForTimeout(100);
        item.visualSlideIndex = await frame.evaluate(
          () => window.Asc.editor.WordControl.m_oLogicDocument.CurPage,
        );
        assert.equal(item.visualSlideIndex, readbackSlide);
        await writeFile(
          path.join(outputRoot, "opened-model.json"),
          JSON.stringify(before, null, 2),
          { mode: 0o600 },
        );
        await page.screenshot({ path: path.join(outputRoot, "readback.png") });
        item.writeCount = await page.evaluate(
          () => window.__ONLYOFFICE_SAVE_E2E__.getStatus().writeCount,
        );
        assert.equal(item.writeCount, 0);
        item.status = item.reopenDifferences.length
          ? "preserved-package-model-differs"
          : "preserved-package-model-readback-verified";
        continue;
      }
      if (!report.engineApiMethods)
        report.engineApiMethods = await frame.evaluate(() => {
          const a = window.Asc.editor;
          const names = new Set();
          for (let p = a; p; p = Object.getPrototypeOf(p))
            for (const k of Object.getOwnPropertyNames(p))
              if (
                typeof a[k] === "function" &&
                /slide|shape|chart|table|crop|anim|comment|undo|redo|text|notes|theme|size/iu.test(
                  k,
                )
              )
                names.add(k);
          return [...names].sort();
        });
      if (preserveSource) {
        // Raw baseline is an engine observation, never an admitted artifact.
        // Restore authored ownership before repairing the artifact to save.
        item.stage = "source-baseline";
        const baseline = await captureStableOnlyOfficeBaseline(page, save);
        item.sourceBaselineStabilization = { attempts: baseline.attempts, transitions: baseline.transitions };
        item.sourceBaselineExportMs = baseline.ms;
        item.sourceBaselineSha256 = sha(Buffer.from(baseline.base64, "base64"));
        assert.deepEqual(
          differences(before, await snapshot(frame)),
          [],
          "Baseline export must not mutate the document",
        );
      }
      if (scenario === "late-save-ack") {
        item.stage = "held-save";
        const duplicate = () =>
          frame.evaluate(() =>
            window.Asc.editor.WordControl.m_oLogicDocument.DublicateSlide(),
          );
        await duplicate();
        await page.waitForTimeout(250);
        const firstSnapshot = await snapshot(frame);
        assert.equal(firstSnapshot.slides.length, before.slides.length + 1);
        const duplicateIntent = (state, slideIndex, cloneSourceSlideIndex) => ({
          sourceOperations: null,
          sourceTargets: [{ op: "native_slide_topology", slideIndex, cloneSourceSlideIndex,
            elements: state.slides[slideIndex].shapes.map(shape => ({ text: shape.text?.replace(/\r\n/g,"\n").replace(/\n$/u,"") })) }],
        });
        if (preserveSource) await page.evaluate(intent => window.__comparisonIntent=intent, duplicateIntent(firstSnapshot, 1, 0));
        await page.evaluate(() => {
          window.__holdSave = true;
          window.__pendingSave = window.__ONLYOFFICE_SAVE_E2E__.save();
          window.__pendingSave.catch(() => undefined);
        });
        await page.waitForFunction(() => window.__heldSave === true, null, {
          timeout: 60000,
        });
        await duplicate();
        await page.waitForTimeout(250);
        const latest = await snapshot(frame);
        assert.equal(latest.slides.length, firstSnapshot.slides.length + 1);
        if (preserveSource) await page.evaluate(intent => window.__comparisonIntent=intent, duplicateIntent(latest, 2, 1));
        const overlap = await page.evaluate(async () => {
          try { await window.__ONLYOFFICE_SAVE_E2E__.save(); return null; }
          catch (error) { return error.message; }
        });
        assert.equal(overlap, "comparison_save_in_flight", "Concurrent persistence must not replace the in-flight snapshot");
        item.overlapSaveRejected = overlap;
        await page.evaluate(() => {
          window.__releaseSave();
          window.__holdSave = false;
          return window.__pendingSave;
        });
        item.afterOldAck = [];
        for (const delay of [100, 1000, 2000]) {
          await page.waitForTimeout(delay);
          const status = await page.evaluate(() =>
            window.__ONLYOFFICE_SAVE_E2E__.getStatus(),
          );
          item.afterOldAck.push({ delayMs: delay, ...status });
          assert.equal(status.dirty, true, "Old ACK must retain later edits");
          assert.deepEqual(differences(latest, await snapshot(frame)), []);
        }
        const oldSaved = await page.evaluate(() => {
          let binary = "";
          const bytes = window.__comparisonSaved;
          for (let i = 0; i < bytes.length; i += 32768)
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return btoa(binary);
        });
        const oldBytes = Buffer.from(oldSaved, "base64");
        await writeFile(
          path.join(outputRoot, "late-save-ack-old.pptx"),
          oldBytes,
          {
            mode: 0o600,
          },
        );
        item.stage = "second-save";
        const currentSave = await save(page);
        item.structuralRepairs = currentSave.structuralRepairs;
        item.sourcePreservations = currentSave.preservations;
        const currentBytes = Buffer.from(currentSave.base64, "base64");
        await writeFile(
          path.join(outputRoot, "late-save-ack-latest.pptx"),
          currentBytes,
          {
            mode: 0o600,
          },
        );
        const reconciliationStart = performance.now();
        await page.waitForFunction(
          () => window.__ONLYOFFICE_SAVE_E2E__.getStatus().dirty === false,
          null,
          { timeout: 30000 },
        );
        item.latestAckToCleanMs = performance.now() - reconciliationStart;
        item.saveUntilVerifiedCleanMs =
          currentSave.ms + item.latestAckToCleanMs;
        item.afterLatestAck = await page.evaluate(() =>
          window.__ONLYOFFICE_SAVE_E2E__.getStatus(),
        );
        assert.equal(
          item.afterLatestAck.dirty,
          false,
          "Latest persisted state should clear dirty",
        );
        assert.equal(item.afterLatestAck.writeCount, 2);
        await frame.evaluate(() => window.Asc.editor.Undo());
        await page.waitForTimeout(250);
        item.undoDifferences = differences(
          firstSnapshot,
          await snapshot(frame),
        );
        assert.deepEqual(item.undoDifferences, []);
        await frame.evaluate(() => window.Asc.editor.Redo());
        await page.waitForTimeout(250);
        item.redoDifferences = differences(latest, await snapshot(frame));
        assert.deepEqual(item.redoDifferences, []);
        item.stage = "reopen-old-and-latest";
        served = oldBytes;
        ({ frame } = await open(page));
        item.oldReopenDifferences = differences(
          firstSnapshot,
          await snapshot(frame),
        );
        assert.deepEqual(item.oldReopenDifferences, []);
        served = currentBytes;
        ({ frame } = await open(page));
        item.latestReopenDifferences = differences(
          latest,
          await snapshot(frame),
        );
        assert.deepEqual(item.latestReopenDifferences, []);
        item.oldSlides = firstSnapshot.slides.length;
        item.latestSlides = latest.slides.length;
        item.oldSavedSha256 = sha(oldBytes);
        item.latestSavedSha256 = sha(currentBytes);
        item.exportMs = currentSave.ms;
        item.status = "late-ack-second-save-history-reopen-verified";
        item.stage = "complete";
        continue;
      }
      await page.screenshot({
        path: path.join(outputRoot, `${scenario}-before.png`),
      });
      item.stage = "edit";
      if (!["roundtrip", "save-failure"].includes(scenario)) {
        item.setup = await frame.evaluate((s) => {
          const a = window.Asc.editor,
            m = a.WordControl.m_oLogicDocument;
          a.WordControl.Thumbnails.SelectPage(0);
          const slide = m.Slides[0],
            c = slide.graphicObjects;
          if (s === "dupslide") {
            m.DublicateSlide();
            return { kind: "slide-duplicate", cloneSourceSlideIndex: 0 };
          }
          if (s === "delslide") {
            m.deleteSlides([slide]);
            return { kind: "slide-delete" };
          }
          if (s === "newslide") {
            a.AddSlide();
            return { kind: "slide-add" };
          }
          const text = (x) =>
            x.getDocContent?.()?.GetText?.({ Numbering: false });
          const target = ["type", "type-move"].includes(s)
            ? slide.cSld.spTree
                .filter((x) => typeof text(x) === "string" && text(x).trim())
                .sort(
                  (a, b) => text(b).trim().length - text(a).trim().length,
                )[0]
            : s === "delete"
              ? slide.cSld.spTree.find(shape => !shape.isPlaceholder?.())
              : slide.cSld.spTree[0];
          if (!target) throw new Error("No suitable first-slide target");
          c.resetSelection();
          c.selectObject(target, 0);
          m.Document_UpdateSelectionState();
          if (["type", "type-move"].includes(s)) c.startEditTextCurrentShape();
          a.WordControl.m_oDrawingDocument.TargetStart();
          return {
            kind: "shape",
            hadNonemptyText:
              typeof text(target) === "string" &&
              text(target).trim().length > 0,
            index: slide.cSld.spTree.indexOf(target),
            name: target.getCNvProps?.()?.name ?? null,
          };
        }, scenario);
        if (!["dupslide", "delslide", "newslide"].includes(scenario)) {
          const area = frame.locator("#area_id");
          if (await area.count()) await area.focus();
          if (["move", "type-move"].includes(scenario)) {
            // Exit text before movement, then resume text at the same target.
            if (scenario === "type-move") await page.keyboard.press("Escape");
            for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
            if (scenario === "type-move")
              await frame.evaluate(() =>
                window.Asc.editor.WordControl.m_oLogicDocument.Slides[0].graphicObjects.startEditTextCurrentShape(),
              );
          }
          if (["type", "type-move"].includes(scenario)) {
            await page.keyboard.press("End");
            await page.keyboard.insertText(` ${editMarker}`);
            await page.keyboard.press("Escape");
          }
          if (scenario === "delete") await page.keyboard.press("Delete");
        }
      }
      await page.waitForTimeout(350);
      const edited = await snapshot(frame);
      item.visualSlideIndex = await frame.evaluate(
        () => window.Asc.editor.WordControl.m_oLogicDocument.CurPage,
      );
      const b = before.slides[0]?.shapes,
        a = edited.slides[0]?.shapes;
      const targetIndex = item.setup?.index;
      const moved =
        Number.isFinite(a?.[targetIndex]?.x) &&
        a[targetIndex].x !== b?.[targetIndex]?.x;
      const typed =
        a?.[targetIndex]?.text?.includes(editMarker) === true &&
        a[targetIndex].text !== b?.[targetIndex]?.text;
      item.engineApplied =
        scenario === "roundtrip" || scenario === "save-failure"
          ? true
          : scenario === "type"
            ? typed
            : scenario === "type-move"
              ? typed && moved
              : scenario === "move"
                ? moved
                : scenario === "delete"
                  ? a.length === b.length - 1
                  : scenario === "delslide"
                    ? edited.slides.length === before.slides.length - 1
                    : edited.slides.length === before.slides.length + 1;
      item.editDifferences = differences(before, edited);
      item.editedSlideCount = edited.slides.length;
      await writeFile(
        path.join(outputRoot, `${scenario}-intent.json`),
        JSON.stringify({ before, edited }, null, 2),
        { mode: 0o600 },
      );
      await page.screenshot({
        path: path.join(outputRoot, `${scenario}-edited.png`),
      });
      if (!item.engineApplied)
        throw new Error("Requested edit did not apply; not a passing test");
      item.stage = "save";
      if (scenario === "save-failure") {
        await frame.evaluate(() =>
          window.Asc.editor.WordControl.m_oLogicDocument.DublicateSlide(),
        );
        await page.waitForTimeout(250);
        const dirtyBefore = await page.evaluate(
          () => window.__ONLYOFFICE_SAVE_E2E__.getStatus().dirty,
        );
        await page.evaluate(() => {
          window.__comparisonRejectSave = true;
        });
        let error = null;
        try {
          await save(page);
        } catch (e) {
          error = e.message;
        }
        const status = await page.evaluate(() =>
          window.__ONLYOFFICE_SAVE_E2E__.getStatus(),
        );
        item.failure = {
          rejected: Boolean(error),
          dirtyBefore,
          dirtyAfter: status.dirty,
          writeCount: status.writeCount,
          error: error?.slice(0, 500),
        };
        item.status =
          error && status.writeCount === 0 && status.dirty
            ? "host-failure-keeps-dirty"
            : "host-failure-contract-broken";
        continue;
      }
      if (preserveSource) {
        const operations =
          scenario === "type-move"
            ? ["replace_text", "move"]
            : ({
                type: ["replace_text"],
                move: ["move"],
                delete: ["delete_element"],
              }[scenario] ?? null);
        let targets = operations
          ? operations.map((op) => ({
              op,
              slideIndex: 0,
              name: item.setup.name,
              shapeIndex: item.setup.index,
            }))
          : null;
        if (scenario === "dupslide")
          targets = [
            {
              op: "native_slide_topology",
              slideIndex: 1,
              cloneSourceSlideIndex: item.setup.cloneSourceSlideIndex,
              elements: edited.slides[1].shapes.map((shape) => ({
                text: shape.text?.replace(/\r\n/g, "\n").replace(/\n$/u, ""),
              })),
            },
          ];
        await page.evaluate(
          (intent) => {
            window.__comparisonIntent = intent;
          },
          { sourceOperations: operations, sourceTargets: targets },
        );
      }
      const saved = await save(page);
      item.structuralRepairs = saved.structuralRepairs;
      item.sourcePreservations = saved.preservations;
      const bytes = Buffer.from(saved.base64, "base64");
      item.exportMs = saved.ms;
      const cleanStart = performance.now();
      await page.waitForFunction(
        () => window.__ONLYOFFICE_SAVE_E2E__.getStatus().dirty === false,
        null,
        { timeout: 30000 },
      );
      item.ackToCleanMs = performance.now() - cleanStart;
      item.saveUntilVerifiedCleanMs = saved.ms + item.ackToCleanMs;
      item.afterSave = await page.evaluate(() =>
        window.__ONLYOFFICE_SAVE_E2E__.getStatus(),
      );
      assert.equal(
        item.afterSave.writeCount,
        1,
        "One edited artifact must reach the host callback",
      );
      assert.deepEqual(
        differences(edited, await snapshot(frame)),
        [],
        "Saving must not mutate the live document",
      );
      item.savedBytes = bytes.length;
      item.savedSha256 = sha(bytes);
      Object.assign(item, packageDelta(bytes));
      await writeFile(path.join(outputRoot, `${scenario}.pptx`), bytes, {
        mode: 0o600,
      });
      // Export must not destroy the native history. Probe after saving so that
      // a pre-save undo pass cannot conceal a save-induced history reset.
      if (scenario !== "roundtrip") {
        // Six arrow presses are six human actions, not one atomic AI turn.
        // Undo until the pre-action state returns, then redo that exact count.
        item.undoSteps = 0;
        do {
          await frame.evaluate(() => window.Asc.editor.Undo());
          await page.waitForTimeout(100);
          item.undoSteps++;
          item.undoDifferences = differences(before, await snapshot(frame));
        } while (item.undoDifferences.length && item.undoSteps < 12);
        for (let i = 0; i < item.undoSteps; i++)
          await frame.evaluate(() => window.Asc.editor.Redo());
        await page.waitForTimeout(150);
        item.redoDifferences = differences(edited, await snapshot(frame));
      }
      item.stage = "reopen";
      served = bytes;
      ({ frame, ms } = await open(page));
      item.reopenMs = ms;
      item.reopenDifferences = differences(edited, await snapshot(frame));
      assert(
        Number.isInteger(item.visualSlideIndex),
        "Edited slide index unavailable",
      );
      await frame.evaluate(
        (index) => window.Asc.editor.WordControl.GoToPage(index),
        item.visualSlideIndex,
      );
      await page.waitForTimeout(100);
      assert.equal(
        await frame.evaluate(
          () => window.Asc.editor.WordControl.m_oLogicDocument.CurPage,
        ),
        item.visualSlideIndex,
      );
      await page.screenshot({
        path: path.join(outputRoot, `${scenario}-reopened.png`),
      });
      item.status = item.reopenDifferences.length
        ? "reopen-model-differs"
        : item.undoDifferences?.length || item.redoDifferences?.length
          ? "history-differs"
          : preserveSource
            ? "source-preserved-save-reopen-verified"
            : repairStructure
              ? "repaired-export-reopen-verified"
              : "raw-export-reopen-verified";
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      const metrics = await cdp.send("Performance.getMetrics");
      item.jsHeapUsedBytes = metrics.metrics.find(
        (x) => x.name === "JSHeapUsedSize",
      )?.value;
      item.stage = "complete";
    } catch (error) {
      item.status = "failed";
      item.error = String(error.message).slice(0, 1500);
      item.diagnostic = await page
        .evaluate(() => ({
          status: window.__ONLYOFFICE_SAVE_E2E__?.getStatus(),
          frames: [...document.querySelectorAll("iframe")].map((f) => f.src),
        }))
        .catch(() => null);
    } finally {
      item.structuralRepairs ??= await page
        .evaluate(() => window.__comparisonStructuralRepairs ?? [])
        .catch(() => []);
      await page
        .evaluate(() => window.__ONLYOFFICE_SAVE_E2E__?.destroy())
        .catch(() => undefined);
      await context.close();
      await writeFile(
        path.join(outputRoot, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
    process.stdout.write(
      JSON.stringify({
        scenario,
        status: item.status,
        openMs: item.openMs,
        exportMs: item.exportMs,
        error: item.error,
      }) + "\n",
    );
  }
} finally {
  await browser.close();
  await new Promise((resolve) => diagnosticServer.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(outputRoot, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (
  report.cases.some(
    (c) =>
      ![
        "raw-export-reopen-verified",
        "repaired-export-reopen-verified",
        "source-preserved-save-reopen-verified",
        "preserved-package-model-readback-verified",
        "host-failure-keeps-dirty",
        "late-ack-second-save-history-reopen-verified",
      ].includes(c.status),
  )
)
  process.exitCode = 1;
