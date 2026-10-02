/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createOnlyOfficeComparisonHost } from "./onlyoffice/comparison-host.mjs";

async function host() {
  let options,
    value = 1;
  const requests = [],
    workers = [];
  class Worker {
    constructor() {
      workers.push(this);
    }
    postMessage(message) {
      requests.push(message);
    }
    reply(bytes) {
      const message = requests.at(-1);
      this.onmessage({
        data: {
          requestId: message.requestId,
          bytes: Uint8Array.of(bytes),
          report: {},
        },
      });
    }
  }
  const window = {};
  const context = vm.createContext({
    window,
    Worker,
    File,
    Uint8Array,
    Map,
    Error,
    Promise,
    structuredClone,
    crypto: { randomUUID },
    performance,
    document: { querySelector: () => ({}) },
    fetch: async () => ({ arrayBuffer: async () => Uint8Array.of(1).buffer }),
    repairCandidatePptxStructure: (_original, bytes) => ({ bytes, report: {} }),
    createOfficeEditor: async (_container, configuration) => {
      options = configuration;
      return {
        getState: () => ({ status: "ready" }),
        destroy: async () => {},
        save: async () => {
          const file = new File([Uint8Array.of(value)], "test.pptx");
          await options.onSave(file);
          return file;
        },
      };
    },
  });
  const html = createOnlyOfficeComparisonHost({
    origin: "http://127.0.0.1:1",
    preserveSource: true,
    repairStructure: true,
  });
  const script = html
    .slice(
      html.indexOf('<script type="module">') + '<script type="module">'.length,
      html.indexOf("</script>"),
    )
    .replace(/^\s*import .*;\n/u, "")
    .replace(
      "(await import('/comparison-repair.js')).repairCandidatePptxStructure",
      "repairCandidatePptxStructure",
    );
  await vm.runInContext(`(async()=>{${script}})()`, context);
  assert.equal(window.__ONLYOFFICE_SAVE_E2E__.getStatus().error, null);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  window.__comparisonCaptureBaseline = true;
  await window.__ONLYOFFICE_SAVE_E2E__.save();
  window.__comparisonCaptureBaseline = false;
  return {
    window,
    requests,
    worker: workers[0],
    settle,
    setValue: (next) => (value = next),
  };
}

test("source preservation binds intent and baseline to its save and advances only after persistence", async () => {
  const h = await host();
  h.window.__comparisonIntent = {
    sourceOperations: null,
    sourceTargets: [{ slideIndex: 1 }],
  };
  h.window.__holdSave = true;
  h.setValue(2);
  const first = h.window.__ONLYOFFICE_SAVE_E2E__.save();
  h.window.__comparisonIntent.sourceTargets[0].slideIndex = 2;
  h.window.__holdSave = false;
  await h.settle();
  assert.equal(h.requests[0].sourceTargets[0].slideIndex, 1);
  assert.deepEqual([...h.requests[0].bytes], [1]);
  assert.deepEqual([...h.requests[0].noEditBytes], [1]);
  // A stray worker response cannot settle another request.
  h.worker.onmessage({ data: { requestId: "unknown", error: "unrelated" } });
  assert.equal(h.window.__ONLYOFFICE_SAVE_E2E__.getStatus().writeCount, 0);
  h.worker.reply(12);
  await h.settle();
  assert.equal(h.window.__heldSave, true);
  await assert.rejects(
    h.window.__ONLYOFFICE_SAVE_E2E__.save(),
    /save_in_flight/,
  );
  assert.equal(h.window.__ONLYOFFICE_SAVE_E2E__.getStatus().writeCount, 0);
  h.window.__releaseSave();
  await first;
  h.setValue(3);
  const second = h.window.__ONLYOFFICE_SAVE_E2E__.save();
  await h.settle();
  assert.equal(h.requests[1].sourceTargets[0].slideIndex, 2);
  assert.deepEqual([...h.requests[1].bytes], [12]);
  assert.deepEqual([...h.requests[1].noEditBytes], [2]);
  h.worker.reply(13);
  await second;
  assert.equal(h.window.__ONLYOFFICE_SAVE_E2E__.getStatus().writeCount, 2);
});

test("worker rejection keeps the accepted baseline and releases the failed save slot", async () => {
  const h = await host();
  h.window.__comparisonIntent = { sourceOperations: null, sourceTargets: null };
  h.setValue(2);
  const rejected = assert.rejects(
    h.window.__ONLYOFFICE_SAVE_E2E__.save(),
    /worker_failed/,
  );
  await h.settle();
  h.worker.onerror({ message: "worker_failed" });
  await rejected;
  h.setValue(3);
  const next = h.window.__ONLYOFFICE_SAVE_E2E__.save();
  await h.settle();
  assert.deepEqual([...h.requests[1].bytes], [1]);
  assert.deepEqual([...h.requests[1].noEditBytes], [1]);
  h.worker.reply(13);
  await next;
  assert.equal(h.window.__ONLYOFFICE_SAVE_E2E__.getStatus().writeCount, 1);
});

test("comparison hosts require loopback and source-preserved artifacts require format repair", () => {
  assert.throws(
    () => createOnlyOfficeComparisonHost({ origin: "https://example.com" }),
    /loopback/,
  );
  assert.throws(
    () =>
      createOnlyOfficeComparisonHost({
        origin: "http://localhost",
        preserveSource: true,
      }),
    /structure repair/,
  );
});
