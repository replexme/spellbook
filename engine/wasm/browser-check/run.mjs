// Browser check: the WASM engine in a Web Worker in headless Chrome.
//   node engine/wasm/browser-check/run.mjs <playwright-core dir> <web glue dir> <deck.pptx> <out-dir> <font>...
// glue: wasm-bindgen --target web output. Chrome runs headless with a
// temporary profile; nothing is shown on screen.
//   A. Worker: the given font files, every slide rendered; PNG and layout
//      written to <out-dir>/served for comparison with the native engine.
//   B. Local Font Access: the installed fonts Chrome hands over, and the
//      deck's text drawn with them.
//   C. IME: Korean composed in a text field reaches the engine as one text
//      edit per committed syllable group, through the AI bridge contract.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [pwDir, glue, deck, out, ...fontFiles] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)(pwDir);
const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (url === "/deck.pptx") file = deck;
  else if (url.startsWith("/fonts/")) file = fontFiles[Number(url.slice(7))];
  else if (url.startsWith("/glue/")) file = path.join(glue, path.basename(url));
  else file = path.join(here, path.basename(url === "/" ? "index.html" : url));
  if (!file || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const result = { chrome: browser.version() };
try {
  // The permission a user would give at Chrome's prompt.
  const context = await browser.newContext();
  await context.grantPermissions(["local-fonts"], { origin });
  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/index.html`);
    await page.evaluate(() => check.call({ type: "init" }));
    return page;
  };

  // A. Worker with the given font files.
  const a = await open();
  result.worker = await a.evaluate(async (n) => {
    const fonts = await Promise.all([...Array(n).keys()].map((i) => fetch(`/fonts/${i}`).then((r) => r.arrayBuffer())));
    await check.call({ type: "fonts", fonts }, fonts);
    const bytes = await (await fetch("/deck.pptx")).arrayBuffer();
    const opened = await check.call({ type: "open", bytes }, [bytes]);
    const slides = [];
    for (let s = 1; s <= opened.slides; s++) {
      const r = await check.call({ type: "render", slide: s, scale: 1.0 });
      let bin = "";
      for (let i = 0; i < r.png.length; i += 0x8000) bin += String.fromCharCode(...r.png.subarray(i, i + 0x8000));
      slides.push({ png: btoa(bin), layout: r.layout, ms: r.ms });
    }
    return { openMs: opened.ms, slides };
  }, fontFiles.length);
  fs.mkdirSync(path.join(out, "served"), { recursive: true });
  result.worker.slides.forEach((s, i) => {
    fs.writeFileSync(path.join(out, "served", `slide-${i + 1}.png`), Buffer.from(s.png, "base64"));
    fs.writeFileSync(path.join(out, "served", `slide-${i + 1}.json`), s.layout);
  });
  const ms = result.worker.slides.map((s) => s.ms).sort((x, y) => x - y);
  result.worker = { openMs: Math.round(result.worker.openMs), slides: ms.length, renderMsMedian: Math.round(ms[ms.length >> 1]), renderMsMax: Math.round(ms[ms.length - 1]) };

  // B. Local Font Access.
  const b = await open();
  result.localFonts = await b.evaluate(async () => {
    const wanted = ["Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "AppleGothic", "Arial", "Calibri", "Helvetica", "Noto Sans KR", "Pretendard", "Batang", "AppleMyungjo"];
    const t = performance.now();
    const lf = await check.localFonts(wanted);
    const readMs = performance.now() - t;
    await check.call({ type: "fonts", fonts: lf.buffers }, lf.buffers);
    const bytes = await (await fetch("/deck.pptx")).arrayBuffer();
    const opened = await check.call({ type: "open", bytes }, [bytes]);
    const fidelity = {};
    for (let s = 1; s <= opened.slides; s++) {
      for (const t of JSON.parse((await check.call({ type: "render", slide: s, scale: 0.25 })).layout).texts)
        for (const f of t.fonts) fidelity[`${f.requested} -> ${f.used} (${f.fidelity})`] = (fidelity[`${f.requested} -> ${f.used} (${f.fidelity})`] ?? 0) + 1;
    }
    const has = (n) => lf.families.some((f) => f.toLowerCase() === n.toLowerCase());
    return { installedFaces: lf.count, families: lf.families.length, malgunGothic: has("Malgun Gothic") || has("맑은 고딕"), appleSdGothicNeo: has("Apple SD Gothic Neo"), loaded: lf.picked, readMs: Math.round(readMs), fidelity };
  });

  // C. IME: compose 한, commit, compose 글, commit.
  const deckB64 = fs.readFileSync(deck).toString("base64");
  result.ime = await a.evaluate(async (b64) => {
    const inv = async (operation, parameters) => JSON.parse((await check.call({ type: "invoke", input: JSON.stringify({ abiVersion: 1, operation, parameters }) })).reply);
    await inv("open", { documentId: "doc", bytesBase64: b64 });
    const seen = await inv("observe", { documentId: "doc" });
    const box = seen.result.bounds.find((x) => x.lines.some((l) => l.text.trim()));
    check.setTarget({ targetId: box.targetId, version: Number(seen.result.version) });
    document.getElementById("edit").focus();
    return box.targetId;
  }, deckB64);
  const page = await context.newCDPSession(a);
  for (const [composing, commit] of [[["ㅎ", "하", "한"], "한"], [["ㄱ", "그", "글"], "글"]]) {
    for (const text of composing) await page.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await page.send("Input.insertText", { text: commit });
  }
  await a.waitForFunction(() => check.target()?.last?.result?.version === "2" || check.target()?.last?.error, null, { timeout: 10000 }).catch(() => {});
  const ime = await a.evaluate(() => ({ field: document.getElementById("edit").value, edits: check.edits, receipt: check.target().last }));
  result.ime = {
    target: result.ime,
    field: ime.field,
    editsSent: ime.edits,
    engineVersion: ime.receipt?.result?.version,
    engineLines: ime.receipt?.result?.scene?.[0]?.lines.map((l) => l.text),
    error: ime.receipt?.error,
  };
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(result, null, 1));
