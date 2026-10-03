import { readOnlyOfficeFontCoverage } from "./onlyoffice-font-coverage.mjs";
import { readOfficeDistributionEvidence } from "./distribution-check.mjs";
import { readCandidateNativeEvidence } from "./onlyoffice/native-evidence.mjs";
import { readOnlyOfficeCodeIdentity, readOnlyOfficeCodeEvidence } from "./onlyoffice/code-identity.mjs";
import { beginCandidateTransaction, finishCandidateTransaction } from "./onlyoffice/candidate-transaction.mjs";
import { captureStableOnlyOfficeBaseline } from "./onlyoffice-baseline.mjs";
import { observeOnlyOfficeCandidate as typedProjection } from "./onlyoffice-observation.mjs";
/* SPDX-License-Identifier: MPL-2.0 */
import { createOnlyOfficeComparisonHost } from "./onlyoffice/comparison-host.mjs";
import { buildHarness } from "./build-harness.mjs";
// Diagnostic candidate adapter, deliberately separate from production engine
// admission. Private documents/results belong outside the repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { prepareChartSeriesWorkbookMutation } from "./ooxml-worker-source.mjs";
import { readRepositoryIdentity, readRepositoryEvidence, repositoryIdentityStable } from "./repository-identity.mjs";

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
assert(
  ["127.0.0.1", "localhost"].includes(origin.hostname),
  "Local candidate origin required",
);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const source = await readFile(inputPath);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidate = readRepositoryIdentity(candidateRoot);
const integration = readRepositoryIdentity(
  path.resolve(import.meta.dirname, "../.."),
);
assert(!candidate.dirty && !integration.dirty, "Commit candidate and integration sources before recording trials");
await buildHarness();
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
        strFromU8(v).includes("SBX_TYPED_9F3"),
    ),
  };
};
const candidateCodeIdentity = await readOnlyOfficeCodeIdentity(candidateRoot);
const candidateDistribution = await readOfficeDistributionEvidence(path.join(candidateRoot, "dist"));
assert(candidateDistribution.valid, "Reviewed complete candidate distribution required: " + candidateDistribution.error);
const inputFontCoverage = await readOnlyOfficeFontCoverage(candidateRoot, source);
const report = {
  inputFontCoverage,
  candidateCodeIdentity,
  candidateDistribution,
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  inputName: path.basename(inputPath),
  inputSha256: sha(source),
  sourceBytes: source.length,
  candidate,
  candidateSdkSha256: sha(
    await readFile(path.join(candidateRoot, "dist/sdkjs/slide/sdk-all.js")),
  ),
  integration,
  timingScope:
    "candidate readiness and authored-source preservation plus final format repair in real save callback; excludes independent SDK validation and 94-command product admission",
  inputSetup:
    "version-pinned native SDK history mutations in a headless local browser",
  cases: [],
  engineApiMethods: null,
  externalRequestCount: 0,
};
const typedCase = flag("--typed-case");
const failAfterApply = process.argv.includes("--fail-after-apply");
const preexistingRedo = process.argv.includes("--preexisting-redo");
assert(!preexistingRedo || failAfterApply, "Redo preservation requires a cancelled transaction");
let redoNativeExpected = null;
let transaction = null, transactionBefore = null, transactionNativeBefore = null, transactionHostBefore = null;
const knownTypedCases = [
  "table-row-add",
  "table-cell-style",
  "table-cell-append",
  "table-cell-text",
  "chart-data",
  "chart-type",
  "slide-transition",
  "animation-timing",
  "object-hyperlink",
  "shape-fill",
  "slide-background",
  "layout-switch",
  "shape-insert",
  "wordart-insert",
  "smartart-move",
  "picture-crop",
  "smartart-text",
  "smartart-add",
  "smartart-delete",
];
assert(knownTypedCases.includes(typedCase), "Unknown typed comparison case");

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
  preserveSource: true,
  repairStructure: true,
});
// Real loopback HTTP gives Chromium a local address space for the host iframe.
const repairBundle = await readFile(
  path.join(import.meta.dirname, "runtime/ooxml-worker.js"),
);
const diagnosticServer = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/compare.html") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(diagnosticHost);
  } else if (pathname === "/comparison-repair.js") {
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
    };
  });
}

const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (
    ["http:", "https:"].includes(url.protocol) &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    report.externalRequestCount++;
    await route.abort("blockedbyclient");
  } else await route.continue();
});
const item = {
  typedCase,
  stage: "open",
  status: "running",
  proofLimit:
    "Actual typed candidate native history and authored-source preservation plus final structure repair in real save callback; excludes full 94-command product admission.",
};
report.cases.push(item);
async function visibleSlide(frame) {
  return frame.evaluate(async () => {
    const canvas = document.getElementById("id_viewer");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height)
      throw Error("visible_slide_canvas_missing");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return { width: canvas.width, height: canvas.height, sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("") };
  });
}
async function visibleSlides(page, frame, label, count) {
  const views = [];
  for (let index = 0; index < count; index++) {
    await frame.evaluate(index => window.Asc.editor.WordControl.GoToPage(index), index);
    await page.waitForTimeout(250);
    views.push(await visibleSlide(frame));
    await page.screenshot({path: path.join(outputRoot, `slide-${label}-${index + 1}.png`)});
  }
  await frame.evaluate(() => window.Asc.editor.WordControl.GoToPage(0));
  await page.waitForTimeout(250);
  return views;
}

try {
  assert(inputFontCoverage.valid, "Candidate font catalog does not cover input text: " + JSON.stringify(inputFontCoverage.missing));
  let { frame, ms } = await open(page);
  item.openMs = ms;
  await page.evaluate(() => {
    window.__comparisonIntent = { sourceOperations: null, sourceTargets: null };
  });
  const before = await typedProjection(frame);
  item.slideRendering = { before: await visibleSlides(page, frame, "before", before.common.slides.length) };
  if (typedCase === "chart-data") item.visibleRendering = { before: await visibleSlide(frame) };
  await page.screenshot({ path: path.join(outputRoot, "before.png") });
  const sourceBaseline = await captureStableOnlyOfficeBaseline(page, save);
  item.sourceBaselineStabilization = { ms: sourceBaseline.ms, attempts: sourceBaseline.attempts, transitions: sourceBaseline.transitions };
  item.stage = "apply";
  let chartAuthority = null;
  if (typedCase === "chart-data") {
    const preparationStarted = performance.now();
    const request = await frame.evaluate(() => {
      const d = window.AscBuilder.Slide.Api.GetPresentation()
        .GetSlideByIndex(0)
        .GetAllDrawings()
        .find((d) => d.GetClassType() === "chart");
      if (!d) throw Error("chart target missing");
      const series = d.Chart.getAllSeries()[0],
        points = series.val?.numRef?.numCache?.pts;
      if (!points?.length) throw Error("numeric chart cache missing");
      return {
        initialWorkbookBytes: Array.from(d.Chart.XLSX),
        initialWorkbook: {
          bytes: d.Chart.XLSX.length,
          prefix: Array.from(d.Chart.XLSX.slice(0, 32)),
        },
        slideIndex: 0,
        shapeName: d.Drawing.getOwnName(),
        seriesIndex: series.idx,
        values: points.map(
          (point, index) => Number(point.val) + (index === 0 ? 7 : 0),
        ),
      };
    });
    const prepared = prepareChartSeriesWorkbookMutation(source, request);
    await page.evaluate(() => window.__ONLYOFFICE_SAVE_E2E__.destroy());
    const workbookBinaries = [];
    for (const workbookBytes of [
      unzipSync(source)[prepared.workbookPart],
      prepared.bytes,
    ]) {
      await page.evaluate(
        async ({ bytes, candidateOrigin }) => {
          const { createOfficeEditor } = await import(
            candidateOrigin + "/npm/public-api.js"
          );
          const container = document.createElement("div");
          container.style.cssText =
            "position:absolute;left:-20000px;top:0;width:1200px;height:900px";
          document.body.append(container);
          window.__comparisonWorkbookContainer = container;
          window.__comparisonWorkbookEditor = await createOfficeEditor(
            container,
            {
              hostUrl: candidateOrigin + "/office-host.html",
              file: new File(
                [
                  Uint8Array.from(atob(bytes), (character) =>
                    character.charCodeAt(0),
                  ),
                ],
                "chart-data.xlsx",
                {
                  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                },
              ),
              fileName: "chart-data.xlsx",
              mode: "edit",
              saveBehavior: "callback",
              onSave: async () => {
                throw new Error(
                  "temporary_workbook_has_no_persistence_authority",
                );
              },
            },
          );
        },
        {
          bytes: Buffer.from(workbookBytes).toString("base64"),
          candidateOrigin: origin.origin,
        },
      );
      await page.waitForFunction(
        () => window.__comparisonWorkbookEditor?.getState().status === "ready",
        null,
        { timeout: 60000 },
      );
      const sheetFrame = page
        .frames()
        .find(
          (candidate) =>
            candidate.url().includes("/spreadsheeteditor/") &&
            candidate.url().includes("/index.html"),
        );
      assert(
        sheetFrame,
        "Owned embedded workbook must have an isolated native spreadsheet frame",
      );
      const embeddedBinary = await sheetFrame.evaluate(() => {
        const editor = window.Asc.editor;
        return window.AscFormat.ExecuteNoHistory(
          () => {
            const workbook = editor.wbModel;
            if (!workbook) throw new Error("native_spreadsheet_model_missing");
            const writer = new window.AscCommonExcel.BinaryFileWriter(workbook);
            const bytes = writer.Write(true, false, true);
            let text = "";
            for (let i = 0; i < bytes.length; i += 32768)
              text += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return btoa(text);
          },
          null,
          [],
        );
      });
      await page.evaluate(async () => {
        await window.__comparisonWorkbookEditor.destroy();
        window.__comparisonWorkbookEditor = null;
        window.__comparisonWorkbookContainer.remove();
      });
      workbookBinaries.push(embeddedBinary);
    }
    const [baselineBinary, embeddedBinary] = workbookBinaries;
    ({ frame, ms } = await open(page));
    assert.deepEqual(
      differences(before, await typedProjection(frame)),
      [],
      "Workbook preparation must not edit the presentation",
    );
    await frame.evaluate((bytes) => {
      const d = window.AscBuilder.Slide.Api.GetPresentation()
        .GetSlideByIndex(0)
        .GetAllDrawings()
        .find((d) => d.GetClassType() === "chart");
      window.AscFormat.ExecuteNoHistory(
        () =>
          d.Chart.setXLSX(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))),
        null,
        [],
      );
    }, baselineBinary);
    const chartBaseline = await captureStableOnlyOfficeBaseline(page, save);
    item.chartBaselineStabilization = { ms: chartBaseline.ms, attempts: chartBaseline.attempts, transitions: chartBaseline.transitions };
    await frame.evaluate((bytes) => {
      const d = window.AscBuilder.Slide.Api.GetPresentation()
        .GetSlideByIndex(0)
        .GetAllDrawings()
        .find((d) => d.GetClassType() === "chart");
      window.AscFormat.ExecuteNoHistory(
        () => d.Chart.setXLSX(Uint8Array.from(bytes)),
        null,
        [],
      );
    }, request.initialWorkbookBytes);
    await page.evaluate(() => {
      window.__comparisonCaptureBaseline = false;
      window.__comparisonIntent = {
        sourceOperations: null,
        sourceTargets: null,
      };
    });
    chartAuthority = {
      ...request,
      previousValues: prepared.previousValues,
      bytes: embeddedBinary,
      expectedWorkbook: Buffer.from(prepared.bytes).toString("base64"),
    };
    item.chartDataAuthority = {
      preparationMs: performance.now() - preparationStarted,
      initialWorkbook: request.initialWorkbook,
      convertedPrefix: Array.from(
        Buffer.from(embeddedBinary, "base64").subarray(0, 48),
      ),
      chartPart: prepared.chartPart,
      workbookPart: prepared.workbookPart,
      worksheetPart: prepared.worksheetPart,
      changedCells: prepared.changedCells,
    };
    await writeFile(
      path.join(outputRoot, "expected-workbook.xlsx"),
      prepared.bytes,
      { mode: 0o600 },
    );
  }
  // Visiting slides can resolve imported dynamic-field caches without a history
  // point. Capture the no-edit baseline after observation/rendering and chart
  // workbook preparation, before any transaction can mutate authored content.
  const transactionBaseline = chartAuthority ? await captureStableOnlyOfficeBaseline(page, save, {retainPreservationBaseline:true}) : sourceBaseline;
  item.transactionBaselineStabilization = {ms:transactionBaseline.ms, attempts:transactionBaseline.attempts, transitions:transactionBaseline.transitions};
  if (preexistingRedo) {
    await frame.evaluate(() => {
      const a = window.Asc.editor, api = window.AscBuilder.Slide.Api;
      a.startGroupActions(); a.executeGroupActionsStart();
      api.GetPresentation().GetSlideByIndex(0).SetBackground(api.CreateSolidFill(api.CreateRGBColor(17,61,103)));
      a.endGroupActions();
    });
    // Rendering warms provider caches. Keep their exact normalized state as
    // the expected real Redo output, then return to the original document.
    await visibleSlides(page, frame, "existing-redo-future", before.common.slides.length);
    redoNativeExpected = await readCandidateNativeEvidence(frame,candidateRoot);
    await frame.evaluate(() => window.Asc.editor.Undo());
    await visibleSlides(page, frame, "existing-redo-undone", before.common.slides.length);
    await captureStableOnlyOfficeBaseline(page, save, {retainPreservationBaseline:true});
    assert(await frame.evaluate(() => window.AscCommon.History.Can_Redo()), "Existing native Redo branch required");
    item.preexistingRedo = {prepared:true,expectedContentSha256:redoNativeExpected.contentSha256};
  }
  transactionBefore = await typedProjection(frame);
  assert.deepEqual(differences(before,transactionBefore),[],"No-edit preparation cannot alter observed content");
  transactionHostBefore = await page.evaluate(() => window.__ONLYOFFICE_SAVE_E2E__.getStatus());
  transactionNativeBefore = await readCandidateNativeEvidence(frame,candidateRoot);
  item.hostBeforeMutation = transactionHostBefore;
  item.nativeBeforeMutation = transactionNativeBefore;
  transaction = { frame, checkpoint: await beginCandidateTransaction(frame) };
  const setup = await frame.evaluate(({ kind, chartAuthority }) => {
    const api = window.AscBuilder.Slide.Api,
      a = window.Asc.editor,
      m = a.WordControl.m_oLogicDocument;
    a.WordControl.Thumbnails.SelectPage(0);
    const p = api.GetPresentation(),
      slide = p.GetSlideByIndex(0),
      drawings = slide.GetAllDrawings();
    const methods = (o) => {
      const n = new Set();
      for (let q = o; q; q = Object.getPrototypeOf(q))
        for (const k of Object.getOwnPropertyNames(q))
          if (typeof o[k] === "function") n.add(k);
      return [...n].sort();
    };
    const find = (type) => drawings.find((d) => d.GetClassType() === type);
    p.CreateNewHistoryPoint();
    let result, semanticMutation;
    const fill = () => api.CreateSolidFill(api.CreateRGBColor(39, 117, 181));
    if (kind === "picture-crop") {
      const d = find("image");
      if (!d) throw Error("image target missing");
      const rect = new window.AscFormat.CSrcRect();
      rect.l = 10;
      rect.t = 5;
      rect.r = 90;
      rect.b = 95;
      d.Drawing.setSrcRect(rect);
      result = true;
    } else if (kind === "smartart-add" || kind === "smartart-delete") {
      const d = find("smartArt"),
        g = d.Drawing;
      if (!g.isCanGenerateSmartArt())
        throw Error("diagram_native_layout_unsupported");
      const model = g.dataModel.createDuplicate(),
        dm = model.getDataModel();
      const parent = dm.ptLst.list.find((p) => p.type === 0),
        edge = dm.cxnLst.list.find(
          (c) =>
            c.type === 0 &&
            c.srcId === parent?.modelId &&
            dm.ptLst.list.some(
              (point) => point.modelId === c.destId && point.type === 0,
            ),
        ),
        child = dm.ptLst.list.find((p) => p.modelId === edge?.destId);
      if (!parent || !edge || !child)
        throw Error("diagram_graph_target_missing");
      if (kind === "smartart-add") {
        const point = child.createDuplicate(),
          connection = edge.createDuplicate();
        point.setModelId(window.AscCommon.CreateGUID());
        point.setType(window.AscFormat.Point_type_node);
        point.setT(
          window.AscFormat.CreateTextBodyFromString("SBX_TYPED_9F3", null),
        );
        connection.setModelId(window.AscCommon.CreateGUID());
        connection.setDestId(point.modelId);
        connection.setSrcOrd(
          Math.max(
            ...dm.cxnLst.list
              .filter((c) => c.type === 0 && c.srcId === parent.modelId)
              .map((c) => c.srcOrd ?? 0),
          ) + 1,
        );
        for (const [field, setter] of [
          ["parTransId", "setParTransId"],
          ["sibTransId", "setSibTransId"],
        ]) {
          const original = dm.ptLst.list.find((p) => p.modelId === edge[field]);
          if (!original) throw Error("diagram_transition_binding_missing");
          const transition = original.createDuplicate();
          transition.setModelId(window.AscCommon.CreateGUID());
          transition.setCxnId(connection.modelId);
          dm.ptLst.addToLst(dm.ptLst.list.length, transition);
          connection[setter](transition.modelId);
        }
        dm.ptLst.addToLst(dm.ptLst.list.length, point);
        dm.cxnLst.addToLst(dm.cxnLst.list.length, connection);
        semanticMutation = {
          kind: "add",
          parent: parent.modelId,
          target: point.modelId,
        };
      } else {
        semanticMutation = {
          kind: "delete",
          parent: parent.modelId,
          target: child.modelId,
        };
        const removed = new Set([child.modelId]);
        for (const c of dm.cxnLst.list)
          if (c.type === 0 && c.srcId === child.modelId)
            throw Error("diagnostic_target_has_children");
        for (const c of dm.cxnLst.list)
          if (c.type === 1 && removed.has(c.srcId)) removed.add(c.destId);
        if (edge.parTransId) removed.add(edge.parTransId);
        if (edge.sibTransId) removed.add(edge.sibTransId);
        for (let i = dm.cxnLst.list.length - 1; i >= 0; i--) {
          const c = dm.cxnLst.list[i];
          if (removed.has(c.srcId) || removed.has(c.destId))
            dm.cxnLst.removeFromLst(i);
        }
        for (let i = dm.ptLst.list.length - 1; i >= 0; i--)
          if (removed.has(dm.ptLst.list[i].modelId)) dm.ptLst.removeFromLst(i);
      }
      const semanticNodes = dm.ptLst.list.filter((point) => point.type === 0);
      if (kind === "smartart-add") {
        const added = semanticNodes.filter((point) =>
          point.t?.content
            ?.GetText?.({ Numbering: false })
            .includes("SBX_TYPED_9F3"),
        );
        if (
          added.length !== 1 ||
          !dm.cxnLst.list.some(
            (c) =>
              c.type === 0 &&
              c.srcId === parent.modelId &&
              c.destId === added[0].modelId,
          )
        )
          throw Error("diagram_normal_child_postcondition_failed");
      } else if (
        dm.ptLst.list.some((point) => point.modelId === child.modelId)
      ) {
        throw Error("diagram_delete_postcondition_failed");
      }
      g.setDataModel(model);
      g.smartArtTree = null;
      g.checkDataModel();
      g.generateDrawingPart();
      g.recalcSmartArtConnections();
      result = true;
    } else if (kind === "smartart-text") {
      const d = find("smartArt");
      const dm = d.Drawing.getDataModelFromData();
      const target = dm.ptLst.list.find((p) => p.type === 0 && p.t);
      if (!target) throw Error("diagram text node missing");
      const leaves = [];
      const visit = (x) => {
        if (
          x
            .getSmartArtPointContent?.()
            ?.some((n) => n.point?.modelId === target.modelId)
        )
          leaves.push(x);
        x.spTree?.forEach(visit);
      };
      visit(d.Drawing);
      if (leaves.length !== 1)
        throw Error("diagram_text_binding_ambiguous:" + leaves.length);
      const leaf = leaves[0],
        content = window.AscBuilder.GetApiDrawing(leaf).GetContent();
      content.RemoveAllElements();
      const para = content.GetElement(0);
      para.AddText("SBX_TYPED_9F3");
      leaf.copyTextInfoFromShapeToPoint();
      if (
        !dm.ptLst.list
          .find((p) => p.modelId === target.modelId)
          ?.t?.content.GetText({ Numbering: false })
          .includes("SBX_TYPED_9F3")
      )
        throw Error("diagram_graph_text_postcondition_failed");
      result = true;
    } else if (kind === "table-row-add") {
      const d = find("table");
      if (!d) throw Error("table target missing");
      result = Boolean(d.AddRow());
    } else if (kind === "table-cell-style") {
      const d = find("table");
      if (!d) throw Error("table target missing");
      d.GetRow(0).GetCell(0).SetShd("clear", 39, 117, 181);
      result = true;
    } else if (kind === "table-cell-append") {
      const d = find("table");
      if (!d) throw Error("table target missing");
      d.GetRow(0)
        .GetCell(0)
        .GetContent()
        .GetElement(0)
        .AddText("SBX_TYPED_9F3");
      result = true;
    } else if (kind === "table-cell-text") {
      const d = find("table");
      if (!d) throw Error("table target missing");
      const content = d.GetRow(0).GetCell(0).GetContent();
      content.RemoveAllElements();
      content.GetElement(0).AddText("SBX_TYPED_9F3");
      if (!content.GetText().includes("SBX_TYPED_9F3"))
        throw Error("table_cell_text_postcondition_failed");
      result = true;
    } else if (kind === "chart-data") {
      const d = find("chart");
      if (!d) throw Error("chart target missing");
      const s = d.Chart.getAllSeries()[0];
      const pts = s.val?.numRef?.numCache?.pts ?? s.val?.numLit?.pts ?? [];
      if (!pts.length) throw Error("numeric chart cache missing");
      if (
        !chartAuthority ||
        d.Drawing.getOwnName() !== chartAuthority.shapeName ||
        s.idx !== chartAuthority.seriesIndex ||
        JSON.stringify(pts.map((point) => Number(point.val))) !==
          JSON.stringify(chartAuthority.previousValues)
      )
        throw Error("chart_authority_preflight_failed");
      result = d.SetSeriaValues(chartAuthority.values, s.idx);
      const bytes = Uint8Array.from(atob(chartAuthority.bytes), (character) =>
        character.charCodeAt(0),
      );
      d.Chart.setXLSX(bytes);
      window.__chartAuthorityApplied = bytes;
    } else if (kind === "chart-type") {
      const d = find("chart");
      if (!d) throw Error("chart target missing");
      const s = d.GetAllSeries()[0];
      const old = s.GetChartType();
      result = s.ChangeChartType(old.startsWith("line") ? "bar" : "lineNormal");
      window.__typedChartDiagnostic = {
        before: old,
        after: s.GetChartType(),
        result,
      };
    } else if (kind === "slide-transition") {
      const t = api.CreateSlideShowTransition();
      t.SetEntryEffect("effectSplitVerticalIn");
      t.SetDuration(1234);
      t.SetAdvanceOnTime(true);
      t.SetAdvanceTime(5000);
      result = slide.SetSlideShowTransition(t);
    } else if (kind === "animation-timing") {
      const effects = slide.GetTimeLine().GetAllEffects();
      if (!effects.length) throw Error("animation target missing");
      result = effects[0].SetDuration(effects[0].GetDuration() + 777);
    } else if (kind === "object-hyperlink") {
      const d = find("shape") ?? find("image");
      if (!d) throw Error("hyperlink target missing");
      result = d.SetHyperlink(
        api.CreateHyperlink(
          "https://example.com/SBX_TYPED_9F3",
          "local comparison; never followed",
        ),
      );
    } else if (kind === "shape-fill") {
      const d = find("shape");
      if (!d) throw Error("shape target missing");
      result = d.Fill(fill());
    } else if (kind === "slide-background") {
      result = slide.SetBackground(fill());
    } else if (kind === "layout-switch") {
      const layouts = p.GetAllSlideMasters().flatMap((m) => m.GetAllLayouts());
      const other = layouts.find((l) => l.Layout !== slide.Slide.Layout);
      if (!other) throw Error("No alternate existing layout");
      result = slide.ApplyLayout(other);
    } else if (kind === "shape-insert") {
      const d = api.CreateShape(
        "rect",
        40 * 36000,
        20 * 36000,
        fill(),
        api.CreateStroke(0, api.CreateNoFill()),
      );
      d.SetName("SBX_TYPED_9F3");
      d.SetPosition(20 * 36000, 20 * 36000);
      result = slide.AddObject(d);
    } else if (kind === "wordart-insert") {
      const t = api.CreateTextPr();
      t.SetFontSize(24);
      const d = api.CreateWordArt(
        t,
        "SBX_TYPED_9F3",
        "textArchUp",
        fill(),
        api.CreateStroke(0, api.CreateNoFill()),
        0,
        100 * 36000,
        30 * 36000,
        20,
        20,
      );
      d.SetName("SBX_TYPED_9F3");
      result = slide.AddObject(d);
      d.SetName("SBX_TYPED_9F3");
      if (d.Drawing.getOwnName() !== "SBX_TYPED_9F3")
        throw Error("wordart_name_postcondition_failed");
    } else if (kind === "smartart-move") {
      const d = drawings.find(
        (d) => d.GetClassType() === "smartArt" || d.GetClassType() === "group",
      );
      if (!d) throw Error("diagram target missing");
      d.SetPosition(d.GetPosX() + 5 * 36000, d.GetPosY());
      result = true;
    } else throw Error("Unknown typed case");
    m.Recalculate();
    m.Document_UpdateInterfaceState();
    return {
      result,
      semanticMutation,
      chartDiagnostic: window.__typedChartDiagnostic ?? null,
      availableMethods: methods(api),
    };
  }, { kind: typedCase, chartAuthority });
  item.setup = setup;
  {
    await page.waitForTimeout(200);
    const edited = await typedProjection(frame);
    item.slideRendering.edited = await visibleSlides(page, frame, "edited", edited.common.slides.length);
    for (let index=1;index<before.common.slides.length;index++)
      assert.deepEqual(item.slideRendering.edited[index], item.slideRendering.before[index], `Untargeted slide ${index+1} must retain visible pixels`);
    if (chartAuthority) {
      item.visibleRendering.edited = await visibleSlide(frame);
      assert.notEqual(item.visibleRendering.edited.sha256, item.visibleRendering.before.sha256, "Chart edit must redraw the visible slide");
    }
    if (setup.semanticMutation) {
      const diagrams = (value) =>
        value.common.slides[0].shapes
          .filter((shape) => shape.diagram)
          .map((shape) => shape.diagram);
      const original = diagrams(before),
        changed = diagrams(edited);
      assert.equal(original.length, 1, "Unique source diagram required");
      assert.equal(changed.length, 1, "Unique edited diagram required");
      const mutation = setup.semanticMutation;
      const retained = original[0].points.filter(
        (point) => mutation.kind !== "delete" || point.id !== mutation.target,
      );
      for (const point of retained)
        assert.deepEqual(
          changed[0].points.find((candidate) => candidate.id === point.id),
          point,
          "Untargeted semantic node changed",
        );
      assert.equal(
        changed[0].points.length,
        original[0].points.length + (mutation.kind === "add" ? 1 : -1),
      );
      if (mutation.kind === "add") {
        const point = changed[0].points.find(
          (point) => point.id === mutation.target,
        );
        assert.equal(
          point?.type,
          0,
          "Added node must be a normal content node",
        );
        assert(
          point.text.includes("SBX_TYPED_9F3"),
          "Added text must be displayed in semantic graph",
        );
        assert(
          changed[0].connections.some(
            (connection) =>
              connection.src === mutation.parent &&
              connection.dest === mutation.target,
          ),
          "Added node must have the requested parent",
        );
      } else
        assert(
          !changed[0].points.some((point) => point.id === mutation.target),
          "Deleted semantic node remained",
        );
    }
    item.applyDifferences = differences(before, edited);
    assert(
      item.applyDifferences.length,
      "Typed request changed no inspected field",
    );
    assert(setup.result !== false, "API rejected mutation");
    if (failAfterApply) throw new Error("injected_failure_after_native_mutation");
    item.nativeTransaction = await finishCandidateTransaction(frame, transaction.checkpoint, true);
    transaction = null;
    await page.screenshot({ path: path.join(outputRoot, "edited.png") });
    item.stage = "save";
    const saved = await save(page),
      bytes = Buffer.from(saved.base64, "base64");
    item.exportMs = saved.ms;
    item.savePipeline = await page.evaluate(() => ({
      preservations: window.__comparisonPreservations,
      repairs: window.__comparisonStructuralRepairs,
    }));
    if (chartAuthority) {
      const workbook = unzipSync(bytes)[item.chartDataAuthority.workbookPart];
      assert(workbook, "Saved chart workbook must retain the authored binding");
      await writeFile(
        path.join(outputRoot, "native-saved-workbook.xlsx"),
        workbook,
        { mode: 0o600 },
      );
      const expected = unzipSync(
          Buffer.from(chartAuthority.expectedWorkbook, "base64"),
        ),
        actual = unzipSync(workbook);
      assert.deepEqual(
        Object.keys(actual).sort(),
        Object.keys(expected).sort(),
        "Saved chart workbook part set changed",
      );
      for (const [part, payload] of Object.entries(expected))
        assert.deepEqual(
          actual[part],
          payload,
          "Saved chart workbook payload differs: " + part,
        );
      item.chartDataAuthority.persistedPayloadVerified = true;
    }
    item.savedSha256 = sha(bytes);
    Object.assign(item, packageDelta(bytes));
    await writeFile(path.join(outputRoot, "saved.pptx"), bytes, {
      mode: 0o600,
    });
    const nativeWorkbook = async () =>
      frame.evaluate(() =>
        Array.from(
          window.AscBuilder.Slide.Api.GetPresentation()
            .GetSlideByIndex(0)
            .GetAllDrawings()
            .find((d) => d.GetClassType() === "chart").Chart.XLSX,
        ),
      );
    const appliedWorkbook = chartAuthority ? await nativeWorkbook() : null;
    await frame.evaluate(() => window.Asc.editor.Undo());
    await page.waitForTimeout(150);
    item.undoDifferences = differences(before, await typedProjection(frame));
    if (chartAuthority) {
      item.visibleRendering.undo = await visibleSlide(frame);
      await page.screenshot({path: path.join(outputRoot, "undo.png")});
      assert.equal(item.visibleRendering.undo.sha256, item.visibleRendering.before.sha256, "Undo must restore visible chart pixels");
    }
    if (chartAuthority)
      assert.deepEqual(
        await nativeWorkbook(),
        chartAuthority.initialWorkbookBytes,
        "Undo must restore the exact prior native workbook",
      );
    await frame.evaluate(() => window.Asc.editor.Redo());
    await page.waitForTimeout(150);
    item.redoDifferences = differences(edited, await typedProjection(frame));
    if (chartAuthority) {
      item.visibleRendering.redo = await visibleSlide(frame);
      await page.screenshot({path: path.join(outputRoot, "redo.png")});
      assert.equal(item.visibleRendering.redo.sha256, item.visibleRendering.edited.sha256, "Redo must restore visible chart pixels");
    }
    if (chartAuthority)
      assert.deepEqual(
        await nativeWorkbook(),
        appliedWorkbook,
        "Redo must restore the exact native workbook snapshot",
      );
    item.stage = "reopen";
    served = bytes;
    ({ frame, ms } = await open(page));
    item.reopenMs = ms;
    const reopened = await typedProjection(frame);
    item.slideRendering.reopened = await visibleSlides(page, frame, "reopened", reopened.common.slides.length);
    for (let index=1;index<before.common.slides.length;index++)
      assert.deepEqual(item.slideRendering.reopened[index], item.slideRendering.before[index], `Saved untargeted slide ${index+1} must retain visible pixels`);
    if (chartAuthority) {
      item.visibleRendering.reopened = await visibleSlide(frame);
      assert.equal(item.visibleRendering.reopened.sha256, item.visibleRendering.edited.sha256, "Saved reopened chart must match the live rendering");
    }
    item.reopenDifferences = differences(edited, reopened);
    await page.screenshot({ path: path.join(outputRoot, "reopened.png") });
    await writeFile(
      path.join(outputRoot, "readback.json"),
      JSON.stringify({ before, edited, reopened }, null, 2),
      { mode: 0o600 },
    );
    item.status =
      item.undoDifferences.length || item.redoDifferences.length
        ? "history-differs"
        : item.reopenDifferences.length
          ? "reopen-differs"
          : "typed-apply-save-history-reopen-verified";
  }
} catch (e) {
  item.status = "failed";
  item.error = e.message;
  if (transaction) {
    try {
      item.nativeRollback = await finishCandidateTransaction(transaction.frame, transaction.checkpoint, false);
      item.rollbackDifferences = differences(transactionBefore, await typedProjection(transaction.frame));
      assert.deepEqual(item.rollbackDifferences, [], "Native cancellation must restore all observed slides");
      item.rollbackRendering = await visibleSlides(page, transaction.frame, "rollback", transactionBefore.common.slides.length);
      assert.deepEqual(item.rollbackRendering, item.slideRendering.before, "Native cancellation must restore every visible slide");
      item.nativeAfterFailure = await readCandidateNativeEvidence(transaction.frame,candidateRoot);
      assert.deepEqual(item.nativeAfterFailure,transactionNativeBefore,"Cancellation must restore native content and saved-state flags");
      item.hostAfterFailure = await page.evaluate(() => window.__ONLYOFFICE_SAVE_E2E__.getStatus());
      assert.deepEqual(item.hostAfterFailure,transactionHostBefore,"Cancellation must restore host saved state without persisting a file");
      if (preexistingRedo) {
        await transaction.frame.evaluate(() => window.Asc.editor.Redo());
        await visibleSlides(page, transaction.frame, "existing-redo-replayed", transactionBefore.common.slides.length);
        const replayed = await readCandidateNativeEvidence(transaction.frame,candidateRoot);
        assert.equal(replayed.contentSha256,redoNativeExpected.contentSha256,"Retained Redo must reproduce its complete native document");
        await transaction.frame.evaluate(() => window.Asc.editor.Undo());
        await visibleSlides(page, transaction.frame, "existing-redo-reverted", transactionBefore.common.slides.length);
        assert.deepEqual(await readCandidateNativeEvidence(transaction.frame,candidateRoot),transactionNativeBefore,"Undo of retained Redo must restore the pre-transaction native checkpoint");
        item.preexistingRedo.replayedAndUndone = true;
      }
      item.rollbackVerified = true;
    } catch (rollbackError) {
      item.rollbackVerified = false;
      item.rollbackError = rollbackError.message;
    }
    transaction = null;
  }
  if (failAfterApply && item.error === "injected_failure_after_native_mutation" && item.rollbackVerified) {
    item.status = "typed-failed-mutation-rollback-verified";
    item.expectedFailure = true;
  }
  await page
    .screenshot({ path: path.join(outputRoot, "failure.png") })
    .catch(() => {});
} finally {
  await page.evaluate(async () => {
    await window.__comparisonWorkbookEditor?.destroy();
    window.__comparisonWorkbookContainer?.remove();
  }).catch(() => {});
  await page
    .evaluate(() => window.__ONLYOFFICE_SAVE_E2E__?.destroy())
    .catch(() => {});
  await context.close();
  await browser.close();
  await new Promise((r) => diagnosticServer.close(r));
  report.finalIntegration = readRepositoryEvidence(path.resolve(import.meta.dirname, "../.."));
  report.finalCandidate = readRepositoryEvidence(candidateRoot);
  report.sourceStable = repositoryIdentityStable(integration, report.finalIntegration) && repositoryIdentityStable(candidate, report.finalCandidate);
  report.finalCandidateCodeIdentity = await readOnlyOfficeCodeEvidence(candidateRoot);
  report.finalCandidateDistribution = await readOfficeDistributionEvidence(path.join(candidateRoot, "dist"));
  report.candidateDistributionStable = report.finalCandidateDistribution.valid && candidateDistribution.distributionSha256 === report.finalCandidateDistribution.distributionSha256;
  report.candidateCodeStable = candidateCodeIdentity.sha256 === report.finalCandidateCodeIdentity.sha256;
  if (!report.sourceStable || !report.candidateCodeStable || !report.candidateDistributionStable) {
    process.exitCode = 1;
    report.error = !report.sourceStable ? "candidate_or_integration_source_changed_during_trial" : !report.candidateDistributionStable ? "candidate_distribution_changed_or_unverified_during_trial" : "candidate_generated_code_changed_during_trial";
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(outputRoot, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    typedCase,
    status: item.status,
    error: item.error,
    applyDifferences: item.applyDifferences,
    undoDifferences: item.undoDifferences,
    redoDifferences: item.redoDifferences,
    reopenDifferences: item.reopenDifferences,
  }),
);
if (item.status !== (failAfterApply ? "typed-failed-mutation-rollback-verified" : "typed-apply-save-history-reopen-verified"))
  process.exitCode = 1;
