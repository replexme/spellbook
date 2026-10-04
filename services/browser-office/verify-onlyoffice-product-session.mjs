/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import Ajv from "ajv";
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
import { createProductSession } from "./product-session.mjs";
import { captureStableOnlyOfficeBaseline } from "./onlyoffice-baseline.mjs";
const flags = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
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
  startedAt: new Date().toISOString(),
  newBuilds: 0,
  productionPromoted: false,
  errors: [],
  stages: [],
};
const contexts = [];
let mainPage, mainFrame, pendingAuthorization;
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
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.slice(i, i + 32768));
    return { ms: performance.now() - start, base64: btoa(binary) };
  });
}
async function pixels(frame) {
  return frame.evaluate(async () => {
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
        return { width: canvas.width, height: canvas.height, sha256: digest };
      previous = digest;
    }
    throw Error("canvas_not_stable");
  });
}
let persisted = null;
async function journalCall(operation, payload = null) {
  const result = await mainPage.evaluate(
    async ({ operation, payload, identity }) => {
      window.__productJournal ??= await (
        await import("/product-journal.mjs")
      ).openBrowserDocumentJournal({ identity });
      if (operation === "save") {
        payload.baseBytes = Uint8Array.from(payload.baseBytes);
        payload.candidateBytes = Uint8Array.from(payload.candidateBytes);
        return window.__productJournal.save(payload);
      }
      if (operation === "clear") return window.__productJournal.clear();
      const loaded = await window.__productJournal.load();
      return loaded
        ? {
            ...loaded,
            baseBytes: Array.from(loaded.baseBytes),
            candidateBytes: Array.from(loaded.candidateBytes),
          }
        : null;
    },
    {
      operation,
      payload,
      identity: "onlyoffice-product-session:" + hash(input),
    },
  );
  if (operation === "load" && result) {
    result.baseBytes = Uint8Array.from(result.baseBytes);
    result.candidateBytes = Uint8Array.from(result.candidateBytes);
  }
  return result;
}
const journal = {
  save: async (record) => {
    const metadata = await journalCall("save", {
      ...record,
      baseBytes: Array.from(record.baseBytes),
      candidateBytes: Array.from(record.candidateBytes),
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
    await mainPage.exposeFunction(
      "__ONLYOFFICE_PRODUCT_ADMIT__",
      async (bytes) => {
        if (!pendingAuthorization)
          throw Error("snapshot_authorization_context_missing");
        await pendingAuthorization(Uint8Array.from(bytes));
        return true;
      },
    );
    await mainPage.evaluate(() => {
      window.__comparisonIntent = {
        sourceOperations: null,
        sourceTargets: null,
      };
    });
    await captureStableOnlyOfficeBaseline(mainPage, save);
  },
  inspect: async (bytes) => {
    const opened = await open(bytes);
    try {
      return await opened.page.evaluate(() =>
        window.__productNativePort.observe(),
      );
    } finally {
      await opened.context.close();
    }
  },
  snapshot: async ({ authorize }) => {
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
  "preflight",
  "begin",
  "apply",
  "finish",
  "undo",
  "redo",
])
  engine[method] = (...args) =>
    mainPage.evaluate(
      async ({ method, args }) => window.__productNativePort[method](...args),
      { method, args },
    );
report.nativeTransport = "origin-and-session-bound-message-port";
const session = createProductSession({
  engine,
  journal,
  validateCommand: validate,
  operationContracts: capabilities.mutationModel.operations,
  verifyObservation: verifyOnlyOfficeProductObservation,
});
try {
  const before = await session.open(input);
  report.stages.push("original-open-and-file-admission");
  report.rendering = { before: await pixels(mainFrame) };
  const target = before.slides[0].elements.find(
    (x) => x.kind === "shape" && Number.isFinite(x.x),
  );
  assert(target);
  const command = Object.fromEntries(
    Object.keys(capabilities.toolInputSchema.properties).map((key) => [
      key,
      null,
    ]),
  );
  const operation = flags("--operation", "move");
  report.operation = operation;
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
    replace_text: { text: "Verified product text" },
    fill_color: { color: 0xffe600 },
    resize: { width: target.width + 500, height: target.height + 500 },
    rotate: { degrees: 15 },
    flip: { axis: "horizontal" },
    set_shape_name: { name: "Verified title" },
    line_color: { color: 0xff0000 },
  };
  Object.assign(command, args[operation]);
  const applied = await session.apply({
    expectedRevision: before.revision,
    commands: [command],
  });
  report.stages.push("canonical-command-live-apply-file-reopen-journal");
  await fs.writeFile(
    path.join(output, "observations.json"),
    JSON.stringify({ before, edited: applied.observation }, null, 2),
  );
  assert.notEqual(applied.observation.revision, before.revision);
  const afterTarget =
    applied.observation.slides[0].elements[
      Number(target.elementId.split("/")[1])
    ];
  const drawing =
    applied.observation.slides[0].onlyoffice.drawings[
      Number(target.elementId.split("/")[1])
    ];
  const styles = drawing.paragraphs?.flatMap((p) => p.runs.map((r) => r.style));
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
    assert.equal(afterTarget.text.trim(), command.text);
  for (const element of before.slides[0].elements.filter(
    (e) => e.elementId !== target.elementId,
  ))
    assert.deepEqual(
      applied.observation.slides[0].elements.find(
        (e) => e.elementId === element.elementId,
      ),
      element,
    );

  await fs.writeFile(
    path.join(output, "edited.pptx"),
    persisted.candidateBytes,
  );
  report.rendering.edited = await pixels(mainFrame);
  if (!["set_shape_name", "font_family", "flip"].includes(operation))
    assert.notEqual(
      report.rendering.edited.sha256,
      report.rendering.before.sha256,
    );
  await mainPage.screenshot({ path: path.join(output, "edited.png") });
  await session.undo();
  report.rendering.undo = await pixels(mainFrame);
  assert.deepEqual(report.rendering.undo, report.rendering.before);
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
  };
  await assert.rejects(
    session.apply({
      expectedRevision: before.revision,
      commands: [rollbackCommand],
    }),
    /injected_after_native_change/,
  );
  engine.apply = originalApply;
  assert.deepEqual(await pixels(mainFrame), report.rendering.before);
  assert.equal(session.status().redo, 1);
  report.stages.push("native-failure-rollback-retains-old-redo");
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
  assert.deepEqual(await pixels(mainFrame), report.rendering.before);
  report.stages.push("whole-batch-preflight-before-native-history");
  await session.redo();
  report.rendering.redo = await pixels(mainFrame);
  assert.deepEqual(report.rendering.redo, report.rendering.edited);
  report.stages.push("redo-exact-approved-package");
  await assert.rejects(
    session.apply({ expectedRevision: before.revision, commands: [command] }),
    /stale/,
  );
  report.stages.push("stale-command-refused");
  const recovered = await session.recover();
  verifyOnlyOfficeProductObservation(applied.observation, recovered);
  report.stages.push("recovery-exact-file-readback");
  assert.equal(session.status().undo, 1);
  await session.undo();
  assert.deepEqual(await pixels(mainFrame), report.rendering.before);
  await session.recover();
  assert.equal(session.status().redo, 1);
  await session.redo();
  assert.deepEqual(await pixels(mainFrame), report.rendering.edited);
  report.stages.push("recovered-native-undo-and-redo-branch");
  report.rendering.recovered = await pixels(mainFrame);
  assert.deepEqual(report.rendering.recovered, report.rendering.edited);
  await mainPage.screenshot({ path: path.join(output, "recovered.png") });
  await assert.rejects(
    session.save(async () => ({ candidateSha256: "wrong" })),
    /acknowledgement/,
  );
  assert(persisted);
  report.stages.push("wrong-save-ack-keeps-recovery");
  report.saved = await session.save(async (bytes, receipt) => {
    await fs.writeFile(path.join(output, "saved.pptx"), bytes);
    return { candidateSha256: hash(bytes) };
  });
  assert.equal(persisted, null);
  report.stages.push("acknowledged-exact-file-save");
  report.status = "product-session-first-command-verified";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
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
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
