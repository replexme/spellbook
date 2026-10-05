/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
const source = new URL("./ooxml-worker-source.mjs", import.meta.url);
function globals(values) {
  const saved = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}
test("helper imports in a Window-like environment preserve its existing message handler", async () => {
  const handler = () => {},
    context = { onmessage: handler };
  const restore = globals({
    self: context,
    DedicatedWorkerGlobalScope: undefined,
  });
  try {
    await import(source.href + "?window-registration-test");
    assert.equal(context.onmessage, handler);
  } finally {
    restore();
  }
});
test("a dedicated Worker registers the file RPC and returns correlated errors", async () => {
  class DedicatedScope {}
  const replies = [],
    context = new DedicatedScope();
  context.postMessage = (value) => replies.push(value);
  const restore = globals({
    self: context,
    DedicatedWorkerGlobalScope: DedicatedScope,
  });
  try {
    await import(source.href + "?dedicated-registration-test");
    assert.equal(typeof context.onmessage, "function");
    await context.onmessage({
      data: {
        requestId: "invalid-package-probe",
        operation: "inspect",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].requestId, "invalid-package-probe");
    assert.equal(typeof replies[0].error, "string");
  } finally {
    restore();
  }
});
test("helper imports in other worker contexts do not install a dedicated-worker RPC", async () => {
  class DedicatedScope {}
  class OtherWorkerScope {}
  const handler = () => {},
    context = new OtherWorkerScope();
  context.onmessage = handler;
  const restore = globals({
    self: context,
    DedicatedWorkerGlobalScope: DedicatedScope,
    WorkerGlobalScope: OtherWorkerScope,
  });
  try {
    await import(source.href + "?other-worker-registration-test");
    assert.equal(context.onmessage, handler);
  } finally {
    restore();
  }
});
