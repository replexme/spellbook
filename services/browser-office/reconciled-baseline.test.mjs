import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
