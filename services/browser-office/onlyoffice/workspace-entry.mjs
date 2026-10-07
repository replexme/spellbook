import {validateOperationArguments} from "../../../contracts/native-edit-tools.cjs";
import Ajv from "ajv";
import { createOfficeEditor } from "/npm/public-api.js";
import { createProductSession } from "../product-session.mjs";
import { openBrowserDocumentJournal } from "../opfs-journal.mjs";
import { connectOnlyOfficeProductPort } from "../onlyoffice/product-port-client.mjs";
import {
  inspectOoxmlSections,
  repairCandidatePptxStructure,
  nativeExportDifferences,
} from "../ooxml-worker-source.mjs";
import { onlyOfficeSourceTargets } from "../onlyoffice/source-targets.mjs";
import {
  onlyOfficePersistenceState,
  verifyOnlyOfficeProductObservation,
} from "../onlyoffice/product-engine.mjs";
import { verifyOnlyOfficeProductIntent } from "../onlyoffice/product-intent.mjs";
import { createOnlyOfficeResourcePreparation } from "./product-resource-preparation.mjs";
import {
  onlyOfficeTextDetails,
  undoOnlyOfficeTurn,
  assertServiceObservation,
  assertWorkspacePermission,
  onlyOfficeElement,
} from "./workspace-operations.mjs";
import { onlyOfficeWorkspaceLayout } from "./workspace-layout.mjs";
import contract from "../../../contracts/native-edit-capabilities.json";

/* SPDX-License-Identifier: MPL-2.0 */
// Host for the existing browser-office protocol. Engine selection remains explicit.
const runtime = JSON.parse(
  document.getElementById("office-runtime-config").textContent,
);
const candidateOrigin = new URL(runtime.sdkOrigin).origin;
const inspectionOrigin = new URL(runtime.inspectionOrigin).origin;
let documentName = "문서.pptx";
const origin = new URL(location.href).searchParams.get("hostOrigin");
if (
  !origin ||
  new URL(origin).origin !== origin ||
  !runtime.hostOrigins.includes(origin)
)
  throw Error("trusted_host_origin_required");
window.__onlyofficeConnections = new Map();
window.addEventListener("message", (event) => {
  if (
    ![candidateOrigin, inspectionOrigin].includes(event.origin) ||
    event.data?.type !== "spellbook.onlyoffice-sdk-ready"
  )
    return;
  const value = [...window.__onlyofficeConnections.values()].find(
    (c) =>
      c.origin === event.origin &&
      event.source.parent ===
        c.container.querySelector("iframe")?.contentWindow,
  );
  if (!value || value.nativeWindow) return;
  value.nativeWindow = event.source;
  const channel = new MessageChannel(),
    calls = new Map();
  value.disposeView = () => {
    for (const p of calls.values()) {
      clearTimeout(p.timer);
      p.reject(Error("workspace_disposed"));
    }
    calls.clear();
    channel.port1.close();
  };
  value.view = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(Error("viewport_request_timeout"));
      }, 180000);
      calls.set(id, { resolve, reject, timer });
      channel.port1.postMessage({ id, method, ...args });
    });
  channel.port1.onmessage = ({ data }) => {
    if (data.type === "ready") {
      value.resolve();
      return;
    }
    if (data.type === "error") {
      value.reject(Error(data.error));
      return;
    }
    const p = calls.get(data.id);
    if (p) {
      calls.delete(data.id);
      clearTimeout(p.timer);
      data.error ? p.reject(Error(data.error)) : p.resolve(data.value);
    }
  };
  channel.port1.start();
  event.source.postMessage(
    {
      type: "spellbook.onlyoffice-sdk-initialize",
      sessionId: value.sessionId,
      sections: value.sections,
    },
    value.origin,
    [channel.port2],
  );
});
const worker = new Worker("/comparison-repair.js", { type: "module" }),
  pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.requestId);
  if (!p) return;
  pending.delete(data.requestId);
  clearTimeout(p.timer);
  data.error ? p.reject(Error(data.error)) : p.resolve(data);
};
worker.onerror = (event) => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(Error(event.message));
  }
  pending.clear();
};
const work = (payload) =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Error("artifact_worker_timeout"));
    }, 180000);
    pending.set(requestId, { resolve, reject, timer });
    worker.postMessage({ requestId, ...payload });
  });
const debugEvents = [];
let live,
  session,
  host,
  hostRevision,
  opening = false,
  busy = false,
  saveWaiter,
  journal,
  reportedToken;
const taskResponses = new Map(),
  taskFingerprints = new Map(),
  ownedAssets = new Map();
const post = (value, transfer = []) => {
  if (
    typeof value.id === "string" &&
    taskFingerprints.has(value.id) &&
    !taskResponses.has(value.id)
  ) {
    taskResponses.set(value.id, {
      fingerprint: taskFingerprints.get(value.id),
      response: structuredClone(value),
    });
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
  if (value.assetBytes instanceof ArrayBuffer)
    value.assetBytes = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", value.assetBytes),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalJson(value)),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
window.spellbookBrowserOffice = {
  diagnostics: () => ({ engine: "ONLYOFFICE", status: session?.status() }),
  evidence: { events: debugEvents },
};
const canonicalJson = (value) => JSON.stringify(orderKeys(value));
function orderKeys(value) {
  if (Array.isArray(value)) return value.map(orderKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, orderKeys(value[key])]),
    );
  return value;
}
const validateFull = new Ajv({ strict: false }).compile(
  contract.toolInputSchema,
);
const absentCommandFields = Object.fromEntries(
  Object.keys(contract.toolInputSchema.properties).map((key) => [key, null]),
);
const validate = (command) => {
  validateOperationArguments(command);
  return validateFull({ ...absentCommandFields, ...command });
};

async function component(bytes, hidden = false) {
  const engineOrigin = hidden ? inspectionOrigin : candidateOrigin;
  const container = document.createElement("div");
  container.style.cssText = hidden
    ? "position:fixed;left:-20000px;top:0;width:1440px;height:960px"
    : "position:absolute;inset:0";
  if (hidden) container.inert = true;
  const sessionId = crypto.randomUUID();
  container.dataset.officeSession = sessionId;
  document.body.append(container);
  let resolve, reject;
  const ready = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  const config = {
    sessionId,
    resolve,
    reject,
    container,
    origin: engineOrigin,
    ready: false,
    sections: inspectOoxmlSections(bytes).sections.map(
      ({ slideCount, ...s }) => s,
    ),
  };
  window.__onlyofficeConnections.set(sessionId, config);
  const value = {
    original: bytes.slice(),
    baseline: null,
    intent: null,
    saved: null,
    capture: false,
    authorize: null,
    container,
    config,
  };
  try {
    value.editor = await createOfficeEditor(container, {
      hostUrl: engineOrigin + "/office-host.html",
      file: new File([bytes], documentName, {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
      fileName: documentName,
      lang: "ko",
      mode: "edit",
      saveBehavior: "callback",
      onError: (e) => {
        value.error = e.message;
      },
      onDirtyChange: (dirty) => {
        if (!hidden && !opening && dirty && value.port)
          void value.port
            .observe()
            .then((observed) => {
              if (
                live === value &&
                !opening &&
                observed.revision !== value.stableRevision
              )
                post({ type: "modified", modified: true });
            })
            .catch(() => {});
      },
      onSave: async (file) => {
        const raw = new Uint8Array(await file.arrayBuffer());
        if (value.capture) {
          value.baseline = raw;
          value.saved = raw;
          return true;
        }
        if (!value.baseline)
          throw Error("source_or_artifact_authority_missing");
        if (!value.authorize) {
          if (hidden || opening)
            throw Error("source_or_artifact_authority_missing");
          setTimeout(() => {
            const run = queue.then(() =>
              handle({
                type: "command",
                messageId: "Action_Save",
                reason: "native_user_save",
              }),
            );
            queue = run.catch(() => {});
            run.catch((error) => post({ type: "error", error: error.message }));
          }, 0);
          return false;
        }
        const nativeSections = (await value.port.observe()).sections;
        const preserved = await work({
          operation: "preserve-native",
          bytes: value.original,
          noEditBytes: value.baseline,
          editedBytes: raw,
          ...value.intent,
          nativeSections,
        });
        const repaired = repairCandidatePptxStructure(
          value.original,
          new Uint8Array(preserved.bytes),
        ).bytes;
        await value.authorize(repaired);
        value.stableRevision = (await value.port.observe()).revision;
        value.saved = repaired;
        value.original = repaired;
        value.baseline = raw;
        return true;
      },
    });
    config.ready = true;
    await ready;
    value.port = await connectOnlyOfficeProductPort({
      frameWindow: config.nativeWindow,
      frameOrigin: engineOrigin,
      sessionId,
      timeoutMs: 180000,
    });
    value.capture = true;
    let prior;
    try {
      for (let n = 0; n < 4; n++) {
        await value.editor.save("pptx");
        if (prior && !nativeExportDifferences(prior, value.saved).length) break;
        prior = value.saved;
        if (n === 3) throw Error("native_export_baseline_unstable");
      }
    } finally {
      value.capture = false;
    }
    value.stableRevision = (await value.port.observe()).revision;
    return value;
  } catch (e) {
    await value.editor?.destroy();
    container.remove();
    window.__onlyofficeConnections.delete(sessionId);
    throw e;
  }
}
async function destroy(value) {
  if (!value || value.disposed) return;
  value.disposed = true;
  value.config.disposeView?.();
  try {
    await value.port?.dispose();
  } finally {
    try {
      await value.editor?.destroy();
    } finally {
      value.container.remove();
      window.__onlyofficeConnections.delete(value.config.sessionId);
    }
  }
}
async function inspect(bytes) {
  const other = await component(bytes, true);
  try {
    return await other.port.observe();
  } finally {
    await destroy(other);
  }
}
const engine = {
  open: async (bytes) => {
    const previous = live;
    live = null;
    await destroy(previous);
    live = await component(bytes);
  },
  inspect,
  persistenceState: onlyOfficePersistenceState,
  observe: () => live.port.observe(),
  changeToken: () => live.port.changeToken(),
  approveNativeChanges: (t) => live.port.approveNativeChanges(t),
  verifyManualChanges: () => live.port.verifyManualChanges(),
  prepareManualCheckpoint: () => live.port.prepareManualCheckpoint(),
  preflight: (c) => live.port.preflight(c),
  apply: (c) => live.port.apply(c),
  undo: () => live.port.undo(),
  redo: () => live.port.redo(),
  begin: async () => ({
    native: await live.port.begin(),
    original: live.original,
    baseline: live.baseline,
    saved: live.saved,
  }),
  finish: async (token, commit) => {
    await live.port.finish(token.native, commit);
    if (!commit) {
      live.original = token.original;
      live.baseline = token.baseline;
      live.saved = token.saved;
    }
  },
  verifyIntent: (before, after, commands, prepared) =>
    verifyOnlyOfficeProductIntent(before, after, commands, prepared),
  bindArtifact: async (bytes) => {
    live.original = bytes.slice();
    live.capture = true;
    try {
      await live.editor.save("pptx");
    } finally {
      live.capture = false;
    }
  },
  snapshot: async ({ before, commands, prepared, authorize }) => {
    live.intent = {
      sourceOperations: commands?.map((c) => c.op) ?? null,
      sourceTargets: onlyOfficeSourceTargets(before, commands, prepared),
    };
    live.authorize = authorize;
    try {
      await live.editor.save("pptx");
      return live.saved.slice();
    } finally {
      live.authorize = null;
    }
  },
};
async function selection(observation) {
  const view = await live.config.view("selection");
  return {
    activeSlide: view.activeSlide,
    selected: view.selectedIds.map((id) => onlyOfficeElement(observation, id)),
  };
}
async function decorate(value, request = {}) {
  const chosen = await selection(value);
  const indexes = request.captureSlideIndexes ?? [
    request.detailSlideIndex ?? chosen.activeSlide,
  ];
  if (!Array.isArray(indexes) || indexes.length > 8)
    throw Error("capture_slide_invalid");
  const images = [];
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || !value.slides[index])
      throw Error("capture_slide_invalid");
    images.push(await live.config.view("capture", { slideIndex: index }));
  }
  return {
    ...value,
    layoutAudit: onlyOfficeWorkspaceLayout(value),
    textDetails: onlyOfficeTextDetails(value, {
      slideIndex: request.detailSlideIndex ?? chosen.activeSlide,
      expectedElements: value.slides[
        request.detailSlideIndex ?? chosen.activeSlide
      ].elements
        .filter(
          (e) =>
            e.text &&
            value.slides[request.detailSlideIndex ?? chosen.activeSlide]
              .onlyoffice?.drawings[Number(e.elementId.split("/")[1])]
              ?.paragraphs,
        )
        .map((e) => ({ elementId: e.elementId, text: e.text })),
    }),
    unit: "1/100mm",
    activeSlide: chosen.activeSlide,
    selectedElementIds: chosen.selected.map((e) => e.elementId),
    images,
    changedSlideIndexes: [],
    visualEvidenceComplete: true,
    engine: {
      name: "ONLYOFFICE",
      supportedOperations: Object.keys(
        contract.mutationModel.operations,
      ).filter(
        (k) =>
          contract.mutationModel.operations[k].availability !==
          "format_excluded",
      ),
    },
  };
}
function changedSlides(before, after) {
  const globalChange =
    before.width !== after.width ||
    before.height !== after.height ||
    canonicalJson(before.masters) !== canonicalJson(after.masters);
  const changed = after.slides.flatMap((slide, i) =>
    globalChange || canonicalJson(slide) !== canonicalJson(before.slides[i])
      ? [i]
      : [],
  );
  if (
    before.slides.length !== after.slides.length &&
    !changed.length &&
    after.slides.length
  )
    changed.push(after.slides.length - 1);
  return changed;
}
async function handle(message) {
  if (/^[0-9a-f-]{36}$/i.test(message.id ?? "") && message.request) {
    const fp = await fingerprint(message.request),
      cached = taskResponses.get(message.id);
    if (cached) {
      if (fp !== cached.fingerprint) throw Error("task_id_request_changed");
      host.postMessage(structuredClone(cached.response));
      return;
    }
    taskFingerprints.set(message.id, fp);
  }
  debugEvents.push({
    stage: "received",
    at: Date.now(),
    id: message.id,
    type: message.type,
    messageId: message.messageId,
    operation: message.request?.operation,
  });
  if (debugEvents.length > 100) debugEvents.shift();
  if (message.type === "file-name") {
    const name = message.fileName;
    if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name))
      throw Error("document_file_name_invalid");
    if (name !== documentName) {
      await live.config.view("set_file_name", {fileName: name});
      documentName = name;
    }
    return;
  }
  if (message.type === "save-result") {
    if (!saveWaiter || message.requestId !== saveWaiter.requestId) return;
    const waiter = saveWaiter;
    saveWaiter = null;
    message.ok && typeof message.revision === "string"
      ? waiter.resolve(message.revision)
      : waiter.reject(Error(message.error ?? "host_save_failed"));
    return;
  }
  if (message.type === "open") {
    documentName = typeof message.fileName === "string" && message.fileName.trim()
      ? message.fileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255)
      : "문서.pptx";
    opening = true;
    ownedAssets.clear();
    hostRevision = message.revision;
    journal = await openBrowserDocumentJournal({
      identity: "document:" + message.documentId,
    });
    session = createProductSession({
      engine,
      journal,
      validateCommand: validate,
      operationContracts: contract.mutationModel.operations,
      verifyObservation: verifyOnlyOfficeProductObservation,
      prepareResources: createOnlyOfficeResourcePreparation({
        port: {
          registerAsset: (a) => live.port.registerAsset(a),
          registerChartWorkbook: (w) => live.port.registerChartWorkbook(w),
        },
        loadAsset: async (id) => {
          const asset = ownedAssets.get(id);
          if (!asset) throw Error("owned_asset_missing");
          return asset;
        },
      }),
    });
    try {
      await session.open(new Uint8Array(message.bytes));
      const recovered = await session.recover();
      const observed = await session.observe();
      reportedToken = await live.port.changeToken();
      post({ type: "modified", modified: session.status().modified });
      post({
        type: "open-complete",
        requestId: message.requestId,
        revision: hostRevision,
        slideCount: observed.slides.length,
        recovered: !!recovered,
      });
    } finally {
      opening = false;
    }
    return;
  }
  if (!session) throw Error("document_not_open");
  if (message.type === "command" && message.messageId === "Action_Save") {
    const requestId = crypto.randomUUID();
    try {
      await session.save(
        (bytes, receipt) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              if (saveWaiter?.requestId === requestId) saveWaiter = null;
              reject(Error("service_save_ack_timeout"));
            }, 180000);
            saveWaiter = {
              requestId,
              resolve: (revision) => {
                clearTimeout(timer);
                hostRevision = revision;
                resolve({ candidateSha256: receipt.candidateSha256 });
              },
              reject: (e) => {
                clearTimeout(timer);
                reject(e);
              },
            };
            const owned = bytes.slice();
            post(
              {
                type: "save",
                requestId,
                revision: hostRevision,
                bytes: owned.buffer,
                reason: message.reason,
                humanConfirmed: message.values?.HumanConfirmedChanges === true || message.reason === "native_user_save",
              },
              [owned.buffer],
            );
          }),
      );
      post({ type: "modified", modified: false });
      post({
        type: "save-response",
        requestId,
        success: true,
        modified: false,
      });
    } catch (e) {
      post({
        type: "save-response",
        requestId,
        success: false,
        error: e.message,
      });
      post({ type: "modified", modified: true });
    }
    return;
  }
  if (message.type === "command" && message.messageId === "Send_UNO_Command") {
    const command = message.values?.Command?.replace(/^\.uno:/, "");
    if (!["Undo", "Redo"].includes(command))
      throw Error("unsupported_host_command");
    await session[command.toLowerCase()]();
    post({ type: "modified", modified: true });
    return;
  }
  if (
    message.type === "command" &&
    ["User_Active", "Host_PostmessageReady", "welcome-close"].includes(
      message.messageId,
    )
  )
    return;
  if (message.type === "command" && message.messageId === "Action_GoToPage") {
    await live.config.view("reveal", { slideIndex: message.values.Page - 1 });
    return;
  }
  const request = message.request;
  if (typeof message.id !== "string" || !request)
    throw Error(
      "invalid_host_request:" +
        JSON.stringify({
          keys: Object.keys(message ?? {}),
          messageId: message.messageId,
          id: message.id,
          idType: typeof message.id,
          requestType: typeof message.request,
          operation: message.request?.operation,
        }),
    );
  let value;
  if (request.operation === "register_asset") {
    if (
      typeof request.assetId !== "string" ||
      !(request.assetBytes instanceof ArrayBuffer) ||
      request.assetBytes.byteLength > 25000000 ||
      [...ownedAssets.values()].reduce((n, a) => n + a.bytes.length, 0) +
        request.assetBytes.byteLength >
        64000000
    )
      throw Error("asset_authority_invalid");
    const asset = {
      assetId: request.assetId,
      mediaType: request.mediaType,
      bytes: new Uint8Array(request.assetBytes),
    };
    const receipt = await live.port.registerAsset(asset);
    ownedAssets.set(asset.assetId, asset);
    value = {
      assetId: receipt.assetId,
      sha256: receipt.sha256,
      mediaType: receipt.mediaType,
      byteLength: asset.bytes.length,
    };
  } else if (request.operation === "observe")
    value = await decorate(await session.observe(), request);
  else if (request.operation === "selection")
    value = await selection(await session.observe());
  else if (request.operation === "detail_slide")
    value = onlyOfficeTextDetails(await session.observe(), request);
  else if (request.operation === "export_pptx") {
    const before = await session.observe();
    if (request.expectedRevision !== before.revision)
      throw Error("document_changed_observe_again");
    const bytes = await session.exportCurrentArtifact();
    value = {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      revision: before.revision,
    };
  } else if (request.operation === "export_pdf") {
    const before = await session.observe();
    if (request.expectedRevision !== before.revision)
      throw Error("document_changed_observe_again");
    const bytes = await live.config.view("export_pdf");
    if (new TextDecoder().decode(new Uint8Array(bytes, 0, 5)) !== "%PDF-")
      throw Error("pdf_export_invalid");
    if ((await session.observe()).revision !== before.revision)
      throw Error("document_changed_during_export");
    value = { bytes, mediaType: "application/pdf", revision: before.revision };
  } else if (request.operation === "fit_view") {
    value = await live.config.view("fit_view");
  } else if (request.operation === "reveal") {
    await live.config.view("reveal", request);
    value = {
      activeSlide: request.slideIndex,
      revealed: request.elementId ?? null,
    };
  } else if (request.operation === "undo_turn") {
    value = await undoOnlyOfficeTurn(session, request);
    post({ type: "modified", modified: session.status().modified });
  } else if (["edit", "edit_batch"].includes(request.operation)) {
    const commands =
      request.operation === "edit" ? [request.command] : request.commands;
    if (
      !Array.isArray(commands) ||
      !commands.length ||
      commands.length > 50 ||
      commands.some((c) => !c || typeof c !== "object")
    )
      throw Error("invalid_edit_commands");
    const before = await session.observe();
    assertServiceObservation(before, request);
    assertWorkspacePermission(
      commands,
      request.permission,
      contract.mutationModel.operations,
    );
    if (request.dryRun) {
      if (
        !Array.isArray(commands) ||
        !commands.length ||
        commands.some((c) => !validate(c))
      )
        throw Error("invalid_dry_run");
      await live.port.preflight(commands);
      value = await decorate(before, { captureSlideIndexes: [] });
      value.dryRun = true;
    } else {
      const result = await session.apply({
        expectedRevision: request.expectedRevision,
        commands,
      });
      const changed = changedSlides(before, result.observation);
      value = await decorate(result.observation, {
        captureSlideIndexes: changed.slice(0, 8),
      });
      value.visualEvidenceComplete = changed.length <= 8;
      value.changedSlideIndexes = changed;
      value.layoutAudit = onlyOfficeWorkspaceLayout(
        result.observation,
        onlyOfficeWorkspaceLayout(before),
      );
      value.undoSteps = result.observation.revision !== before.revision ? 1 : 0;
      post({ type: "modified", modified: session.status().modified });
    }
  } else if (contract.mutationModel.operations[request.operation]) {
    const before = await session.observe();
    assertServiceObservation(before, request);
    const {
      operation,
      expectedRevision,
      expectedSlides,
      assetBytes,
      mediaType,
      fileName,
      permission,
      ...args
    } = request;
    assertWorkspacePermission(
      [{ op: operation, ...args }],
      permission,
      contract.mutationModel.operations,
    );
    if (assetBytes !== undefined) {
      if (
        typeof args.assetId !== "string" ||
        !(assetBytes instanceof ArrayBuffer) ||
        assetBytes.byteLength > 25000000 ||
        [...ownedAssets.values()].reduce((n, a) => n + a.bytes.length, 0) +
          assetBytes.byteLength >
          64000000
      )
        throw Error("asset_authority_invalid");
      if (ownedAssets.size >= 256 && !ownedAssets.has(args.assetId))
        throw Error("asset_cache_limit");
      const previous = ownedAssets.get(args.assetId);
      const bytes = new Uint8Array(assetBytes);
      if (
        previous &&
        (previous.mediaType !== mediaType ||
          canonicalJson([...previous.bytes]) !== canonicalJson([...bytes]))
      )
        throw Error("asset_receipt_conflict");
      ownedAssets.set(args.assetId, {
        assetId: args.assetId,
        bytes,
        mediaType,
      });
    }
    const result = await session.apply({
      expectedRevision,
      commands: [{ op: operation, ...args }],
    });
    const changed = changedSlides(before, result.observation);
    value = await decorate(result.observation, {
      captureSlideIndexes: changed.slice(0, 8),
    });
    value.changedSlideIndexes = changed;
    value.visualEvidenceComplete = changed.length <= 8;
    value.layoutAudit = onlyOfficeWorkspaceLayout(
      result.observation,
      onlyOfficeWorkspaceLayout(before),
    );
    value.undoSteps = result.observation.revision !== before.revision ? 1 : 0;
    post({ type: "modified", modified: session.status().modified });
  } else throw Error("unsupported_host_operation");
  debugEvents.push({
    stage: "responded",
    at: Date.now(),
    id: message.id,
    operation: request.operation,
  });
  post({ id: message.id, value });
}
let queue = Promise.resolve();
window.addEventListener("message", (event) => {
  if (
    host ||
    event.source !== parent ||
    event.origin !== origin ||
    event.data?.type !== "spellbook.browser-office-connect" ||
    event.data.protocolVersion !== 1 ||
    event.ports.length !== 1
  )
    return;
  host = event.ports[0];
  host.onmessage = (event) => {
    const message = event.data;
    if (message?.type === "save-result") {
      void handle(message);
      return;
    }
    const run = queue.then(async () => {
      busy = true;
      try {
        await handle(message);
      } finally {
        busy = false;
      }
    });
    queue = run.catch(() => {});
    run.catch((e) =>
      post(
        message?.id
          ? { id: message.id, error: e.message }
          : { type: "error", error: e.message },
      ),
    );
  };
  host.start();
  post({ type: "ready", protocolVersion: 1 });
});
setInterval(async () => {
  if (!live || opening || busy || !session) return;
  busy = true;
  try {
    const token = await live.port.changeToken();
    if (token !== reportedToken) {
      const changed = await session.checkpointManual();
      reportedToken = await live.port.changeToken();
      if (changed) post({ type: "modified", modified: true });
    }
    post({
      type: "selection",
      value: await selection(await live.port.observe()),
    });
  } catch (e) {
    post({ type: "error", error: e.message });
  } finally {
    busy = false;
  }
}, 1500);
parent.postMessage(
  {
    type: "spellbook.browser-office-ready",
    protocolVersion: 1,
    bridgeSessionId: crypto.randomUUID(),
  },
  origin,
);
