#!/usr/bin/env node
// Drives the built document view in headless Chrome the way the web app's
// NativeWorkspace does: connect, open a deck, observe, apply AI edits,
// undo the turn and save. Prints one JSON report. An `.idml` file runs the
// InDesign steps (the operations IDML documents support) instead.
//   node apps/office/check.mjs <playwright-core dir> <built site> <deck.pptx> <out-dir> [--coverage]
//   node apps/office/check.mjs <playwright-core dir> - <deck.pptx> <out-dir> --remote <view origin> --host <web origin>
// With --remote the deployed view is checked: the host page is answered
// inside the test browser only (requests to the web origin never leave it).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const [pwDir, site, deck, out] = process.argv.slice(2);
const option = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const remote = option("--remote"), hostOrigin = option("--host");
const contractFile = new URL("./src/native-edit-capabilities.json", import.meta.url);
const { chromium } = createRequire(import.meta.url)(pwDir);
fs.mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json" };

const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="f" style="border:0;width:1280px;height:900px"></iframe><script type="module">
const frame = document.getElementById("f");
const events = []; let port; const waiters = new Map(); let seq = 0; const pending = new Map();
window.addEventListener("message", (e) => {
  if (e.data?.type !== "spellbook.document-view-ready") return;
  const channel = new MessageChannel(); port = channel.port1;
  port.onmessage = ({ data }) => {
    if (data.id && pending.has(data.id)) { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.value); return; }
    events.push(data);
    for (const [type, w] of waiters) if (data.type === type) { waiters.delete(type); w(data); }
  };
  port.start();
  frame.contentWindow.postMessage({ type: "spellbook.document-view-connect", protocolVersion: 2 }, new URL(frame.src).origin, [channel.port2]);
});
const next = (type) => { const hit = events.find((e) => e.type === type && !e.seen); if (hit) { hit.seen = true; return Promise.resolve(hit); } return new Promise((r) => waiters.set(type, (d) => { d.seen = true; r(d); })); };
window.check = {
  events, next,
  request: (request, transfer = []) => new Promise((resolve, reject) => { const id = crypto.randomUUID(); pending.set(id, { resolve, reject }); port.postMessage({ id, request }, transfer); }),
  send: (message, transfer = []) => port.postMessage(message, transfer),
};
frame.src = __VIEW__ + "/workspace?hostOrigin=" + encodeURIComponent(location.origin);
</script>`;

/** The InDesign steps: open, observe, text and frame edits, refusals, undo of the turn, save. */
async function idmlSteps() {
  const { request, send, next } = window.check;
  const steps = [];
  const step = async (name, fn) => {
    const t = performance.now();
    try {
      const value = await fn();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - t), ...value });
    } catch (e) {
      steps.push({ name, ok: false, ms: Math.round(performance.now() - t), error: e.message });
    }
  };
  const contract = await (await fetch("native-edit-capabilities.json")).json();
  const blank = Object.fromEntries(Object.keys(contract.toolInputSchema.properties).map((k) => [k, null]));
  const cmd = (c) => ({ ...blank, ...c });
  const permission = { mode: "document", slideIndexes: [], elementIds: [] };
  const all = () => obs.slides.flatMap((s) => s.elements);
  let obs;
  let edits = 0;
  const edit = async (commands) => {
    const before = obs.revision;
    const r = await request({ operation: commands.length > 1 ? "edit_batch" : "edit", expectedRevision: obs.revision, expectedSlides: JSON.stringify(obs.slides), permission, ...(commands.length > 1 ? { commands: commands.map(cmd), dryRun: false } : { command: cmd(commands[0]) }) });
    edits++;
    obs = r;
    return { changed: r.changedSlideIndexes, images: r.images.length, revisionChanged: r.revision !== before, introduced: r.layoutAudit?.introducedIssueCount };
  };
  await step("open", async () => {
    const bytes = await (await fetch("deck.pptx")).arrayBuffer();
    send({ type: "open", requestId: "open-1", documentId: "d1", fileName: "document.idml", revision: '"v1:abc"', maxBytes: 100000000, bytes }, [bytes]);
    const done = await Promise.race([next("open-complete"), next("error").then((e) => Promise.reject(Error(e.error)))]);
    return { pages: done.slideCount };
  });
  await step("observe", async () => {
    obs = await request({ operation: "observe", detailSlideIndex: null });
    const valid = obs.documentFormat === "idml" && obs.unit === "1/100mm" && obs.images.every((i) => atob(i.pngBase64.slice(0, 12)).startsWith("\x89PNG"));
    return { valid, elements: all().length, texts: all().filter((e) => e.text).length, textDetails: obs.textDetails?.elements.length, supported: obs.engine.supportedOperations, issues: obs.layoutAudit.issues.map((i) => i.code) };
  });
  let turnStart;
  await step("replace_text_range", async () => {
    turnStart = obs.revision;
    const d = obs.textDetails.elements.find((e) => e.paragraphs.some((p) => p.text.length >= 2));
    const p = d.paragraphs.find((x) => x.text.length >= 2);
    const r = await edit([{ op: "replace_text_range", elementId: d.elementId, paragraphId: p.paragraphId, startOffset: p.startOffset, endOffset: p.startOffset + 2, expectedText: p.text.slice(0, 2), text: "★" }]);
    const after = obs.textDetails.elements.find((e) => e.elementId === d.elementId);
    return { ...r, before: p.text.slice(0, 10), after: after?.paragraphs[p.paragraphIndex].text.slice(0, 10) };
  });
  await step("replace_text", async () => {
    const t = all().find((e) => e.text && e.text.trim());
    const r = await edit([{ op: "replace_text", elementId: t.elementId, text: "AI가 고친 제목\n둘째 문단" }]);
    return { ...r, target: t.elementId, text: all().find((e) => e.elementId === t.elementId).text };
  });
  await step("move_resize", async () => {
    const t = all().find((e) => e.kind !== "group");
    const r = await edit([{ op: "move", elementId: t.elementId, x: t.x + 500, y: t.y + 300 }, { op: "resize", elementId: t.elementId, width: t.width, height: t.height + 1000 }]);
    const now = all().find((e) => e.elementId === t.elementId);
    return { ...r, dx: now.x - t.x, dy: now.y - t.y, dh: now.height - t.height };
  });
  await step("delete_element", async () => {
    const t = [...all()].reverse().find((e) => !e.text && !e.continuedFrom);
    if (!t) return { skipped: "no shape" };
    const n = all().length;
    const r = await edit([{ op: "delete_element", elementId: t.elementId }]);
    return { ...r, before: n, after: all().length };
  });
  await step("create_on_new_page", async () => {
    const pages = obs.slides.length;
    await edit([{ op: "insert_slide", slideIndex: 0, masterIndex: null, layout: null, name: null }]);
    const added = obs.slides.length;
    await edit([
      { op: "add_text_box", slideIndex: 1, x: 2000, y: 2000, width: 15000, height: 3000, text: "새 쪽 제목\n둘째 문단", name: "AI 제목" },
      { op: "add_shape", slideIndex: 1, x: 2000, y: 6000, width: 5000, height: 5000, geometry: "ellipse", color: 0x2b8a3e, name: null },
    ]);
    const title = obs.slides[1].elements.find((e) => e.objectName === "AI 제목");
    const shape = obs.slides[1].elements.find((e) => e.kind === "shape");
    await edit([
      { op: "font_size", elementId: title.elementId, size: 28 },
      { op: "paragraph_alignment", elementId: title.elementId, alignment: "center" },
      { op: "fill_color", elementId: shape.elementId, color: 0xd9480f },
    ]);
    // A 2 x 2 PNG, transferred like the web app sends generated images.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
    await request({ operation: "register_asset", assetId: "img-1", assetBytes: png.buffer, mediaType: "image/png" }, [png.buffer]);
    const r = await edit([{ op: "insert_image", slideIndex: 1, assetId: "img-1", x: 2000, y: 12000, width: 6000, height: 6000, name: null }]);
    const kinds = obs.slides[1].elements.map((e) => e.kind);
    await edit([{ op: "delete_slide", slideIndex: 1 }]);
    return { pages, added, kinds, text: title.text, images: r.images, after: obs.slides.length };
  });
  await step("refusal", async () => {
    try {
      await edit([{ op: "set_chart_type", elementId: all()[0].elementId, chartType: "bar" }]);
    } catch (e) {
      // A refusal must say nothing changed, or the web app will not save later edits.
      if (!e.message.startsWith("product_mutation_rejected:")) throw Error(`refusal without the rejected prefix: ${e.message}`);
      return { refused: true, message: e.message.slice(0, 120) };
    }
    throw Error("the unsupported edit was not refused");
  });
  await step("stale_write_refused", async () => {
    try {
      await request({ operation: "edit", expectedRevision: "old", expectedSlides: JSON.stringify(obs.slides), permission, command: cmd({ op: "move", elementId: all()[0].elementId, x: 0, y: 0 }) });
      throw Error("a stale write was accepted");
    } catch (e) {
      if (e.message !== "product_mutation_rejected:stale_service_observation") throw Error(`unexpected stale-write error: ${e.message}`);
      return { refused: true };
    }
  });
  await step("undo_turn", async () => {
    const r = await request({ operation: "undo_turn", steps: edits, expectedRevision: obs.revision, targetRevision: turnStart });
    obs = await request({ operation: "observe", detailSlideIndex: null });
    return { undone: r.undone, restored: obs.revision === turnStart };
  });
  await step("redo_after_undo", async () => {
    send({ type: "redo" });
    await new Promise((r) => setTimeout(r, 300));
    obs = await request({ operation: "observe", detailSlideIndex: 0 });
    return { revisionChanged: obs.revision !== turnStart };
  });
  await step("save", async () => {
    send({ type: "save-now", onlyIfModified: false });
    const save = await next("save");
    window.savedBytes = Array.from(new Uint8Array(save.bytes));
    send({ type: "save-result", requestId: save.requestId, ok: true, revision: '"v2:def"' });
    const resp = await next("save-response");
    return { bytes: save.bytes.byteLength, success: resp.success };
  });
  return steps;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/host.html") return res.writeHead(200, { "content-type": "text/html" }).end(HOST.replace("__VIEW__", '""'));
  if (url === "/deck.pptx") return res.writeHead(200).end(fs.readFileSync(deck));
  let file = path.join(site, url === "/workspace" ? "workspace.html" : url);
  if (!file.startsWith(path.resolve(site)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
if (!remote) await new Promise((r) => server.listen(4183, "127.0.0.1", r));
const base = remote ? `${hostOrigin}/__office-check` : "http://127.0.0.1:4183";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  if (remote)
    await page.route(`${base}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();
      if (name === "host.html") return route.fulfill({ contentType: "text/html", body: HOST.replace("__VIEW__", JSON.stringify(remote)) });
      if (name === "deck.pptx") return route.fulfill({ body: fs.readFileSync(deck) });
      if (name === "native-edit-capabilities.json") return route.fulfill({ contentType: "application/json", body: fs.readFileSync(contractFile) });
      return route.fulfill({ status: 404, body: "" });
    });
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text()));
  page.on("response", (r) => r.status() >= 400 && consoleLines.push(`http ${r.status()}: ${r.url()}`));
  page.on("pageerror", (e) => consoleLines.push("pageerror: " + e.message));
  await page.goto(`${base}/host.html`);
  await page.waitForFunction(() => window.check?.events.some((e) => e.type === "ready"), null, { timeout: 60000 });
  if (process.argv.includes("--coverage")) {
    await page.addScriptTag({ content: fs.readFileSync(new URL("./coverage-page.js", import.meta.url), "utf8") });
    report.coverage = await page.evaluate(async () => {
      const { send, next } = window.check;
      const bytes = await (await fetch("deck.pptx")).arrayBuffer();
      send({ type: "open", requestId: "open-1", documentId: "d1", fileName: "deck.pptx", revision: '"v1:abc"', maxBytes: 100000000, bytes }, [bytes]);
      await next("open-complete");
      const results = await window.runCoverage();
      send({ type: "save-now", onlyIfModified: false });
      const save = await next("save");
      window.savedBytes = Array.from(new Uint8Array(save.bytes));
      send({ type: "save-result", requestId: save.requestId, ok: true, revision: '"v2:def"' });
      await next("save-response");
      return results;
    });
  } else if (deck.toLowerCase().endsWith(".idml")) report.steps = await page.evaluate(idmlSteps);
  else
  report.steps = await page.evaluate(async () => {
    const { request, send, next } = window.check;
    const steps = [];
    const step = async (name, fn) => {
      const t = performance.now();
      try {
        const value = await fn();
        steps.push({ name, ok: true, ms: Math.round(performance.now() - t), ...value });
      } catch (e) {
        steps.push({ name, ok: false, ms: Math.round(performance.now() - t), error: e.message });
      }
    };
    const contract = await (await fetch("native-edit-capabilities.json")).json();
    const blank = Object.fromEntries(Object.keys(contract.toolInputSchema.properties).map((k) => [k, null]));
    const cmd = (c) => ({ ...blank, ...c });
    const permission = { mode: "document", slideIndexes: [], elementIds: [] };
    let obs;
    let edits = 0;
    const edit = async (commands) => {
      const r = await request({ operation: commands.length > 1 ? "edit_batch" : "edit", expectedRevision: obs.revision, expectedSlides: JSON.stringify(obs.slides), permission, ...(commands.length > 1 ? { commands: commands.map(cmd), dryRun: false } : { command: cmd(commands[0]) }) });
      const before = obs.revision;
      edits++;
      obs = r;
      return { changed: r.changedSlideIndexes, images: r.images.length, revisionChanged: r.revision !== before, introduced: r.layoutAudit?.introducedIssueCount };
    };
    await step("open", async () => {
      const bytes = await (await fetch("deck.pptx")).arrayBuffer();
      send({ type: "open", requestId: "open-1", documentId: "d1", fileName: "deck.pptx", revision: '"v1:abc"', maxBytes: 100000000, bytes }, [bytes]);
      const done = await next("open-complete");
      return { slides: done.slideCount };
    });
    await step("observe", async () => {
      obs = await request({ operation: "observe", detailSlideIndex: null });
      const valid = obs.unit === "1/100mm" && Array.isArray(obs.slides) && Array.isArray(obs.selectedElementIds) && Number.isInteger(obs.activeSlide) && Array.isArray(obs.changedSlideIndexes) && typeof obs.visualEvidenceComplete === "boolean" && obs.images.every((i) => typeof i.pngBase64 === "string" && atob(i.pngBase64.slice(0, 12)).startsWith("\x89PNG"));
      const issues = {};
      for (const i of obs.layoutAudit.issues) issues[i.code] = (issues[i.code] ?? 0) + 1;
      return { valid, revision: obs.revision.slice(0, 12), elements: obs.slides.reduce((n, s) => n + s.elements.length, 0), textDetails: obs.textDetails?.elements.length, supported: obs.engine.supportedOperations.length, issues };
    });
    const firstText = () => obs.slides.flatMap((s) => s.elements).find((e) => e.text && e.text.trim() && !e.elements);
    const startRevision = () => obs.revision;
    let turnStart;
    await step("replace_text", async () => {
      turnStart = startRevision();
      const t = firstText();
      const r = await edit([{ op: "replace_text", elementId: t.elementId, text: "AI가 고친 제목\n둘째 줄" }]);
      const now = obs.slides.flatMap((s) => s.elements).find((e) => e.elementId === t.elementId);
      return { ...r, target: t.elementId, text: now.text };
    });
    await step("format_batch", async () => {
      const t = firstText();
      return edit([{ op: "font_size", elementId: t.elementId, size: 28 }, { op: "bold", elementId: t.elementId, bold: true }, { op: "font_color", elementId: t.elementId, color: 0xc00000 }]);
    });
    await step("move_resize", async () => {
      const t = firstText();
      const r = await edit([{ op: "move", elementId: t.elementId, x: t.x + 500, y: t.y + 300 }, { op: "resize", elementId: t.elementId, width: t.width, height: t.height + 1000 }]);
      const now = obs.slides.flatMap((s) => s.elements).find((e) => e.elementId === t.elementId);
      return { ...r, dx: now.x - t.x, dy: now.y - t.y, dh: now.height - t.height };
    });
    await step("text_overflow_reported", async () => {
      // Text squeezed into a box too short for it: the engine says how far it runs past.
      const over = new Set(obs.layoutAudit.issues.filter((i) => i.code === "text_overflow").map((i) => i.elementId));
      const t = obs.slides.flatMap((s) => s.elements).find((e) => e.text && e.text.trim() && !e.elements && !over.has(e.elementId));
      await edit([{ op: "resize", elementId: t.elementId, width: t.width, height: 200 }]);
      const issue = obs.layoutAudit.introducedIssues?.find((i) => i.code === "text_overflow" && i.elementId === t.elementId);
      if (!issue) throw Error(`no text_overflow for ${t.elementId}: ${JSON.stringify(obs.layoutAudit.introducedIssues)}`);
      return { overflowPt: issue.overflowPt, severity: issue.severity ?? "problem" };
    });
    await step("add_text_box_named", async () => {
      const r = await edit([{ op: "add_text_box", slideIndex: 0, x: 2000, y: 2000, width: 8000, height: 1500, text: "새 상자", name: "AI 상자" }]);
      const added = obs.slides[0].elements.find((e) => e.objectName === "AI 상자");
      return { ...r, added: added?.elementId ?? null, text: added?.text };
    });
    await step("replace_text_range", async () => {
      const d = obs.textDetails.elements.find((e) => e.paragraphs.some((p) => p.text.length >= 2));
      const p = d.paragraphs.find((x) => x.text.length >= 2);
      const r = await edit([{ op: "replace_text_range", elementId: d.elementId, paragraphId: p.paragraphId, startOffset: p.startOffset, endOffset: p.startOffset + 2, expectedText: p.text.slice(0, 2), text: "★" }]);
      const after = obs.textDetails.elements.find((e) => e.elementId === d.elementId);
      return { ...r, before: p.text.slice(0, 10), after: after?.paragraphs[p.paragraphIndex].text.slice(0, 10) };
    });
    await step("slides", async () => {
      const n = obs.slides.length;
      await edit([{ op: "duplicate_slide", slideIndex: 0 }]);
      const dup = obs.slides.length;
      await edit([{ op: "insert_slide", slideIndex: 0, masterIndex: obs.slides[0].masterIndex ?? 0, layout: obs.slides[0].layout ?? 0, name: null }]);
      const ins = obs.slides.length;
      await edit([{ op: "delete_slide", slideIndex: 1 }]);
      await edit([{ op: "move_slide", slideIndex: 1, targetSlideIndex: 0 }]);
      return { before: n, afterDuplicate: dup, afterInsert: ins, after: obs.slides.length };
    });
    await step("table", async () => {
      const t = obs.slides.flatMap((s) => s.elements).find((e) => e.table);
      if (!t) return { skipped: "no table" };
      const r = await edit([{ op: "set_table_cell", elementId: t.elementId, row: 0, column: 0, text: "칸 수정" }]);
      const now = obs.slides.flatMap((s) => s.elements).find((e) => e.elementId === t.elementId);
      return { ...r, cell: now.table.cells[0][0] };
    });
    await step("chart", async () => {
      const t = obs.slides.flatMap((s) => s.elements).find((e) => e.chart);
      if (!t) return { skipped: "no chart" };
      const data = t.chart.data.map((row) => row.map((v) => (v ?? 0) + 1));
      const r = await edit([{ op: "set_chart_data", elementId: t.elementId, data, rowDescriptions: null, columnDescriptions: null }]);
      const now = obs.slides.flatMap((s) => s.elements).find((e) => e.elementId === t.elementId);
      return { ...r, first: [t.chart.data[0][0], now.chart.data[0][0]] };
    });
    await step("crop_to_circle", async () => {
      // A photo cropped to an ellipse (PowerPoint's "Crop to Shape"); a circle needs a square box.
      const t = obs.slides.flatMap((s) => s.elements).find((e) => e.kind === "image");
      if (!t) return { skipped: "no picture" };
      const side = Math.min(t.width, t.height);
      const r = await edit([
        { op: "resize", elementId: t.elementId, width: side, height: side },
        { op: "crop_image", elementId: t.elementId, left: null, top: null, right: null, bottom: null, geometry: "ellipse" },
      ]);
      const now = obs.slides.flatMap((s) => s.elements).find((e) => e.elementId === t.elementId);
      return { ...r, size: [now.width, now.height] };
    });
    await step("refusal", async () => {
      const t = firstText();
      try {
        await edit([{ op: "set_slide_metadata", slideIndex: 0, slideMetadata: { footerVisible: true } }]);
      } catch (e) {
        // A refusal must say nothing changed, or the web app will not save later edits.
        if (!e.message.startsWith("product_mutation_rejected:")) throw Error(`refusal without the rejected prefix: ${e.message}`);
        return { refused: true, message: e.message.slice(0, 120), revisionKept: obs.revision !== undefined, target: t.elementId };
      }
      throw Error("the unsupported edit was not refused");
    });
    await step("stale_write_refused", async () => {
      try {
        await request({ operation: "edit", expectedRevision: "old", expectedSlides: JSON.stringify(obs.slides), permission, command: cmd({ op: "bold", elementId: firstText().elementId, bold: false }) });
        throw Error("a stale write was accepted");
      } catch (e) {
        if (e.message !== "product_mutation_rejected:stale_service_observation") throw Error(`unexpected stale-write error: ${e.message}`);
      return { refused: true };
      }
    });
    await step("undo_turn", async () => {
      const steps = edits;
      const r = await request({ operation: "undo_turn", steps, expectedRevision: obs.revision, targetRevision: turnStart });
      obs = await request({ operation: "observe", detailSlideIndex: null });
      return { undone: r.undone, restored: obs.revision === turnStart };
    });
    await step("redo_after_undo", async () => {
      send({ type: "redo" });
      await new Promise((r) => setTimeout(r, 300));
      obs = await request({ operation: "observe", detailSlideIndex: 0 });
      return { revisionChanged: obs.revision !== turnStart };
    });
    await step("save", async () => {
      send({ type: "save-now", onlyIfModified: false });
      const save = await next("save");
      window.savedBytes = Array.from(new Uint8Array(save.bytes));
      send({ type: "save-result", requestId: save.requestId, ok: true, revision: '"v2:def"' });
      const resp = await next("save-response");
      return { bytes: save.bytes.byteLength, success: resp.success };
    });
    return steps;
  });
  const saved = await page.evaluate(() => window.savedBytes ?? null);
  if (saved) fs.writeFileSync(path.join(out, deck.toLowerCase().endsWith(".idml") ? "saved.idml" : "saved.pptx"), Buffer.from(saved));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "view.png") });
  report.console = consoleLines.filter((l) => !l.startsWith("log:")).slice(0, 20);
} finally {
  await browser.close();
  if (!remote) server.close();
}
console.log(JSON.stringify(report, null, 1));
