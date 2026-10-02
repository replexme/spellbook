import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createAutosaveIdleGate } from "./save-transaction.mjs";

const source = await readFile(
  new URL("./harness/app.js", import.meta.url),
  "utf8",
);
const binding = source.slice(
  source.indexOf("function bindReconciledNativeBaseline("),
  source.indexOf("async function checkpointLiveNativeState("),
);
const checkpoint = source.slice(
  source.indexOf("async function checkpointLiveNativeStateOnce("),
  source.indexOf("function download(bytes)"),
);

function session(mode, version = 7) {
  const bytes = new Uint8Array([1]),
    observation = { revision: mode === "noop" ? "old" : "new", slides: [{}] };
  const serializedVersions = new WeakMap();
  if (version !== null) serializedVersions.set(bytes, version);
  const context = vm.createContext({
    browserProbeMode: false,
    query: { get: () => null },
    observed: {},
    reconciledModelRevision: "old",
    reconciledObservation: { revision: "old", slides: [] },
    checkpointedDocumentChanges: 1,
    liveExportBaseline: { revision: "old", bytes: new Uint8Array([0]) },
    unreconciledModelRevision: "",
    currentBytes: new Uint8Array([0]),
    currentSlideCount: 0,
    commands: [],
    productUndoHistory: [],
    productRedoHistory: [],
    requestSequence: 0,
    nativeVersionsBySerializedBytes: serializedVersions,
    nativeVersionsByObservation: new WeakMap([[observation, 7]]),
    captureProductEditState: () => ({
      reconciledModelRevision: "old",
      currentBytes: new Uint8Array([0]),
      reconciledObservation: { slides: [] },
    }),
    reconcileNativeHistoryRevision: () =>
      mode === "history" ? { bytes } : null,
    normalizeDirectEditPersistenceState: (value) => value,
    persistenceStateFromObservation: () => ({}),
    directTextPreservationTarget: () => null,
    directTextGeometryPreservationTarget: () => null,
    directMovePreservationTarget: () => null,
    directDeletePreservationTarget: () => null,
    preserveAndInspectNativeDocument: async () => ({
      bytes,
      serialized: bytes,
      report: {},
    }),
    isRevisionOnlyNativeSnapshot: () => mode === "revision-only",
    admitProductArtifact: async () => {},
    admitProductHistoryArtifact: async () => {},
    recordManualProductCheckpoint() {},
    rememberReconciledObservation() {},
    persistCheckpoint: async () => {},
    serializeNativeDocument: async () => bytes,
    liveExportBaselineAt: () => new Uint8Array([0]),
    mutationPending: new Map(),
    ooxmlWorker: {
      postMessage({ requestId }) {
        context.mutationPending
          .get(requestId)
          .resolve({ report: { changedParts: [] } });
      },
    },
    restoreProductEditState() {},
    reportHostModified() {},
    observation,
    bytes,
  });
  vm.runInContext(binding + checkpoint, context);
  return context;
}

test("every successful manual checkpoint binds the admitted baseline to the engine version", async () => {
  for (const mode of ["edit", "history", "revision-only", "noop"]) {
    const context = session(mode);
    await vm.runInContext(
      'checkpointLiveNativeStateOnce(observation, "manual_save", 0)',
      context,
    );
    assert.equal(context.checkpointedDocumentChanges, 7, mode);
    assert.equal(context.liveExportBaseline.bytes, context.bytes, mode);
    assert.equal(
      context.liveExportBaseline.revision,
      context.observation.revision,
      mode,
    );
  }
});

test("unknown serialized versions retain the full-read requirement", async () => {
  const context = session("edit", null);
  await vm.runInContext(
    'checkpointLiveNativeStateOnce(observation, "manual_save", 0)',
    context,
  );
  assert.equal(context.checkpointedDocumentChanges, null);
});

test("a copied buffer cannot inherit a serialized version and mismatched revisions cannot bind", () => {
  const context = session("edit");
  assert.throws(
    () =>
      vm.runInContext(
        "bindReconciledNativeBaseline(observation, bytes)",
        context,
      ),
    /baseline_mismatch/,
  );
  context.reconciledModelRevision = "new";
  vm.runInContext(
    "bindReconciledNativeBaseline(observation, bytes.slice())",
    context,
  );
  assert.equal(context.checkpointedDocumentChanges, null);
});

test("failed persistence cannot publish a newly checkpointed event version", async () => {
  const context = session("edit");
  context.persistCheckpoint = async () => {
    throw new Error("disk_failure");
  };
  await assert.rejects(
    vm.runInContext(
      'checkpointLiveNativeStateOnce(observation, "manual_save", 0)',
      context,
    ),
    /disk_failure/,
  );
  assert.equal(context.checkpointedDocumentChanges, 1);
});

test("heartbeat retains the admitted retry version when typing advances after its first read", async () => {
  let poll, pending;
  let time = 17_000;
  const autosaveIdleGate = createAutosaveIdleGate(() => time);
  autosaveIdleGate.ready(10);
  time = 20_000;
  const originalRead = {
    value: { revision: "typing-in-progress" },
    documentChanges: 10,
  };
  const context = vm.createContext({
    productMode: true,
    runtimeReady: true,
    hostPort: {},
    productHeartbeat: null,
    currentBytes: new Uint8Array([1]),
    checkpointInFlight: false,
    commands: [],
    unreconciledModelRevision: "",
    selectionTick: 0,
    checkpointedDocumentChanges: 1,
    lastCheckpointAt: 0,
    reconciledModelRevision: "before-typing",
    Date: { now: () => time },
    autosaveIdleGate,
    requestNative: async () => ({ value: null }),
    request: async () => ({ modified: true, documentChanges: 10 }),
    reportHostModified() {},
    observeNativeDocumentChanges: async () => originalRead,
    checkpointLiveNativeState: async () => {
      // The first snapshot races with input. The real checkpointer retries,
      // validates and admits a later version instead of this original read.
      context.reconciledModelRevision = "typing-complete";
      context.checkpointedDocumentChanges = 14;
    },
    persistCheckpoint: async () => {},
    enqueueProductOperation: (operation) => {
      pending = operation();
      return pending;
    },
    setInterval: (callback) => {
      poll = callback;
      return 1;
    },
  });
  const heartbeat = source.slice(
    source.indexOf("function startProductHeartbeat()"),
    source.indexOf("async function runConformance()"),
  );
  // Include the former writer when testing an earlier source: its stale
  // post-retry assignment makes this regression fail rather than throw.
  const oldWriterStart = source.indexOf(
    "function noteCheckpointedDocumentChanges(",
  );
  const oldWriter =
    oldWriterStart < 0
      ? ""
      : source.slice(
          oldWriterStart,
          source.indexOf("function startProductHeartbeat()"),
        );
  vm.runInContext(oldWriter + heartbeat + "startProductHeartbeat();", context);
  autosaveIdleGate.input("compositionstart");
  poll();
  await pending;
  assert.equal(context.checkpointedDocumentChanges, 1);
  assert.equal(context.reconciledModelRevision, "before-typing");
  autosaveIdleGate.input("compositionend");
  time += 1500;
  poll();
  await pending;
  assert.equal(context.checkpointedDocumentChanges, 14);
  assert.equal(context.reconciledModelRevision, "typing-complete");
});

test("a coverage refusal records the actual parts and retains file pairs only in explicit probes", async () => {
  for (const rawProbe of [false, true]) {
    const context = session("noop");
    context.browserProbeMode = rawProbe;
    context.query = { get: () => (rawProbe ? "1" : null) };
    context.savedArtifacts = new Map();
    context.ooxmlWorker = {
      postMessage({ requestId }) {
        context.mutationPending
          .get(requestId)
          .resolve({ report: { changedParts: ["ppt/charts/chart1.xml"] } });
      },
    };
    await assert.rejects(
      vm.runInContext(
        'checkpointLiveNativeStateOnce(observation, "manual_save", 0)',
        context,
      ),
      /browser_native_unobserved_change/,
    );
    assert.deepEqual(
      Array.from(context.observed.nativeCoverageFailure.changedParts),
      ["ppt/charts/chart1.xml"],
    );
    assert.equal(context.observed.nativeCoverageFailure.documentChanges, 7);
    assert.equal(
      context.observed.nativeCoverageFailure.checkpointedDocumentChanges,
      1,
    );
    assert.equal(context.checkpointedDocumentChanges, 1);
    assert.equal(context.savedArtifacts.size, rawProbe ? 2 : 0);
    if (rawProbe) {
      assert.deepEqual(
        Array.from(context.savedArtifacts.get("native-coverage-baseline")),
        [0],
      );
      assert.deepEqual(
        Array.from(context.savedArtifacts.get("native-coverage-candidate")),
        [1],
      );
      assert.notEqual(
        context.savedArtifacts.get("native-coverage-candidate"),
        context.bytes,
      );
    }
  }
});
