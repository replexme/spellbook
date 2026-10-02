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
import { readRepositoryIdentity } from "./repository-identity.mjs";

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
const report = {
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
async function snapshot(frame) {
  return frame.evaluate(() => {
    const m = window.Asc.editor.WordControl.m_oLogicDocument;
    const shape = (x) => ({
      text: x.isTable?.()
        ? null
        : (x.getDocContent?.()?.GetText?.({ Numbering: false }) ??
          x.getContentText?.() ??
          null),
      x: x.x,
      y: x.y,
      w: x.extX,
      h: x.extY,
      type: x.isTable?.()
        ? "table"
        : x.isChart?.()
          ? "chart"
          : x.isImage?.()
            ? "image"
            : x.spTree
              ? "group"
              : "shape",
      children: x.spTree?.map(shape) ?? [],
      hidden: x.getCNvProps?.()?.isHidden ?? null,
      ownName: x.getOwnName?.() ?? null,
      crop: x.blipFill?.srcRect
        ? {
            l: x.blipFill.srcRect.l,
            t: x.blipFill.srcRect.t,
            r: x.blipFill.srcRect.r,
            b: x.blipFill.srcRect.b,
          }
        : null,
      diagram: x.getDataModelFromData
        ? {
            points: x
              .getDataModelFromData()
              .ptLst.list.filter((p) => [0, 1, 2].includes(p.type))
              .map((p) => ({
                id: p.modelId,
                type: p.type,
                text: p.t?.content?.GetText?.({ Numbering: false }) ?? null,
              })),
            connections: x
              .getDataModelFromData()
              .cxnLst.list.filter((c) => c.type === 0)
              .map((c) => ({
                src: c.srcId,
                dest: c.destId,
                type: c.type,
                srcOrd: c.srcOrd,
                destOrd: c.destOrd,
              })),
          }
        : null,
    });
    return {
      slides: m.Slides.map((s) => ({ shapes: s.cSld.spTree.map(shape) })),
    };
  });
}
async function extendedFeatures(frame) {
  return frame.evaluate(() => {
    const unavailable = [];
    const read = (o, k, at, ...args) => {
      if (typeof o?.[k] !== "function") {
        unavailable.push(at + "." + k + ":missing");
        return null;
      }
      try {
        return o[k](...args);
      } catch (e) {
        unavailable.push(at + "." + k + ":" + String(e.message).slice(0, 100));
        return null;
      }
    };
    const p = window.AscBuilder?.Slide?.Api?.GetPresentation?.();
    if (!p) return { unavailable: ["presentation-api"], state: null };
    const drawing = (d, at) => {
      if (!d) {
        unavailable.push(at + ":no-public-wrapper");
        return { type: "unavailable-public-wrapper" };
      }
      const type = read(d, "GetClassType", at); // GetName synthesizes transient type/ID names when no name was authored.
      const state = { type, name: d.Drawing?.getOwnName?.() ?? null };
      for (const k of ["GetPosX", "GetPosY", "GetWidth", "GetHeight"]) {
        const v = read(d, k, at);
        state[k] = typeof v === "number" ? v / 36000 : v;
      }
      for (const k of ["GetRotation", "GetFlipH", "GetFlipV"])
        state[k] = read(d, k, at);
      // Public GetContent creates a missing text body; use the existing content only.
      const content = type === "table" ? null : d.Drawing?.getDocContent?.();
      state.text = content?.GetText?.({ Numbering: false }) ?? null;
      if (d.Table?.Content)
        state.tableCells = d.Table.Content.map((row) =>
          row.Content.map(
            (cell) => cell.Content?.GetText?.({ Numbering: false }) ?? null,
          ),
        );
      if (type === "chart") {
        state.chartType = read(d, "GetChartType", at);
        const series = read(d, "GetAllSeries", at);
        if (Array.isArray(series))
          state.series = series.map((s, i) => ({
            chartType: read(s, "GetChartType", at + ".series" + i),
          }));
        // Version-pinned SDK readback supplements the narrower public series getters.
        const cache = (c) =>
          c
            ? {
                formula: c.f ?? null,
                points: (c.numCache?.pts ?? c.strCache?.pts ?? c.pts ?? []).map(
                  (p) => ({
                    idx: p.idx,
                    val:
                      typeof p.val === "string" &&
                      /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(
                        p.val,
                      )
                        ? Number(p.val)
                        : p.val,
                  }),
                ),
              }
            : null;
        state.cachedSeries =
          d.Chart?.getAllSeries?.()?.map((s) => ({
            idx: s.idx,
            val: cache(s.val?.numRef ?? s.val?.numLit),
            cat: cache(
              s.cat?.strRef ?? s.cat?.numRef ?? s.cat?.strLit ?? s.cat?.numLit,
            ),
            xVal: cache(s.xVal?.numRef ?? s.xVal?.numLit),
            yVal: cache(s.yVal?.numRef ?? s.yVal?.numLit),
          })) ?? null;
      }
      const hyperlink = read(d, "GetHyperlink", at);
      if (hyperlink) {
        state.hyperlink = {
          link: hyperlink.ParaHyperlink?.GetValue?.() ?? null,
          tooltip: read(hyperlink, "GetScreenTipText", at + ".hyperlink"),
        };
      }
      if (d.Drawing?.spTree)
        state.groupChildren = d.Drawing.spTree.map((x, i) =>
          drawing(window.AscBuilder.GetApiDrawing(x), at + ".child" + i),
        );
      return state;
    };
    const slides = read(p, "GetAllSlides", "presentation");
    return {
      unavailable,
      state: {
        width: read(p, "GetWidth", "presentation") / 36000,
        height: read(p, "GetHeight", "presentation") / 36000,
        slides: slides?.map((s, i) => {
          const at = "slide" + i;
          const state = { visible: read(s, "GetVisible", at) };
          // Notes getters can create a missing body; inspect existing notes without writes.
          const noteBody = s.Slide?.notes?.getBodyShape?.();
          state.notes =
            noteBody?.getDocContent?.()?.GetText?.({ Numbering: false }) ??
            null;
          const transition = read(s, "GetSlideShowTransition", at);
          if (transition) {
            state.transition = {};
            for (const k of [
              "GetEntryEffect",
              "GetDuration",
              "GetSpeed",
              "GetAdvanceOnClick",
              "GetAdvanceOnTime",
              "GetAdvanceTime",
            ])
              state.transition[k] = read(transition, k, at + ".transition");
          }
          // GetTimeLine creates timing when absent; avoid mutating during observation.
          const timeline = s.Slide?.timing ? read(s, "GetTimeLine", at) : null;
          if (timeline) {
            const effects = read(timeline, "GetAllEffects", at + ".timeline");
            if (Array.isArray(effects))
              state.effects = effects.map((e, j) => {
                const v = {};
                for (const k of [
                  "GetEffectType",
                  "GetDuration",
                  "GetDelay",
                  "GetRepeatCount",
                  "GetTriggerType",
                ])
                  v[k] = read(e, k, at + ".effect" + j);
                return v;
              });
          }
          const objects = read(s, "GetAllDrawings", at);
          state.drawings = objects?.map((d, j) =>
            drawing(d, at + ".drawing" + j),
          );
          return state;
        }),
      },
    };
  });
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
    };
  });
}
async function typedProjection(frame) {
  const common = await snapshot(frame),
    extended = await extendedFeatures(frame);
  const narrow = await frame.evaluate(() => {
    const api = window.AscBuilder.Slide.Api,
      p = api.GetPresentation(),
      s = p.GetSlideByIndex(0);
    const drawings = s.GetAllDrawings();
    const color = (f) => {
      const c = f?.fill?.color?.RGBA;
      return c ? { R: c.R, G: c.G, B: c.B, A: c.A } : null;
    };
    return {
      layout: s.Slide.Layout
        ? { name: s.Slide.Layout.cSld?.name ?? null, type: s.Slide.Layout.type }
        : null,
      background: color(s.Slide.cSld.Bg?.bgPr?.Fill),
      table: drawings
        .filter((d) => d.GetClassType() === "table")
        .map((d) => ({
          rows: d.Table.Content.length,
          cells: d.Table.Content.map((r) =>
            r.Content.map((c) => ({
              text: c.Content.GetText({ Numbering: false }),
              fill: color(c.Pr.Shd?.Unifill),
            })),
          ),
        })),
      drawingStyle: drawings.map((d) => ({
        name: d.Drawing?.getOwnName?.() ?? null,
        fill: color(d.Drawing.spPr?.Fill),
      })),
      wordArt: drawings.map((d) => ({
        name: d.Drawing?.getOwnName?.() ?? null,
        preset: d.Drawing.txBody?.bodyPr?.prstTxWarp?.preset ?? null,
      })),
    };
  });
  return {
    common,
    extended: extended.state,
    narrow,
    unavailable: extended.unavailable,
  };
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
try {
  let { frame, ms } = await open(page);
  item.openMs = ms;
  await page.evaluate(() => (window.__comparisonCaptureBaseline = true));
  await save(page);
  await page.evaluate(() => {
    window.__comparisonCaptureBaseline = false;
    window.__comparisonIntent = { sourceOperations: null, sourceTargets: null };
  });
  const before = await typedProjection(frame);
  await page.screenshot({ path: path.join(outputRoot, "before.png") });
  item.stage = "apply";
  const setup = await frame.evaluate((kind) => {
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
      d.GetRow(0).GetCell(0).SetText("SBX_TYPED_9F3");
      result = true;
    } else if (kind === "chart-data") {
      const d = find("chart");
      if (!d) throw Error("chart target missing");
      const s = d.Chart.getAllSeries()[0];
      const pts = s.val?.numRef?.numCache?.pts ?? s.val?.numLit?.pts ?? [];
      if (!pts.length) throw Error("numeric chart cache missing");
      result = d.SetSeriaValues(
        pts.map((p, i) => (i === 0 ? Number(p.val) + 7 : Number(p.val))),
        s.idx,
      );
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
  }, typedCase);
  item.setup = setup;
  {
    await page.waitForTimeout(200);
    const edited = await typedProjection(frame);
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
    await page.screenshot({ path: path.join(outputRoot, "edited.png") });
    item.stage = "save";
    const saved = await save(page),
      bytes = Buffer.from(saved.base64, "base64");
    item.exportMs = saved.ms;
    item.savePipeline = await page.evaluate(() => ({
      preservations: window.__comparisonPreservations,
      repairs: window.__comparisonStructuralRepairs,
    }));
    item.savedSha256 = sha(bytes);
    Object.assign(item, packageDelta(bytes));
    await writeFile(path.join(outputRoot, "saved.pptx"), bytes, {
      mode: 0o600,
    });
    await frame.evaluate(() => window.Asc.editor.Undo());
    await page.waitForTimeout(150);
    item.undoDifferences = differences(before, await typedProjection(frame));
    await frame.evaluate(() => window.Asc.editor.Redo());
    await page.waitForTimeout(150);
    item.redoDifferences = differences(edited, await typedProjection(frame));
    item.stage = "reopen";
    served = bytes;
    ({ frame, ms } = await open(page));
    item.reopenMs = ms;
    const reopened = await typedProjection(frame);
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
  await page
    .screenshot({ path: path.join(outputRoot, "failure.png") })
    .catch(() => {});
} finally {
  await page
    .evaluate(() => window.__ONLYOFFICE_SAVE_E2E__?.destroy())
    .catch(() => {});
  await context.close();
  await browser.close();
  await new Promise((r) => diagnosticServer.close(r));
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
if (item.status !== "typed-apply-save-history-reopen-verified")
  process.exitCode = 1;
