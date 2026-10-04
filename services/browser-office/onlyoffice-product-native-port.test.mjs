/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { installOnlyOfficeProductPort } from "./onlyoffice/product-native-port.mjs";

test("native product port rejects foreign source, origin and session, and exposes no code execution", async () => {
  const old = globalThis.window;
  let listener,
    closed = 0;
  const client = {};
  const sent = [];
  const port = {
    onmessage: null,
    start() {},
    close() {
      closed++;
    },
    postMessage(value) {
      sent.push(value);
    },
  };
  globalThis.window = {
    addEventListener(_, fn) {
      listener = fn;
    },
    removeEventListener() {},
  };
  const dispose = installOnlyOfficeProductPort({
    clientWindow: client,
    clientOrigin: "http://127.0.0.1:1234",
    sessionId: "a".repeat(32),
  });
  const event = {
    source: client,
    origin: "http://127.0.0.1:1234",
    data: {
      type: "spellbook.onlyoffice-product-connect",
      sessionId: "a".repeat(32),
    },
    ports: [port],
  };
  try {
    listener({ ...event, source: {} });
    listener({ ...event, origin: "http://127.0.0.1:9999" });
    listener({ ...event, data: { ...event.data, sessionId: "b".repeat(32) } });
    assert.equal(port.onmessage, null);
    listener(event);
    assert.equal(sent[0].type, "ready");
    port.onmessage({
      data: { id: "x", method: "eval", payload: "globalThis.compromised=true" },
    });
    port.onmessage({
      data: { id: "y", method: "apply", payload: { op: "move" } },
    });
    port.onmessage({
      data: {
        id: "z",
        method: "preflight",
        payload: Array.from({ length: 51 }, () => ({ op: "move" })),
      },
    });
    await new Promise(setImmediate);
    assert.equal(
      sent.find((x) => x.id === "x").error,
      "onlyoffice_product_method_unavailable",
    );
    assert.equal(
      sent.find((x) => x.id === "y").error,
      "onlyoffice_product_transaction_required",
    );
    assert.equal(
      sent.find((x) => x.id === "z").error,
      "onlyoffice_product_batch_invalid",
    );
    assert.equal(globalThis.compromised, undefined);
  } finally {
    await dispose();
    globalThis.window = old;
  }
  assert.equal(closed, 1);
});
