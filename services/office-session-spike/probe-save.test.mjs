import assert from "node:assert/strict";
import test from "node:test";

import { requestNativeProbeSave } from "./probe-save.mjs";

test("browser Office probe saves through its explicit transaction", async () => {
  const priorDocument = globalThis.document;
  const priorOffice = globalThis.spellbookBrowserOffice;
  let saved = false;
  globalThis.document = { body: { dataset: { browserProbe: "ready" } } };
  globalThis.spellbookBrowserOffice = {
    async saveProbe() {
      saved = true;
    },
  };
  try {
    await requestNativeProbeSave({
      url: () => "http://127.0.0.1:4173/workspace?browserProbe=1",
      waitForFunction: async (predicate) => assert.equal(predicate(), true),
      evaluate: async (callback) => callback(),
      getByRole: () => {
        throw new Error("The product toolbar is hidden in probe mode.");
      },
    });
    assert.equal(saved, true);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorOffice === undefined) delete globalThis.spellbookBrowserOffice;
    else globalThis.spellbookBrowserOffice = priorOffice;
  }
});

test("server Office probe still uses its visible Save control", async () => {
  const calls = [];
  await requestNativeProbeSave({
    url: () => "http://127.0.0.1:3190/documents/example",
    getByRole: (role, options) => {
      calls.push([role, options]);
      if (role === "button") return { click: async () => {} };
      return {
        filter: () => ({ waitFor: async () => {} }),
      };
    },
  });
  assert.deepEqual(calls, [
    ["button", { name: "저장", exact: true }],
    ["status", undefined],
  ]);
});
