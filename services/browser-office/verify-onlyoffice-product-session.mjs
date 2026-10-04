/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import Ajv from "ajv";
import { preserveOriginalPptxParts } from "./ooxml-worker-source.mjs";
import { createOnlyOfficeComparisonHost } from "./onlyoffice/comparison-host.mjs";
import {
  createOnlyOfficeProductEngine,
  observeOnlyOfficeProduct,
  verifyOnlyOfficeProductObservation,
} from "./onlyoffice/product-engine.mjs";
import {
  readRepositoryIdentity,
  repositoryIdentityStable,
} from "./repository-identity.mjs";
import { readOfficeDistributionEvidence } from "./distribution-check.mjs";
import { compareCanvasPixels } from "./canvas-pixel-evidence.mjs";
import { createProductSession } from "./product-session.mjs";
import { captureStableOnlyOfficeBaseline } from "./onlyoffice-baseline.mjs";
const flags = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const selectedSlideIndex = Number(flags("--slide-index", "0"));
assert(
  Number.isSafeInteger(selectedSlideIndex) && selectedSlideIndex >= 0,
  "Invalid target slide index",
);
const elementIndexFlag = flags("--element-index", null);
const selectedElementIndex =
  elementIndexFlag === null ? null : Number(elementIndexFlag);
assert(
  selectedElementIndex === null ||
    (Number.isSafeInteger(selectedElementIndex) && selectedElementIndex >= 0),
  "Invalid target element index",
);
const candidate = path.resolve(
  flags(
    "--candidate-root",
    "artifacts/office-audit-20261003/onlyoffice-cold-test-helper-candidate",
  ),
);
const output = path.resolve(
  flags("--output", "artifacts/onlyoffice-product-session"),
);
const integrationRoot = path.resolve(import.meta.dirname, "../..");
const sourceIdentities = {
  candidate: readRepositoryIdentity(candidate),
  integration: readRepositoryIdentity(integrationRoot),
};
assert(
  !sourceIdentities.candidate.dirty && !sourceIdentities.integration.dirty,
  "Commit sources before recording product evidence",
);
const distribution = await readOfficeDistributionEvidence(
  path.join(candidate, "dist"),
);
assert(distribution.valid, "Candidate distribution evidence invalid");
const input = await fs.readFile(
  path.resolve(
    flags("--input", "eval/public/fixtures/general-native-surface.pptx"),
  ),
);
await fs.mkdir(output, { recursive: false });
const capabilities = JSON.parse(
  await fs.readFile("contracts/native-edit-capabilities.json", "utf8"),
);
const validate = new Ajv({ strict: false }).compile(
  capabilities.toolInputSchema,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const documentTool = flags("--existing-document-tool", null);
const documentToolSha256 = flags("--document-tool-sha256", null);
assert(
  Boolean(documentTool) === Boolean(documentToolSha256),
  "Existing format inspection needs both binary path and SHA-256; no build fallback exists",
);
let documentToolEvidence = null,
  baselineFormat = null;
const formatInspections = new Map();
if (documentTool) {
  assert(/^[0-9a-f]{64}$/.test(documentToolSha256));
  const bytes = await fs.readFile(documentTool);
  assert.equal(
    hash(bytes),
    documentToolSha256,
    "Existing document tool hash mismatch",
  );
  documentToolEvidence = {
    file: documentTool,
    sha256: documentToolSha256,
    bytes: bytes.length,
    newBuilds: 0,
  };
  await fs.mkdir(path.join(output, "format-readback"));
}
async function inspectFormat(bytes) {
  if (!documentTool) return;
  const digest = hash(bytes);
  const prior = formatInspections.get(digest);
  if (prior) {
    if (prior.newErrors.length)
      throw Error(
        "product_format_new_errors:" + JSON.stringify(prior.newErrors),
      );
    return;
  }
  const file = path.join(output, "format-readback", digest + ".pptx");
  await fs.writeFile(file, bytes);
  let text;
  try {
    text = execFileSync("dotnet", [documentTool, "validate-openxml", file], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    text = error.stdout;
  }
  const result = JSON.parse(text);
  assert.equal(
    hash(await fs.readFile(file)),
    digest,
    "Format inspector must not rewrite authored bytes",
  );
  if (result.Failure || !Array.isArray(result.Errors))
    throw Error("product_format_reader_failed:" + JSON.stringify(result));
  baselineFormat ??= result;
  const remaining = new Map();
  for (const error of baselineFormat.Errors) {
    const key = JSON.stringify(error);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const newErrors = result.Errors.filter((error) => {
    const key = JSON.stringify(error),
      count = remaining.get(key) ?? 0;
    if (count) {
      remaining.set(key, count - 1);
      return false;
    }
    return true;
  });
  const evidence = { digest, ...result, newErrors };
  await fs.writeFile(
    path.join(output, "format-readback", digest + ".json"),
    JSON.stringify(evidence, null, 2),
  );
  formatInspections.set(digest, evidence);
  if (newErrors.length)
    throw Error("product_format_new_errors:" + JSON.stringify(newErrors));
}
const documents = new Map();
let candidateOrigin;
const worker = await fs.readFile(
  new URL("./runtime/ooxml-worker.js", import.meta.url),
);
const journalSource = await fs.readFile(
  new URL("./opfs-journal.mjs", import.meta.url),
);
const contentType = (name) =>
  ({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".html": "text/html",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  })[path.extname(name)] ?? "application/octet-stream";
const candidateServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const name = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    ).replace(/^\//, "");
    const file = path.resolve(candidate, "dist", name || "index.html");
    if (!file.startsWith(path.join(candidate, "dist") + path.sep))
      throw Error("invalid_path");
    const bytes = await fs.readFile(file);
    res.writeHead(200, { "content-type": contentType(file) });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => candidateServer.listen(0, "127.0.0.1", resolve));
candidateOrigin = "http://127.0.0.1:" + candidateServer.address().port;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", candidateOrigin);
  if (req.url.startsWith("/repo/")) {
    try {
      const file = path.resolve(
        integrationRoot,
        "services",
        decodeURIComponent(
          new URL(req.url, "http://localhost").pathname.slice(6),
        ),
      );
      if (
        !file.startsWith(path.join(integrationRoot, "services") + path.sep) ||
        !file.endsWith(".mjs")
      )
        throw Error("invalid_source_path");
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("document");
  if (url.pathname === "/compare.html") {
    const host = createOnlyOfficeComparisonHost({
      origin: candidateOrigin,
      preserveSource: true,
      repairStructure: true,
      authorizeArtifact: true,
      preservationBridge: true,
    })
      .replaceAll(
        "'/compare.pptx'",
        JSON.stringify("/compare.pptx?document=" + token),
      )
      .replaceAll(
        "'/original.pptx'",
        JSON.stringify("/original.pptx?document=" + token),
      );
    res.writeHead(200, { "content-type": "text/html" });
    res.end(host);
  } else if (url.pathname === "/product-journal.mjs") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(journalSource);
  } else if (url.pathname === "/comparison-repair.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(worker);
  } else if (
    ["/compare.pptx", "/original.pptx"].includes(url.pathname) &&
    documents.has(token)
  ) {
    res.writeHead(200, {
      "content-type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "cache-control": "no-store",
    });
    res.end(documents.get(token));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});
const report = {
  sourceIdentities,
  distribution,
  inputSha256: hash(input),
  preservationWorkerSha256: hash(worker),
  documentToolEvidence,
  startedAt: new Date().toISOString(),
  newBuilds: 0,
  productionPromoted: false,
  errors: [],
  stages: [],
  timings: {},
};
const contexts = [];
let mainPage,
  mainFrame,
  pendingAuthorization,
  lastObserved,
  lastInspection,
  lastCommandObservation,
  commandTableDetails,
  inspectedTableDetails;
async function tableDetails(frame) {
  return frame.evaluate(() =>
    window.Asc.editor.WordControl.m_oLogicDocument.Slides.map((slide) =>
      slide.cSld.spTree
        .filter((s) => s.isTable?.())
        .map((shape) =>
          shape.graphicObject.Content.map((row) => ({
            height: {
              value: row.Get_Height().Value,
              rule: row.Get_Height().HRule,
            },
            cells: row.Content.map((cell) => {
              const p = cell.Content.Content[0],
                c = p.Get_CompiledPr2(false),
                pr = cell.Get_CompiledPr(false);
              return {
                spacing: c.ParaPr.Spacing,
                fontSize: c.TextPr.FontSize,
                fontSizeCS: c.TextPr.FontSizeCS,
                hint: c.TextPr.RFonts.Hint,
                language: c.TextPr.Lang,
                complexScript: c.TextPr.CS,
                rtl: c.TextPr.RTL,
                runs: p.Content.filter((r) => r.Pr).map((r) => {
                  const cp = r.Get_CompiledPr(false);
                  return {
                    glyphs: r.Content.filter(
                      (item) => typeof item.GetGrapheme === "function",
                    ).map((item) => {
                      const id = window.AscFonts.GetGraphemeFontId(
                        item.GetGrapheme(),
                      );
                      return {
                        codePoint: item.Value,
                        font: window.AscFonts.GetFontNameByFontId(id),
                        style: window.AscFonts.GetFontStyleByFontId(id),
                      };
                    }),
                    raw: {
                      hint: r.Pr.RFonts.Hint,
                      language: r.Pr.Lang,
                      cs: r.Pr.CS,
                      rtl: r.Pr.RTL,
                    },
                    compiled: {
                      hint: cp.RFonts.Hint,
                      language: cp.Lang,
                      cs: cp.CS,
                      rtl: cp.RTL,
                    },
                  };
                }),
                fonts: Object.fromEntries(
                  Object.entries(c.TextPr.RFonts)
                    .filter(([key]) =>
                      ["Ascii", "HAnsi", "EastAsia", "CS"].includes(key),
                    )
                    .map(([key, value]) => [key, value?.Name]),
                ),
                margins: pr.TableCellMar,
                borders: Object.fromEntries(
                  Object.entries(pr.TableCellBorders).map(([key, value]) => [
                    key,
                    {
                      size: value?.Size,
                      space: value?.Space,
                      value: value?.Value,
                    },
                  ]),
                ),
                lines: p.Lines?.map((line) => ({
                  metrics: line.Metrics,
                  top: line.Top,
                  bottom: line.Bottom,
                })),
              };
            }),
          })),
        ),
    ),
  );
}
const mainContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
contexts.push(mainContext);
async function open(bytes, providedContext) {
  const context =
    providedContext ??
    (await browser.newContext({ viewport: { width: 1440, height: 1000 } }));
  if (!providedContext) contexts.push(context);
  const token = hash(bytes);
  documents.set(token, bytes);
  const page = await context.newPage();
  page.on("crash", () =>
    report.errors.push("renderer_crashed:" + token.slice(0, 10)),
  );
  page.on("pageerror", (e) => {
    report.errors.push(e.message);
    console.log("PAGE_ERROR", e.message);
  });
  await context.route(/^https?:\/\//, (route) => {
    const u = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(u.hostname)
      ? route.continue()
      : route.abort();
  });
  console.log("OPEN", token.slice(0, 10));
  await page.goto(origin + "/compare.html?document=" + token);
  await page.waitForFunction(
    () =>
      window.__ONLYOFFICE_SAVE_E2E__?.getStatus().ready ||
      window.__ONLYOFFICE_SAVE_E2E__?.getStatus().error,
    null,
    { timeout: 180000 },
  );
  const error = await page.evaluate(
    () => window.__ONLYOFFICE_SAVE_E2E__?.getStatus().error,
  );
  assert(!error, error);
  await page.evaluate(async () => {
    window.__productBinaryCodec = await import(
      "/repo/browser-office/binary-codec.mjs"
    );
  });
  const frame = page
    .frames()
    .find((f) => f.url().includes("/presentationeditor/"));
  assert(frame);
  const sessionId = crypto.randomUUID(),
    framePath = [];
  for (let child = frame; child.parentFrame(); child = child.parentFrame())
    framePath.unshift(child.parentFrame().childFrames().indexOf(child));
  await frame.evaluate(
    async (config) => {
      const { installOnlyOfficeProductPort } = await import(config.url);
      window.__productPortDispose = installOnlyOfficeProductPort({
        clientWindow: window.top,
        clientOrigin: config.clientOrigin,
        sessionId: config.sessionId,
      });
    },
    {
      url: origin + "/repo/browser-office/onlyoffice/product-native-port.mjs",
      clientOrigin: origin,
      sessionId,
    },
  );
  await page.evaluate(
    async (config) => {
      const { connectOnlyOfficeProductPort } = await import(config.url);
      let frameWindow = window;
      for (const index of config.framePath)
        frameWindow = frameWindow.frames[index];
      window.__productNativePort = await connectOnlyOfficeProductPort({
        frameWindow,
        frameOrigin: config.frameOrigin,
        sessionId: config.sessionId,
      });
    },
    {
      url: origin + "/repo/browser-office/onlyoffice/product-port-client.mjs",
      frameOrigin: candidateOrigin,
      sessionId,
      framePath,
    },
  );
  return { page, frame, context };
}
async function save(page) {
  return page.evaluate(async () => {
    const start = performance.now();
    await window.__ONLYOFFICE_SAVE_E2E__.save();
    const bytes = window.__comparisonSaved;
    return {
      ms: performance.now() - start,
      base64: window.__productBinaryCodec.encodeBinary(bytes),
    };
  });
}
const pixelStates = new Map();
async function pixels(frame) {
  const result = await frame.evaluate(
    async ({ codecUrl, slideIndex }) => {
      const codec = await import(codecUrl);
      // Compare document rendering in the same view state. Native selection
      // handles are transient UI, not saved document content.
      const editor = window.Asc.editor;
      const model = editor.WordControl.m_oLogicDocument;
      if (!model.Slides[slideIndex])
        throw Error("diagnostic_target_slide_missing");
      editor.WordControl.GoToPage(slideIndex);
      if (model.CurPage !== slideIndex)
        throw Error("diagnostic_canvas_slide_mismatch");
      model.Slides[model.CurPage]?.graphicObjects.resetSelection();
      model.Document_UpdateSelectionState();
      model.RedrawCurSlide();
      const canvas = document.getElementById("id_viewer");
      if (!canvas?.width) throw Error("canvas_missing");
      let previous = null,
        stable = 0;
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const bytes = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
        stable = digest === previous ? stable + 1 : 0;
        if (stable >= 3)
          return {
            width: canvas.width,
            height: canvas.height,
            sha256: digest,
            base64: codec.encodeBinary(
              new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ),
          };
        previous = digest;
      }
      throw Error("canvas_not_stable");
    },
    {
      codecUrl: origin + "/repo/browser-office/binary-codec.mjs",
      slideIndex: selectedSlideIndex,
    },
  );
  const bytes = Buffer.from(result.base64, "base64");
  delete result.base64;
  pixelStates.set(result.sha256, bytes);
  await fs.writeFile(path.join(output, result.sha256 + ".rgba"), bytes);
  return result;
}
function assertSameCanvas(actual, expected) {
  const evidence = compareCanvasPixels(
    expected,
    actual,
    pixelStates.get(expected.sha256),
    pixelStates.get(actual.sha256),
  );
  report.visualComparisons ??= [];
  report.visualComparisons.push({
    before: expected.sha256,
    after: actual.sha256,
    ...evidence,
  });
}
let persisted = null;
function stageBinary(bytes) {
  const owned = Buffer.from(bytes),
    digest = hash(owned);
  documents.set(digest, owned);
  return "/original.pptx?document=" + digest;
}
async function journalCall(operation, payload = null) {
  const result = await mainPage.evaluate(
    async ({ operation, payload, identity }) => {
      window.__productJournal ??= await (
        await import("/repo/browser-office/opfs-journal.mjs")
      ).openBrowserDocumentJournal({ identity });
      if (operation === "save") {
        const read = async (url) => {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) throw Error("journal_transfer_read_failed");
          return new Uint8Array(await response.arrayBuffer());
        };
        payload.baseBytes = await read(payload.baseBytes);
        payload.candidateBytes = await read(payload.candidateBytes);
        if (payload.historyArtifacts)
          for (const artifact of payload.historyArtifacts)
            artifact.bytes = await read(artifact.bytes);
        return window.__productJournal.save(payload);
      }
      if (operation === "clear") return window.__productJournal.clear();
      const loaded = await window.__productJournal.load();
      if (!loaded) return null;
      // The journal reads and verifies complete files. Only the diagnostic JSON
      // bridge is chunked; original/candidate/history duplicates cross it once.
      const files = new Map();
      const describe = async (bytes) => {
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
        files.set(digest, bytes);
        return { digest, length: bytes.length };
      };
      const result = {
        ...loaded,
        baseBytes: await describe(loaded.baseBytes),
        candidateBytes: await describe(loaded.candidateBytes),
        historyArtifacts: [],
      };
      for (const artifact of loaded.historyArtifacts)
        result.historyArtifacts.push({
          ...artifact,
          bytes: await describe(artifact.bytes),
        });
      window.__productJournalLoadedBytes = files;
      return result;
    },
    {
      operation,
      payload,
      identity: "onlyoffice-product-session:" + hash(input),
    },
  );
  if (operation === "load" && result) {
    const files = new Map();
    const read = async ({ digest, length }) => {
      if (files.has(digest)) return files.get(digest);
      assert(
        Number.isSafeInteger(length) &&
          length > 0 &&
          length <= 64 * 1024 * 1024,
      );
      const bytes = Buffer.alloc(length);
      for (let offset = 0; offset < length; offset += 4 * 1024 * 1024) {
        const size = Math.min(4 * 1024 * 1024, length - offset);
        const encoded = await mainPage.evaluate(
          ({ digest, offset, size }) => {
            const bytes = window.__productJournalLoadedBytes.get(digest);
            if (!bytes) throw Error("journal_transfer_file_missing");
            return window.__productBinaryCodec.encodeBinary(
              bytes.subarray(offset, offset + size),
            );
          },
          { digest, offset, size },
        );
        const chunk = Buffer.from(encoded, "base64");
        assert.equal(chunk.length, size);
        chunk.copy(bytes, offset);
      }
      assert.equal(hash(bytes), digest);
      files.set(digest, bytes);
      return bytes;
    };
    try {
      result.baseBytes = await read(result.baseBytes);
      result.candidateBytes = await read(result.candidateBytes);
      for (const artifact of result.historyArtifacts)
        artifact.bytes = await read(artifact.bytes);
    } finally {
      await mainPage.evaluate(() => {
        window.__productJournalLoadedBytes = null;
      });
    }
  }
  return result;
}

const journal = {
  save: async (record) => {
    const metadata = await journalCall("save", {
      ...record,
      baseBytes: stageBinary(record.baseBytes),
      candidateBytes: stageBinary(record.candidateBytes),
      historyArtifacts: record.historyArtifacts?.map((a) => ({
        ...a,
        bytes: stageBinary(a.bytes),
      })),
    });
    persisted = await journalCall("load");
    assert.equal(hash(persisted.candidateBytes), metadata.candidateSha256);
    await fs.writeFile(
      path.join(output, "recovery.pptx"),
      persisted.candidateBytes,
    );
    await fs.writeFile(
      path.join(output, "recovery-receipt.json"),
      JSON.stringify(metadata, null, 2),
    );
  },
  load: () => journalCall("load"),
  clear: async () => {
    await journalCall("clear");
    assert.equal(await journalCall("load"), null);
    persisted = null;
  },
};
report.recoveryProvider = "existing-opfs-two-slot-journal";
report.preservationExecution = {
  mode: "current-source-direct-node-through-real-save-callback",
  sourceSha256: hash(
    await fs.readFile("services/browser-office/ooxml-worker-source.mjs"),
  ),
  newBuilds: 0,
  limitation: "Diagnostic bridge; not production browser bundle admission",
};
const engine = createOnlyOfficeProductEngine({
  getFrame: async () => mainFrame,
  open: async (bytes) => {
    const old = mainPage;
    if (old) {
      await old.evaluate(() => window.__ONLYOFFICE_SAVE_E2E__.destroy());
      await old.close();
    }
    const opened = await open(bytes, mainContext);
    mainPage = opened.page;
    mainFrame = opened.frame;
    // Run the current preservation source directly. The retained bundle is
    // used only for its unchanged final structure repair; never rebuild it.
    await mainPage.exposeFunction(
      "__ONLYOFFICE_PRODUCT_PRESERVE_BINARY__",
      async (payload) => {
        const inputs = [
          payload.bytes,
          payload.noEditBytes,
          payload.editedBytes,
        ].map((bytes) => Buffer.from(bytes, "base64"));
        const result = preserveOriginalPptxParts(
          ...inputs,
          payload.sourceOperations,
          payload.sourceTargets,
        );
        return {
          bytes: Buffer.from(result.bytes).toString("base64"),
          report: result.report,
        };
      },
    );
    await mainPage.exposeFunction(
      "__ONLYOFFICE_PRODUCT_ADMIT_BINARY__",
      async (bytes) => {
        if (!pendingAuthorization)
          throw Error("snapshot_authorization_context_missing");
        await pendingAuthorization(Buffer.from(bytes, "base64"));
        return true;
      },
    );
    await mainPage.evaluate(() => {
      window.__ONLYOFFICE_PRODUCT_PRESERVE__ = async (payload) => {
        const binary = window.__productBinaryCodec;
        const result = await window.__ONLYOFFICE_PRODUCT_PRESERVE_BINARY__({
          ...payload,
          bytes: binary.encodeBinary(payload.bytes),
          noEditBytes: binary.encodeBinary(payload.noEditBytes),
          editedBytes: binary.encodeBinary(payload.editedBytes),
        });
        return { ...result, bytes: binary.decodeBinary(result.bytes) };
      };
      window.__ONLYOFFICE_PRODUCT_ADMIT__ = (bytes) =>
        window.__ONLYOFFICE_PRODUCT_ADMIT_BINARY__(
          window.__productBinaryCodec.encodeBinary(bytes),
        );
      window.__comparisonIntent = {
        sourceOperations: null,
        sourceTargets: null,
      };
    });
    await captureStableOnlyOfficeBaseline(mainPage, save);
  },
  inspect: async (bytes) => {
    await inspectFormat(bytes);
    const opened = await open(bytes);
    try {
      const observation = await opened.page.evaluate(() =>
        window.__productNativePort.observe(),
      );
      lastInspection = observation;
      if (
        [
          "set_table_cell",
          "set_table_row_height",
          "set_table_column_width",
          "insert_table_rows",
          "delete_table_rows",
        ].includes(flags("--operation", "move"))
      )
        inspectedTableDetails = await tableDetails(opened.frame);
      return observation;
    } finally {
      await opened.context.close();
    }
  },
  bindArtifact: async (bytes) => {
    await mainPage.evaluate(
      (bytes) =>
        window.__ONLYOFFICE_PRODUCT_PRESERVATION__.bind(
          window.__productBinaryCodec.decodeBinary(bytes),
        ),
      Buffer.from(bytes).toString("base64"),
    );
    await captureStableOnlyOfficeBaseline(mainPage, save);
  },
  snapshot: async ({ before, commands, authorize }) => {
    if (commands) {
      lastCommandObservation = lastObserved;
      if (
        [
          "set_table_cell",
          "set_table_row_height",
          "set_table_column_width",
          "insert_table_rows",
          "delete_table_rows",
        ].includes(flags("--operation", "move"))
      )
        commandTableDetails = await tableDetails(mainFrame);
      assert.equal(
        await mainFrame.evaluate(() =>
          window.AscCommon.CollaborativeEditing.Get_GlobalLock(),
        ),
        true,
        "Human input must be locked throughout async AI file admission",
      );
      report.asyncNativeMutationLockVerified = true;
    }
    await mainPage.evaluate((intent) => (window.__comparisonIntent = intent), {
      sourceOperations: commands?.map((c) => c.op) ?? null,
      sourceTargets:
        commands?.map((c) => {
          if (
            [
              "rename_slide",
              "set_slide_hidden",
              "set_background",
              "set_speaker_notes",
            ].includes(c.op)
          )
            return { op: c.op, slideIndex: c.slideIndex };
          if (c.op === "set_reading_order")
            return {
              op: c.op,
              slideIndex: Number(c.elementIds[0].split("/")[0]),
            };
          const [slideIndex, shapeIndex] = c.elementId.split("/").map(Number);
          return {
            op: c.op,
            slideIndex,
            shapeIndex,
            ...(["insert_table_rows", "delete_table_rows"].includes(c.op)
              ? { index: c.index, count: c.count }
              : {}),
            name:
              before.slides[slideIndex].elements[shapeIndex].objectName ?? "",
          };
        }) ?? null,
    });
    pendingAuthorization = authorize;
    try {
      return Buffer.from((await save(mainPage)).base64, "base64");
    } finally {
      pendingAuthorization = null;
    }
  },
});
// Commands cross the same restricted browser port a product host consumes.
// Playwright observes pixels and installs the trusted source, but never executes
// command handlers or supplies JavaScript for a model-requested mutation.
for (const method of [
  "observe",
  "changeToken",
  "prepareManualCheckpoint",
  "preflight",
  "begin",
  "apply",
  "finish",
  "undo",
  "redo",
])
  engine[method] = async (...args) => {
    const result = await mainPage.evaluate(
      async ({ method, args }) => window.__productNativePort[method](...args),
      { method, args },
    );
    if (method === "observe") lastObserved = result;
    return result;
  };
if (flags("--operation", "move") === "font_color") {
  const applyNative = engine.apply;
  engine.apply = async (command) => {
    const value = await applyNative(command);
    report.nativeColorReadback = await mainFrame.evaluate((slideIndex) => {
      const m = window.Asc.editor.WordControl.m_oLogicDocument;
      const pr = (p) => ({
        color: p?.Color ? { r: p.Color.r, g: p.Color.g, b: p.Color.b } : null,
        fill: p?.Unifill?.fill?.color?.color
          ? {
              R: p.Unifill.fill.color.color.R,
              G: p.Unifill.fill.color.color.G,
              B: p.Unifill.fill.color.color.B,
              r: p.Unifill.fill.color.color.r,
              type: p.Unifill.fill.color.color.constructor.name,
              rgba: p.Unifill.fill.color.color.RGBA,
            }
          : null,
      });
      return m.Slides[slideIndex].cSld.spTree[0]
        .getDocContent()
        .Content.map((p) => ({
          end: pr(p.TextPr?.Value),
          runs: p.Content.map((r) => pr(r.Pr)),
        }));
    }, selectedSlideIndex);
    return value;
  };
}
const nativeVerifyIntent = engine.verifyIntent;
engine.verifyIntent = (before, after, commands) => {
  lastCommandObservation = structuredClone(after);
  return nativeVerifyIntent(before, after, commands);
};
const nativeBegin = engine.begin,
  nativeFinish = engine.finish;
engine.begin = async () => {
  const sourceToken = await mainPage.evaluate(() =>
    window.__ONLYOFFICE_PRODUCT_PRESERVATION__.begin(),
  );
  try {
    return { native: await nativeBegin(), sourceToken };
  } catch (error) {
    await mainPage.evaluate(
      (token) =>
        window.__ONLYOFFICE_PRODUCT_PRESERVATION__.finish(token, false),
      sourceToken,
    );
    throw error;
  }
};
engine.finish = async (token, commit) => {
  await nativeFinish(token.native, commit);
  await mainPage.evaluate(
    ({ token, commit }) =>
      window.__ONLYOFFICE_PRODUCT_PRESERVATION__.finish(token, commit),
    { token: token.sourceToken, commit },
  );
};
report.nativeTransport = "origin-and-session-bound-message-port";
const session = createProductSession({
  engine,
  journal,
  validateCommand: validate,
  operationContracts: capabilities.mutationModel.operations,
  verifyObservation: verifyOnlyOfficeProductObservation,
});
try {
  let phaseStarted = performance.now();
  const before = await session.open(input);
  assert(
    before.slides[selectedSlideIndex],
    "Target slide missing from actual document",
  );
  report.timings.openWithBaselineAndAdmissionMs =
    performance.now() - phaseStarted;
  report.stages.push("original-open-and-file-admission");
  if (process.argv.includes("--unobserved-native-probe")) {
    const originalToken = await engine.changeToken();
    const token = await engine.begin();
    await mainFrame.evaluate((slideIndex) => {
      const editor = window.Asc.editor;
      editor.executeGroupActionsStart();
      try {
        const model = editor.WordControl.m_oLogicDocument;
        const properties =
          model.Slides[slideIndex].cSld.spTree[0].getCNvProps();
        properties.setId(properties.id + 1000000);
      } finally {
        editor.executeGroupActionsEnd();
      }
    }, selectedSlideIndex);
    await engine.finish(token, true);
    assert.notEqual(await engine.changeToken(), originalToken);
    // This property has not yet been admitted by the candidate observation.
    verifyOnlyOfficeProductObservation(before, await engine.observe());
    await assert.rejects(session.observe(), /product_unobserved_native_edit/);
    let written = false;
    await assert.rejects(
      session.save(async () => {
        written = true;
      }),
      /product_unobserved_native_edit/,
    );
    assert.equal(written, false);
    const ignoredCommand = Object.fromEntries(
      Object.keys(capabilities.toolInputSchema.properties).map((key) => [
        key,
        null,
      ]),
    );
    Object.assign(ignoredCommand, {
      op: "move",
      elementId: `${selectedSlideIndex}/0`,
      x: before.slides[selectedSlideIndex].elements[0].x + 500,
      y: before.slides[selectedSlideIndex].elements[0].y,
    });
    await assert.rejects(
      session.apply({
        expectedRevision: before.revision,
        commands: [ignoredCommand],
      }),
      /product_unobserved_native_edit/,
    );
    assert.equal(await journal.load(), null);
    await engine.undo();
    assert.equal(await engine.changeToken(), originalToken);
    verifyOnlyOfficeProductObservation(before, await session.observe());
    report.stages.push(
      "unobserved-native-edit-refuses-stale-file-and-recovers-after-native-undo",
    );
  }
  report.rendering = { before: await pixels(mainFrame) };
  if (process.argv.includes("--observe-only")) {
    await fs.writeFile(
      path.join(output, "observation.json"),
      JSON.stringify(before, null, 2),
    );
    await fs.writeFile(
      path.join(output, "table-details.json"),
      JSON.stringify(await tableDetails(mainFrame), null, 2),
    );
    report.status = "native-file-observation-verified";
  } else {
    const operation = flags("--operation", "move");
    const targets = before.slides[selectedSlideIndex].elements.filter(
      (x) => x.kind === "shape" && Number.isFinite(x.x),
    );
    const target =
      selectedElementIndex !== null
        ? before.slides[selectedSlideIndex].elements[selectedElementIndex]
        : [
              "set_table_cell",
              "set_table_row_height",
              "set_table_column_width",
              "insert_table_rows",
              "delete_table_rows",
            ].includes(operation)
          ? before.slides[selectedSlideIndex].elements.find(
              (element) => element.kind === "table",
            )
          : operation === "crop_image"
            ? before.slides[selectedSlideIndex].elements.find(
                (element) => element.kind === "image",
              )
            : [
                  "resize",
                  "fill_color",
                  "fill_opacity",
                  "line_opacity",
                  "line_color",
                  "line_width",
                  "set_line_style",
                  "flip",
                ].includes(operation)
              ? targets.at(-1)
              : targets[0];
    assert(target);
    const command = Object.fromEntries(
      Object.keys(capabilities.toolInputSchema.properties).map((key) => [
        key,
        null,
      ]),
    );
    report.operation = operation;
    report.selectedSlideIndex = selectedSlideIndex;
    Object.assign(command, {
      op: operation,
      elementId: target.elementId,
      x: target.x + 500,
      y: target.y,
    });
    const args = {
      font_size: { size: 32 },
      bold: { bold: true },
      italic: { italic: true },
      underline: { underline: true },
      strikethrough: { strikethrough: true },
      font_family: { family: "Arial" },
      font_color: { color: 0xff0000 },
      replace_text: { text: flags("--text", "Verified product text") },
      set_table_row_height: { index: 0, height: 2000 },
      set_table_column_width: { index: 0, width: 5000 },
      insert_table_rows: { index: 1, count: 1 },
      delete_table_rows: { index: 1, count: 1 },
      set_table_cell: {
        row: 0,
        column: 0,
        text: flags("--text", "검증된 표 셀"),
      },
      fill_color: { color: 0xffe600 },
      fill_opacity: { opacity: 37.123 },
      line_opacity: { opacity: 37.123 },
      resize: { width: target.width + 500, height: target.height + 500 },
      rotate: { degrees: 15 },
      flip: { axis: "horizontal" },
      z_order: { position: flags("--position", "front") },
      set_reading_order: {
        elementId: null,
        elementIds: before.slides[selectedSlideIndex].elements
          .map((e) => e.elementId)
          .reverse(),
      },
      set_shape_name: { name: "Verified title" },
      set_alt_text: {
        title: "Verified accessible title",
        description: "Verified accessible description",
      },
      crop_image: { left: 0.15, top: 0.1, right: 0.08, bottom: 0.06 },
      line_color: { color: 0xff0000 },
      line_width: { size: 4 },
      set_line_style: {
        lineStyle: {
          dash: "lgDashDot",
          startArrow: { type: "triangle", width: "med", length: "lg" },
          endArrow: { type: "oval", width: "sm", length: "med" },
        },
      },
      paragraph_alignment: { alignment: "right" },
      set_character_spacing: { spacing: 2 },
      set_script_position: { script: "superscript" },
      set_text_language: { languageTag: "ko-KR" },
      set_object_lock: { lockPosition: true, lockSize: true },
      rename_slide: {
        slideIndex: selectedSlideIndex,
        elementId: null,
        name: "Verified slide",
      },
      set_slide_hidden: {
        slideIndex: selectedSlideIndex,
        elementId: null,
        hidden: true,
      },
      set_speaker_notes: {
        slideIndex: selectedSlideIndex,
        elementId: null,
        text: flags("--text", "검증된 발표자 노트\nSecond paragraph"),
      },
      set_background: {
        slideIndex: selectedSlideIndex,
        elementId: null,
        color: 0x27b575,
      },
    };
    Object.assign(command, args[operation]);
    let finalExpected;
    const manualFlow = process.argv.includes("--manual-flow");
    phaseStarted = performance.now();
    const applied = await session.apply({
      expectedRevision: before.revision,
      commands: [command],
    });
    report.timings.commandWithFileAdmissionAndJournalMs =
      performance.now() - phaseStarted;
    report.stages.push("canonical-command-live-apply-file-reopen-journal");
    await fs.writeFile(
      path.join(output, "observations.json"),
      JSON.stringify({ before, edited: applied.observation }, null, 2),
    );
    assert.notEqual(applied.observation.revision, before.revision);
    const afterTarget =
      applied.observation.slides[selectedSlideIndex].elements[
        Number(target.elementId.split("/")[1])
      ];
    const drawing =
      applied.observation.slides[selectedSlideIndex].onlyoffice.drawings[
        Number(target.elementId.split("/")[1])
      ];
    const styles = drawing.paragraphs?.flatMap((p) =>
      p.runs.map((r) => r.style),
    );
    const property = {
      bold: "GetBold",
      italic: "GetItalic",
      underline: "GetUnderline",
      strikethrough: "GetStrikeout",
    }[operation];
    if (property) {
      assert(styles?.length);
      assert(styles.every((s) => s[property] === command[operation]));
    }
    if (operation === "font_color") {
      assert(styles?.length);
      assert(
        styles.every(
          (s) =>
            s.color?.rgb.r === ((command.color >>> 16) & 255) &&
            s.color.rgb.g === ((command.color >>> 8) & 255) &&
            s.color.rgb.b === (command.color & 255),
        ),
      );
    }
    if (operation === "font_size") {
      assert(styles?.length);
      assert(styles.every((s) => s.GetFontSize === command.size * 2));
    }
    if (operation === "font_family") {
      assert(styles?.length);
      assert(styles.every((s) => s.fonts.every((f) => f === command.family)));
    }
    if (operation === "move") {
      assert(Math.abs(afterTarget.x - command.x) < 0.01);
      assert(Math.abs(afterTarget.y - command.y) < 0.01);
    }
    if (operation === "replace_text")
      assert.equal(
        afterTarget.text.replace(/\r\n/g, "\n").replace(/\n$/, ""),
        command.text.replace(/\r\n/g, "\n"),
      );
    for (const element of before.slides[selectedSlideIndex].elements.filter(
      (e) => e.elementId !== target.elementId,
    )) {
      const expected = structuredClone(element);
      if (operation === "set_reading_order") {
        expected.elementId = `${selectedSlideIndex}/${command.elementIds.indexOf(element.elementId)}`;
      }
      if (operation === "z_order") {
        const order = before.slides[selectedSlideIndex].elements.map(
          (_, i) => i,
        );
        const originalIndex = Number(target.elementId.split("/")[1]);
        const destination = {
          front: order.length - 1,
          back: 0,
          forward: Math.min(originalIndex + 1, order.length - 1),
          backward: Math.max(originalIndex - 1, 0),
        }[command.position];
        order.splice(originalIndex, 1);
        order.splice(destination, 0, originalIndex);
        const index = Number(element.elementId.split("/")[1]);
        expected.elementId = `${selectedSlideIndex}/${order.indexOf(index)}`;
      }
      if (operation === "delete_element") {
        const index = Number(element.elementId.split("/")[1]);
        const removedIndex = Number(target.elementId.split("/")[1]);
        expected.elementId = `${selectedSlideIndex}/${index > removedIndex ? index - 1 : index}`;
      }
      assert.deepEqual(
        applied.observation.slides[selectedSlideIndex].elements.find(
          (e) => e.elementId === expected.elementId,
        ),
        expected,
      );
    }

    await fs.writeFile(
      path.join(output, "edited.pptx"),
      persisted.candidateBytes,
    );
    report.rendering.edited = await pixels(mainFrame);
    if (
      ![
        "set_shape_name",
        "set_alt_text",
        "set_text_language",
        "set_object_lock",
        "font_family",
        "flip",
        "rename_slide",
        "set_slide_hidden",
        "set_speaker_notes",
        "z_order",
        "set_reading_order",
      ].includes(operation)
    )
      assert.notEqual(
        report.rendering.edited.sha256,
        report.rendering.before.sha256,
      );
    if (operation === "set_alt_text")
      assertSameCanvas(report.rendering.edited, report.rendering.before);
    await mainPage.screenshot({ path: path.join(output, "edited.png") });
    await session.undo();
    report.rendering.undo = await pixels(mainFrame);
    assertSameCanvas(report.rendering.undo, report.rendering.before);
    report.stages.push("undo-exact-approved-package");
    const originalApply = engine.apply;
    engine.apply = async (command) => {
      await originalApply(command);
      throw Error("injected_after_native_change");
    };
    const rollbackCommand = {
      ...command,
      op: "move",
      x: target.x + 1000,
      y: target.y,
      elementId: target.elementId,
      slideIndex: null,
    };
    await assert.rejects(
      session.apply({
        expectedRevision: before.revision,
        commands: [rollbackCommand],
      }),
      /injected_after_native_change/,
    );
    engine.apply = originalApply;
    assertSameCanvas(await pixels(mainFrame), report.rendering.before);
    assert.equal(session.status().redo, 1);
    report.stages.push("native-failure-rollback-retains-old-redo");
    const saveJournal = journal.save;
    journal.save = async () => {
      throw Error("injected_journal_disk_full");
    };
    await assert.rejects(
      session.apply({
        expectedRevision: before.revision,
        commands: [rollbackCommand],
      }),
      /injected_journal_disk_full/,
    );
    journal.save = saveJournal;
    assert.equal(session.status().ready, true);
    assert.equal(session.status().redo, 1);
    assertSameCanvas(await pixels(mainFrame), report.rendering.before);
    report.stages.push("journal-failure-restores-native-and-source-baselines");
    let beginCount = 0;
    const originalBegin = engine.begin;
    engine.begin = async () => {
      beginCount++;
      return originalBegin();
    };
    await assert.rejects(
      session.apply({
        expectedRevision: before.revision,
        commands: [rollbackCommand, { ...command, op: "set_sections" }],
      }),
      /operation_unavailable/,
    );
    assert.equal(beginCount, 0);
    engine.begin = originalBegin;
    assertSameCanvas(await pixels(mainFrame), report.rendering.before);
    report.stages.push("whole-batch-preflight-before-native-history");
    await session.redo();
    report.rendering.redo = await pixels(mainFrame);
    assertSameCanvas(report.rendering.redo, report.rendering.edited);
    report.stages.push("redo-exact-approved-package");
    finalExpected = applied.observation;
    if (manualFlow) {
      const textIndex = finalExpected.slides[
        selectedSlideIndex
      ].elements.findIndex(
        (element) => typeof element.text === "string" && element.text.length,
      );
      const manualIndex =
        textIndex >= 0 ? textIndex : Number(target.elementId.split("/")[1]);
      const manualBefore =
        finalExpected.slides[selectedSlideIndex].elements[manualIndex];
      assert(manualBefore, "Manual edit needs an existing native object");
      // Select only; typing or image movement comes through real browser keys.
      await mainFrame.evaluate(
        ({ index, text, slideIndex }) => {
          const a = window.Asc.editor,
            m = a.WordControl.m_oLogicDocument,
            c = m.Slides[slideIndex].graphicObjects;
          a.WordControl.GoToPage(slideIndex);
          c.resetSelection();
          c.selectObject(m.Slides[slideIndex].cSld.spTree[index], slideIndex);
          m.Document_UpdateSelectionState();
          if (text) {
            c.startEditTextCurrentShape();
            a.WordControl.m_oDrawingDocument.TargetStart();
          }
        },
        {
          index: manualIndex,
          text: textIndex >= 0,
          slideIndex: selectedSlideIndex,
        },
      );
      const area = mainFrame.locator("#area_id");
      if (await area.count()) await area.focus();
      if (textIndex >= 0) {
        await mainPage.keyboard.press("End");
        await mainPage.keyboard.insertText(" HUMAN_VERIFIED");
      } else await mainPage.keyboard.press("ArrowRight");
      await mainPage.keyboard.press("Escape");
      phaseStarted = performance.now();
      finalExpected = await session.observe();
      report.timings.humanCheckpointWithFileAdmissionAndJournalMs =
        performance.now() - phaseStarted;
      if (textIndex >= 0)
        assert(
          finalExpected.slides[selectedSlideIndex].elements[
            manualIndex
          ].text.includes("HUMAN_VERIFIED"),
        );
      else
        assert(
          finalExpected.slides[selectedSlideIndex].elements[manualIndex].x >
            manualBefore.x,
        );
      assert.equal(session.status().undo, 2);
      // Use the editor's own buttons, independent of the product history API.
      const manualRevision = finalExpected.revision;
      report.nativeHistoryControls = await mainFrame
        .locator("[aria-label*='Undo'],[title*='Undo']")
        .evaluateAll((elements) =>
          elements.map((e) => ({
            tag: e.tagName,
            id: e.id,
            label: e.getAttribute("aria-label"),
            title: e.getAttribute("title"),
            visible: !!e.getClientRects().length,
            display: getComputedStyle(e).display,
            disabled: e.disabled,
          })),
        );
      await mainFrame.getByRole("button", { name: /^Undo/ }).click();
      const nativeUndo = await session.observe();
      assert.equal(nativeUndo.revision, applied.observation.revision);
      assert.equal(session.status().redo, 1);
      await mainFrame.getByRole("button", { name: /^Redo/ }).click();
      finalExpected = await session.observe();
      assert.equal(finalExpected.revision, manualRevision);
      assert.equal(session.status().redo, 0);
      report.stages.push(
        "native-editor-buttons-reconcile-with-product-history",
      );
      report.rendering.manual = await pixels(mainFrame);
      assert.notDeepEqual(report.rendering.manual, report.rendering.edited);
      await mainPage.screenshot({ path: path.join(output, "manual.png") });
      report.stages.push(
        "real-keyboard-human-edit-admitted-with-earlier-ai-history",
      );
    }
    await assert.rejects(
      session.apply({ expectedRevision: before.revision, commands: [command] }),
      /stale/,
    );
    report.stages.push("stale-command-refused");
    phaseStarted = performance.now();
    const recovered = await session.recover();
    report.timings.recoveryWithExactFileAndHistoryMs =
      performance.now() - phaseStarted;
    verifyOnlyOfficeProductObservation(finalExpected, recovered);
    report.stages.push("recovery-exact-file-readback");
    const recoveryPixels = manualFlow
      ? report.rendering.manual
      : report.rendering.edited;
    assert.equal(session.status().undo, manualFlow ? 2 : 1);
    await session.undo();
    assertSameCanvas(
      await pixels(mainFrame),
      manualFlow ? report.rendering.edited : report.rendering.before,
    );
    await session.recover();
    assert.equal(session.status().redo, 1);
    await session.redo();
    assertSameCanvas(await pixels(mainFrame), recoveryPixels);
    if (manualFlow) {
      await session.undo();
      await session.undo();
      assertSameCanvas(await pixels(mainFrame), report.rendering.before);
      await session.redo();
      await session.redo();
      assertSameCanvas(await pixels(mainFrame), recoveryPixels);
      report.stages.push(
        "recovered-mixed-human-and-ai-history-keeps-exact-files",
      );
    } else report.stages.push("recovered-native-undo-and-redo-branch");
    report.rendering.recovered = await pixels(mainFrame);
    assertSameCanvas(report.rendering.recovered, recoveryPixels);
    await mainPage.screenshot({ path: path.join(output, "recovered.png") });
    await assert.rejects(
      session.save(async () => ({ candidateSha256: "wrong" })),
      /acknowledgement/,
    );
    assert(persisted);
    report.stages.push("wrong-save-ack-keeps-recovery");
    phaseStarted = performance.now();
    report.saved = await session.save(async (bytes, receipt) => {
      await fs.writeFile(path.join(output, "saved.pptx"), bytes);
      return { candidateSha256: hash(bytes) };
    });
    report.timings.acknowledgedFileSaveMs = performance.now() - phaseStarted;
    assert.equal(persisted, null);
    report.stages.push("acknowledged-exact-file-save");
    if (manualFlow) {
      await session.undo();
      assertSameCanvas(await pixels(mainFrame), report.rendering.edited);
      await session.redo();
      assertSameCanvas(await pixels(mainFrame), recoveryPixels);
      report.stages.push("acknowledged-save-keeps-earlier-undo-and-redo");
    }
    report.status = "product-session-command-verified";
  }
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  await fs.writeFile(
    path.join(output, "failure-observations.json"),
    JSON.stringify(
      {
        command: lastCommandObservation,
        inspected: lastInspection,
        commandTableDetails,
        inspectedTableDetails,
      },
      null,
      2,
    ),
  );
  if (mainPage && !mainPage.isClosed()) {
    await mainPage
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => null);
    report.failureRendering = await pixels(mainFrame).catch(() => null);
  }
  if (mainFrame)
    report.unwrappedNativeObjects = await mainFrame
      .evaluate(() => {
        const model = window.Asc.editor.WordControl.m_oLogicDocument;
        const objects = [];
        const names = Object.fromEntries(
          Object.entries(window.AscDFH)
            .filter(([key]) => key.startsWith("historyitem_type_"))
            .map(([key, value]) => [value, key]),
        );
        const visit = (object, path) => {
          if (!window.AscBuilder.GetApiDrawing(object))
            objects.push({
              path,
              type: names[object.getObjectType?.()] ?? object.getObjectType?.(),
              keys: Object.keys(object)
                .filter((k) => !["parent", "group"].includes(k))
                .slice(0, 70),
              isShape: !!object.isShape?.(),
              isImage: !!object.isImage?.(),
              isChart: !!object.isChart?.(),
              isTable: !!object.isTable?.(),
            });
          object.spTree?.forEach((child, index) =>
            visit(child, `${path}/${index}`),
          );
        };
        model.Slides.forEach((slide, index) =>
          slide.cSld.spTree.forEach((object, shape) =>
            visit(object, `${index}/${shape}`),
          ),
        );
        return objects;
      })
      .catch(() => null);
  if (mainPage && !mainPage.isClosed()) {
    const diagnostic = await mainPage
      .evaluate(() => {
        const snapshot = window.__comparisonLastSnapshot;
        if (!snapshot) return null;
        return Object.fromEntries(
          Object.entries(snapshot).map(([key, value]) => [
            key,
            value instanceof Uint8Array
              ? window.__productBinaryCodec.encodeBinary(value)
              : value,
          ]),
        );
      })
      .catch(() => null);
    if (diagnostic) {
      for (const key of [
        "original",
        "noEditBytes",
        "rawBytes",
        "candidateBytes",
      ])
        if (diagnostic[key]) {
          await fs.writeFile(
            path.join(output, `failure-${key}.pptx`),
            Buffer.from(diagnostic[key], "base64"),
          );
          delete diagnostic[key];
        }
      report.failedSnapshot = diagnostic;
    }
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  candidateServer.closeAllConnections();
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => candidateServer.close(r)),
  ]);
  report.finalSourceIdentities = {
    candidate: readRepositoryIdentity(candidate),
    integration: readRepositoryIdentity(integrationRoot),
  };
  report.sourceStable =
    repositoryIdentityStable(
      sourceIdentities.candidate,
      report.finalSourceIdentities.candidate,
    ) &&
    repositoryIdentityStable(
      sourceIdentities.integration,
      report.finalSourceIdentities.integration,
    );
  if (!report.sourceStable) {
    report.status = "failed";
    report.errors.push("source_changed_during_trial");
    process.exitCode = 1;
  }
  report.formatInspections = [...formatInspections.values()];
  if (
    documentTool &&
    hash(await fs.readFile(documentTool)) !== documentToolSha256
  ) {
    report.status = "failed";
    report.errors.push("format_inspector_changed_during_trial");
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
