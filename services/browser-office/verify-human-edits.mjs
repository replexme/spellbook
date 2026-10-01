// One direct edit on a freshly opened PPTX, followed by Save. Keep private
// inputs and outputs outside Git; the single JSON result contains no content.
import { comparisonEditMarker as editMarker, assertComparisonMarkerAbsent } from "./comparison-input.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { buildHarness } from "./build-harness.mjs";
import { createHarnessServer } from "./server.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`);
  return process.argv[i + 1];
};
const inputPath = path.resolve(arg("--input"));
const runtimeDirectory = path.resolve(arg("--runtime"));
const scenario = arg("--scenario");
if (
  ![
    "roundtrip",
    "type",
    "type-move",
    "move",
    "delete",
    "newslide",
    "dupslide",
    "delslide",
    "unobserved-picture-mode",
  ].includes(scenario)
)
  throw new Error(`Unknown scenario: ${scenario}`);
const label = arg("--label");
const coverageBoundary = process.argv.includes("--coverage-boundary") ? arg("--coverage-boundary") : "save";
if (!["save","observe","heartbeat","ack","before-ai"].includes(coverageBoundary))
  throw new Error("Unknown observation-coverage boundary");
const captureUi = process.argv.includes("--capture-ui")
  ? path.resolve(arg("--capture-ui"))
  : null;
const receiptPath = process.argv.includes("--receipt")
  ? path.resolve(arg("--receipt"))
  : null;
const savedPath = process.argv.includes("--saved-output")
  ? path.resolve(arg("--saved-output"))
  : null;
const diagnosticRaw = process.argv.includes("--diagnostic-raw")
  ? path.resolve(arg("--diagnostic-raw"))
  : null;
const input = new Uint8Array(await readFile(inputPath));
assertComparisonMarkerAbsent(input);

const runtime = await admitCandidateRuntime({ runtimeDirectory });
await buildHarness();
const server = createHarnessServer({
  runtimeRoot: runtime.runtimeDirectory,
  browserProbeSource: inputPath,
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
if (scenario === "unobserved-picture-mode") {
  // Test-only fault injection: change a real UNO property omitted from the
  // current observation. Do not add a hidden mutation operation to the app.
  await page.route("**/harness/operations.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "  const pages = model.getDrawPages();";
    assert(source.includes(marker));
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        `${marker}
  if (request.__coverageProbe) {
    const page = pages.getByIndex(0);
    const shape = Array.from({length:page.getCount()}, (_,i)=>page.getByIndex(i))
      .find(s=>String(s.getShapeType()).endsWith("GraphicObjectShape"));
    if (!shape) throw new Error("No picture for observation-coverage probe");
    const before = shape.getPropertyValue("GraphicColorMode");
    if (request.__coverageProbe === "write") {
      const color = uno.idl.com.sun.star.drawing.ColorMode;
      shape.setPropertyValue("GraphicColorMode", new uno.Any(uno.type.enum(color), color.GREYS));
      model.setModified(true);
    }
    const after = shape.getPropertyValue("GraphicColorMode");
    const position=shape.getPosition();
    return { before:Number(before?.value ?? before), after:Number(after?.value ?? after),x:position.X,y:position.Y };
  }
`,
      ),
    });
  });
}
// Private captures are enabled only in this local verifier, never in the
// shipped app. Retain both engine exports so a failed correspondence can be
// reproduced without changing the live document or weakening its checks.
if (diagnosticRaw) {
  await page.route("**/harness/app.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "const requestId = `ooxml-preserve-${++requestSequence}`;";
    assert(source.includes(marker));
    const topologyMarker = "const topologyVerified = persistedDirectSlideTopologyMatches(";
    assert(source.includes(topologyMarker));
    await route.fulfill({ response, body: source.replace(marker,
      `globalThis.__humanSnapshot = { original, noEdit, edited, sourceOperations, sourceTargets };\n  ${marker}`).replace(topologyMarker,
      `globalThis.__humanTopology = { before: persistenceStateFromObservation(reconciledObservation), live: persistenceStateFromObservation(live), reopened: persistenceStateFromObservation(preserved.observation), report: preserved.report };\n    ${topologyMarker}`) });
  });
}

const result = {
  label,
  deck: path.basename(inputPath).replace(/[^\x20-\x7e]/gu, "?"),
  scenario,
  sourceBytes: input.length,
  stage: "opening",
};

async function waitEvent(type, previousCount = 0, timeout = 120_000) {
  await page.waitForFunction(
    ({ expectedType, count }) => {
      const events = globalThis.__spellbookProductHost?.events ?? [];
      return (
        events.some((event) => event.type === "error") ||
        events.filter((event) => event.type === expectedType).length > count
      );
    },
    { expectedType: type, count: previousCount },
    { timeout },
  );
  return page.evaluate(
    ({ expectedType, count }) => {
      const events = globalThis.__spellbookProductHost.events;
      const failure = events.find((event) => event.type === "error");
      if (failure) return { error: failure.error };
      return events.filter((event) => event.type === expectedType)[count];
    },
    { expectedType: type, count: previousCount },
  );
}

async function nativeCall(request) {
  const id = `probe-${Date.now()}-${Math.random()}`;
  const errorCount = await page.evaluate(
    () =>
      globalThis.__spellbookProductHost.events.filter(
        (event) => event.type === "error",
      ).length,
  );
  await page.evaluate(
    ({ taskId, task }) =>
      globalThis.__spellbookProductHost.port.postMessage({
        id: taskId,
        request: task,
      }),
    { taskId: id, task: request },
  );
  await page.waitForFunction(
    ({ taskId, previousErrors }) => {
      const events = globalThis.__spellbookProductHost.events;
      return (
        events.some((event) => event.id === taskId) ||
        events.filter((event) => event.type === "error").length > previousErrors
      );
    },
    { taskId: id, previousErrors: errorCount },
    { timeout: 120_000 },
  );
  const found = await page.evaluate(
    ({ taskId, previousErrors }) => {
      const events = globalThis.__spellbookProductHost.events;
      return (
        events.find((event) => event.id === taskId) ??
        events.filter((event) => event.type === "error")[previousErrors]
      );
    },
    { taskId: id, previousErrors: errorCount },
  );
  if (found.error) throw new Error(found.error);
  return found.value;
}

const engineState = async () => {
  const observed = await nativeCall({
    operation: "observe",
    captureSlideIndexes: [],
  });
  const first = observed?.slides?.[0]?.elements ?? [];
  return {
    ...(scenario === "unobserved-picture-mode" ? { sourceSlides:observed.slides } : {}),
    slideCount: observed?.slides?.length ?? 0,
    firstSlideElements: first.length,
    elements: first.map((e) => ({
      id: e.elementId,
      name: e.name,
      text: typeof e.text === "string" ? e.text : null,
      x: e.x,
      y: e.y,
      w: e.width,
      h: e.height,
    })),
  };
};

async function capturePrivateSnapshots() {
  if (diagnosticRaw) {
    await mkdir(diagnosticRaw, { recursive: true, mode: 0o700 });
    for (const kind of ["original", "noEdit", "edited"]) {
      const encoded = await page.evaluate((key) => {
        const bytes = globalThis.__humanSnapshot?.[key];
        if (!bytes) return null;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(binary);
      }, kind);
      if (encoded) await writeFile(path.join(diagnosticRaw, `${kind}.pptx`),
        Buffer.from(encoded, "base64"), { mode: 0o600 });
    }
    const intent = await page.evaluate(() => ({
      sourceOperations: globalThis.__humanSnapshot?.sourceOperations,
      sourceTargets: globalThis.__humanSnapshot?.sourceTargets,
    }));
    await writeFile(path.join(diagnosticRaw, "intent.json"), JSON.stringify(intent, null, 2), { mode: 0o600 });
    const topology = await page.evaluate(() => globalThis.__humanTopology ?? null);
    if (topology) await writeFile(path.join(diagnosticRaw, "topology.json"), JSON.stringify(topology), { mode: 0o600 });
  }
}

const partsDiff = (before, after) => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const name of [...names].sort()) {
    const a = before[name];
    const b = after[name];
    if (!a || !b) changed.push(`${a ? "-" : "+"}${name}`);
    else if (a.length !== b.length || a.some((byte, i) => byte !== b[i]))
      changed.push(name);
  }
  return changed;
};

try {
  const runtimeStarted = Date.now();
  await page.goto(
    `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`,
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  await page.waitForFunction(
    () => ["runtime-ready", "error"].includes(document.body.dataset.state),
    null,
    { timeout: 180_000 },
  );
  assert.equal(
    await page.evaluate(() => document.body.dataset.state),
    "runtime-ready",
    await page.evaluate(() => document.body.innerText.slice(-3000)),
  );
  result.runtimeReadyMs = Date.now() - runtimeStarted;
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
  await waitEvent("ready");
  const openStarted = Date.now();
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (await fetch("/fixtures/browser-probe.pptx")).arrayBuffer(),
    );
    globalThis.__spellbookProductHost.port.postMessage(
      {
        type: "open",
        requestId: "probe-open",
        documentId: "probe-doc",
        fileName: "probe.pptx",
        revision:
          '"baseline:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        maxBytes: 64 * 1024 * 1024,
        bytes: bytes.buffer,
      },
      [bytes.buffer],
    );
  });
  const opened = await waitEvent("open-complete", 0, 240_000);
  if (opened.error) throw new Error(`open failed: ${opened.error}`);
  result.slideCount = opened.slideCount;
  result.openMs = Date.now() - openStarted;
  result.stage = "editing";
  await page.waitForTimeout(3500);
  if (captureUi) await page.screenshot({ path: `${captureUi}-before.png` });

  // Focus the canvas without selecting anything, then Tab to the first object.
  const canvas = page.locator("#qtcanvas");
  const box = await canvas.boundingBox();
  assert.ok(box, "canvas visible");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.97);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  const pickTarget = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(500);
      const selection = await nativeCall({ operation: "selection" });
      const item = selection?.selected?.[0];
      if (item && selection.activeSlide === 0) {
        result.selectionKeys ??= Object.keys(item).join(",");
        if (
          !["type", "type-move"].includes(scenario) ||
          item.hasText === true ||
          item.text
        )
          return item;
        if (
          ["type", "type-move"].includes(scenario) &&
          item.kind &&
          /text|title|shape|placeholder/iu.test(String(item.kind))
        )
          return item;
      }
    }
    return null;
  };

  const beforeState = await engineState();
  let target = null;
  if (scenario === "roundtrip") {
    result.engineApplied = true;
  } else if (scenario === "unobserved-picture-mode") {
    let pendingSave = null;
    if (coverageBoundary === "ack") {
      await page.evaluate(() => globalThis.__spellbookProductHost.port.postMessage({
        type:"command",messageId:"Action_Save",values:{Notify:true},
      }));
      pendingSave=await waitEvent("save");
      if (pendingSave.error) throw new Error(pendingSave.error);
    }
    result.controlledProperty = await nativeCall({
      operation: "selection",
      __coverageProbe: "write",
    });
    result.engineApplied =
      result.controlledProperty.before !== result.controlledProperty.after;
    if (!result.engineApplied)
      throw new Error("Coverage probe did not change the engine");
    result.coverageBoundary=coverageBoundary;
    if (coverageBoundary === "heartbeat") {
      await page.waitForTimeout(12_000);
      result.heartbeatUnreconciled = await page.evaluate(() => globalThis.spellbookBrowserOffice.diagnostics().unreconciledModelRevision);
      assert(result.heartbeatUnreconciled,"Autosave must retain the unknown change as unreconciled");
    }
    if (["observe","before-ai","ack"].includes(coverageBoundary)) {
      if (coverageBoundary === "ack") {
        await page.evaluate(requestId => globalThis.__spellbookProductHost.port.postMessage({
          type:"save-result",requestId,ok:true,revision:'"coverage-server-accepted-baseline"',
        }),pendingSave.requestId);
        const response=await waitEvent("save-response");
        result.outcome=response.success ? "incorrectly-acknowledged" : "refused";
        result.error=response.error; result.acknowledgementModified=response.modified;
      } else {
        const target=beforeState.elements[0];
        const request=coverageBoundary === "observe" ? {operation:"observe",captureSlideIndexes:[]} : {
          operation:"edit",expectedRevision:beforeState.revision,expectedSlides:JSON.stringify(beforeState.sourceSlides),
          command:{op:"move",elementId:target.id,x:target.x+100,y:target.y},
          permission:{mode:"document",slideIndexes:[],elementIds:[]},suppressCapture:true,
        };
        try { await nativeCall(request); result.outcome="incorrectly-accepted"; }
        catch(error) { result.outcome="refused";result.error=error.message; }
        if (coverageBoundary === "before-ai")
          result.afterRejectedAi = await nativeCall({operation:"selection",__coverageProbe:"read"});
      }
      throw Object.assign(new Error("Coverage boundary checked"),{skip:true});
    }
  } else if (["newslide", "dupslide", "delslide"].includes(scenario)) {
    const itemY = { newslide: 16, dupslide: 49, delslide: 145 }[scenario];
    await page.mouse.click(369, 15);
    await page.waitForTimeout(1000);
    if (captureUi) await page.screenshot({ path: `${captureUi}-menu.png` });
    await page.mouse.click(70, itemY);
    // A large imported deck can take several seconds to apply a menu action.
    await page.waitForTimeout(10_000);
    if (captureUi) await page.screenshot({ path: `${captureUi}-after.png` });
    result.slideMethods = "menu:Slide";
  } else {
    target = await pickTarget();
    if (!target) {
      result.outcome = "inconclusive";
      result.note = "no object could be selected with Tab";
      throw Object.assign(new Error("skip"), { skip: true });
    }
    result.target = {
      kind: target.kind,
      name: String(target.name ?? "").replace(/[^\x20-\x7e]/gu, "?"),
    };
    if (["type", "type-move"].includes(scenario)) {
      if (scenario === "type-move")
        for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
      await page.keyboard.press("F2");
      await page.waitForTimeout(800);
      await page.keyboard.press("End");
      await page.keyboard.type(` ${editMarker}`, { delay: 60 });
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
    } else if (scenario === "move") {
      for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    } else if (scenario === "delete") {
      await page.keyboard.press("Delete");
    } else throw new Error(`unknown scenario ${scenario}`);
    await page.waitForTimeout(1500);
  }
  result.stage = "checking-edit";
  const checkpointStarted = Date.now();
  // Saving must independently reject the unknown change. Observing it first
  // would exercise the AI-observe guard and conceal a missing save guard.
  const afterState = ["roundtrip", "unobserved-picture-mode"].includes(scenario)
    ? beforeState
    : await engineState();
  result.checkpointMs = Date.now() - checkpointStarted;
  const before =
    beforeState.elements.find((e) => e.id === target?.elementId) ??
    beforeState.elements.find((e) => e.name === target?.name);
  const after =
    afterState.elements.find((e) => e.id === target?.elementId) ??
    afterState.elements.find((e) => e.name === target?.name);
  result.engineApplied = ["roundtrip", "unobserved-picture-mode"].includes(
    scenario,
  )
    ? result.engineApplied
    : ["type", "type-move"].includes(scenario)
      ? Boolean(
          after?.text?.includes(editMarker) &&
            after.text !== before?.text &&
            (scenario !== "type-move" || (before && after.x !== before.x)),
        )
      : scenario === "move"
        ? Boolean(before && after && after.x !== before.x)
        : scenario === "delete"
          ? afterState.firstSlideElements < beforeState.firstSlideElements
          : scenario === "newslide" || scenario === "dupslide"
            ? afterState.slideCount > beforeState.slideCount
            : afterState.slideCount < beforeState.slideCount;
  result.engineDelta = {
    slides: [beforeState.slideCount, afterState.slideCount],
    firstSlideElements: [
      beforeState.firstSlideElements,
      afterState.firstSlideElements,
    ],
  };
  if (!result.engineApplied) {
    result.outcome = "edit-not-applied";
    result.note = "The UI action did not change the engine model.";
    throw Object.assign(new Error("skip"), { skip: true });
  }

  result.stage = "saving";
  const beforeSave = await page.evaluate(
    () =>
      globalThis.__spellbookProductHost.events.filter((e) => e.type === "save")
        .length,
  );
  const saveStarted = Date.now();
  await page.evaluate(() =>
    globalThis.__spellbookProductHost.port.postMessage({
      type: "command",
      messageId: "Action_Save",
      values: { Notify: true },
    }),
  );
  const saved = await waitEvent("save", beforeSave, 180_000);
  result.saveMs = Date.now() - saveStarted;
  result.saveTimingScope = "save-message-after-checkpoint";
  if (saved.error) {
    result.outcome = "refused";
    result.error = String(saved.error).slice(0, 220);
  } else {
    const output = new Uint8Array(
      Buffer.from(
        await page.evaluate((requestId) => {
          const event = globalThis.__spellbookProductHost.events.find(
            (e) => e.type === "save" && e.requestId === requestId,
          );
          const bytes = new Uint8Array(event.bytes);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 32768)
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return btoa(binary);
        }, saved.requestId),
        "base64",
      ),
    );
    if (savedPath) await writeFile(savedPath, output);
    const before = unzipSync(input);
    const after = unzipSync(output);
    const changed = partsDiff(before, after);
    result.outcome = "saved";
    result.stage = "checking-file";
    result.savedBytes = output.length;
    result.changedPartCount = changed.length;
    result.changedParts = changed.slice(0, 8);
    result.unrelatedParts = changed
      .filter(
        (part) =>
          part !== "ppt/slides/slide1.xml" &&
          part !== "ppt/slides/_rels/slide1.xml.rels",
      )
      .slice(0, 12);
    result.otherSlidesIdentical = changed.every(
      (part) =>
        !/^[-+]?ppt\/slides\/slide\d+\.xml$/u.test(part) ||
        part === "ppt/slides/slide1.xml",
    );
    result.mastersLayoutsThemeIdentical = changed.every(
      (part) => !/^[-+]?ppt\/(slideMasters|slideLayouts|theme)\//u.test(part),
    );
    if (["newslide", "dupslide", "delslide"].includes(scenario)) {
      result.existingSlidePartsChanged = changed.filter(
        (part) =>
          !part.startsWith("+") &&
          !part.startsWith("-") &&
          /^ppt\/slides\//u.test(part),
      );
      result.existingDesignPartsChanged = changed.filter(
        (part) =>
          !part.startsWith("+") &&
          !part.startsWith("-") &&
          /^ppt\/(slideMasters|slideLayouts|theme)\//u.test(part),
      );
      result.existingNotesPartsChanged = changed.filter(
        (part) =>
          !part.startsWith("+") &&
          !part.startsWith("-") &&
          /^ppt\/notesSlides\//u.test(part),
      );
    }
    const slide1After = after["ppt/slides/slide1.xml"]
      ? strFromU8(after["ppt/slides/slide1.xml"])
      : "";
    if (["type", "type-move"].includes(scenario))
      result.textPresent = slide1After.includes(editMarker);
    if (["newslide", "dupslide", "delslide"].includes(scenario))
      result.slidesAfter = Object.keys(after).filter((n) =>
        /^ppt\/slides\/slide\d+\.xml$/u.test(n),
      ).length;
    if (
      ["newslide", "dupslide", "delslide"].includes(scenario) &&
      (result.existingSlidePartsChanged.length ||
        result.existingDesignPartsChanged.length ||
        result.existingNotesPartsChanged.length)
    )
      result.note = "PRESERVATION FAILURE: an existing content part changed";
    if (
      scenario !== "roundtrip" &&
      result.engineApplied &&
      (changed.length === 0 ||
        (changed.length === 1 && changed[0].startsWith("docProps")))
    )
      result.note =
        "SILENT LOSS: edit applied in engine but the saved file has no change";
    if (
      ["type", "type-move", "move", "delete"].includes(scenario) &&
      (!changed.includes("ppt/slides/slide1.xml") ||
        result.unrelatedParts.length > 0 ||
        result.otherSlidesIdentical !== true ||
        result.mastersLayoutsThemeIdentical !== true)
    )
      result.note =
        "PRESERVATION FAILURE: intended slide missing or unrelated parts changed";
    result.stage = "complete";
  }
} catch (error) {
  if (!error.skip) {
    result.outcome ??= "error";
    result.error = String(error.message).slice(0, 1000);
  }
} finally {
  await capturePrivateSnapshots().catch((error) => {
    result.captureError = error.message;
  });
  if (captureUi)
    await page
      .screenshot({ path: `${captureUi}-result.png` })
      .catch((error) => {
        result.captureUiError = error.message;
      });
  result.metrics = await page
    .evaluate(() => globalThis.spellbookBrowserOffice?.diagnostics?.() ?? null)
    .catch(() => null);
  result.phases = await page
    .evaluate(() =>
      performance
        .getEntriesByType("measure")
        .filter((e) => e.name.startsWith("spellbook-"))
        .map((e) => ({ name: e.name, duration: Math.round(e.duration) })),
    )
    .catch(() => []);
  if (receiptPath)
    await writeFile(receiptPath, JSON.stringify(result, null, 2) + "\n");
  if (scenario === "unobserved-picture-mode") {
    const staleAiRejectedWithoutMutation = coverageBoundary === "before-ai" &&
      result.error === "browser_package_revision_changed" &&
      result.afterRejectedAi?.x === result.controlledProperty?.x &&
      result.afterRejectedAi?.y === result.controlledProperty?.y;
    result.coverageGuardPassed =
      result.engineApplied === true &&
      result.outcome === "refused" &&
      (staleAiRejectedWithoutMutation ||
        (result.error === "browser_native_unobserved_change" && Boolean(result.metrics?.unreconciledModelRevision)));
    // Record the assertion too, not only the engine's refusal message.
    if (receiptPath)
      await writeFile(receiptPath, JSON.stringify(result, null, 2) + "\n");
    if (!result.coverageGuardPassed) process.exitCode = 1;
  } else if (result.outcome !== "saved" || result.note) process.exitCode = 1;
  process.stdout.write(JSON.stringify(result) + "\n");
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
