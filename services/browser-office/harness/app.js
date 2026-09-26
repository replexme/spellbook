/* SPDX-License-Identifier: MPL-2.0 */

import {
  openBrowserDocumentJournal,
  requestPersistentBrowserStorage,
} from "/harness/opfs-journal.mjs";
import {
  browserCaptureTargets,
  withBrowserVisualEvidence,
} from "/harness/browser-visual-evidence.mjs";
import {
  persistedSectionsMatch,
  persistedSlideTopologyMatches,
} from "/harness/product-persistence.mjs";
import {
  reconcileNativeHistoryRevision,
  recordManualProductCheckpoint,
  snapshotProductEditState,
  trimSessionProductHistory,
} from "/harness/product-history.mjs";
import {
  intendedDocumentMutationDifferences,
  persistenceStateFromObservation,
  withAuthoredUntargetedShapes,
} from "/harness/persistence-evidence.mjs";
import {
  acknowledgedSaveHasLaterChanges,
  createSaveSnapshot,
  journalSnapshotFromSavedBase,
  journalRecoveryDisposition,
} from "/harness/save-transaction.mjs";
import { installTextInputBridge } from "/harness/text-input-bridge.mjs";
import "/harness/runtime-admission.js";

const body = document.body;
const canvas = document.querySelector("#qtcanvas");
const status = document.querySelector("#status");
const evidence = document.querySelector("#evidence");
const fileInput = document.querySelector("#file-input");
const insertSlideButton = document.querySelector("#insert-slide");
const undoButton = document.querySelector("#undo");
const saveButton = document.querySelector("#save");
const productMode = location.pathname === "/workspace";
const query = new URLSearchParams(location.search);
const browserProbeMode = productMode && query.get("browserProbe") === "1";
const compactEditor = window.matchMedia("(max-width: 760px)");
const productBridgeSessionId = productMode ? crypto.randomUUID() : "";
const expectedHostOrigin = productMode ? query.get("hostOrigin") : null;
const networkFetch = globalThis.fetch.bind(globalThis);

let enginePort;
let engineDocumentOpen = false;
let hostPort;
let hostRevision = "";
let hostMaximumBytes = 0;
let lastReportedModified = false;
let filename = "document.pptx";
let activePath = "/tmp/spellbook/document.pptx";
let requestSequence = 0;
const pending = new Map();
const mutationPending = new Map();
const observed = { marks: {}, events: [], runs: [] };
const savedArtifacts = new Map();
const upstreamUiSettleMs = 1_000;
const history = [];
const verifiedTopologyOperations = "add,duplicate,move,delete";
const verifiedMetadataOperations = "rename,hide";
const recoveryMarker = "spellbook-browser-office-recovery-v1";
const conformanceLabels = [
  "after-insert",
  "after-duplicate",
  "after-move",
  "after-delete",
  "after-rename",
  "after-hide",
];
const productElementOperations = new Set([
  "replace_text",
  "move",
  "resize",
  "rotate",
  "fill_color",
  "line_color",
  "line_width",
  "fill_opacity",
  "line_opacity",
  "font_size",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "font_family",
  "font_color",
  "paragraph_alignment",
]);
const productSlideOperations = new Set([
  "insert_slide",
  "duplicate_slide",
  "delete_slide",
  "move_slide",
  "rename_slide",
  "set_slide_hidden",
]);
const packageOnlyProductOperations = new Set(["set_sections"]);
const nativeExactUndoOperations = new Set([
  "replace_text",
  "move",
  "resize",
  "fill_color",
]);
const patchedRuntimeOnlyProductOperations = new Set([
  "font_size",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "font_family",
  "font_color",
  "paragraph_alignment",
  "rotate",
  "line_color",
  "line_width",
  "fill_opacity",
  "line_opacity",
  "insert_slide",
  "rename_slide",
  "set_slide_hidden",
]);
const paragraphAlignmentByUnoValue = new Map([
  [0, "left"],
  [1, "right"],
  [2, "justify"],
  [3, "center"],
]);
let currentBytes;
let currentSlideCount = 0;
let baseBytes;
let baseModelRevision = "";
let journal;
let productExportQueue = Promise.resolve();
let productMessageQueue = Promise.resolve();
let browserProbeActivity = null;
let browserProbePhaseTrace = [];
const commands = [];
const productUndoHistory = [];
const productRedoHistory = [];
let reconciledModelRevision = "";
let unreconciledModelRevision = "";
let reconciledObservation = null;
// The engine's save of the live document at one reconciled revision, taken
// when the document opens or kept from the previous edit's save. Comparing
// two saves of the same live document isolates what the edit changed. A
// fresh load of the saved file can differ from the live document in details
// no edit made (for example an empty paragraph's alignment), and comparing
// against it let those differences reach the author's file. A save taken at
// open has no revision until the opener observes the document.
let liveExportBaseline = null;

function captureProductEditState() {
  return snapshotProductEditState({
    currentBytes,
    currentSlideCount,
    commands,
    undoHistory: productUndoHistory,
    redoHistory: productRedoHistory,
    reconciledModelRevision,
    unreconciledModelRevision,
    reconciledObservation,
  });
}

function restoreProductEditState(state) {
  currentBytes = state.currentBytes;
  currentSlideCount = state.currentSlideCount;
  commands.splice(0, commands.length, ...state.commands);
  productUndoHistory.splice(0, productUndoHistory.length, ...state.undoHistory);
  productRedoHistory.splice(0, productRedoHistory.length, ...state.redoHistory);
  reconciledModelRevision = state.reconciledModelRevision;
  unreconciledModelRevision = state.unreconciledModelRevision;
  reconciledObservation = state.reconciledObservation;
}

function rebaseCommandsToSavedBase(reason) {
  const snapshot = journalSnapshotFromSavedBase({
    baseBytes,
    currentBytes,
    baseRevision: baseModelRevision,
    currentRevision: reconciledModelRevision,
    reason,
  });
  commands.splice(0, commands.length, ...(snapshot ? [snapshot] : []));
  return Boolean(snapshot);
}

function rememberReconciledObservation(observation) {
  if (
    !observation ||
    observation.revision !== reconciledModelRevision ||
    !Array.isArray(observation.slides) ||
    !Array.isArray(observation.masters)
  )
    throw new Error("browser_reconciled_observation_mismatch");
  reconciledObservation = {
    revision: observation.revision,
    slides: structuredClone(observation.slides),
    masters: structuredClone(observation.masters),
    sections: structuredClone(observation.sections),
    textDetails: structuredClone(observation.textDetails),
  };
}

function clearNativeProductHistoryAvailability() {
  for (const entry of [...productUndoHistory, ...productRedoHistory]) {
    entry.nativeUndoAvailable = false;
    entry.nativeRedoAvailable = false;
  }
}

function patchedBrowserRuntimeAdmitted() {
  return (
    globalThis.spellbookBrowserRuntimeAdmitted?.(
      globalThis.spellbookBrowserRuntimeCandidate,
    ) === true
  );
}

function nativeSlideStructureAdmitted() {
  return (
    patchedBrowserRuntimeAdmitted() &&
    globalThis.spellbookBrowserRuntimeCandidate?.nativeSlideStructureReady ===
      true
  );
}

function nativeUndoAvailableFor(operation) {
  return (
    nativeExactUndoOperations.has(operation) || patchedBrowserRuntimeAdmitted()
  );
}

function setState(nextState, message) {
  body.dataset.state = nextState;
  status.textContent = message;
  observed.marks[nextState] = Math.round(performance.now());
  observed.events.push({
    state: nextState,
    atMs: observed.marks[nextState],
    message,
  });
  evidence.value = JSON.stringify(observed);
}

function request(command, details = {}) {
  const requestId = `browser-office-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, command });
    enginePort.postMessage({ command, requestId, ...details });
  });
}

async function syncSlidePane() {
  const visible = !compactEditor.matches;
  await request("set-editor-slide-pane", { visible });
  body.dataset.defaultSlidePane = visible ? "open" : "closed";
}

compactEditor.addEventListener("change", () => {
  if (!productMode || !engineDocumentOpen) return;
  void syncSlidePane().catch((error) => {
    body.dataset.defaultSlidePane = "unavailable";
    observed.events.push({
      state: "view-warning",
      atMs: Math.round(performance.now()),
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

function settle(message) {
  if (!message.requestId) return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;
  pending.delete(message.requestId);
  if (message.command === "error") waiter.reject(new Error(message.message));
  else waiter.resolve(message);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function writeAndOpen(bytes, name = "document.pptx") {
  liveExportBaseline = null;
  currentBytes = bytes.slice();
  filename = name;
  activePath = `/tmp/spellbook/${name.replace(/[^a-zA-Z0-9._-]/gu, "-")}`;
  if (engineDocumentOpen) {
    if (productMode) clearNativeProductHistoryAvailability();
    await request("close");
    engineDocumentOpen = false;
  }
  try {
    FS.mkdir("/tmp/spellbook");
  } catch {}
  FS.writeFile(activePath, bytes);
  setState("opening", `Opening ${filename}`);
  const result = await request("open", { path: activePath });
  engineDocumentOpen = true;
  currentSlideCount = result.slideCount;
  await waitForUiPaint("document");
  if (productMode) {
    try {
      // The conversation already occupies the right side. Close Impress's
      // properties pane once per open; the native View menu still reopens it.
      await request("set-editor-sidebar", { visible: false });
      body.dataset.defaultSidebar = "closed";
    } catch (error) {
      body.dataset.defaultSidebar = "unavailable";
      observed.events.push({
        state: "view-warning",
        atMs: Math.round(performance.now()),
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await syncSlidePane();
    } catch (error) {
      body.dataset.defaultSlidePane = "unavailable";
      observed.events.push({
        state: "view-warning",
        atMs: Math.round(performance.now()),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (productMode)
    // Saving to PPTX completes the live model (it adds a master's missing
    // placeholders), so a first save taken later would change what an edit
    // reports about the masters. Save once before anything observes the
    // document; the save is also the preservation baseline for the first
    // edit.
    liveExportBaseline = {
      revision: null,
      bytes: await serializeNativeDocument(),
    };
  setState("document-ready", `${filename} · ${result.slideCount} slides`);
  for (const button of [insertSlideButton, undoButton, saveButton])
    button.disabled = false;
  return result;
}

async function runNativeBridgeProbe() {
  const probePackage = await applyMutation(currentBytes, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  await writeAndOpen(
    new Uint8Array(probePackage.bytes),
    "general-native-surface-navigation-probe.pptx",
  );
  const before = (
    await requestNative({ operation: "observe", captureSlideIndexes: [] })
  ).value;
  if (!before?.slides?.length || before.unit !== "1/100mm")
    throw new Error(
      "Browser native observation did not return the PPTX model.",
    );
  const targetSlideIndex = before.slides.findIndex(
    (slide, slideIndex) =>
      slideIndex !== before.activeSlide &&
      slide.elements.some(
        (element) => typeof element.text === "string" && element.text,
      ),
  );
  const target = before.slides[targetSlideIndex]?.elements.find(
    (element) => typeof element.text === "string" && element.text,
  );
  if (!target)
    throw new Error(
      "Browser native bridge fixture has no editable text target on a non-active slide.",
    );
  const replacement = `${target.text} · browser AI bridge`;
  const edited = (
    await requestNative({
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      command: {
        op: "replace_text",
        elementId: target.elementId,
        text: replacement,
      },
      permission: {
        mode: "selection",
        elementIds: [target.elementId],
        slideIndexes: [],
      },
      suppressCapture: true,
    })
  ).value;
  const changed = edited.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.elementId === target.elementId);
  if (changed?.text !== replacement || edited.revision === before.revision)
    throw new Error("Browser native edit did not change the selected text.");
  await request("dispatch", { unoCommand: "Undo" });
  const restored = (
    await requestNative({ operation: "observe", captureSlideIndexes: [] })
  ).value;
  if (restored.revision !== before.revision)
    throw new Error(
      "Browser native Undo did not restore the observed revision.",
    );
  observed.nativeBridge = {
    operation: "replace_text",
    slideCount: before.slides.length,
    sourceActiveSlide: before.activeSlide,
    targetSlideIndex,
    editedActiveSlide: edited.activeSlide,
    elementId: target.elementId,
    editedRevision: edited.revision,
    restoredRevision: restored.revision,
    status: "observe-edit-undo-passed",
  };
  body.dataset.nativeBridge = "observe-edit-undo";
}

async function recordBytes(label, bytes, slideCount, mutation) {
  const entry = {
    label,
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
    slideCount,
    mutation,
  };
  observed.runs.push(entry);
  savedArtifacts.set(label, bytes);
  evidence.value = JSON.stringify(observed);
  return { bytes, entry };
}

async function waitForUiPaint(label) {
  window.dispatchEvent(new Event("resize"));
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  // ZetaOffice's own Web Office example uses this temporary settle window
  // after resize while the upstream Qt canvas-ready signal remains pending.
  await new Promise((resolve) => setTimeout(resolve, upstreamUiSettleMs));
  observed.marks[`${label}-visual-ready`] = Math.round(performance.now());
}

function applyMutation(bytes, command) {
  const requestId = `ooxml-${++requestSequence}`;
  const transferable = bytes.slice();
  return new Promise((resolve, reject) => {
    mutationPending.set(requestId, { resolve, reject });
    ooxmlWorker.postMessage(
      { requestId, bytes: transferable.buffer, command },
      [transferable.buffer],
    );
  });
}

function inspectPackage(bytes) {
  const requestId = `ooxml-inspect-${++requestSequence}`;
  const transferable = bytes.slice();
  return new Promise((resolve, reject) => {
    mutationPending.set(requestId, { resolve, reject });
    ooxmlWorker.postMessage(
      { requestId, bytes: transferable.buffer, operation: "inspect" },
      [transferable.buffer],
    );
  });
}

// The slide and author's name of every element each command names, or the
// slide it names, so the preservation merge can keep everything else as the
// author wrote it; it decides from the operation what it may change there.
// Null when a command names neither or a target cannot be identified.
function nativeSnapshotTargets(observation, commands) {
  const targets = [];
  for (const command of commands) {
    const op = command?.op;
    const elementIds = [
      ...(typeof command?.elementId === "string" ? [command.elementId] : []),
      ...(Array.isArray(command?.elementIds) ? command.elementIds : []),
    ];
    if (!elementIds.length) {
      if (!Number.isSafeInteger(command?.slideIndex)) return null;
      targets.push({ op, slideIndex: command.slideIndex });
      continue;
    }
    for (const elementId of elementIds) {
      const [slide, shape] = String(elementId).split("/");
      const slideIndex = Number(slide);
      const element = observation?.slides?.[slideIndex]?.elements?.find(
        (candidate) => candidate.elementId === `${slide}/${shape}`,
      );
      if (!Number.isSafeInteger(slideIndex) || !element?.name) return null;
      targets.push({ op, slideIndex, name: element.name });
    }
  }
  return targets;
}

function preserveNativeSnapshot(
  original,
  noEdit,
  edited,
  sourceOperations,
  sourceTargets = null,
) {
  const requestId = `ooxml-preserve-${++requestSequence}`;
  const source = original.slice();
  const baseline = noEdit.slice();
  const candidate = edited.slice();
  return new Promise((resolve, reject) => {
    mutationPending.set(requestId, { resolve, reject });
    ooxmlWorker.postMessage(
      {
        requestId,
        operation: "preserve-native",
        bytes: source.buffer,
        noEditBytes: baseline.buffer,
        editedBytes: candidate.buffer,
        sourceOperations,
        sourceTargets,
      },
      [source.buffer, baseline.buffer, candidate.buffer],
    );
  });
}

// The browser engine keeps no slide sections; the package holds them. Each
// engine request carries the sections of the package it observes, so its
// observation and revision cover them as the Office engine's do.
const packageSectionsByBytes = new WeakMap();
async function packageSectionsOf(bytes) {
  if (!bytes) return [];
  if (!packageSectionsByBytes.has(bytes))
    packageSectionsByBytes.set(
      bytes,
      (await inspectPackage(bytes)).report.sections,
    );
  return packageSectionsByBytes.get(bytes);
}

const mediaFileExtensions = Object.freeze({
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
});

async function requestNative(nativeRequest) {
  // The engine reads audio and video with its own file calls, which go to
  // this page's file system, not the engine thread's copy; write the file
  // here and name it in the request.
  const mediaPath =
    ["insert_media", "replace_media"].includes(nativeRequest.operation) &&
    nativeRequest.assetBytes instanceof ArrayBuffer &&
    Object.hasOwn(mediaFileExtensions, nativeRequest.mediaType)
      ? `/tmp/spellbook-assets/${crypto.randomUUID()}.${mediaFileExtensions[nativeRequest.mediaType]}`
      : null;
  if (mediaPath) {
    FS.mkdirTree("/tmp/spellbook-assets");
    FS.writeFile(mediaPath, new Uint8Array(nativeRequest.assetBytes));
  }
  try {
    return await request("native", {
      nativeRequest: {
        ...nativeRequest,
        ...(mediaPath ? { assetPath: mediaPath } : {}),
        packageSections: await packageSectionsOf(currentBytes),
      },
    });
  } finally {
    if (mediaPath)
      try {
        FS.unlink(mediaPath);
      } catch {}
  }
}

async function withPackageDocumentMetadata(value) {
  if (!currentBytes || !value || typeof value !== "object") return value;
  return { ...value, sections: await packageSectionsOf(currentBytes) };
}

function verifyPreparedSlideTopology(command, report) {
  if (
    !["add_slide", "duplicate_slide", "delete_slide", "move_slide"].includes(
      command.op,
    )
  )
    return;
  if (
    !persistedSlideTopologyMatches(
      command,
      report.slideIdsBefore,
      report.slideIdsAfter,
    )
  )
    throw new Error("browser_package_topology_not_persisted");
}

async function serializeNativeDocument({
  inspect = false,
  detailSlideIndex,
} = {}) {
  const outputPath = `/tmp/spellbook/native-${++requestSequence}.pptx`;
  try {
    await request("store", { path: outputPath });
    const bytes = FS.readFile(outputPath).slice();
    if (
      bytes.byteLength < 4 ||
      bytes.byteLength > hostMaximumBytes ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b
    )
      throw new Error("Browser native serialization produced an invalid PPTX.");
    if (!inspect) return bytes;
    const saved = await request("inspect-saved", {
      path: outputPath,
      detailSlideIndex,
      packageSections: await packageSectionsOf(bytes),
    });
    return { bytes, observation: saved.value };
  } finally {
    try {
      FS.unlink(outputPath);
    } catch {}
  }
}

async function normalizeNativeDocumentBytes(bytes) {
  const inputPath = `/tmp/spellbook/native-${++requestSequence}.pptx`;
  const outputPath = `/tmp/spellbook/normalized-${++requestSequence}.pptx`;
  try {
    FS.writeFile(inputPath, bytes);
    await request("normalize-saved", { path: inputPath, outputPath });
    const normalized = FS.readFile(outputPath).slice();
    if (
      normalized.byteLength < 4 ||
      normalized.byteLength > hostMaximumBytes ||
      normalized[0] !== 0x50 ||
      normalized[1] !== 0x4b
    )
      throw new Error(
        "Browser no-edit normalization produced an invalid PPTX.",
      );
    return normalized;
  } finally {
    for (const path of [inputPath, outputPath]) {
      try {
        FS.unlink(path);
      } catch {}
    }
  }
}

async function inspectNativeDocumentBytes(bytes, detailSlideIndex) {
  const path = `/tmp/spellbook/native-${++requestSequence}.pptx`;
  try {
    FS.writeFile(path, bytes);
    const observed = await request("inspect-saved", {
      path,
      detailSlideIndex,
      packageSections: await packageSectionsOf(bytes),
    });
    return observed.value;
  } finally {
    try {
      FS.unlink(path);
    } catch {}
  }
}

async function preserveAndInspectNativeDocument(
  originalBytes,
  detailSlideIndex,
  sourceOperations,
  sourceTargets = null,
  baselineBytes = null,
) {
  markBrowserProbePhase("snapshot:serialize");
  const serialized = await serializeNativeDocument();
  markBrowserProbePhase("snapshot:normalize");
  const noEdit =
    baselineBytes?.slice() ??
    (await normalizeNativeDocumentBytes(originalBytes));
  if (browserProbeMode && query.get("nativeRaw") === "1") {
    savedArtifacts.set("native-snapshot-original", originalBytes.slice());
    savedArtifacts.set("native-snapshot-no-edit", noEdit.slice());
    savedArtifacts.set("native-snapshot-edited", serialized.slice());
  }
  markBrowserProbePhase("snapshot:preserve");
  const preserved = await preserveNativeSnapshot(
    originalBytes,
    noEdit,
    serialized,
    sourceOperations,
    sourceTargets,
  );
  const bytes = new Uint8Array(preserved.bytes);
  if (browserProbeMode && query.get("nativeRaw") === "1")
    savedArtifacts.set("native-snapshot-preserved", bytes.slice());
  markBrowserProbePhase("snapshot:inspect");
  const observation = await inspectNativeDocumentBytes(bytes, detailSlideIndex);
  return { bytes, observation, report: preserved.report, serialized };
}

// The kept save of the live document when it matches the reconciled live
// model; otherwise the caller falls back to a fresh load of the saved file.
function liveExportBaselineAt(liveRevision) {
  return liveRevision &&
    liveRevision === reconciledModelRevision &&
    liveExportBaseline?.revision === liveRevision
    ? liveExportBaseline.bytes.slice()
    : null;
}

// Binds the save taken at open to the revision observed right after it.
function bindOpenExportBaseline(revision) {
  if (liveExportBaseline && liveExportBaseline.revision === null)
    liveExportBaseline.revision = revision;
}

function assertPersistedNativeIntent(
  before,
  expected,
  reopened,
  preservationReport,
) {
  const state = (observation) => ({
    ...persistenceStateFromObservation(observation),
    sections: observation?.sections,
  });
  const beforeState = state(before);
  // The merge keeps the author's XML for every shape the command did not
  // name, so the saved file cannot carry a live-model change there: those
  // shapes are compared as the author left them.
  const scopes = Array.isArray(preservationReport?.authoredShapeScopes)
    ? new Map(
        preservationReport.authoredShapeScopes.map(([slideIndex, names]) => [
          slideIndex,
          names === null ? null : new Set(names),
        ]),
      )
    : null;
  const differences = intendedDocumentMutationDifferences(
    {
      before: beforeState,
      expected: withAuthoredUntargetedShapes(
        beforeState,
        state(expected),
        scopes,
      ),
      observed: state(reopened),
    },
    { limit: 5 },
  );
  if (differences.length)
    throw new Error(
      `browser_native_snapshot_not_persisted:${differences[0].path}${
        browserProbeMode
          ? `:${JSON.stringify({ differences, preservation: preservationReport })}`
          : ""
      }`,
    );
}

async function mutate(command) {
  if (!currentBytes) throw new Error("Open a PPTX before editing slides.");
  const before = currentBytes.slice();
  const result = await applyMutation(before, command);
  history.push(before);
  await writeAndOpen(new Uint8Array(result.bytes), filename);
  commands.push(command);
  await persistCheckpoint();
  undoButton.disabled = false;
  observed.lastMutation = result.report;
  evidence.value = JSON.stringify(observed);
  return result.report;
}

async function addSlide() {
  return mutate({
    op: "add_slide",
    templateSlideIndex: 0,
    insertIndex: currentSlideCount,
  });
}

async function undoMutation() {
  const previous = history.pop();
  if (!previous) throw new Error("There is no browser mutation to undo.");
  const result = await writeAndOpen(previous, filename);
  commands.pop();
  await persistCheckpoint();
  undoButton.disabled = history.length === 0;
  return result;
}

async function observeNativeDocument() {
  return (await observeNativeDocumentChanges()).value;
}

// The observation with the engine's change count for the state it read.
async function observeNativeDocumentChanges() {
  const result = await requestNative({
    operation: "observe",
    captureSlideIndexes: [],
  });
  if (
    !result.value ||
    typeof result.value.revision !== "string" ||
    !result.value.revision
  )
    throw new Error("Browser Office observation has no document revision.");
  return result;
}

// A small sample of the visible canvas. Comparing samples tells whether the
// editor has repainted since an edit; LibreOffice paints after the model
// changes, not at the moment the edit call returns.
// The AI sees each slide as the engine draws it, the way the server editor
// shows it: the engine renders the slide to PNG, so the image does not wait
// for the page to repaint and a hidden browser tab still gets the current
// slide.
async function attachBrowserVisualEvidence(nativeRequest, value) {
  let targets = [];
  const images = [];
  let captureError = null;
  try {
    targets = browserCaptureTargets(nativeRequest, value);
    for (const slideIndex of targets) {
      const rendered = await request("render-slide", { slideIndex });
      images.push({ slideIndex, pngBytes: Array.from(rendered.png) });
    }
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error);
  }
  if (captureError)
    return {
      ...withBrowserVisualEvidence(value, images, targets),
      visualEvidenceComplete: false,
      visualEvidenceError: captureError,
    };
  return withBrowserVisualEvidence(value, images, targets);
}

function parseExpectedSlides(value) {
  let slides;
  try {
    slides = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Browser edit expectedSlides is invalid JSON.");
  }
  if (!Array.isArray(slides))
    throw new Error("Browser edit expectedSlides must be an array.");
  return slides;
}

function expectedElementForId(slides, elementId) {
  for (const slide of slides) {
    if (!Array.isArray(slide?.elements)) continue;
    const element = slide.elements.find(
      (candidate) => candidate?.elementId === elementId,
    );
    if (element) return element;
  }
  throw new Error("Browser package target is absent from expectedSlides.");
}

function firstModelDifference(left, right, path = "slides") {
  if (Object.is(left, right)) return null;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return path;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const difference = firstModelDifference(
      left[key],
      right[key],
      `${path}.${key}`,
    );
    if (difference) return difference;
  }
  return null;
}

function requiredObservedNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`Browser observation has no usable ${name}.`);
  return number;
}

function requiredWholeTextFormatting(element) {
  const formatting = element?.wholeTextFormatting;
  if (!formatting || typeof formatting !== "object")
    throw new Error("Browser observation has no uniform text formatting.");
  return formatting;
}

function hundredthsOfPoint(value, name) {
  return Math.round(requiredObservedNumber(value, name) * 100);
}

function normalizedFontSize(value, name) {
  return Math.round(requiredObservedNumber(value, name) * 20) * 5;
}

const fillStyleMembers = ["NONE", "SOLID", "GRADIENT", "HATCH", "BITMAP"];
const lineStyleMembers = ["NONE", "SOLID", "DASH"];

// Observed UNO enumerators arrive as a member name, a qualified name or an
// ordinal; resolve them to the member name.
function observedEnumMember(value, members) {
  const token = String(value ?? "")
    .split(/[.:]/u)
    .at(-1)
    .toUpperCase();
  return /^\d+$/u.test(token) ? (members[Number(token)] ?? token) : token;
}

function observedItalic(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized.includes("NONE")) return false;
  if (normalized.includes("ITALIC") || normalized.includes("OBLIQUE"))
    return true;
  throw new Error("Browser observation has no usable italic state.");
}

function observedTextDecoration(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number))
    throw new Error("Browser observation has no usable text decoration.");
  return number !== 0;
}

function observedParagraphAlignment(value) {
  const number = Number(value);
  const alignment = paragraphAlignmentByUnoValue.get(number);
  if (!alignment)
    throw new Error(
      "Browser observation has no supported paragraph alignment.",
    );
  return alignment;
}

function textFormattingValues(element, property) {
  const formatting = element?.wholeTextFormatting;
  if (!formatting || typeof formatting !== "object") return [];
  return [
    formatting[property],
    formatting[`${property}Asian`],
    formatting[`${property}Complex`],
  ];
}

function everyTextFormattingValue(element, property, predicate) {
  const values = textFormattingValues(element, property);
  return (
    values.length === 3 &&
    values.every(
      (value) => value !== null && value !== undefined && predicate(value),
    )
  );
}

function productElementMutationMatches(command, target) {
  if (!target) return false;
  try {
    switch (command.op) {
      case "replace_text":
        return target.text === command.text;
      case "move":
        return target.x === command.x && target.y === command.y;
      case "resize":
        return (
          target.width === command.width && target.height === command.height
        );
      case "rotate":
        return target.rotation === command.rotation;
      case "fill_color":
        return target.fill === command.color;
      case "line_color":
        return target.lineColor === command.color;
      case "line_width":
        return target.lineWidth === command.width;
      case "fill_opacity":
        return target.fillOpacity === command.opacity;
      case "line_opacity":
        return target.lineOpacity === command.opacity;
      case "font_size":
        return everyTextFormattingValue(
          target,
          "fontSize",
          (value) => hundredthsOfPoint(value, "font size") === command.size,
        );
      case "bold":
        return everyTextFormattingValue(
          target,
          "fontWeight",
          (value) => Number(value) === (command.bold ? 150 : 100),
        );
      case "italic":
        return everyTextFormattingValue(
          target,
          "fontStyle",
          (value) => observedItalic(value) === command.italic,
        );
      case "underline":
        return (
          observedTextDecoration(target.wholeTextFormatting?.underline) ===
          command.underline
        );
      case "strikethrough":
        return (
          observedTextDecoration(target.wholeTextFormatting?.strikethrough) ===
          command.strikethrough
        );
      case "font_family":
        return everyTextFormattingValue(
          target,
          "fontFamily",
          (value) => value === command.family,
        );
      case "font_color":
        return target.wholeTextFormatting?.color === command.color;
      case "paragraph_alignment":
        return (
          observedParagraphAlignment(
            target.wholeTextFormatting?.paragraphAlignment,
          ) === command.alignment
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function productMutationMatches(prepared, nativeValue) {
  const command = prepared.command;
  const slides = nativeValue?.slides;
  if (!Array.isArray(slides)) return false;
  switch (command.op) {
    case "set_sections":
      return persistedSectionsMatch(
        command.sections,
        nativeValue.sections,
        slides.length,
      );
    case "add_slide":
    case "duplicate_slide":
      return (
        slides.length === prepared.beforeSlides.length + 1 &&
        Boolean(slides[command.insertIndex])
      );
    case "delete_slide":
      return slides.length === prepared.beforeSlides.length - 1;
    case "move_slide":
      return slides.length === prepared.beforeSlides.length;
    case "rename_slide":
      return slides[command.slideIndex]?.name === command.name;
    case "set_slide_hidden":
      return slides[command.slideIndex]?.hidden === command.hidden;
    default: {
      const target = slides
        .flatMap((slide) => slide.elements ?? [])
        .find((element) => element.elementId === command.elementId);
      return productElementMutationMatches(command, target);
    }
  }
}

async function prepareProductPackageMutation(nativeRequest) {
  if (
    ![
      "edit",
      "edit_batch",
      "insert_image",
      "replace_image",
      "insert_media",
      "replace_media",
    ].includes(nativeRequest?.operation) ||
    nativeRequest.dryRun === true
  )
    return null;
  if (!currentBytes || !journal)
    throw new Error("No browser Office document is open.");
  if (
    typeof nativeRequest.expectedRevision !== "string" ||
    !nativeRequest.expectedRevision
  )
    throw new Error("browser_package_revision_changed");
  if (nativeRequest.expectedRevision !== reconciledModelRevision) {
    const live = await observeNativeDocument();
    if (live.revision !== nativeRequest.expectedRevision)
      throw new Error("browser_package_revision_changed");
    await checkpointLiveNativeState(live, "manual_before_ai");
  }
  const expectedSlides = parseExpectedSlides(nativeRequest.expectedSlides);
  if (
    ["insert_image", "replace_image", "insert_media", "replace_media"].includes(
      nativeRequest.operation,
    )
  ) {
    const isImage = nativeRequest.operation.endsWith("_image");
    if (
      !(nativeRequest.assetBytes instanceof ArrayBuffer) ||
      !nativeRequest.assetBytes.byteLength ||
      nativeRequest.assetBytes.byteLength >
        (isImage ? 5_000_000 : 25_000_000) ||
      (isImage
        ? !["image/png", "image/jpeg"].includes(nativeRequest.mediaType)
        : !Object.hasOwn(mediaFileExtensions, nativeRequest.mediaType))
    )
      throw new Error("invalid_asset");
    const beforeObservation = await observeNativeDocument();
    return {
      persistence: "native_snapshot",
      beforeBytes: currentBytes.slice(),
      beforeRevision: reconciledModelRevision,
      beforeObservation,
      baselineBytes: liveExportBaselineAt(beforeObservation.revision),
      beforeSlides: expectedSlides,
      nativeRequest: structuredClone(nativeRequest),
      persistedNativeRequest: {
        operation: nativeRequest.operation,
        mediaType: nativeRequest.mediaType,
        slideIndex: nativeRequest.slideIndex,
        elementId: nativeRequest.elementId ?? null,
        assetId: nativeRequest.assetId ?? null,
        permission: structuredClone(nativeRequest.permission),
      },
      sourceOperations: [nativeRequest.operation],
      sourceTargets: nativeSnapshotTargets(beforeObservation, [
        {
          op: nativeRequest.operation,
          elementId: nativeRequest.elementId ?? null,
          slideIndex: nativeRequest.slideIndex,
        },
      ]),
    };
  }
  const nativeCommands =
    nativeRequest.operation === "edit_batch"
      ? nativeRequest.commands
      : [nativeRequest.command];
  if (
    !Array.isArray(nativeCommands) ||
    nativeCommands.length < 1 ||
    nativeCommands.length > 50 ||
    nativeCommands.some(
      (command) =>
        !command ||
        typeof command !== "object" ||
        Array.isArray(command) ||
        typeof command.op !== "string",
    )
  )
    throw new Error("Browser edit command is invalid.");
  const command = nativeCommands[0];
  if (
    nativeCommands.length === 1 &&
    packageOnlyProductOperations.has(command.op)
  ) {
    if (nativeRequest.permission?.mode !== "document")
      throw new Error("outside_edit_permission");
    const beforeBytes = currentBytes.slice();
    const packageCommand = productPackageCommand(command, null);
    const mutation = await applyMutation(beforeBytes, packageCommand);
    return {
      persistence: "package_reload",
      beforeBytes,
      beforeRevision: reconciledModelRevision,
      beforeSlides: expectedSlides,
      command: packageCommand,
      mutation,
      sourceOperations: [command.op],
    };
  }
  const localized =
    nativeCommands.length === 1 &&
    (productElementOperations.has(command.op) ||
      productSlideOperations.has(command.op));
  if (!localized) {
    if (!patchedBrowserRuntimeAdmitted())
      throw new Error("browser_native_runtime_patch_required");
    const beforeObservation = await observeNativeDocument();
    return {
      persistence: "native_snapshot",
      beforeBytes: currentBytes.slice(),
      beforeRevision: reconciledModelRevision,
      beforeObservation,
      baselineBytes: liveExportBaselineAt(beforeObservation.revision),
      beforeSlides: expectedSlides,
      nativeRequest: {
        operation: nativeRequest.operation,
        ...(nativeRequest.operation === "edit_batch"
          ? { commands: structuredClone(nativeCommands) }
          : { command: structuredClone(command) }),
        permission: structuredClone(nativeRequest.permission),
        suppressCapture: true,
      },
      sourceOperations: nativeCommands.map(({ op }) => op),
      sourceTargets: nativeSnapshotTargets(beforeObservation, nativeCommands),
    };
  }
  if (productSlideOperations.has(command.op) && !nativeSlideStructureAdmitted())
    throw new Error("browser_native_slide_structure_not_ready");
  if (
    patchedRuntimeOnlyProductOperations.has(command.op) &&
    !patchedBrowserRuntimeAdmitted()
  )
    throw new Error("browser_native_runtime_patch_required");
  if (
    productElementOperations.has(command.op) &&
    typeof command.elementId !== "string"
  )
    throw new Error("Browser element command is invalid.");
  const expectedElement = productElementOperations.has(command.op)
    ? expectedElementForId(expectedSlides, command.elementId)
    : null;
  const packageCommand = productPackageCommand(command, expectedElement);
  const beforeBytes = currentBytes.slice();
  const mutation = await applyMutation(beforeBytes, packageCommand);
  verifyPreparedSlideTopology(packageCommand, mutation.report);
  return {
    beforeBytes,
    beforeRevision: reconciledModelRevision,
    beforeSlides: expectedSlides,
    nativeCommand: structuredClone(command),
    nativeRequest: {
      operation: "edit",
      command: structuredClone(command),
      permission: structuredClone(nativeRequest.permission),
      suppressCapture: true,
    },
    permission: structuredClone(nativeRequest.permission),
    command: packageCommand,
    mutation,
  };
}

function productPackageCommand(command, expectedElement) {
  const base = { op: command.op, elementId: command.elementId };
  switch (command.op) {
    case "set_sections":
      return {
        op: command.op,
        sections: structuredClone(command.sections),
      };
    case "insert_slide":
      return {
        op: "add_slide",
        templateSlideIndex: command.slideIndex,
        insertIndex: command.slideIndex + 1,
      };
    case "duplicate_slide":
      return {
        op: command.op,
        slideIndex: command.slideIndex,
        insertIndex: command.slideIndex + 1,
      };
    case "delete_slide":
      return { op: command.op, slideIndex: command.slideIndex };
    case "move_slide":
      return {
        op: command.op,
        slideIndex: command.slideIndex,
        insertIndex: command.targetSlideIndex,
      };
    case "rename_slide":
      return {
        op: command.op,
        slideIndex: command.slideIndex,
        name: String(command.name).trim(),
      };
    case "set_slide_hidden":
      return {
        op: command.op,
        slideIndex: command.slideIndex,
        hidden: command.hidden,
      };
    case "replace_text":
      if (
        typeof expectedElement.text !== "string" ||
        typeof command.text !== "string"
      )
        throw new Error("Browser replace_text command is invalid.");
      return {
        ...base,
        expectedText: expectedElement.text,
        text: command.text,
      };
    case "move":
      return {
        ...base,
        expectedX: expectedElement.x,
        expectedY: expectedElement.y,
        x: Math.round(command.x),
        y: Math.round(command.y),
      };
    case "resize":
      return {
        ...base,
        expectedWidth: expectedElement.width,
        expectedHeight: expectedElement.height,
        width: Math.round(command.width),
        height: Math.round(command.height),
      };
    case "rotate":
      return {
        ...base,
        expectedRotation: expectedElement.rotation,
        rotation: Math.round(command.degrees * 100),
      };
    case "fill_color":
      return {
        ...base,
        expectedColor: expectedElement.fill,
        expectedSolid: !["NONE", "GRADIENT", "HATCH", "BITMAP"].includes(
          observedEnumMember(expectedElement.fillStyle, fillStyleMembers),
        ),
        color: Math.round(command.color),
      };
    case "line_color":
      return {
        ...base,
        expectedColor: expectedElement.lineColor,
        expectedSolid:
          observedEnumMember(expectedElement.lineStyle, lineStyleMembers) !==
          "NONE",
        color: Math.round(command.color),
      };
    case "line_width":
      return {
        ...base,
        expectedWidth: expectedElement.lineWidth,
        width: Math.round(command.size * 100),
      };
    case "fill_opacity":
      return {
        ...base,
        expectedOpacity: expectedElement.fillOpacity,
        opacity: Math.round(command.opacity),
        expectedColor: expectedElement.fill,
      };
    case "line_opacity":
      return {
        ...base,
        expectedOpacity: expectedElement.lineOpacity,
        opacity: Math.round(command.opacity),
        expectedColor: expectedElement.lineColor,
      };
    case "font_size": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedSize: hundredthsOfPoint(formatting.fontSize, "font size"),
        size: normalizedFontSize(command.size, "font size"),
      };
    }
    case "bold": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedBold:
          requiredObservedNumber(formatting.fontWeight, "font weight") >= 150,
        bold: command.bold,
      };
    }
    case "italic": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedItalic: observedItalic(formatting.fontStyle),
        italic: command.italic,
      };
    }
    case "underline": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedUnderline: observedTextDecoration(formatting.underline),
        underline: command.underline,
      };
    }
    case "strikethrough": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedStrikethrough: observedTextDecoration(formatting.strikethrough),
        strikethrough: command.strikethrough,
      };
    }
    case "font_family": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      if (
        typeof formatting.fontFamily !== "string" ||
        typeof command.family !== "string"
      )
        throw new Error("Browser observation has no usable font family.");
      return {
        ...base,
        expectedFamily: formatting.fontFamily,
        family: String(command.family).trim(),
      };
    }
    case "font_color": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedColor: formatting.color,
        color: Math.round(command.color),
      };
    }
    case "paragraph_alignment": {
      const formatting = requiredWholeTextFormatting(expectedElement);
      return {
        ...base,
        expectedAlignment: observedParagraphAlignment(
          formatting.paragraphAlignment,
        ),
        alignment: command.alignment,
      };
    }
    default:
      throw new Error(`browser_ooxml_reconciliation_required:${command.op}`);
  }
}

async function commitProductPackageReload(prepared) {
  if (!prepared.mutation.report.changedParts.length) {
    const unchanged = await withPackageDocumentMetadata(
      await observeNativeDocument(),
    );
    if (!productMutationMatches(prepared, unchanged))
      throw new Error("browser_package_edit_not_persisted");
    return unchanged;
  }
  const afterBytes = new Uint8Array(prepared.mutation.bytes);
  const previousState = captureProductEditState();
  try {
    await writeAndOpen(afterBytes, filename);
    const after = await withPackageDocumentMetadata(
      await observeNativeDocument(),
    );
    if (!productMutationMatches(prepared, after))
      throw new Error("browser_package_edit_not_persisted");
    const journalCommand = {
      ...prepared.command,
      persistence: "package_reload",
      sourceOperations: prepared.sourceOperations,
      reconciliation: {
        beforeRevision: prepared.beforeRevision,
        afterRevision: after.revision,
      },
    };
    productUndoHistory.push({
      beforeBytes: prepared.beforeBytes,
      afterBytes,
      beforeRevision: prepared.beforeRevision,
      afterRevision: after.revision,
      beforeSlides: prepared.beforeSlides,
      nativeCommand: null,
      nativeRequest: null,
      command: journalCommand,
      persistence: "package_reload",
      nativeUndoAvailable: false,
      nativeRedoAvailable: false,
    });
    commands.push(journalCommand);
    productRedoHistory.length = 0;
    reconciledModelRevision = after.revision;
    unreconciledModelRevision = "";
    currentSlideCount = Array.isArray(after.slides)
      ? after.slides.length
      : currentSlideCount;
    await persistCheckpoint();
    observed.lastMutation = prepared.mutation.report;
    evidence.value = JSON.stringify(observed);
    return after;
  } catch (error) {
    restoreProductEditState(previousState);
    await restoreProductPackageSnapshot(
      prepared.beforeBytes,
      "browser_package_reload_rollback_failed",
    );
    throw error;
  }
}

async function commitProductPackageMutation(prepared, nativeValue) {
  if (!prepared) return;
  if (
    !nativeValue ||
    typeof nativeValue.revision !== "string" ||
    !nativeValue.revision
  )
    throw new Error("Browser native edit has no resulting revision.");
  const previousState = captureProductEditState();
  if (prepared.persistence === "native_snapshot") {
    if (nativeValue.revision === prepared.beforeRevision) {
      reconciledModelRevision = nativeValue.revision;
      unreconciledModelRevision = "";
      return;
    }
    let afterBytes;
    let preservationReport;
    let liveSave;
    liveExportBaseline = null;
    try {
      const preserved = await preserveAndInspectNativeDocument(
        prepared.beforeBytes,
        nativeValue.textDetails?.slideIndex,
        prepared.sourceOperations,
        prepared.sourceTargets ?? null,
        prepared.baselineBytes ?? null,
      );
      afterBytes = preserved.bytes;
      preservationReport = preserved.report;
      liveSave = preserved.serialized;
      if ((await sha256(afterBytes)) === (await sha256(prepared.beforeBytes)))
        throw new Error("Browser native edit did not change the PPTX package.");
      assertPersistedNativeIntent(
        prepared.beforeObservation,
        nativeValue,
        preserved.observation,
        preservationReport,
      );
    } catch (error) {
      try {
        await restoreProductPackageSnapshot(
          prepared.beforeBytes,
          "browser_native_snapshot_rollback_failed",
        );
      } catch (rollbackError) {
        throw new Error(
          `browser_native_snapshot_rollback_failed:${error instanceof Error ? error.message : String(error)}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    const journalCommand = {
      op: "native_snapshot",
      persistence: "native_snapshot",
      sourceOperations: prepared.sourceOperations,
      reconciliation: {
        beforeRevision: prepared.beforeRevision,
        afterRevision: nativeValue.revision,
        nativeRequest:
          prepared.persistedNativeRequest ?? prepared.nativeRequest,
      },
    };
    currentBytes = afterBytes;
    productUndoHistory.push({
      beforeBytes: prepared.beforeBytes,
      afterBytes,
      beforeRevision: prepared.beforeRevision,
      afterRevision: nativeValue.revision,
      beforeSlides: prepared.beforeSlides,
      nativeRequest: prepared.nativeRequest,
      command: journalCommand,
      persistence: "native_snapshot",
      nativeUndoAvailable: true,
      nativeRedoAvailable: false,
    });
    commands.push(journalCommand);
    productRedoHistory.length = 0;
    reconciledModelRevision = nativeValue.revision;
    unreconciledModelRevision = "";
    currentSlideCount = Array.isArray(nativeValue.slides)
      ? nativeValue.slides.length
      : currentSlideCount;
    try {
      await persistCheckpoint();
    } catch (error) {
      restoreProductEditState(previousState);
      await restoreProductPackageSnapshot(
        prepared.beforeBytes,
        "browser_native_snapshot_checkpoint_and_rollback_failed",
      );
      throw error;
    }
    liveExportBaseline = { revision: nativeValue.revision, bytes: liveSave };
    observed.lastMutation = {
      persistence: "native_snapshot",
      sourceOperations: prepared.sourceOperations,
      preservation: preservationReport,
    };
    evidence.value = JSON.stringify(observed);
    return;
  }
  if (!productMutationMatches(prepared, nativeValue)) {
    await restoreProductPackageSnapshot(
      prepared.beforeBytes,
      "browser_native_package_disagreement_rollback_failed",
    );
    throw new Error("Browser native and package edits disagree.");
  }
  if (!prepared.mutation.report.changedParts.length) {
    reconciledModelRevision = nativeValue.revision;
    unreconciledModelRevision = "";
    return nativeValue;
  }
  const afterBytes = new Uint8Array(prepared.mutation.bytes);
  const packageAuthoritative = productSlideOperations.has(
    prepared.nativeCommand.op,
  );
  if (packageAuthoritative) {
    // LibreOffice may assign new object names while duplicating/reordering
    // slides, while the local OOXML patch preserves the author's names. Use
    // native editing to apply the command, then reopen the exact PPTX that
    // Undo, download and recovery will use. A live hash from the pre-reopen
    // model is not a valid identity for the saved package.
    try {
      await writeAndOpen(afterBytes, filename);
      nativeValue = await observeNativeDocument();
      if (!productMutationMatches(prepared, nativeValue))
        throw new Error("browser_package_slide_edit_not_persisted");
    } catch (error) {
      restoreProductEditState(previousState);
      await restoreProductPackageSnapshot(
        prepared.beforeBytes,
        "browser_slide_edit_rollback_failed",
      );
      throw error;
    }
  }
  const journalCommand = {
    ...prepared.command,
    reconciliation: {
      beforeRevision: prepared.beforeRevision,
      afterRevision: nativeValue.revision,
      nativeCommand: prepared.nativeCommand,
      nativeRequest: prepared.nativeRequest,
      permission: prepared.permission,
    },
  };
  currentBytes = afterBytes;
  productUndoHistory.push({
    beforeBytes: prepared.beforeBytes,
    afterBytes,
    beforeRevision: prepared.beforeRevision,
    afterRevision: nativeValue.revision,
    beforeSlides: prepared.beforeSlides,
    nativeCommand: prepared.nativeCommand,
    nativeRequest: packageAuthoritative ? null : prepared.nativeRequest,
    permission: prepared.permission,
    command: journalCommand,
    nativeUndoAvailable:
      !packageAuthoritative &&
      nativeUndoAvailableFor(prepared.nativeCommand.op),
    nativeRedoAvailable: false,
  });
  commands.push(journalCommand);
  productRedoHistory.length = 0;
  reconciledModelRevision = nativeValue.revision;
  unreconciledModelRevision = "";
  currentSlideCount = prepared.mutation.report.slideCount;
  try {
    await persistCheckpoint();
  } catch (error) {
    restoreProductEditState(previousState);
    await restoreProductPackageSnapshot(
      prepared.beforeBytes,
      "browser_package_checkpoint_and_rollback_failed",
    );
    throw error;
  }
  observed.lastMutation = prepared.mutation.report;
  evidence.value = JSON.stringify(observed);
  // A later direct edit is compared with a save of this live document; a
  // fresh load of the patched file writes untouched tables differently.
  if (!packageAuthoritative)
    try {
      liveExportBaseline = {
        revision: nativeValue.revision,
        bytes: await serializeNativeDocument(),
      };
    } catch {
      liveExportBaseline = null;
    }
  return nativeValue;
}

async function replayRecoveredCommands(base, recoveredCommands) {
  let candidate = base.slice();
  commands.length = 0;
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  for (const command of recoveredCommands) {
    const before = candidate.slice();
    const result = await applyMutation(before, command);
    candidate = new Uint8Array(result.bytes);
    const reconciliation = command.reconciliation;
    if (
      typeof reconciliation?.beforeRevision !== "string" ||
      !reconciliation.beforeRevision ||
      typeof reconciliation.afterRevision !== "string" ||
      !reconciliation.afterRevision
    )
      throw new Error("Browser recovery command has no revision identity.");
    productUndoHistory.push({
      beforeBytes: before,
      afterBytes: candidate,
      beforeRevision: reconciliation.beforeRevision,
      afterRevision: reconciliation.afterRevision,
      nativeCommand: reconciliation.nativeCommand ?? null,
      nativeRequest: reconciliation.nativeRequest ?? null,
      permission: reconciliation.permission ?? null,
      command,
      nativeUndoAvailable: false,
      nativeRedoAvailable: false,
    });
    commands.push(command);
  }
  return candidate;
}

// Native Undo/Redo is a fast path, not the source of truth. Impress can
// quantize shape geometry while restoring an otherwise identical edit, which
// changes its live revision. The journal retains the exact PPTX for each side
// of the edit, so reopen that package when the native result is not exact.
// Reopening an exact package is how Undo, Redo and rollback return to a
// saved state, and the reopened model becomes the reconciled baseline. Its
// observation can differ from the live model that produced those bytes in
// import-normalized details (a substituted font name, a master's placeholder
// count), so that earlier live revision is not an identity for the reopened
// document; the package bytes are.
async function restoreProductPackageSnapshot(bytes, errorCode) {
  try {
    await writeAndOpen(bytes, filename);
    const restored = await observeNativeDocument();
    reconciledModelRevision = restored.revision;
    unreconciledModelRevision = "";
    bindOpenExportBaseline(restored.revision);
    rememberReconciledObservation(restored);
    return restored;
  } catch (error) {
    unreconciledModelRevision ||= errorCode;
    throw error;
  }
}

async function restoreProductHistoryPackage({
  targetBytes,
  rollbackBytes,
  errorCode,
}) {
  try {
    return await restoreProductPackageSnapshot(targetBytes, errorCode);
  } catch (error) {
    try {
      await restoreProductPackageSnapshot(
        rollbackBytes,
        "browser_history_package_rollback_failed",
      );
    } catch (rollbackError) {
      unreconciledModelRevision = "browser_history_package_rollback_failed";
      throw new Error(
        `${errorCode}_and_rollback_failed:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function undoProductMutation() {
  const previous = productUndoHistory.at(-1);
  if (!previous) return false;
  liveExportBaseline = null;
  const previousState = captureProductEditState();
  const current = await observeNativeDocument();
  if (current.revision !== reconciledModelRevision) {
    unreconciledModelRevision = current.revision;
    return false;
  }
  let reached;
  if (previous.nativeUndoAvailable === true) {
    await request("dispatch", { unoCommand: "Undo" });
    reached = await observeNativeDocument();
    if (reached.revision !== previous.beforeRevision) {
      reached = await restoreProductHistoryPackage({
        targetBytes: previous.beforeBytes,
        rollbackBytes: previous.afterBytes,
        errorCode: "browser_package_undo_failed",
      });
      // Reopening the package clears Impress's native history. Redo must use
      // the exact journaled package too, rather than replaying the command.
      previous.nativeRequest = null;
      previous.nativeRedoAvailable = false;
    } else {
      previous.nativeRedoAvailable = true;
    }
    currentBytes = previous.beforeBytes.slice();
    previous.nativeUndoAvailable = false;
  } else {
    reached = await restoreProductHistoryPackage({
      targetBytes: previous.beforeBytes,
      rollbackBytes: previous.afterBytes,
      errorCode: "browser_package_undo_failed",
    });
  }
  productUndoHistory.pop();
  productRedoHistory.push(previous);
  reconciledModelRevision = reached.revision;
  unreconciledModelRevision = "";
  try {
    rebaseCommandsToSavedBase("undo");
    await persistCheckpoint();
  } catch (error) {
    restoreProductEditState(previousState);
    await restoreProductPackageSnapshot(
      previous.afterBytes,
      "browser_undo_checkpoint_rollback_failed",
    );
    throw error;
  }
  reportHostModified(commands.length > 0);
  return true;
}

async function redoProductMutation() {
  const next = productRedoHistory.at(-1);
  if (!next) return false;
  liveExportBaseline = null;
  const previousState = captureProductEditState();
  if ((await sha256(currentBytes)) !== (await sha256(next.beforeBytes)))
    throw new Error("Browser redo base no longer matches the package history.");
  const current = await observeNativeDocument();
  if (current.revision !== reconciledModelRevision) {
    unreconciledModelRevision = current.revision;
    return false;
  }
  const useNativeRedo = next.nativeRedoAvailable === true;
  // Replaying the command reproduces the recorded result only from the same
  // live model it first ran on; a reopened package is a different model.
  const canReplayNative =
    !useNativeRedo &&
    next.nativeRequest &&
    typeof next.nativeRequest === "object" &&
    current.revision === next.beforeRevision;
  let reached;
  if (useNativeRedo) {
    await request("dispatch", { unoCommand: "Redo" });
    reached = await observeNativeDocument();
    if (reached.revision !== next.afterRevision) {
      reached = await restoreProductHistoryPackage({
        targetBytes: next.afterBytes,
        rollbackBytes: next.beforeBytes,
        errorCode: "browser_package_redo_failed",
      });
      next.nativeRequest = null;
      next.nativeUndoAvailable = false;
    } else {
      next.nativeUndoAvailable = true;
    }
    currentBytes = next.afterBytes.slice();
    next.nativeRedoAvailable = false;
  } else if (canReplayNative) {
    const replayed = (
      await requestNative({
        ...next.nativeRequest,
        expectedRevision: current.revision,
        expectedSlides: JSON.stringify(current.slides),
        suppressCapture: true,
      })
    ).value;
    if (
      replayed?.revision !== next.afterRevision ||
      (next.persistence !== "native_snapshot" &&
        !productMutationMatches(
          { command: next.command, beforeSlides: current.slides },
          replayed,
        ))
    ) {
      await restoreProductPackageSnapshot(
        next.beforeBytes,
        "browser_native_replay_rollback_failed",
      );
      throw new Error("browser_native_replay_revision_mismatch");
    }
    reached = replayed;
    currentBytes = next.afterBytes.slice();
    next.nativeUndoAvailable =
      next.persistence === "native_snapshot" ||
      nativeUndoAvailableFor(next.nativeCommand?.op);
    next.nativeRedoAvailable = false;
  } else {
    reached = await restoreProductHistoryPackage({
      targetBytes: next.afterBytes,
      rollbackBytes: next.beforeBytes,
      errorCode: "browser_package_redo_failed",
    });
  }
  productRedoHistory.pop();
  productUndoHistory.push(next);
  reconciledModelRevision = reached.revision;
  unreconciledModelRevision = "";
  try {
    rebaseCommandsToSavedBase("redo");
    await persistCheckpoint();
  } catch (error) {
    restoreProductEditState(previousState);
    await restoreProductPackageSnapshot(
      next.beforeBytes,
      "browser_redo_checkpoint_rollback_failed",
    );
    throw error;
  }
  reportHostModified(true);
  return true;
}

async function openJournal(initialBytes, name, documentId = null) {
  baseBytes = initialBytes.slice();
  journal = await openBrowserDocumentJournal({
    identity: documentId
      ? `document:${documentId}`
      : `${name}:${await sha256(initialBytes)}`,
  });
  if (documentId && !(await journal.load())) {
    const legacy = await openBrowserDocumentJournal({
      identity: `${name}:${await sha256(initialBytes)}`,
    });
    const checkpoint = await legacy.load();
    if (
      checkpoint &&
      (await sha256(checkpoint.baseBytes)) === (await sha256(initialBytes))
    ) {
      await journal.save({
        fileName: checkpoint.metadata.fileName,
        baseVersionId: checkpoint.metadata.baseVersionId,
        baseBytes: checkpoint.baseBytes,
        candidateBytes: checkpoint.candidateBytes,
        commands: checkpoint.metadata.commands,
      });
      const migrated = await journal.load();
      if (
        !migrated ||
        migrated.metadata.candidateSha256 !==
          checkpoint.metadata.candidateSha256
      )
        throw new Error("Browser recovery migration could not be verified.");
      await legacy.clear();
    }
  }
  return journal;
}

async function persistCheckpoint() {
  if (!journal || !baseBytes || !currentBytes) return;
  await journal.save({
    fileName: filename,
    baseVersionId: await sha256(baseBytes),
    baseBytes,
    candidateBytes: currentBytes,
    commands,
  });
  trimSessionProductHistory(productUndoHistory, productRedoHistory);
}

async function checkpointLiveNativeState(live, reason) {
  if (
    !live ||
    typeof live.revision !== "string" ||
    !live.revision ||
    live.revision === reconciledModelRevision
  )
    return false;
  const previousState = captureProductEditState();
  const beforeRevision = previousState.reconciledModelRevision;
  if (reconciledObservation?.revision !== beforeRevision)
    throw new Error("browser_native_baseline_unavailable");
  const knownState = reconcileNativeHistoryRevision({
    commands,
    undoHistory: productUndoHistory,
    redoHistory: productRedoHistory,
    currentBytes,
    currentRevision: beforeRevision,
    observedRevision: live.revision,
  });
  if (knownState) {
    try {
      const serialized = await serializeNativeDocument();
      currentBytes = knownState.bytes;
      reconciledModelRevision = live.revision;
      unreconciledModelRevision = "";
      currentSlideCount = live.slides.length;
      rememberReconciledObservation(live);
      await persistCheckpoint();
      liveExportBaseline = {
        revision: live.revision,
        bytes: serialized,
      };
    } catch (error) {
      restoreProductEditState(previousState);
      unreconciledModelRevision = live.revision;
      throw error;
    }
    return true;
  }
  const baselineBytes =
    liveExportBaseline?.revision === beforeRevision
      ? liveExportBaseline.bytes
      : null;
  liveExportBaseline = null;
  // A direct human edit has no command list; null selects the human-edit
  // preservation budget instead of an AI operation family.
  const preserved = await preserveAndInspectNativeDocument(
    previousState.currentBytes,
    live.textDetails?.slideIndex,
    null,
    null,
    baselineBytes,
  );
  const afterBytes = preserved.bytes;
  assertPersistedNativeIntent(
    reconciledObservation,
    live,
    preserved.observation,
  );
  recordManualProductCheckpoint({
    commands,
    undoHistory: productUndoHistory,
    redoHistory: productRedoHistory,
    beforeBytes: previousState.currentBytes,
    afterBytes,
    beforeRevision,
    afterRevision: live.revision,
    beforeSlides: previousState.reconciledObservation.slides,
    reason,
  });
  currentBytes = afterBytes;
  reconciledModelRevision = live.revision;
  unreconciledModelRevision = "";
  currentSlideCount = Array.isArray(live.slides)
    ? live.slides.length
    : currentSlideCount;
  try {
    rememberReconciledObservation(live);
    await persistCheckpoint();
  } catch (error) {
    restoreProductEditState(previousState);
    unreconciledModelRevision = live.revision;
    throw error;
  }
  liveExportBaseline = { revision: live.revision, bytes: preserved.serialized };
  return true;
}

function download(bytes) {
  const url = URL.createObjectURL(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function requireProductHostOrigin() {
  if (!expectedHostOrigin)
    throw new Error("Browser Office host origin is required.");
  const parsed = new URL(expectedHostOrigin);
  if (
    parsed.origin !== expectedHostOrigin ||
    !["http:", "https:"].includes(parsed.protocol)
  )
    throw new Error("Browser Office host origin is invalid.");
  return parsed.origin;
}

function postHost(message, transfer = []) {
  if (!hostPort) throw new Error("Browser Office host is not connected.");
  hostPort.postMessage(message, transfer);
}

function reportHostModified(modified) {
  if (modified === lastReportedModified) return;
  lastReportedModified = modified;
  postHost({ type: "modified", modified });
}

function enqueueProductOperation(operation) {
  const pendingOperation = productMessageQueue.then(operation);
  productMessageQueue = pendingOperation.catch((error) => {
    postHost({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return pendingOperation;
}

async function exportProductDocumentNow({ checkpoint = true } = {}) {
  if (!currentBytes || !journal)
    throw new Error("No browser Office document is open.");
  const live = await observeNativeDocument();
  if (live.revision !== reconciledModelRevision)
    await checkpointLiveNativeState(live, "manual_save");
  unreconciledModelRevision = "";
  const bytes = currentBytes.slice();
  if (!bytes.byteLength || bytes.byteLength > hostMaximumBytes)
    throw new Error("Browser Office export exceeded the document limit.");
  if (checkpoint) await persistCheckpoint();
  return bytes;
}

function exportProductDocument(options = {}) {
  const pendingExport = productExportQueue.then(() =>
    exportProductDocumentNow(options),
  );
  productExportQueue = pendingExport.catch(() => undefined);
  return pendingExport;
}

async function openProductDocument(message) {
  if (
    typeof message.requestId !== "string" ||
    typeof message.fileName !== "string" ||
    !message.fileName.trim() ||
    message.fileName.length > 255 ||
    typeof message.documentId !== "string" ||
    !message.documentId.trim() ||
    message.documentId.length > 255 ||
    typeof message.revision !== "string" ||
    !message.revision ||
    !Number.isSafeInteger(message.maxBytes) ||
    message.maxBytes <= 0 ||
    message.maxBytes > 64 * 1024 * 1024 ||
    !(message.bytes instanceof ArrayBuffer) ||
    !message.bytes.byteLength ||
    message.bytes.byteLength > message.maxBytes
  )
    throw new Error("Browser Office open request is invalid.");
  const initial = new Uint8Array(message.bytes);
  if (initial[0] !== 0x50 || initial[1] !== 0x4b)
    throw new Error("Browser Office received an invalid PPTX package.");
  hostRevision = message.revision;
  hostMaximumBytes = message.maxBytes;
  history.length = 0;
  commands.length = 0;
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  reconciledModelRevision = "";
  unreconciledModelRevision = "";
  reconciledObservation = null;
  baseModelRevision = "";
  await requestPersistentBrowserStorage();
  await openJournal(initial, message.fileName, message.documentId);
  let recovered = await journal.load();
  baseBytes = initial.slice();
  let candidate = initial;
  let recoveredSnapshotHistory = null;
  if (recovered) {
    const disposition = journalRecoveryDisposition(
      await sha256(initial),
      recovered,
    );
    if (disposition === "conflict")
      throw new Error("Browser recovery base differs from the host document.");
    if (disposition === "already_saved") {
      try {
        await journal.clear();
      } catch (error) {
        observed.events.push({
          state: "recovery-warning",
          atMs: Math.round(performance.now()),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      recovered = null;
    }
  }
  if (recovered) {
    const containsNativeSnapshot = recovered.metadata.commands.some(
      (command) =>
        command?.op === "native_snapshot" &&
        command.persistence === "native_snapshot",
    );
    let replayed;
    if (containsNativeSnapshot) {
      for (const command of recovered.metadata.commands) {
        const reconciliation = command?.reconciliation;
        if (
          typeof reconciliation?.beforeRevision !== "string" ||
          !reconciliation.beforeRevision ||
          typeof reconciliation.afterRevision !== "string" ||
          !reconciliation.afterRevision
        )
          throw new Error("Browser recovery command has no revision identity.");
      }
      const first = recovered.metadata.commands[0];
      const last = recovered.metadata.commands.at(-1);
      const recoveredCommand = {
        op: "native_snapshot",
        persistence: "native_snapshot",
        sourceOperations: recovered.metadata.commands.flatMap((command) =>
          Array.isArray(command.sourceOperations)
            ? command.sourceOperations
            : [command.op],
        ),
        reason: "recovered_session",
        reconciliation: {
          beforeRevision: first.reconciliation.beforeRevision,
          afterRevision: last.reconciliation.afterRevision,
          nativeRequest: null,
        },
      };
      commands.push(recoveredCommand);
      recoveredSnapshotHistory = {
        beforeBytes: initial.slice(),
        afterBytes: recovered.candidateBytes.slice(),
        beforeRevision: first.reconciliation.beforeRevision,
        afterRevision: last.reconciliation.afterRevision,
        beforeSlides: [],
        nativeRequest: null,
        command: recoveredCommand,
        persistence: "native_snapshot",
        nativeUndoAvailable: false,
        nativeRedoAvailable: false,
      };
      replayed = recovered.candidateBytes.slice();
    } else {
      replayed = await replayRecoveredCommands(
        initial,
        recovered.metadata.commands,
      );
    }
    if (
      (await sha256(replayed)) !== recovered.metadata.candidateSha256 ||
      (await sha256(recovered.candidateBytes)) !==
        recovered.metadata.candidateSha256
    )
      throw new Error("Browser recovery command journal cannot be reconciled.");
    candidate = recovered.candidateBytes;
  }
  await writeAndOpen(candidate, message.fileName);
  const live = await observeNativeDocument();
  const recoveredRevision = commands.at(-1)?.reconciliation?.afterRevision;
  if (recoveredRevision && live.revision !== recoveredRevision)
    throw new Error("Browser recovery model differs from the package journal.");
  if (recoveredSnapshotHistory)
    productUndoHistory.push(recoveredSnapshotHistory);
  reconciledModelRevision = live.revision;
  baseModelRevision =
    commands[0]?.reconciliation?.beforeRevision ?? live.revision;
  bindOpenExportBaseline(live.revision);
  rememberReconciledObservation(live);
  const modified = commands.length > 0;
  lastReportedModified = !modified;
  reportHostModified(modified);
  postHost({
    type: "open-complete",
    requestId: message.requestId,
    revision: hostRevision,
    slideCount: currentSlideCount,
    recovered: Boolean(recovered),
  });
}

let hostSaveRequestId = null;
let hostSaveSnapshot = null;
async function saveProductDocument() {
  if (hostSaveRequestId) return;
  const requestId = `browser-save-${++requestSequence}`;
  hostSaveRequestId = requestId;
  try {
    const bytes = await exportProductDocument();
    hostSaveSnapshot = createSaveSnapshot(bytes, reconciledModelRevision);
    const transferable = bytes.slice();
    postHost(
      {
        type: "save",
        requestId,
        revision: hostRevision,
        bytes: transferable.buffer,
      },
      [transferable.buffer],
    );
  } catch (error) {
    hostSaveRequestId = null;
    hostSaveSnapshot = null;
    throw error;
  }
}

async function handleProductHostMessage(message) {
  if (!message || typeof message !== "object")
    throw new Error("Browser Office host message is invalid.");
  if (message.type === "open") {
    await openProductDocument(message);
    return;
  }
  if (message.type === "command") {
    if (message.messageId === "Action_Save") {
      await saveProductDocument();
      return;
    }
    if (message.messageId === "Send_UNO_Command") {
      const command = String(message.values?.Command ?? "").replace(
        /^\.uno:/u,
        "",
      );
      if (!["Undo", "Redo"].includes(command))
        throw new Error("Browser Office host command is not allowed.");
      const handled =
        command === "Undo"
          ? await undoProductMutation()
          : await redoProductMutation();
      if (!handled) {
        await request("dispatch", { unoCommand: command });
        const live = await observeNativeDocument();
        if (live.revision !== reconciledModelRevision)
          await checkpointLiveNativeState(
            live,
            `manual_${command.toLowerCase()}`,
          );
        const status = await request("status");
        reportHostModified(
          Boolean(status.modified) || Boolean(unreconciledModelRevision),
        );
      }
      const settled = await observeNativeDocument();
      if (settled.revision === reconciledModelRevision)
        rememberReconciledObservation(settled);
      postHost({
        type: "command-complete",
        messageId: message.messageId,
        command,
        revision: unreconciledModelRevision || reconciledModelRevision,
        ...(typeof message.requestId === "string"
          ? { requestId: message.requestId }
          : {}),
      });
      return;
    }
    if (message.messageId === "Action_GoToPage") {
      // The product shows the slide an AI request changed, or the one a
      // person picked from a result card.
      const page = Number(message.values?.Page);
      if (!Number.isSafeInteger(page) || page < 1)
        throw new Error("Browser Office page is invalid.");
      if (engineDocumentOpen)
        await request("show-slide", { slideIndex: page - 1 });
      return;
    }
    // Server-editor housekeeping with no browser counterpart.
    if (
      message.messageId === "welcome-close" ||
      message.messageId === "Host_PostmessageReady" ||
      message.messageId === "User_Active"
    )
      return;
    throw new Error("Browser Office host command is not supported.");
  }
  if (message.type === "save-result") {
    if (
      !hostSaveRequestId ||
      !hostSaveSnapshot ||
      message.requestId !== hostSaveRequestId
    )
      throw new Error("Browser Office save response is stale.");
    if (message.ok !== true) {
      hostSaveRequestId = null;
      hostSaveSnapshot = null;
      reportHostModified(true);
      postHost({
        type: "save-response",
        requestId: message.requestId,
        success: false,
        error: String(message.error ?? "browser_document_save_failed"),
      });
      return;
    }
    try {
      if (typeof message.revision !== "string" || !message.revision)
        throw new Error("Browser Office save revision is invalid.");
      const saved = hostSaveSnapshot;
      // The server has already accepted this version. Even if local
      // reconciliation fails, the next save must not use the previous ETag.
      hostRevision = message.revision;
      const live = await observeNativeDocument();
      if (live.revision !== reconciledModelRevision)
        await checkpointLiveNativeState(live, "manual_after_save_request");
      const hasLaterChanges = acknowledgedSaveHasLaterChanges(
        saved,
        currentBytes,
        reconciledModelRevision,
      );
      baseBytes = saved.bytes.slice();
      baseModelRevision = saved.modelRevision;
      if (hasLaterChanges) {
        rebaseCommandsToSavedBase("save_acknowledged_with_later_edits");
        await persistCheckpoint();
      } else {
        await request("mark-saved");
        await journal.clear();
        history.length = 0;
        commands.length = 0;
      }
      const afterAcknowledgement = await observeNativeDocument();
      if (afterAcknowledgement.revision !== reconciledModelRevision)
        await checkpointLiveNativeState(
          afterAcknowledgement,
          "manual_after_save_acknowledgement",
        );
      else rememberReconciledObservation(afterAcknowledgement);
      const modified = acknowledgedSaveHasLaterChanges(
        saved,
        currentBytes,
        reconciledModelRevision,
      );
      unreconciledModelRevision = "";
      hostSaveRequestId = null;
      hostSaveSnapshot = null;
      lastReportedModified = !modified;
      reportHostModified(modified);
      postHost({
        type: "save-response",
        requestId: message.requestId,
        success: true,
        modified,
      });
    } catch (error) {
      hostSaveRequestId = null;
      hostSaveSnapshot = null;
      lastReportedModified = false;
      reportHostModified(true);
      postHost({
        type: "save-response",
        requestId: message.requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (
    typeof message.id === "string" &&
    ["selection", "reveal"].includes(message.request?.operation)
  ) {
    // Host reads for the request box and result cards: no package commit,
    // no screenshots.
    try {
      const result = await requestNative(message.request);
      postHost({ id: message.id, value: result.value });
    } catch (error) {
      postHost({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (
    typeof message.id === "string" &&
    message.request?.operation === "undo_turn"
  ) {
    // Undo one AI request through the package history each AI edit added,
    // so the result is the exact package from before the request. If the
    // document moved on, or the result is not the pre-request state, every
    // undone step is redone and nothing changes.
    try {
      const { steps, expectedRevision, targetRevision } = message.request;
      if (
        !Number.isInteger(steps) ||
        steps < 1 ||
        steps > 50 ||
        typeof expectedRevision !== "string" ||
        typeof targetRevision !== "string"
      )
        throw new Error("invalid_undo_request");
      const live = await observeNativeDocument();
      if (live.revision !== expectedRevision)
        throw new Error("document_changed_since_turn");
      let undone = 0;
      while (undone < steps && (await undoProductMutation())) undone += 1;
      const after = await observeNativeDocument();
      if (undone !== steps || after.revision !== targetRevision) {
        while (undone > 0 && (await redoProductMutation())) undone -= 1;
        throw new Error(
          undone === 0
            ? "undo_result_mismatch"
            : "undo_result_mismatch_not_restored",
        );
      }
      rememberReconciledObservation(after);
      postHost({ id: message.id, value: { ...after, undone: steps } });
    } catch (error) {
      postHost({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (typeof message.id === "string" && message.request) {
    try {
      markBrowserProbePhase("prepare");
      const prepared = await prepareProductPackageMutation(message.request);
      let value;
      // The engine reply whose state became the reconciled one, when known.
      let nativeResult = null;
      if (prepared?.persistence === "package_reload") {
        markBrowserProbePhase("package-reload");
        value = await commitProductPackageReload(prepared);
      } else {
        markBrowserProbePhase("native-execute");
        const result = await requestNative(message.request);
        markBrowserProbePhase("package-commit");
        const committed = await commitProductPackageMutation(
          prepared,
          result.value,
        );
        if (!committed || committed === result.value) nativeResult = result;
        value = await withPackageDocumentMetadata(committed ?? result.value);
      }
      markBrowserProbePhase("visual-capture");
      value = await attachBrowserVisualEvidence(message.request, value);
      markBrowserProbePhase("status");
      const status = await request("status");
      reportHostModified(
        Boolean(status.modified) ||
          commands.length > 0 ||
          Boolean(unreconciledModelRevision),
      );
      if (value?.revision === reconciledModelRevision) {
        rememberReconciledObservation(value);
        noteCheckpointedDocumentChanges(nativeResult);
      }
      markBrowserProbePhase("complete");
      postHost({ id: message.id, value });
    } catch (error) {
      markBrowserProbePhase("error");
      postHost({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  throw new Error("Browser Office host message is unsupported.");
}

function connectProductHost(event) {
  if (
    !productMode ||
    event.source !== window.parent ||
    event.origin !== requireProductHostOrigin() ||
    event.data?.type !== "spellbook.browser-office-connect" ||
    event.data?.protocolVersion !== 1 ||
    event.ports.length !== 1 ||
    hostPort
  )
    return;
  hostPort = event.ports[0];
  hostPort.onmessage = (hostEvent) => {
    if (browserProbeMode && typeof hostEvent.data?.id === "string")
      browserProbeActivity = {
        id: hostEvent.data.id,
        operation:
          hostEvent.data.request?.command?.op ??
          hostEvent.data.request?.operation ??
          "unknown",
        phase: "queued",
        at: Date.now(),
      };
    if (browserProbeMode && typeof hostEvent.data?.id === "string")
      browserProbePhaseTrace = [{ phase: "queued", at: Date.now() }];
    void enqueueProductOperation(() =>
      handleProductHostMessage(hostEvent.data),
    );
  };
  hostPort.start();
  postHost({ type: "ready", protocolVersion: 1 });
  startProductHeartbeat();
}

let runtimeReady = false;
let productHeartbeat = null;
let lastSelectionKey = "";
let selectionTick = 0;
let checkpointInFlight = false;
let lastCheckpointAt = 0;
// The engine's change count when the live document last matched the
// journaled state. The heartbeat reads the whole deck, which takes seconds to
// minutes on a large deck, only after the count moves.
let checkpointedDocumentChanges = null;
function noteCheckpointedDocumentChanges(result) {
  checkpointedDocumentChanges =
    result?.value?.revision === reconciledModelRevision &&
    Number.isSafeInteger(result.documentChanges)
      ? result.documentChanges
      : null;
}
function startProductHeartbeat() {
  if (!productMode || !runtimeReady || !hostPort || productHeartbeat) return;
  const poll = () => {
    if (!currentBytes || checkpointInFlight) return;
    checkpointInFlight = true;
    void enqueueProductOperation(async () => {
      const current = await request("status");
      const modified =
        Boolean(current.modified) ||
        commands.length > 0 ||
        Boolean(unreconciledModelRevision);
      reportHostModified(modified);
      // Tell the host what is selected, about every 1.5 seconds.
      if (++selectionTick % 2 === 0) {
        const selection = await requestNative({ operation: "selection" }).catch(
          () => null,
        );
        const key = JSON.stringify(selection?.value ?? null);
        if (selection?.value && key !== lastSelectionKey) {
          lastSelectionKey = key;
          postHost({ type: "selection", value: selection.value });
        }
      }
      if (
        modified &&
        Date.now() - lastCheckpointAt >= 10_000 &&
        (!Number.isSafeInteger(current.documentChanges) ||
          current.documentChanges !== checkpointedDocumentChanges)
      ) {
        // A failed checkpoint waits for the next interval instead of
        // re-serializing the whole document on every tick.
        lastCheckpointAt = Date.now();
        const observedLive = await observeNativeDocumentChanges();
        const live = observedLive.value;
        if (live.revision !== reconciledModelRevision)
          await checkpointLiveNativeState(live, "manual_autosave");
        else await persistCheckpoint();
        noteCheckpointedDocumentChanges(observedLive);
        lastCheckpointAt = Date.now();
      }
    }).then(
      () => {
        checkpointInFlight = false;
      },
      () => {
        checkpointInFlight = false;
      },
    );
  };
  productHeartbeat = setInterval(poll, 750);
}

async function runConformance() {
  const fixture = new Uint8Array(
    await (await fetch("/fixtures/general-native-surface.pptx")).arrayBuffer(),
  );
  await requestPersistentBrowserStorage();
  await openJournal(fixture, "general-native-surface.pptx");
  const pendingRecovery = sessionStorage.getItem(recoveryMarker);
  if (pendingRecovery) {
    sessionStorage.removeItem(recoveryMarker);
    await resumeConformance(JSON.parse(pendingRecovery));
    return;
  }
  await journal.clear();
  commands.length = 0;
  history.length = 0;
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  const initial = await writeAndOpen(fixture, "general-native-surface.pptx");
  await runNativeBridgeProbe();
  await writeAndOpen(fixture, "general-native-surface.pptx");
  const addMutation = await addSlide();
  if (currentSlideCount !== initial.slideCount + 1)
    throw new Error("OOXML add_slide did not add exactly one slide.");
  await recordBytes(
    "after-insert",
    currentBytes,
    currentSlideCount,
    addMutation,
  );

  const duplicateMutation = await mutate({
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: currentSlideCount,
  });
  if (currentSlideCount !== initial.slideCount + 2)
    throw new Error("OOXML duplicate_slide did not add exactly one slide.");
  await recordBytes(
    "after-duplicate",
    currentBytes,
    currentSlideCount,
    duplicateMutation,
  );

  const moveMutation = await mutate({
    op: "move_slide",
    slideIndex: currentSlideCount - 1,
    insertIndex: 0,
  });
  if (currentSlideCount !== initial.slideCount + 2)
    throw new Error("OOXML move_slide changed the slide count.");
  await recordBytes(
    "after-move",
    currentBytes,
    currentSlideCount,
    moveMutation,
  );

  const deleteMutation = await mutate({
    op: "delete_slide",
    slideIndex: 0,
  });
  if (currentSlideCount !== initial.slideCount + 1)
    throw new Error("OOXML delete_slide did not remove exactly one slide.");
  await recordBytes(
    "after-delete",
    currentBytes,
    currentSlideCount,
    deleteMutation,
  );

  const renameMutation = await mutate({
    op: "rename_slide",
    slideIndex: 0,
    name: "Browser 검증 슬라이드",
  });
  await recordBytes(
    "after-rename",
    currentBytes,
    currentSlideCount,
    renameMutation,
  );

  const hideMutation = await mutate({
    op: "set_slide_hidden",
    slideIndex: 1,
    hidden: true,
  });
  const hidden = await recordBytes(
    "after-hide",
    currentBytes,
    currentSlideCount,
    hideMutation,
  );

  sessionStorage.setItem(
    recoveryMarker,
    JSON.stringify({
      initialSlideCount: initial.slideCount,
      mutatedSha256: hidden.entry.sha256,
      nativeBridge: observed.nativeBridge,
    }),
  );
  location.reload();
}

async function resumeConformance(expected) {
  if (expected.nativeBridge?.status !== "observe-edit-undo-passed")
    throw new Error("Browser native bridge evidence was not retained.");
  observed.nativeBridge = expected.nativeBridge;
  body.dataset.nativeBridge = "observe-edit-undo";
  const checkpoint = await journal.load();
  if (!checkpoint)
    throw new Error("OPFS did not retain a valid browser edit checkpoint.");
  if (checkpoint.metadata.commands.length !== conformanceLabels.length)
    throw new Error(
      "OPFS did not retain the complete browser command journal.",
    );
  baseBytes = checkpoint.baseBytes.slice();
  currentBytes = baseBytes.slice();
  commands.length = 0;
  history.length = 0;
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  for (let index = 0; index < checkpoint.metadata.commands.length; index += 1) {
    const command = checkpoint.metadata.commands[index];
    history.push(currentBytes.slice());
    const result = await applyMutation(currentBytes, command);
    currentBytes = new Uint8Array(result.bytes);
    currentSlideCount = result.report.slideCount;
    commands.push(command);
    await recordBytes(
      conformanceLabels[index],
      currentBytes,
      currentSlideCount,
      result.report,
    );
  }
  if ((await sha256(currentBytes)) !== checkpoint.metadata.candidateSha256)
    throw new Error(
      "The replayed command journal differs from the OPFS candidate.",
    );
  await writeAndOpen(checkpoint.candidateBytes, checkpoint.metadata.fileName);
  observed.marks["opfs-recovered"] = Math.round(performance.now());
  observed.events.push({
    state: "opfs-recovered",
    atMs: observed.marks["opfs-recovered"],
    message: "Recovered candidate and Undo history after page reload",
  });

  const undoCounts = [
    expected.initialSlideCount + 1,
    expected.initialSlideCount + 1,
    expected.initialSlideCount + 2,
    expected.initialSlideCount + 2,
    expected.initialSlideCount + 1,
    expected.initialSlideCount,
  ];
  let undone;
  for (const expectedCount of undoCounts) {
    undone = await undoMutation();
    if (undone.slideCount !== expectedCount)
      throw new Error(
        `Browser undo restored ${undone.slideCount} slides instead of ${expectedCount}.`,
      );
  }
  const restored = await recordBytes(
    "after-undo",
    currentBytes,
    currentSlideCount,
    { operation: "restore_original" },
  );
  if (expected.mutatedSha256 === restored.entry.sha256)
    throw new Error("Mutation and undone saves unexpectedly match.");
  const reopenPath = "/tmp/spellbook/reopened.pptx";
  FS.writeFile(reopenPath, restored.bytes);
  const reopened = await request("open", { path: reopenPath });
  if (reopened.slideCount !== expected.initialSlideCount)
    throw new Error("The undone PPTX changed after browser reopen.");
  await waitForUiPaint("reopen");
  body.dataset.initialSlides = String(expected.initialSlideCount);
  body.dataset.reopenedSlides = String(reopened.slideCount);
  body.dataset.mutatedSha256 = expected.mutatedSha256;
  body.dataset.restoredSha256 = restored.entry.sha256;
  body.dataset.addedSha256 = observed.runs.find(
    (entry) => entry.label === "after-insert",
  ).sha256;
  body.dataset.topologyOperations = verifiedTopologyOperations;
  body.dataset.metadataOperations = verifiedMetadataOperations;
  body.dataset.recovery = "opfs-two-slot";
  await journal.clear();
  setState(
    "complete",
    "Browser edits, page-reload recovery, six-step Undo and reopen passed",
  );
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  history.length = 0;
  commands.length = 0;
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  undoButton.disabled = true;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openJournal(bytes, file.name);
  await journal.clear();
  await writeAndOpen(bytes, file.name);
});

insertSlideButton.addEventListener("click", async () => {
  await addSlide();
});

undoButton.addEventListener("click", async () => {
  await undoMutation();
});

async function saveBrowserProbeDocument() {
  if (!browserProbeMode || body.dataset.browserProbe !== "ready")
    throw new Error("Browser probe is not ready.");
  if (!currentBytes) throw new Error("Open a PPTX before saving.");
  const bytes = await exportProductDocument();
  const response = await networkFetch("/browser-probe/save", {
    method: "POST",
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    body: bytes,
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(
      value.error ?? `Browser probe save failed: ${response.status}`,
    );
  }
  status.textContent = "저장 확인 중…";
}

saveButton.addEventListener("click", async () => {
  if (browserProbeMode) return saveBrowserProbeDocument();
  if (!currentBytes) throw new Error("Open a PPTX before saving.");
  await recordBytes("manual-save", currentBytes, currentSlideCount, {
    operation: "export_current_candidate",
  });
  download(currentBytes);
});

if (productMode) {
  body.dataset.mode = "product";
  window.addEventListener("message", connectProductHost);
}

let browserProbePort;
const browserProbeEvents = [];

function markBrowserProbePhase(phase) {
  if (browserProbeMode && browserProbeActivity) {
    browserProbeActivity = { ...browserProbeActivity, phase, at: Date.now() };
    browserProbePhaseTrace.push({ phase, at: Date.now() });
  }
}

function waitForBrowserProbeEvent(match, timeoutMs = 30_000) {
  const existing = browserProbeEvents.find((event) =>
    Object.entries(match).every(([key, value]) => event[key] === value),
  );
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const event = browserProbeEvents.find((candidate) =>
        Object.entries(match).every(([key, value]) => candidate[key] === value),
      );
      if (event) resolve(event);
      else if (Date.now() >= deadline)
        reject(
          new Error(
            `Browser probe event timed out: ${JSON.stringify({
              match,
              activity: browserProbeActivity,
              phaseTrace: browserProbePhaseTrace,
              pendingOfficeRequests: [...pending.keys()].slice(-5),
              pendingPackageRequests: [...mutationPending.keys()].slice(-5),
              hostErrors: browserProbeEvents
                .filter((event) => event.type === "error")
                .slice(-3),
            })}`,
          ),
        );
      else setTimeout(poll, 25);
    };
    poll();
  });
}

async function browserProbeNativeCall(nativeRequest) {
  const id = `browser-probe-native-${++requestSequence}`;
  let request = nativeRequest;
  if (
    ["insert_image", "replace_image", "insert_media", "replace_media"].includes(
      nativeRequest.operation,
    )
  ) {
    const response = await networkFetch(
      `/fixtures/probe-assets/${encodeURIComponent(nativeRequest.assetId)}`,
    );
    if (!response.ok) throw new Error("probe_asset_not_found");
    request = {
      ...nativeRequest,
      assetBytes: await response.arrayBuffer(),
      mediaType: response.headers.get("content-type")?.split(";")[0],
    };
  }
  browserProbePort.postMessage({ id, request });
  const event = await waitForBrowserProbeEvent({ id }, 120_000);
  if (Object.hasOwn(event, "error"))
    throw new Error(event.error || "browser_probe_native_error_without_detail");
  if (event.value === undefined)
    throw new Error(
      `browser_probe_returned_no_value:${JSON.stringify({ event, activity: browserProbeActivity, phaseTrace: browserProbePhaseTrace })}`,
    );
  return event.value;
}

async function browserProbeHistory(direction = null) {
  if (direction !== null) {
    if (!["undo", "redo"].includes(direction))
      throw new Error("invalid_history_direction");
    const requestId = `browser-probe-history-${++requestSequence}`;
    browserProbePort.postMessage({
      type: "command",
      messageId: "Send_UNO_Command",
      values: { Command: direction === "undo" ? ".uno:Undo" : ".uno:Redo" },
      requestId,
    });
    // Undo may reopen the package when native history cannot reach the
    // recorded revision, which takes as long as the edit itself.
    await waitForBrowserProbeEvent(
      {
        type: "command-complete",
        messageId: "Send_UNO_Command",
        requestId,
      },
      120_000,
    );
  }
  return {
    undo: Array.from(
      { length: productUndoHistory.length },
      () => "AI presentation edit",
    ),
    redo: Array.from(
      { length: productRedoHistory.length },
      () => "AI presentation edit",
    ),
  };
}

async function startBrowserProbe() {
  if (!browserProbeMode) return;
  if (!patchedBrowserRuntimeAdmitted())
    throw new Error("Browser probe requires an admitted candidate runtime.");
  const channel = new MessageChannel();
  browserProbePort = channel.port1;
  browserProbePort.onmessage = (event) => browserProbeEvents.push(event.data);
  browserProbePort.start();
  window.postMessage(
    {
      type: "spellbook.browser-office-connect",
      protocolVersion: 1,
    },
    requireProductHostOrigin(),
    [channel.port2],
  );
  await waitForBrowserProbeEvent({ type: "ready" });

  const sourceResponse = await networkFetch("/fixtures/browser-probe.pptx");
  if (!sourceResponse.ok)
    throw new Error(`Browser probe source failed: ${sourceResponse.status}`);
  const bytes = new Uint8Array(await sourceResponse.arrayBuffer());
  const openRequestId = `browser-probe-open-${++requestSequence}`;
  const transferable = bytes.slice();
  browserProbePort.postMessage(
    {
      type: "open",
      requestId: openRequestId,
      documentId: "browser-probe",
      fileName: "browser-probe.pptx",
      revision: '"browser-probe:baseline"',
      maxBytes: 64 * 1024 * 1024,
      bytes: transferable.buffer,
    },
    [transferable.buffer],
  );
  await waitForBrowserProbeEvent({
    type: "open-complete",
    requestId: openRequestId,
  });

  globalThis.__spellbookLaunch = { accessToken: "browser-probe" };
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
      location.href,
    );
    if (url.pathname !== "/native/probe") return networkFetch(input, init);
    try {
      const request = JSON.parse(String(init?.body ?? "null"));
      const value = await browserProbeNativeCall(request);
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  };
  saveButton.textContent = "저장";
  saveButton.disabled = false;
  const extensionFrame = document.createElement("iframe");
  extensionFrame.hidden = true;
  extensionFrame.src = "/extensions/org.spellbook.editor/browser-probe.html";
  document.body.append(extensionFrame);
  body.dataset.browserProbe = "ready";
}

window.addEventListener("error", (event) => {
  body.dataset.error = event.message;
  setState("error", event.message);
});

// The engine's threads need an isolated frame. A browser that cannot isolate
// it is told apart from a failure so the product can refuse the browser.
if (productMode && !globalThis.crossOriginIsolated) {
  window.parent.postMessage(
    { type: "spellbook.browser-office-unsupported", protocolVersion: 1 },
    requireProductHostOrigin(),
  );
  throw new Error("This browser cannot isolate the editor frame.");
}

// A static host serves each runtime build under its own folder so browsers
// can keep the large engine files; the runtime identity script names it.
const runtimeBase = new URL(
  globalThis.spellbookBrowserRuntimeBase ?? "/runtime/",
  location.href,
).href;
const ooxmlWorker = new Worker(new URL("ooxml-worker.js", runtimeBase), {
  type: "module",
});
ooxmlWorker.onmessage = (event) => {
  const waiter = mutationPending.get(event.data.requestId);
  if (!waiter) return;
  mutationPending.delete(event.data.requestId);
  if (event.data.error) waiter.reject(new Error(event.data.error));
  else waiter.resolve(event.data);
};
ooxmlWorker.onerror = (event) => {
  body.dataset.error = event.message;
  setState("error", event.message);
};
installTextInputBridge({
  canvas,
  textInput: document.querySelector("#text-input"),
  compositionBox: document.querySelector("#composition"),
});
globalThis.Module = {
  canvas,
  uno_scripts: [
    new URL("zeta.js", runtimeBase).href,
    new URL("browser-candidate.js", runtimeBase).href,
    new URL("/harness/runtime-admission.js", location.href).href,
    new URL("/harness/mutation-contract.generated.js", location.href).href,
    new URL("/harness/operations.js", location.href).href,
    new URL("/harness/native-transform-adapter.js", location.href).href,
    new URL("/harness/office-thread.js", location.href).href,
  ],
  locateFile: (path, prefix) => (prefix || runtimeBase) + path,
  preRun: [useQtFonts, installRuntimeFiles],
};

// LibreOffice's Qt layer draws text with cairo unless SAL_VCL_QT_USE_QFONT is
// set, and only the Qt font path registers the Korean fonts with Qt (patches
// 0047 and 0049). Qt draws the menu bar, context menus and tooltips itself,
// so without it their Korean labels were empty boxes; slides render the same.
function useQtFonts() {
  ENV.SAL_VCL_QT_USE_QFONT = "1";
}

// The engine carries no Korean fonts or Korean UI setting. Write them, with
// the font rules, into its file system before it starts; runtime/files.json
// lists the files.
function installRuntimeFiles() {
  Module.addRunDependency("spellbook-runtime-files");
  (async () => {
    const listing = await networkFetch(new URL("files.json", runtimeBase));
    if (!listing.ok) throw new Error("The editor file list failed to load.");
    const files = await Promise.all(
      (await listing.json()).map(async (file) => {
        const response = await networkFetch(new URL(file.url, runtimeBase));
        if (!response.ok)
          throw new Error(`The editor file ${file.name} failed to load.`);
        return { ...file, bytes: new Uint8Array(await response.arrayBuffer()) };
      }),
    );
    for (const file of files) {
      Module.FS_createPath("/", file.directory.slice(1), true, true);
      Module.FS_createDataFile(
        file.directory,
        file.name,
        file.bytes,
        true,
        false,
        true,
      );
    }
  })().then(
    () => Module.removeRunDependency("spellbook-runtime-files"),
    (error) => {
      body.dataset.error = error.message;
      setState("error", error.message);
    },
  );
}
Module.mainScriptUrlOrBlob = new Blob(
  [
    `importScripts(${JSON.stringify(new URL("soffice.js", runtimeBase).href)});`,
  ],
  { type: "text/javascript" },
);

const script = document.createElement("script");
script.src = new URL("soffice.js", runtimeBase).href;
script.onload = () => {
  Module.uno_main.then((messagePort) => {
    enginePort = messagePort;
    enginePort.onmessage = async (event) => {
      const message = event.data;
      if (message.command === "runtime-ready") {
        runtimeReady = true;
        setState("runtime-ready", "Engine ready");
        if (productMode) {
          window.parent.postMessage(
            {
              type: "spellbook.browser-office-ready",
              protocolVersion: 1,
              bridgeSessionId: productBridgeSessionId,
            },
            requireProductHostOrigin(),
          );
          startProductHeartbeat();
          if (browserProbeMode)
            void startBrowserProbe().catch((error) => {
              body.dataset.error = error.message;
              setState("error", error.message);
            });
        } else if (query.get("autorun") === "1") {
          try {
            await runConformance();
          } catch (error) {
            body.dataset.error = error.message;
            setState("error", error.message);
          }
        }
        return;
      }
      settle(message);
    };
  });
};
script.onerror = () =>
  setState("error", "Failed to load Browser Office runtime");
document.body.append(script);

globalThis.spellbookBrowserOffice = {
  saveProbe: saveBrowserProbeDocument,
  artifactLabels() {
    return [...savedArtifacts.keys()];
  },
  artifact(label) {
    const bytes = savedArtifacts.get(label);
    return bytes ? Array.from(bytes) : null;
  },
  evidence: observed,
  diagnostics() {
    return {
      state: body.dataset.state,
      error: body.dataset.error || null,
      pending: [...pending.entries()].map(([requestId, waiter]) => ({
        requestId,
        command: waiter.command,
      })),
      mutationPending: [...mutationPending.keys()],
      commandCount: commands.length,
      undoCount: productUndoHistory.length,
      redoCount: productRedoHistory.length,
      reconciledModelRevision,
      unreconciledModelRevision,
      hostSaveRequestId,
      checkpointInFlight,
      ...(browserProbeMode ? { browserProbePhaseTrace } : {}),
    };
  },
  probeHistory(direction = null) {
    if (!browserProbeMode) throw new Error("Browser probe mode is not active.");
    return browserProbeHistory(direction);
  },
  async verifySerializedState() {
    if (!productMode || query.get("verifySerialization") !== "1")
      throw new Error("Browser serialization probe is not active.");
    const live = await observeNativeDocument();
    const startedAt = performance.now();
    const serialized = await serializeNativeDocument({
      inspect: true,
      detailSlideIndex: live.textDetails?.slideIndex,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    const normalized = await normalizeNativeDocumentBytes(currentBytes);
    const normalizedObservation = await inspectNativeDocumentBytes(
      normalized,
      live.textDetails?.slideIndex,
    );
    const retained = await observeNativeDocument();
    return {
      durationMs,
      liveRevision: live.revision,
      reopenedRevision: serialized.observation.revision,
      normalizedRevision: normalizedObservation.revision,
      serializedBytes: Array.from(serialized.bytes),
      normalizedBytes: Array.from(normalized),
      retainedRevision: retained.revision,
      slideCount: serialized.observation.slides?.length,
    };
  },
  async verifyProductBytes() {
    if (!productMode || query.get("verifySerialization") !== "1")
      throw new Error("Browser product export probe is not active.");
    return Array.from(await exportProductDocument({ checkpoint: false }));
  },
};
