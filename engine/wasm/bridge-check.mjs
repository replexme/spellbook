// End-to-end check of the AI bridge contract against the real WASM engine:
//   node engine/wasm/bridge-check.mjs <glue.js> <in.pptx> <out.pptx> <font>...
// Uses apps/ai-bridge's SerializedEngine (the class the AI run uses) with the
// engine's invoke(), opens a real deck, observes, applies one text edit,
// checks stale-version refusal and receipt lookup, and saves the file.
import fs from "node:fs";
import { createRequire } from "node:module";
import { SerializedEngine, BridgeError } from "../../apps/ai-bridge/dist/engine.js";

const [glue, input, output, ...fonts] = process.argv.slice(2);
const { Engine } = createRequire(import.meta.url)(glue);
const wasm = new Engine();
for (const f of fonts) wasm.add_font(fs.readFileSync(f));
const host = (operation, parameters) => JSON.parse(wasm.invoke(JSON.stringify({ abiVersion: 1, operation, parameters })));

const opened = host("open", { documentId: "doc", bytesBase64: fs.readFileSync(input).toString("base64") });
if (opened.error) throw new Error(opened.error.code);
const engine = new SerializedEngine(async (s) => wasm.invoke(s), (c) => {
  if (c.operation !== "replace_text" || !Array.isArray(c.parameters.paragraphs)) throw new BridgeError("invalid_command");
});

const t0 = performance.now();
const snapshot = await engine.observe("doc");
const observeMs = performance.now() - t0;
const textShape = snapshot.bounds.find((b) => b.lines.some((l) => l.text.trim()));
if (!textShape) throw new Error("no text shape on the focus slide");
const before = textShape.lines.map((l) => l.text).join("");
const t1 = performance.now();
const receipt = await engine.apply({
  documentId: "doc", expectedVersion: snapshot.version, transactionId: "tx-1",
  executionGeneration: "g1", permissionRevision: "p1",
  commands: [{ operation: "replace_text", targetId: textShape.targetId, parameters: { paragraphs: ["AI 수정 검증: 화면과 파일이 같은가"] } }],
});
const applyMs = performance.now() - t1;
let stale = null;
try {
  await engine.apply({ documentId: "doc", expectedVersion: snapshot.version, transactionId: "tx-2", executionGeneration: "g1", permissionRevision: "p1",
    commands: [{ operation: "replace_text", targetId: textShape.targetId, parameters: { paragraphs: ["늦은 쓰기"] } }] });
} catch (e) { stale = e.code; }
const again = await engine.receipt("doc", "tx-1");
const after = await engine.observe("doc");
const saved = host("save", { documentId: "doc" }).result;
fs.writeFileSync(output, Buffer.from(saved.bytesBase64, "base64"));
console.log(JSON.stringify({
  target: textShape.targetId,
  before,
  versionBefore: snapshot.version,
  receiptVersion: receipt.version,
  receiptLines: receipt.scene[0]?.lines.map((l) => l.text),
  receiptFonts: receipt.scene[0]?.fonts,
  staleWriteRefused: stale,
  receiptLookupMatches: JSON.stringify(again) === JSON.stringify(receipt),
  observedAfterVersion: after.version,
  screenshotVersionMatches: after.screenshot.version === after.version,
  fileHashChanged: after.fileHash !== snapshot.fileHash,
  savedHash: saved.fileHash,
  observeMs: Math.round(observeMs),
  applyMs: Math.round(applyMs),
}, null, 1));
