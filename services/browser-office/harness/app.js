/* SPDX-License-Identifier: MPL-2.0 */

import {
  openBrowserDocumentJournal,
  requestPersistentBrowserStorage,
} from "/harness/opfs-journal.mjs";
import {
  persistedSectionsMatch,
  persistedSlideTopologyMatches,
} from "/harness/product-persistence.mjs";
import {
  acknowledgedSaveHasLaterChanges,
  createSaveSnapshot,
  laterHistoryFromSaveSnapshot,
} from "/harness/save-transaction.mjs";
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
let journal;
let productExportQueue = Promise.resolve();
let productMessageQueue = Promise.resolve();
const commands = [];
const productUndoHistory = [];
const productRedoHistory = [];
let reconciledModelRevision = "";
let unreconciledModelRevision = "";

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
    await request("native", {
      nativeRequest: { operation: "observe", captureSlideIndexes: [] },
    })
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
    await request("native", {
      nativeRequest: {
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
      },
    })
  ).value;
  const changed = edited.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.elementId === target.elementId);
  if (changed?.text !== replacement || edited.revision === before.revision)
    throw new Error("Browser native edit did not change the selected text.");
  await request("dispatch", { unoCommand: "Undo" });
  const restored = (
    await request("native", {
      nativeRequest: { operation: "observe", captureSlideIndexes: [] },
    })
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

async function withPackageDocumentMetadata(value) {
  if (!currentBytes || !value || typeof value !== "object") return value;
  const metadata = await inspectPackage(currentBytes);
  return { ...value, sections: metadata.report.sections };
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

async function serializeNativeDocument() {
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
    return bytes;
  } finally {
    try {
      FS.unlink(outputPath);
    } catch {}
  }
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
  const result = await request("native", {
    nativeRequest: { operation: "observe", captureSlideIndexes: [] },
  });
  if (
    !result.value ||
    typeof result.value.revision !== "string" ||
    !result.value.revision
  )
    throw new Error("Browser Office observation has no document revision.");
  return result.value;
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
        return observedTextDecoration(target.underline) === command.underline;
      case "strikethrough":
        return (
          observedTextDecoration(target.strikethrough) === command.strikethrough
        );
      case "font_family":
        return everyTextFormattingValue(
          target,
          "fontFamily",
          (value) => value === command.family,
        );
      case "font_color":
        return target.color === command.color;
      case "paragraph_alignment":
        return (
          observedParagraphAlignment(target.paragraphAlignment) ===
          command.alignment
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
        : ![
            "audio/mpeg",
            "audio/wav",
            "audio/ogg",
            "audio/mp4",
            "video/mp4",
            "video/webm",
          ].includes(nativeRequest.mediaType))
    )
      throw new Error("invalid_asset");
    return {
      persistence: "native_snapshot",
      beforeBytes: currentBytes.slice(),
      beforeRevision: reconciledModelRevision,
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
    return {
      persistence: "native_snapshot",
      beforeBytes: currentBytes.slice(),
      beforeRevision: reconciledModelRevision,
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
        color: Math.round(command.color),
      };
    case "line_color":
      return {
        ...base,
        expectedColor: expectedElement.lineColor,
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
    case "underline":
      return {
        ...base,
        expectedUnderline: observedTextDecoration(expectedElement.underline),
        underline: command.underline,
      };
    case "strikethrough":
      return {
        ...base,
        expectedStrikethrough: observedTextDecoration(
          expectedElement.strikethrough,
        ),
        strikethrough: command.strikethrough,
      };
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
    case "font_color":
      return {
        ...base,
        expectedColor: expectedElement.color,
        color: Math.round(command.color),
      };
    case "paragraph_alignment":
      return {
        ...base,
        expectedAlignment: observedParagraphAlignment(
          expectedElement.paragraphAlignment,
        ),
        alignment: command.alignment,
      };
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
  const undoHistoryLength = productUndoHistory.length;
  const commandLength = commands.length;
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
    productUndoHistory.length = undoHistoryLength;
    commands.length = commandLength;
    await writeAndOpen(prepared.beforeBytes, filename);
    const restored = await observeNativeDocument();
    reconciledModelRevision = restored.revision;
    unreconciledModelRevision = "";
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
  if (prepared.persistence === "native_snapshot") {
    if (nativeValue.revision === prepared.beforeRevision) {
      reconciledModelRevision = nativeValue.revision;
      unreconciledModelRevision = "";
      return;
    }
    let afterBytes;
    try {
      afterBytes = await serializeNativeDocument();
      if ((await sha256(afterBytes)) === (await sha256(prepared.beforeBytes)))
        throw new Error("Browser native edit did not change the PPTX package.");
    } catch (error) {
      await request("dispatch", { unoCommand: "Undo" });
      const restored = await observeNativeDocument();
      if (restored.revision !== prepared.beforeRevision) {
        unreconciledModelRevision = restored.revision;
        throw new Error("browser_native_snapshot_rollback_failed");
      }
      reconciledModelRevision = restored.revision;
      unreconciledModelRevision = "";
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
      currentBytes = prepared.beforeBytes;
      productUndoHistory.pop();
      commands.pop();
      await request("dispatch", { unoCommand: "Undo" });
      const restored = await observeNativeDocument();
      if (restored.revision !== prepared.beforeRevision)
        throw new Error(
          `browser_native_snapshot_checkpoint_and_rollback_failed:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      reconciledModelRevision = restored.revision;
      throw error;
    }
    observed.lastMutation = {
      persistence: "native_snapshot",
      sourceOperations: prepared.sourceOperations,
    };
    evidence.value = JSON.stringify(observed);
    return;
  }
  if (!productMutationMatches(prepared, nativeValue)) {
    await request("dispatch", { unoCommand: "Undo" });
    const restored = await observeNativeDocument();
    if (restored.revision !== prepared.beforeRevision) {
      unreconciledModelRevision = restored.revision;
      throw new Error("browser_native_package_disagreement_rollback_failed");
    }
    reconciledModelRevision = restored.revision;
    unreconciledModelRevision = "";
    throw new Error("Browser native and package edits disagree.");
  }
  if (!prepared.mutation.report.changedParts.length) {
    reconciledModelRevision = nativeValue.revision;
    unreconciledModelRevision = "";
    return;
  }
  const afterBytes = new Uint8Array(prepared.mutation.bytes);
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
    nativeRequest: prepared.nativeRequest,
    permission: prepared.permission,
    command: journalCommand,
    nativeUndoAvailable: nativeUndoAvailableFor(prepared.nativeCommand.op),
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
    currentBytes = prepared.beforeBytes;
    productUndoHistory.pop();
    commands.pop();
    await request("dispatch", { unoCommand: "Undo" });
    const restored = await observeNativeDocument();
    if (restored.revision !== prepared.beforeRevision)
      throw new Error(
        `browser_package_checkpoint_and_rollback_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    reconciledModelRevision = restored.revision;
    throw error;
  }
  observed.lastMutation = prepared.mutation.report;
  evidence.value = JSON.stringify(observed);
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

async function undoProductMutation() {
  const previous = productUndoHistory.at(-1);
  if (!previous || !commands.length) return false;
  const current = await observeNativeDocument();
  if (current.revision !== reconciledModelRevision) {
    unreconciledModelRevision = current.revision;
    return false;
  }
  const useNativeUndo = previous.nativeUndoAvailable === true;
  if (useNativeUndo) {
    await request("dispatch", { unoCommand: "Undo" });
    const restored = await observeNativeDocument();
    if (restored.revision !== previous.beforeRevision) {
      const difference = firstModelDifference(
        previous.beforeSlides,
        restored.slides,
      );
      await request("dispatch", { unoCommand: "Redo" });
      const recovered = await observeNativeDocument();
      unreconciledModelRevision =
        recovered.revision === previous.afterRevision ? "" : recovered.revision;
      throw new Error(
        `browser_native_undo_revision_mismatch:${difference ?? "unknown"}`,
      );
    }
    currentBytes = previous.beforeBytes.slice();
    previous.nativeUndoAvailable = false;
    previous.nativeRedoAvailable = true;
  } else {
    await writeAndOpen(previous.beforeBytes, filename);
    const restored = await observeNativeDocument();
    if (restored.revision !== previous.beforeRevision) {
      unreconciledModelRevision = restored.revision;
      throw new Error("browser_package_undo_revision_mismatch");
    }
  }
  productUndoHistory.pop();
  commands.pop();
  productRedoHistory.push(previous);
  reconciledModelRevision = previous.beforeRevision;
  unreconciledModelRevision = "";
  try {
    await persistCheckpoint();
  } catch (error) {
    productRedoHistory.pop();
    productUndoHistory.push(previous);
    commands.push(previous.command);
    if (useNativeUndo) {
      await request("dispatch", { unoCommand: "Redo" });
      const recovered = await observeNativeDocument();
      if (recovered.revision !== previous.afterRevision)
        throw new Error("browser_undo_checkpoint_rollback_failed");
      previous.nativeUndoAvailable = true;
      previous.nativeRedoAvailable = false;
      currentBytes = previous.afterBytes.slice();
    } else {
      await writeAndOpen(previous.afterBytes, filename);
      const recovered = await observeNativeDocument();
      if (recovered.revision !== previous.afterRevision)
        throw new Error("browser_undo_checkpoint_reopen_failed");
    }
    reconciledModelRevision = previous.afterRevision;
    throw error;
  }
  reportHostModified(commands.length > 0);
  return true;
}

async function redoProductMutation() {
  const next = productRedoHistory.at(-1);
  if (!next) return false;
  if ((await sha256(currentBytes)) !== (await sha256(next.beforeBytes)))
    throw new Error("Browser redo base no longer matches the package history.");
  const current = await observeNativeDocument();
  if (current.revision !== reconciledModelRevision) {
    unreconciledModelRevision = current.revision;
    return false;
  }
  const useNativeRedo = next.nativeRedoAvailable === true;
  const canReplayNative =
    !useNativeRedo &&
    next.nativeRequest &&
    typeof next.nativeRequest === "object";
  if (useNativeRedo) {
    await request("dispatch", { unoCommand: "Redo" });
    const restored = await observeNativeDocument();
    if (restored.revision !== next.afterRevision) {
      await request("dispatch", { unoCommand: "Undo" });
      const recovered = await observeNativeDocument();
      unreconciledModelRevision =
        recovered.revision === next.beforeRevision ? "" : recovered.revision;
      throw new Error("browser_native_redo_revision_mismatch");
    }
    currentBytes = next.afterBytes.slice();
    next.nativeUndoAvailable = true;
    next.nativeRedoAvailable = false;
  } else if (canReplayNative) {
    const replayed = (
      await request("native", {
        nativeRequest: {
          ...next.nativeRequest,
          expectedRevision: current.revision,
          expectedSlides: JSON.stringify(current.slides),
          suppressCapture: true,
        },
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
      await request("dispatch", { unoCommand: "Undo" });
      const recovered = await observeNativeDocument();
      unreconciledModelRevision =
        recovered.revision === next.beforeRevision ? "" : recovered.revision;
      throw new Error("browser_native_replay_revision_mismatch");
    }
    currentBytes = next.afterBytes.slice();
    next.nativeUndoAvailable =
      next.persistence === "native_snapshot" ||
      nativeUndoAvailableFor(next.nativeCommand?.op);
    next.nativeRedoAvailable = false;
  } else {
    await writeAndOpen(next.afterBytes, filename);
    const restored = await observeNativeDocument();
    if (restored.revision !== next.afterRevision) {
      unreconciledModelRevision = restored.revision;
      throw new Error("browser_package_redo_revision_mismatch");
    }
  }
  productRedoHistory.pop();
  productUndoHistory.push(next);
  commands.push(next.command);
  reconciledModelRevision = next.afterRevision;
  unreconciledModelRevision = "";
  try {
    await persistCheckpoint();
  } catch (error) {
    commands.pop();
    productUndoHistory.pop();
    productRedoHistory.push(next);
    if (useNativeRedo || canReplayNative) {
      await request("dispatch", { unoCommand: "Undo" });
      const recovered = await observeNativeDocument();
      if (recovered.revision !== next.beforeRevision)
        throw new Error("browser_redo_checkpoint_rollback_failed");
      next.nativeUndoAvailable = false;
      next.nativeRedoAvailable = true;
      currentBytes = next.beforeBytes.slice();
    } else {
      await writeAndOpen(next.beforeBytes, filename);
      const recovered = await observeNativeDocument();
      if (recovered.revision !== next.beforeRevision)
        throw new Error("browser_redo_checkpoint_reopen_failed");
    }
    reconciledModelRevision = next.beforeRevision;
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
}

async function checkpointLiveNativeState(live, reason) {
  if (
    !live ||
    typeof live.revision !== "string" ||
    !live.revision ||
    live.revision === reconciledModelRevision
  )
    return false;
  const beforeBytes = currentBytes;
  const beforeRevision = reconciledModelRevision;
  const beforeCommands = commands.slice();
  const beforeUndoHistory = productUndoHistory.slice();
  const beforeRedoHistory = productRedoHistory.slice();
  const afterBytes = await serializeNativeDocument();
  const previousManualSnapshot =
    commands.at(-1)?.persistence === "native_snapshot" &&
    commands.at(-1)?.sourceOperations?.length === 1 &&
    commands.at(-1)?.sourceOperations?.[0] === "manual_edit"
      ? commands.at(-1)
      : null;
  const snapshotCommand = {
    op: "native_snapshot",
    persistence: "native_snapshot",
    sourceOperations: ["manual_edit"],
    reason,
    reconciliation: {
      beforeRevision:
        previousManualSnapshot?.reconciliation?.beforeRevision ??
        beforeRevision,
      afterRevision: live.revision,
      nativeRequest: { operation: "manual_edit" },
    },
  };
  currentBytes = afterBytes;
  if (previousManualSnapshot) commands[commands.length - 1] = snapshotCommand;
  else commands.push(snapshotCommand);
  productUndoHistory.length = 0;
  productRedoHistory.length = 0;
  reconciledModelRevision = live.revision;
  unreconciledModelRevision = "";
  currentSlideCount = Array.isArray(live.slides)
    ? live.slides.length
    : currentSlideCount;
  try {
    await persistCheckpoint();
  } catch (error) {
    currentBytes = beforeBytes;
    commands.splice(0, commands.length, ...beforeCommands);
    productUndoHistory.splice(
      0,
      productUndoHistory.length,
      ...beforeUndoHistory,
    );
    productRedoHistory.splice(
      0,
      productRedoHistory.length,
      ...beforeRedoHistory,
    );
    reconciledModelRevision = beforeRevision;
    unreconciledModelRevision = live.revision;
    throw error;
  }
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
  await requestPersistentBrowserStorage();
  await openJournal(initial, message.fileName, message.documentId);
  const recovered = await journal.load();
  baseBytes = initial.slice();
  let candidate = initial;
  let recoveredSnapshotHistory = null;
  if (recovered) {
    if ((await sha256(recovered.baseBytes)) !== (await sha256(initial)))
      throw new Error("Browser recovery base differs from the host document.");
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
    hostSaveSnapshot = createSaveSnapshot(
      bytes,
      reconciledModelRevision,
      commands.length,
      productUndoHistory.length,
    );
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
    if (
      message.messageId === "welcome-close" ||
      message.messageId === "Host_PostmessageReady"
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
      if (hasLaterChanges) {
        const laterHistory = laterHistoryFromSaveSnapshot(
          saved,
          currentBytes,
          reconciledModelRevision,
          commands,
          productUndoHistory,
        );
        if (laterHistory) {
          commands.splice(0, commands.length, ...laterHistory.commands);
          productUndoHistory.splice(
            0,
            productUndoHistory.length,
            ...laterHistory.undoHistory,
          );
        } else {
          const snapshotCommand = {
            op: "native_snapshot",
            persistence: "native_snapshot",
            sourceOperations: ["edit_after_save_request"],
            reason: "save_acknowledged_with_later_edits",
            reconciliation: {
              beforeRevision: saved.modelRevision,
              afterRevision: reconciledModelRevision,
              nativeRequest: null,
            },
          };
          commands.splice(0, commands.length, snapshotCommand);
          productUndoHistory.splice(0, productUndoHistory.length, {
            beforeBytes: saved.bytes.slice(),
            afterBytes: currentBytes.slice(),
            beforeRevision: saved.modelRevision,
            afterRevision: reconciledModelRevision,
            beforeSlides: [],
            nativeRequest: null,
            command: snapshotCommand,
            persistence: "native_snapshot",
            nativeUndoAvailable: false,
            nativeRedoAvailable: false,
          });
        }
        productRedoHistory.length = 0;
        await persistCheckpoint();
      } else {
        await request("mark-saved");
        await journal.clear();
        history.length = 0;
        commands.length = 0;
        productUndoHistory.length = 0;
        productRedoHistory.length = 0;
      }
      const afterAcknowledgement = await observeNativeDocument();
      if (afterAcknowledgement.revision !== reconciledModelRevision)
        await checkpointLiveNativeState(
          afterAcknowledgement,
          "manual_after_save_acknowledgement",
        );
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
  if (typeof message.id === "string" && message.request) {
    try {
      const prepared = await prepareProductPackageMutation(message.request);
      let value;
      if (prepared?.persistence === "package_reload") {
        value = await commitProductPackageReload(prepared);
      } else {
        const result = await request("native", {
          nativeRequest: message.request,
        });
        await commitProductPackageMutation(prepared, result.value);
        value = await withPackageDocumentMetadata(result.value);
      }
      const status = await request("status");
      reportHostModified(
        Boolean(status.modified) ||
          commands.length > 0 ||
          Boolean(unreconciledModelRevision),
      );
      postHost({ id: message.id, value });
    } catch (error) {
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
let checkpointInFlight = false;
let lastCheckpointAt = 0;
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
      if (modified && Date.now() - lastCheckpointAt >= 10_000) {
        const live = await observeNativeDocument();
        if (live.revision !== reconciledModelRevision)
          await checkpointLiveNativeState(live, "manual_autosave");
        else await persistCheckpoint();
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

saveButton.addEventListener("click", async () => {
  if (!currentBytes) throw new Error("Open a PPTX before saving.");
  if (browserProbeMode) {
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
    return;
  }
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
          new Error(`Browser probe event timed out: ${JSON.stringify(match)}`),
        );
      else setTimeout(poll, 25);
    };
    poll();
  });
}

async function browserProbeNativeCall(nativeRequest) {
  const id = `browser-probe-native-${++requestSequence}`;
  browserProbePort.postMessage({ id, request: nativeRequest });
  const event = await waitForBrowserProbeEvent({ id });
  if (event.error) throw new Error(event.error);
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
    await waitForBrowserProbeEvent({
      type: "command-complete",
      messageId: "Send_UNO_Command",
      requestId,
    });
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

const runtimeBase = new URL("/runtime/", location.href).href;
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
};
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
    };
  },
  probeHistory(direction = null) {
    if (!browserProbeMode) throw new Error("Browser probe mode is not active.");
    return browserProbeHistory(direction);
  },
};
