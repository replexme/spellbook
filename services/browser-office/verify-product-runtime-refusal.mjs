import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { buildHarness } from "./build-harness.mjs";
import { readRepositoryIdentity } from "./repository-identity.mjs";
import { createHarnessServer } from "./server.mjs";

// Real product-host probe: stock runtime must refuse before touching a
// document or recovery storage, without crashing the browser or host queue.
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const flag = process.argv.indexOf("--output");
const outputRoot = path.resolve(
  flag < 0
    ? "artifacts/browser-office/product-runtime-refusal"
    : process.argv[flag + 1],
);
const fixture = await readFile(
  path.join(repositoryRoot, "eval/public/fixtures/general-native-surface.pptx"),
);
await mkdir(outputRoot, { recursive: true });
await buildHarness();
const server = createHarnessServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(
    `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`,
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  await page.waitForFunction(
    () => document.body.dataset.state === "runtime-ready",
    null,
    { timeout: 60_000 },
  );
  await page.evaluate((hostOrigin) => {
    const channel = new MessageChannel();
    globalThis.__runtimeRefusalEvents = [];
    globalThis.__runtimeRefusalPort = channel.port1;
    channel.port1.onmessage = (event) =>
      globalThis.__runtimeRefusalEvents.push(event.data);
    channel.port1.start();
    window.postMessage(
      { type: "spellbook.browser-office-connect", protocolVersion: 1 },
      hostOrigin,
      [channel.port2],
    );
  }, origin);
  await page.waitForFunction(() =>
    globalThis.__runtimeRefusalEvents.some(({ type }) => type === "ready"),
  );
  // Send twice to verify a refusal does not poison the shared operation queue.
  for (let index = 0; index < 2; index++) {
    await page.evaluate(
      ({ source, requestId }) => {
        const bytes = Uint8Array.from(source);
        globalThis.__runtimeRefusalPort.postMessage(
          {
            type: "open",
            requestId,
            fileName: "runtime-refusal.pptx",
            documentId: "runtime-refusal",
            revision: "baseline",
            maxBytes: 64 * 1024 * 1024,
            bytes: bytes.buffer,
          },
          [bytes.buffer],
        );
      },
      { source: Array.from(fixture), requestId: `open-${index}` },
    );
    await page.waitForFunction(
      (count) =>
        globalThis.__runtimeRefusalEvents.filter(({ type }) => type === "error")
          .length === count,
      index + 1,
      { timeout: 10_000 },
    );
  }
  const evidence = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const storageEntries = [];
    for await (const [name] of root.entries()) storageEntries.push(name);
    return {
      state: document.body.dataset.state,
      events: globalThis.__runtimeRefusalEvents,
      runtime: globalThis.spellbookBrowserRuntimeCandidate,
      storageEntries,
    };
  });
  assert.equal(evidence.runtime.buildReady, false);
  assert.equal(evidence.state, "runtime-ready");
  assert.deepEqual(evidence.storageEntries, []);
  assert.equal(
    evidence.events.filter(({ type }) => type === "error").length,
    2,
  );
  assert.equal(
    evidence.events.some(({ type }) => type === "open-complete"),
    false,
  );
  for (const event of evidence.events.filter(({ type }) => type === "error"))
    assert.match(event.error, /requires a verified runtime/u);
  assert.deepEqual(pageErrors, []);
  const result = {
    status: "unadmitted-product-runtime-refused",
    integrationSource: readRepositoryIdentity(repositoryRoot),
    ...evidence,
    pageErrors,
  };
  await writeFile(
    path.join(outputRoot, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
