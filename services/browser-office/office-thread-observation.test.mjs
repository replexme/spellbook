import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("./harness/office-thread.js", import.meta.url),
  "utf8",
);

function thread() {
  const messages = [],
    calls = [];
  const selection = { activeSlide: 0, selected: [{ elementId: "0/0" }] };
  let now = 100;
  const bridge = {
    getUnoComponentContext: () => ({}),
    uno: {
      com: { sun: { star: { frame: { Desktop: { create: () => ({}) } } } } },
    },
    mainPort: { postMessage: (value) => messages.push(structuredClone(value)) },
  };
  const context = vm.createContext({
    Module: { zetajs: { then() {} } },
    WebAssembly,
    testBridge: bridge,
    Date: { now: () => now },
    spellbookMutationContracts: {},
    createSpellbookBrowserNativeAdapter: () => ({}),
    spellbookDocumentOperation(request) {
      calls.push(request);
      if (request.operation === "selection") return structuredClone(selection);
      return {
        revision: `revision-${calls.length}`,
        slides: [{}],
        activeSlide: selection.activeSlide,
        selectedElementIds: selection.selected.map(
          ({ elementId }) => elementId,
        ),
      };
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(
    "zetajs = testBridge; documentChangesWatched = true; documentChanges = 1; start();",
    context,
  );
  const send = (data) => {
    bridge.mainPort.onmessage({ data: { requestId: "test", ...data } });
    return messages.at(-1);
  };
  return {
    calls,
    selection,
    context,
    setTime: (value) => {
      now = value;
    },
    observe: (request = {}) =>
      send({
        command: "native",
        nativeRequest: { operation: "observe", ...request },
      }),
    send,
    fullReads: () =>
      calls.filter(({ operation }) => operation === "observe").length,
  };
}

test("identical observation reuses only engine-owned state and checks live selection", () => {
  const t = thread();
  const first = t.observe({
    observedBefore: { revision: "forged", slides: [] },
  });
  first.value.revision = "page-mutated";
  const second = t.observe();
  assert.equal(second.command, "native-complete");
  assert.equal(second.value.revision, "revision-1");
  assert.equal(t.fullReads(), 1);
  assert.equal(t.calls.at(-1).operation, "selection");
});

test("event changes and unavailable listeners force a fresh observation", () => {
  const t = thread();
  t.observe();
  vm.runInContext("documentChanges += 1", t.context);
  t.observe();
  assert.equal(t.fullReads(), 2);
  vm.runInContext("documentChangesWatched = false", t.context);
  t.observe();
  t.observe();
  assert.equal(t.fullReads(), 4);
});

test("selection and active-slide changes force a fresh observation without modify events", () => {
  const t = thread();
  t.observe();
  t.selection.selected = [{ elementId: "0/1" }];
  t.observe();
  t.selection.activeSlide = 1;
  t.observe();
  assert.equal(t.fullReads(), 3);
});

test("detail, package sections and asset identity are part of the observation request", () => {
  const t = thread();
  t.observe();
  t.observe({ detailSlideIndex: 0 });
  t.observe({ detailSlideIndex: 0, packageSections: [{ name: "Section" }] });
  t.observe({
    detailSlideIndex: 0,
    packageSections: [{ name: "Section" }],
    packageAssetHashes: { image: "new" },
  });
  assert.equal(t.fullReads(), 4);
});

test("serialization and hidden inspection invalidate even when the operation fails", () => {
  for (const command of [
    "store",
    "inspect-saved",
    "normalize-saved",
    "mark-saved",
    "dispatch",
  ]) {
    const t = thread();
    t.observe();
    assert.equal(
      t.send({ command, path: "/tmp/spellbook/native-1.pptx" }).command,
      "error",
    );
    t.observe();
    assert.equal(t.fullReads(), 2, command);
  }
});

test("expired requests cannot receive a cached observation", () => {
  const t = thread();
  t.observe({ expiresAt: 200 });
  t.setTime(201);
  const response = t.observe({ expiresAt: 200 });
  assert.equal(response.command, "error");
  assert.match(response.message, /expired_operation/);
  assert.equal(t.fullReads(), 1);
});

test("batch edit reuse requires revision and package identity and invalidates subsequent reads", () => {
  for (const changedAssets of [false, true]) {
    const t = thread();
    const before = t.observe({ packageAssetHashes: { image: "original" } });
    t.send({
      command: "native",
      nativeRequest: {
        operation: "edit_batch",
        expectedRevision: before.value.revision,
        packageAssetHashes: { image: changedAssets ? "changed" : "original" },
        observedBefore: { revision: "forged" },
      },
    });
    assert.equal(
      t.calls.at(-1).observedBefore?.revision,
      changedAssets ? undefined : before.value.revision,
    );
    t.observe();
    assert.equal(t.fullReads(), 2);
  }
});

test("detail-slide requests invalidate because a read can materialize engine defaults", () => {
  const t = thread();
  t.observe();
  t.send({
    command: "native",
    nativeRequest: { operation: "detail_slide", slideIndex: 0 },
  });
  t.observe();
  assert.equal(t.fullReads(), 2);
});
