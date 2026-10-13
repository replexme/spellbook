// The document view inside the Spellbook workspace (the iframe the web app
// connects to with `spellbook.document-view-connect`). It shows the slides
// drawn by the Present engine and carries out the AI's observe and edit
// requests on the same engine; people do not edit here. Protocol version 1,
// as the web app's NativeWorkspace speaks it. InDesign (IDML) documents show
// their pages the same way (idml.mjs).
import contract from "./native-edit-capabilities.json" with { type: "json" };
import { engineCommands, Refused, SUPPORTED_OPERATIONS } from "./commands.mjs";
import { project, assertServiceObservation, assertWorkspacePermission, textDetails, layoutAudit, changedSlides, canonical } from "./observation.mjs";
import { projectIdml, idmlCommands, oversetIssues, IDML_OPERATIONS } from "./idml.mjs";

const runtime = JSON.parse(document.getElementById("office-runtime-config").textContent);
const origin = new URL(location.href).searchParams.get("hostOrigin");
if (!origin || new URL(origin).origin !== origin || !runtime.hostOrigins.includes(origin)) throw Error("trusted_host_origin_required");

// Version 2: the host sends save-now, undo, redo and show-page directly (version 1 wrapped
// them in an older editor's command names).
const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------- engine
const worker = new Worker(new URL("./engine-worker.mjs", import.meta.url), { type: "module" });
let seq = 0;
const calls = new Map();
worker.onmessage = ({ data }) => {
  const call = calls.get(data.id);
  if (!call) return;
  calls.delete(data.id);
  data.error !== undefined ? call.reject(engineError(data.error)) : call.resolve(data.value);
};
worker.onerror = (event) => {
  for (const call of calls.values()) call.reject(Error(event.message || "engine_worker_failed"));
  calls.clear();
};
function engineError(message) {
  try {
    const e = JSON.parse(message);
    const error = Error(`${e.code}: ${e.detail}`);
    error.code = e.code;
    error.index = e.index;
    return error;
  } catch {
    return Error(message);
  }
}
const engine = (method, ...args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject });
    worker.postMessage({ id, method, args }, args.filter((a) => a instanceof ArrayBuffer));
  });

const hex = (buffer) => [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, "0")).join("");
const base64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

// ---------------------------------------------------------------- state
let host = null;
let documentName = "문서.pptx";
let format = "pptx"; // of the open document: "pptx" or "idml"
let hostRevision = null;
let opened = false;
let version = 0;
let savedVersion = 0;
let current = null; // snapshot of `version`
let activeSlide = 0;
let selected = [];
let saveWaiter = null;
const assets = new Map();
const taskResponses = new Map();
const taskFingerprints = new Map();

const post = (value, transfer = []) => {
  if (typeof value.id === "string" && taskFingerprints.has(value.id) && !taskResponses.has(value.id)) {
    const { images, ...rest } = value.value ?? {};
    taskResponses.set(value.id, { fingerprint: taskFingerprints.get(value.id), response: structuredClone(value) });
    void rest;
    while (taskResponses.size > 100) {
      const id = taskResponses.keys().next().value;
      taskResponses.delete(id);
      taskFingerprints.delete(id);
    }
  }
  host?.postMessage(value, transfer);
};

async function fingerprint(request) {
  const value = { ...request };
  if (value.assetBytes instanceof ArrayBuffer) value.assetBytes = hex(await crypto.subtle.digest("SHA-256", value.assetBytes));
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
}

/** The deck at the current version: engine description, AI projection, file bytes and revision. */
async function snapshot() {
  if (current && current.version === version) return current;
  const raw = JSON.parse(await engine("describe"));
  const bytes = new Uint8Array(await engine("save"));
  const revision = hex(await crypto.subtle.digest("SHA-256", bytes));
  // `describe` is deck-shaped for both formats (the view draws and picks from it).
  const { state, lookup, view } = format === "idml" ? projectIdml(raw) : project(raw);
  const describe = view ?? raw;
  current = { version, describe, state: { ...state, revision }, lookup, bytes };
  if (activeSlide >= state.slides.length) activeSlide = Math.max(0, state.slides.length - 1);
  selected = selected.filter((id) => lookup.has(id));
  return current;
}

async function capture(snap, index) {
  const scale = 1280 / (snap.describe.width ?? 720);
  return base64(await engine("render", index + 1, scale));
}

const operations = () => (format === "idml" ? IDML_OPERATIONS : SUPPORTED_OPERATIONS);

// Text the engine laid out past its box, or drew with a substitute for a
// missing font, per slide of one document version. After an edit only the
// slides it changed are laid out again; fonts added later lay out all again.
let fit = { version: -1, slides: [] };

/** The engine's text facts for the slides of `snap` (PPTX). */
async function textFit(snap, recompute = null) {
  if (fit.version === snap.version && !recompute) return fit.slides;
  const count = snap.state.slides.length;
  const slides = [];
  for (let i = 0; i < count; i++) {
    if (recompute && !recompute.has(i) && fit.slides.length === count && fit.slides[i]) {
      slides.push(fit.slides[i]);
      continue;
    }
    const byShape = new Map([...snap.lookup.values()].filter((e) => e.slide === i + 1).map((e) => [e.shapeId, e.elementId]));
    slides.push(
      JSON.parse(await engine("text_fit", i + 1)).flatMap((t) => {
        const elementId = byShape.get(t.shapeId);
        if (!elementId) return [];
        // A substitute font may break lines differently from PowerPoint with the document's own fonts.
        const substituted = t.substituted ? { severity: "warning", fontsSubstituted: true } : {};
        return t.overflow > 0
          ? [{ code: "text_overflow", slideIndex: i, elementId, overflowPt: t.overflow, ...substituted }]
          : [{ code: "font_substituted", severity: "info", slideIndex: i, elementId }];
      }),
    );
  }
  fit = { version: snap.version, slides };
  return slides;
}

/**
 * Layout issues: the geometry check, then what the engine knows from laying
 * the text out (PPTX: text past its box, substitute fonts; IDML: overset
 * text). `previous` (the audit before an edit) marks the issues it introduced.
 */
async function audit(snap, previous = null, recompute = null) {
  const result = layoutAudit(snap.state, null);
  const text = format === "idml" ? oversetIssues(snap.state) : (await textFit(snap, recompute)).flat();
  result.issues.push(...text);
  result.issueCount = result.issues.length;
  result.scope = "authored geometry, and text as the engine lays it out";
  if (previous) {
    const key = (issue) => JSON.stringify([issue.code, issue.slideIndex, issue.elementId ?? null, issue.elementIds ?? null]);
    const old = new Set(previous.issues.map(key));
    result.introducedIssues = result.issues.filter((issue) => !old.has(key(issue)));
    result.introducedIssueCount = result.introducedIssues.length;
  }
  return result;
}

async function decorate(snap, request = {}, extra = {}) {
  const obs = snap.state;
  const detail = Number.isSafeInteger(request.detailSlideIndex) ? request.detailSlideIndex : activeSlide;
  const indexes = request.captureSlideIndexes ?? [detail];
  if (!Array.isArray(indexes) || indexes.length > 8) throw Error("capture_slide_invalid");
  const images = [];
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || !obs.slides[index]) throw Error("capture_slide_invalid");
    images.push({ slideIndex: index, pngBase64: await capture(snap, index) });
  }
  return {
    ...obs,
    layoutAudit: await audit(snap),
    ...(obs.slides[detail] ? { textDetails: textDetails(obs, snap.lookup, detail) } : {}),
    unit: "1/100mm",
    activeSlide,
    selectedElementIds: [...selected],
    images,
    changedSlideIndexes: [],
    visualEvidenceComplete: true,
    engine: { name: "Present", supportedOperations: operations() },
    ...extra,
  };
}

function documentContext(snap) {
  const next = new Map();
  return {
    slideCount: snap.describe.slides.length,
    masters: snap.describe.masters,
    element(id) {
      const t = snap.lookup.get(id);
      if (!t) throw new Refused("invalid_command", `element ${id} is not in the observation`);
      return t;
    },
    slide(index) {
      const s = snap.describe.slides[index];
      if (!s) throw new Refused("invalid_command", `slide ${index} is not in the observation`);
      return s;
    },
    nextShapeId(slide) {
      const id = next.get(slide) ?? (snap.describe.slides[slide - 1]?.maxShapeId ?? 1) + 1;
      next.set(slide, id + 1);
      return id;
    },
    asset(id) {
      const a = assets.get(id);
      if (!a) throw new Refused("invalid_command", `asset ${id} was not transferred to the editor`);
      return { base64: base64(a.bytes), mediaType: a.mediaType };
    },
    paragraphDetail(elementId, paragraph) {
      const slideIndex = Number(elementId.split("/")[0]);
      const element = textDetails(snap.state, snap.lookup, slideIndex).elements.find((e) => e.elementId === elementId);
      const p = element?.paragraphs[paragraph];
      if (!p) throw new Refused("invalid_command", `paragraph ${paragraph} of ${elementId} not found`);
      return p;
    },
    now: () => new Date().toISOString(),
  };
}

const STRUCTURE = new Set(["insert_slide", "duplicate_slide", "delete_slide", "move_slide", "set_sections", "set_slide_size", "set_master_theme"]);

/** Checks and translates an edit; `apply` runs it in the engine. Changes nothing. */
async function prepareEdit(request, commands) {
  if (!Array.isArray(commands) || !commands.length || commands.length > 50 || commands.some((c) => !c || typeof c !== "object")) throw Error("invalid_edit_commands");
  const before = await snapshot();
  assertServiceObservation(before.state, request);
  assertWorkspacePermission(commands, request.permission, contract.mutationModel.operations);
  const context = documentContext(before);
  const origin = [];
  const translated = [];
  commands.forEach((command, index) => {
    if (!operations().includes(command.op)) throw new Refused("unsupported_by_engine", `operation ${command.op}`);
    let list;
    try {
      list = format === "idml" ? idmlCommands(command, before.lookup, { ...context, pageCount: before.describe.slides.length }) : engineCommands(command, context);
    } catch (e) {
      throw Error(commands.length > 1 ? `command ${index}: ${e.message}` : e.message);
    }
    for (const c of list) {
      translated.push(c);
      origin.push(index);
    }
  });
  const targeted = STRUCTURE.has(commands[0]?.op) ? [] : translated.map((c) => c.slide - 1).filter((i) => Number.isSafeInteger(i));
  const apply = async () => {
    try {
      return JSON.parse(await engine("apply", JSON.stringify(translated), version));
    } catch (e) {
      throw Error(e.index != null && commands.length > 1 ? `command ${origin[e.index]}: ${e.message}` : e.message);
    }
  };
  return { before, targeted, apply };
}

/**
 * An edit refused before anything changed. The engine applies a batch as one
 * transaction (all or nothing), so every failure up to and including `apply`
 * leaves the document as it was. The web app's save rule and the AI runtime
 * count only errors with this prefix as "nothing changed"; any other failure
 * of an edit is treated as a possible unconfirmed change.
 */
function rejected(error) {
  const out = Error(`product_mutation_rejected:${error.message}`, { cause: error });
  if (error.code !== undefined) out.code = error.code;
  return out;
}

/** Applies AI commands as one undo step and reports what changed. */
async function edit(request, commands) {
  let prepared;
  try {
    prepared = await prepareEdit(request, commands);
  } catch (error) {
    throw rejected(error);
  }
  const { before, targeted, apply } = prepared;
  // Laid out at the version the edit starts from, before the engine moves on.
  const beforeAudit = request.dryRun ? null : await audit(before);
  if (request.dryRun) {
    // Applied and reverted, so the engine checks every target and value.
    let receipt;
    try {
      receipt = await apply();
    } catch (error) {
      throw rejected(error);
    }
    version = receipt.version;
    version = await engine("undo", version);
    return decorate(await snapshot(), { captureSlideIndexes: [] }, { dryRun: true });
  }
  let receipt;
  try {
    receipt = await apply();
  } catch (error) {
    throw rejected(error);
  }
  version = receipt.version;
  const after = await snapshot();
  const changed = changedSlides(before.state, after.state, targeted);
  const relaid = STRUCTURE.has(commands[0]?.op) || before.state.slides.length !== after.state.slides.length ? null : new Set(changed);
  const afterAudit = await audit(after, beforeAudit, relaid);
  const value = await decorate(after, { captureSlideIndexes: changed.slice(0, 8) }, { layoutAudit: afterAudit });
  value.changedSlideIndexes = changed;
  value.visualEvidenceComplete = changed.length <= 8;
  value.undoSteps = 1;
  value.transaction = { status: "committed", undoActionsAdded: 1 };
  value.engineResults = receipt.results;
  post({ type: "modified", modified: true });
  void refreshView(changed, before.describe.slides.length !== after.describe.slides.length);
  return value;
}

async function undoTurn(request) {
  const { steps, expectedRevision, targetRevision } = request;
  if (!Number.isInteger(steps) || steps < 1 || steps > 50 || typeof expectedRevision !== "string" || typeof targetRevision !== "string") throw Error("invalid_undo_request");
  const before = await snapshot();
  if (before.state.revision !== expectedRevision) throw Error("document_changed_since_turn");
  let undone = 0;
  try {
    for (; undone < steps; undone++) {
      try {
        version = await engine("undo", version);
      } catch {
        throw Error("undo_history_missing");
      }
    }
    const after = await snapshot();
    if (after.state.revision !== targetRevision) throw Error("undo_result_mismatch");
    post({ type: "modified", modified: version !== savedVersion });
    void refreshView(null, true);
    return { ...after.state, undone, changedSlideIndexes: [], images: [], visualEvidenceComplete: true };
  } catch (error) {
    while (undone > 0) {
      version = await engine("redo", version);
      undone--;
    }
    if ((await snapshot()).state.revision !== before.state.revision) throw Error("undo_result_mismatch_not_restored");
    throw error;
  }
}

async function save(message) {
  const requestId = crypto.randomUUID();
  try {
    const snap = await snapshot();
    if (message.onlyIfModified === true && version === savedVersion) {
      post({ type: "save-response", requestId, success: true, modified: false, unchanged: true });
      return;
    }
    const owned = snap.bytes.slice();
    const revision = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (saveWaiter?.requestId === requestId) saveWaiter = null;
        reject(Error("service_save_ack_timeout"));
      }, 180000);
      saveWaiter = {
        requestId,
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      post(
        {
          type: "save",
          requestId,
          revision: hostRevision,
          bytes: owned.buffer,
          humanConfirmed: message.humanConfirmed === true,
        },
        [owned.buffer],
      );
    });
    hostRevision = revision;
    savedVersion = snap.version;
    post({ type: "modified", modified: version !== savedVersion });
    post({ type: "save-response", requestId, success: true, modified: false });
  } catch (e) {
    post({ type: "save-response", requestId, success: false, error: e.message });
    post({ type: "modified", modified: version !== savedVersion });
  }
}

async function open(message) {
  documentName = typeof message.fileName === "string" && message.fileName.trim() ? message.fileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) : "문서.pptx";
  if (!(message.bytes instanceof ArrayBuffer)) throw Error("document_bytes_missing");
  hostRevision = message.revision;
  assets.clear();
  taskResponses.clear();
  taskFingerprints.clear();
  const count = await engine("open", message.bytes);
  format = await engine("format");
  version = await engine("version");
  savedVersion = version;
  current = null;
  activeSlide = 0;
  selected = [];
  opened = true;
  await snapshot();
  await buildView();
  await useLocalFonts();
  post({ type: "modified", modified: false });
  post({ type: "open-complete", requestId: message.requestId, revision: hostRevision, slideCount: count, recovered: false });
}

async function selectionValue() {
  const snap = await snapshot();
  const find = (id) => {
    const [slide, ...path] = id.split("/").map(Number);
    let e = snap.state.slides[slide];
    for (const i of path) e = e?.elements?.[i];
    return e;
  };
  return { activeSlide, selected: selected.map(find).filter(Boolean) };
}

async function handle(message) {
  if (/^[0-9a-f-]{36}$/i.test(message.id ?? "") && message.request) {
    const fp = await fingerprint(message.request);
    const cached = taskResponses.get(message.id);
    if (cached) {
      if (fp !== cached.fingerprint) throw Error("task_id_request_changed");
      host.postMessage(structuredClone(cached.response));
      return;
    }
    taskFingerprints.set(message.id, fp);
  }
  if (message.type === "file-name") {
    const name = message.fileName;
    if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw Error("document_file_name_invalid");
    documentName = name;
    return;
  }
  if (message.type === "save-result") {
    if (!saveWaiter || message.requestId !== saveWaiter.requestId) return;
    const waiter = saveWaiter;
    saveWaiter = null;
    message.ok && typeof message.revision === "string" ? waiter.resolve(message.revision) : waiter.reject(Error(message.error ?? "host_save_failed"));
    return;
  }
  if (message.type === "open") return open(message);
  if (!opened) throw Error("document_not_open");
  if (message.type === "save-now") return save(message);
  if (message.type === "undo" || message.type === "redo") {
    try {
      version = await engine(message.type, version);
    } catch {
      return; // nothing to undo or redo
    }
    post({ type: "modified", modified: version !== savedVersion });
    void refreshView(null, true);
    return;
  }
  if (message.type === "show-page") {
    reveal(Number(message.slideIndex));
    return;
  }
  const request = message.request;
  if (typeof message.id !== "string" || !request) throw Error("invalid_host_request");
  let value;
  switch (request.operation) {
    case "register_asset": {
      if (typeof request.assetId !== "string" || !(request.assetBytes instanceof ArrayBuffer) || request.assetBytes.byteLength > 25000000) throw Error("asset_authority_invalid");
      const bytes = new Uint8Array(request.assetBytes);
      assets.set(request.assetId, { bytes, mediaType: request.mediaType });
      value = { assetId: request.assetId, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), mediaType: request.mediaType, byteLength: bytes.length };
      break;
    }
    case "observe":
      value = await decorate(await snapshot(), request);
      break;
    case "selection":
      value = await selectionValue();
      break;
    case "detail_slide": {
      const snap = await snapshot();
      value = textDetails(snap.state, snap.lookup, request.slideIndex);
      break;
    }
    case "export_pptx": {
      const snap = await snapshot();
      if (request.expectedRevision !== snap.state.revision) throw Error("document_changed_observe_again");
      const bytes = snap.bytes.slice();
      value = { bytes: bytes.buffer, revision: snap.state.revision };
      break;
    }
    case "fit_view":
      value = {};
      break;
    case "reveal":
      reveal(request.slideIndex, request.elementId ?? null);
      value = { activeSlide: request.slideIndex, revealed: request.elementId ?? null };
      break;
    case "undo_turn":
      value = await undoTurn(request);
      break;
    case "edit":
    case "edit_batch":
      value = await edit(request, request.operation === "edit" ? [request.command] : request.commands);
      break;
    default: {
      if (!contract.mutationModel.operations[request.operation]) throw Error("unsupported_host_operation");
      const { operation, expectedRevision, expectedSlides, assetBytes, mediaType, fileName, permission, ...args } = request;
      if (assetBytes !== undefined) {
        if (typeof args.assetId !== "string" || !(assetBytes instanceof ArrayBuffer) || assetBytes.byteLength > 25000000) throw Error("asset_authority_invalid");
        assets.set(args.assetId, { bytes: new Uint8Array(assetBytes), mediaType });
      }
      value = await edit({ expectedRevision, expectedSlides, permission }, [{ op: operation, ...args }]);
    }
  }
  post({ id: message.id, value });
}

// ---------------------------------------------------------------- fonts
// Installed fonts the deck names (and the common Office families), read
// with Local Font Access. Without permission the bundled fonts stand in and
// the engine marks the text as substituted.
const loadedFonts = new Set(); // postscript names already given to the engine
let fontButton = null;

async function addLocalFonts() {
  const wanted = new Set([...runtime.localFontFamilies, ...(current?.describe.fonts ?? [])].map((f) => f.toLowerCase()));
  let added = 0;
  for (const font of await window.queryLocalFonts()) {
    if (loadedFonts.has(font.postscriptName)) continue;
    if (![font.family, font.fullName, font.postscriptName].some((n) => wanted.has(n.toLowerCase()))) continue;
    loadedFonts.add(font.postscriptName);
    await engine("add_font", await (await font.blob()).arrayBuffer());
    added++;
  }
  if (added) fit = { version: -1, slides: [] };
  if (added && current) {
    rendered.clear();
    await refreshView(null, false);
  }
}

/** After a deck opens: load allowed fonts, or offer the permission prompt. */
async function useLocalFonts() {
  if (!("queryLocalFonts" in window)) return;
  let state;
  try {
    state = (await navigator.permissions.query({ name: "local-fonts" })).state;
  } catch {
    return;
  }
  if (state === "granted") await addLocalFonts().catch(() => {});
  else if (state === "prompt") showFontButton();
}

function showFontButton() {
  if (fontButton) return;
  fontButton = document.createElement("button");
  fontButton.type = "button";
  fontButton.className = "font-access";
  fontButton.textContent = "이 PC의 글꼴로 보기";
  fontButton.title = "문서에 쓰인 글꼴이 이 PC에 있으면 그 글꼴로 그려요";
  fontButton.addEventListener("click", () => {
    const run = queue.then(addLocalFonts);
    queue = run.catch(() => {});
    void run.catch(() => {}).finally(() => {
      fontButton?.remove();
      fontButton = null;
    });
  });
  document.body.append(fontButton);
}

// ---------------------------------------------------------------- view
const list = document.getElementById("slides");
const rendered = new Map(); // slide index -> version drawn
let observer = null;

function slideSize() {
  const d = current?.describe;
  return { w: d?.width ?? 720, h: d?.height ?? 405 };
}

async function buildView() {
  observer?.disconnect();
  list.replaceChildren();
  rendered.clear();
  const { w, h } = slideSize();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) void drawSlide(Number(entry.target.dataset.index));
  }, { root: list, rootMargin: "600px 0px" });
  current.describe.slides.forEach((_, index) => {
    const figure = document.createElement("figure");
    figure.dataset.index = String(index);
    figure.style.aspectRatio = `${w} / ${h}`;
    const img = document.createElement("img");
    img.alt = format === "idml" ? `${index + 1}쪽` : `${index + 1}번 슬라이드`;
    img.draggable = false;
    const marks = document.createElement("div");
    marks.className = "marks";
    const number = document.createElement("figcaption");
    number.textContent = String(index + 1);
    figure.append(img, marks, number);
    figure.addEventListener("click", (event) => pick(index, event));
    list.append(figure);
    observer.observe(figure);
  });
  markSelection();
}

async function drawSlide(index) {
  const figure = list.querySelector(`figure[data-index="${index}"]`);
  if (!figure || rendered.get(index) === version) return;
  rendered.set(index, version);
  const drawnAt = version;
  const { w } = slideSize();
  const scale = Math.min(4, (figure.clientWidth * devicePixelRatio) / w);
  try {
    const png = await engine("render", index + 1, scale);
    if (drawnAt !== version) return;
    const img = figure.querySelector("img");
    const old = img.src;
    img.src = URL.createObjectURL(new Blob([png], { type: "image/png" }));
    if (old) URL.revokeObjectURL(old);
  } catch {
    rendered.delete(index);
  }
}

async function refreshView(changed, structural) {
  await snapshot();
  if (structural || list.children.length !== current.describe.slides.length) {
    await buildView();
    return;
  }
  for (const index of changed ?? [...rendered.keys()]) rendered.delete(index);
  for (const figure of list.children) {
    const index = Number(figure.dataset.index);
    const box = figure.getBoundingClientRect();
    if (box.bottom > -600 && box.top < innerHeight + 600) void drawSlide(index);
  }
  markSelection();
}

function reveal(slideIndex, elementId = null) {
  if (!Number.isSafeInteger(slideIndex) || slideIndex < 0 || slideIndex >= list.children.length) return;
  activeSlide = slideIndex;
  if (elementId) selected = [elementId];
  list.children[slideIndex].scrollIntoView({ block: "center", behavior: "smooth" });
  markSelection();
  void announceSelection();
}

/** Clicking a slide makes it the active slide; clicking a shape selects it for the AI. */
function pick(index, event) {
  activeSlide = index;
  const figure = list.children[index];
  const box = figure.getBoundingClientRect();
  const { w, h } = slideSize();
  const x = ((event.clientX - box.left) / box.width) * w;
  const y = ((event.clientY - box.top) / box.height) * h;
  const shapes = current.describe.slides[index].shapes;
  let hit = null;
  shapes.forEach((s, i) => {
    const f = s.frame;
    if (f && x >= f[0] && x <= f[0] + f[2] && y >= f[1] && y <= f[1] + f[3] && f[2] * f[3] < w * h * 0.9) hit = `${index}/${i}`;
  });
  selected = hit ? [hit] : [];
  markSelection();
  void announceSelection();
}

function markSelection() {
  if (!current) return;
  const { w, h } = slideSize();
  for (const figure of list.children) {
    const index = Number(figure.dataset.index);
    figure.classList.toggle("active", index === activeSlide);
    const marks = figure.querySelector(".marks");
    marks.replaceChildren();
    for (const id of selected) {
      if (Number(id.split("/")[0]) !== index) continue;
      const shape = current.lookup.get(id)?.element;
      const f = shape?.frame;
      if (!f) continue;
      const mark = document.createElement("div");
      mark.className = "mark";
      Object.assign(mark.style, { left: `${(f[0] / w) * 100}%`, top: `${(f[1] / h) * 100}%`, width: `${(f[2] / w) * 100}%`, height: `${(f[3] / h) * 100}%` });
      marks.append(mark);
    }
  }
}

async function announceSelection() {
  if (!host || !opened) return;
  post({ type: "selection", value: await selectionValue() });
}

// ---------------------------------------------------------------- connect
let queue = Promise.resolve();
window.addEventListener("message", (event) => {
  if (host || event.source !== parent || event.origin !== origin || event.data?.type !== "spellbook.document-view-connect" || event.data.protocolVersion !== PROTOCOL_VERSION || event.ports.length !== 1) return;
  host = event.ports[0];
  host.onmessage = ({ data: message }) => {
    if (message?.type === "save-result") {
      void handle(message);
      return;
    }
    const run = queue.then(() => handle(message));
    queue = run.catch(() => {});
    run.catch((e) => post(message?.id ? { id: message.id, error: e.message } : { type: "error", error: e.message }));
  };
  host.start();
  post({ type: "ready", protocolVersion: PROTOCOL_VERSION });
});
window.addEventListener("resize", () => {
  if (!current) return;
  rendered.clear();
  void refreshView(null, false);
});
parent.postMessage({ type: "spellbook.document-view-ready", protocolVersion: PROTOCOL_VERSION, bridgeSessionId: crypto.randomUUID() }, origin);
