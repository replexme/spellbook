/* SPDX-License-Identifier: MPL-2.0 */
import {
  writeLocalOfficeFile,
  openLocalOfficeHandle,
  rememberLocalOfficeHandle,
} from "./local-file.mjs";
import { installLocalPhoneView } from "./local-phone-view.mjs";
const element = (id) => document.getElementById(id);
const editor = element("editor"),
  status = element("status");
element("ai").addEventListener("toggle", () => {
  document.body.classList.toggle("has-panel", element("ai").open);
});
element("ai-close").onclick = () => {
  element("ai").open = false;
};
const fileMenu = document.querySelector(".local-file-menu");
fileMenu.addEventListener("click", (event) => {
  if (event.target.closest("button, a")) fileMenu.open = false;
});
document.addEventListener("click", (event) => {
  if (!fileMenu.contains(event.target)) fileMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") fileMenu.open = false;
});
let handle,
  port,
  current,
  pendingHandle,
  pendingSave,
  revision,
  modified = false,
  generation = 0,
  opening = false;
const tasks = new Map(),
  ownedAssets = new Map();
const call = async (request) => {
  if (request.operation === "register_generated_asset") {
    if (
      !/^[0-9a-f-]{36}$/i.test(request.assetId) ||
      !["image/png", "image/jpeg"].includes(request.mediaType) ||
      typeof request.base64 !== "string" ||
      request.base64.length > 6_700_000
    )
      throw Error("generated_asset_invalid");
    const raw = atob(request.base64),
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (bytes.length > 5_000_000) throw Error("generated_asset_too_large");
    if (
      [...ownedAssets.values()].reduce((n, a) => n + a.bytes.length, 0) +
        bytes.length >
      25_000_000
    )
      throw Error("generated_asset_cache_limit");
    if (ownedAssets.has(request.assetId))
      throw Error("generated_asset_id_conflict");
    ownedAssets.set(request.assetId, { bytes, mediaType: request.mediaType });
    return { assetId: request.assetId };
  }
  if (
    ["insert_image", "replace_image", "insert_media", "replace_media"].includes(
      request.operation,
    ) &&
    ownedAssets.has(request.assetId)
  ) {
    const asset = ownedAssets.get(request.assetId);
    request = {
      ...request,
      assetBytes: asset.bytes.slice().buffer,
      mediaType: asset.mediaType,
      fileName: "generated.png",
    };
  }
  return new Promise((resolve, reject) => {
    if (!port) return reject(Error("editor_not_connected"));
    const id = crypto.randomUUID(),
      timer = setTimeout(() => {
        tasks.delete(id);
        reject(Error("editor_request_timeout"));
      }, 180000);
    tasks.set(id, { resolve, reject, timer });
    port.postMessage({ id, request });
  });
};
const phoneView = installLocalPhoneView({
  call,
  isReady: () => !!port && !element("save").disabled,
  generation: () => generation,
  reportError: (error) => showError(error),
});
const showError = (error) => {
  const text = `작업을 완료하지 못했습니다: ${error.message}`;
  element("error").hidden = false;
  element("error").textContent = text;
  status.textContent = text;
};
const clearError = () => {
  element("error").hidden = true;
  element("error").textContent = "";
};
function buttons(enabled) {
  for (const id of ["save", "save-as", "export", "pdf-export", "undo", "redo"])
    element(id).disabled = !enabled;
}
const digest = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
const update = (text) => {
  status.textContent = text;
};
function sendCommand(messageId, values = {}) {
  if (!port) throw Error("editor_not_connected");
  port.postMessage({ type: "command", messageId, values });
}
async function receive(message) {
  if (message.type === "ready") {
    const bytes = current.bytes.slice();
    revision = current.sha256;
    port.postMessage(
      {
        type: "open",
        requestId: crypto.randomUUID(),
        documentId: current.documentId,
        fileName: current.name,
        maxBytes: 64 * 1024 * 1024,
        revision,
        bytes: bytes.buffer,
      },
      [bytes.buffer],
    );
  } else if (message.type === "open-complete") {
    buttons(true);
    window.dispatchEvent(
      new CustomEvent("spellbook-local-document-opened", {
        detail: { documentId: current.documentId, generation },
      }),
    );
    phoneView.opened();
    update(
      message.recovered
        ? "복구한 변경 있음 · 파일에 저장해 주세요"
        : "선택한 파일을 열었습니다",
    );
  } else if (message.type === "modified") {
    modified = message.modified;
    phoneView.refresh();
    if (modified) update("저장하지 않은 변경 · 브라우저 복구본에 기록 중");
  } else if (message.type === "save") {
    const savePort = port;
    pendingSave = true;
    const bytes = new Uint8Array(message.bytes),
      sha256 = await digest(bytes);
    try {
      if (opening) throw Error("파일을 여는 중입니다. 연 뒤 저장해 주세요");
      if (
        !pendingHandle &&
        message.reason === "native_user_save" &&
        handle &&
        (await handle.queryPermission({ mode: "readwrite" })) === "granted"
      )
        pendingHandle = handle;
      if (!pendingHandle)
        throw Error("상단 저장 버튼을 눌러 파일 쓰기를 허용해 주세요");
      if (message.revision !== revision)
        throw Error("local_save_revision_changed");
      await writeLocalOfficeFile(
        pendingHandle,
        bytes,
        sha256,
        pendingHandle === handle ? revision : null,
      );
      await rememberLocalOfficeHandle(
        current.documentId,
        pendingHandle,
        sha256,
      );
      handle = pendingHandle;
      pendingHandle = null;
      revision = sha256;
      current.name = handle.name;
      element("file-name").textContent = handle.name;
      savePort.postMessage({
        type: "save-result",
        requestId: message.requestId,
        ok: true,
        revision,
      });
    } catch (error) {
      savePort.postMessage({
        type: "save-result",
        requestId: message.requestId,
        ok: false,
        error: error.message,
      });
      throw error;
    }
  } else if (message.type === "save-response") {
    pendingHandle = null;
    if (!message.success) throw Error(message.error ?? "local_save_failed");
    port.postMessage({ type: "file-name", fileName: current.name });
    modified = !!message.modified;
    update(
      modified ? "이후 변경은 아직 저장하지 않았습니다" : "파일 저장 완료",
    );
    pendingSave = false;
  } else if (message.type === "error") throw Error(message.error);
  else if (message.id && tasks.has(message.id)) {
    const task = tasks.get(message.id);
    tasks.delete(message.id);
    clearTimeout(task.timer);
    message.error
      ? task.reject(Error(message.error))
      : task.resolve(message.value);
  }
}
window.addEventListener("message", (event) => {
  if (
    event.source !== editor.contentWindow ||
    event.origin !== location.origin ||
    event.data?.type !== "spellbook.browser-office-ready" ||
    event.data.protocolVersion !== 1 ||
    port
  )
    return;
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = ({ data }) => {
    void receive(data).catch((error) => {
      pendingSave = false;
      pendingHandle = null;
      showError(error);
    });
  };
  port.start();
  editor.contentWindow.postMessage(
    { type: "spellbook.browser-office-connect", protocolVersion: 1 },
    location.origin,
    [channel.port2],
  );
});
element("open").onclick = async () => {
  if (pendingSave || opening) {
    showError(Error("진행 중인 파일 작업이 끝난 뒤 다른 파일을 열어 주세요"));
    return;
  }
  opening = true;
  try {
    clearError();
    if (
      modified &&
      !confirm("저장하지 않은 변경이 있습니다. 다른 파일을 열까요?")
    )
      return;
    if (!window.showOpenFilePicker || !window.showSaveFilePicker)
      throw Error("이 브라우저는 직접 파일 저장을 지원하지 않습니다");
    const [chosen] = await showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "PowerPoint",
          accept: {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation":
              [".pptx"],
          },
        },
      ],
    });
    const opened = await openLocalOfficeHandle(chosen);
    generation++;
    window.dispatchEvent(new Event("spellbook-local-document-changing"));
    current = opened;
    await localProgramsReady;
    handle = chosen;
    for (const task of tasks.values()) {
      clearTimeout(task.timer);
      task.reject(Error("document_closed"));
    }
    tasks.clear();
    ownedAssets.clear();
    port?.close();
    port = null;
    modified = false;
    buttons(false);
    element("file-name").textContent = current.name;
    element("empty").hidden = true;
    editor.hidden = false;
    update("문서를 여는 중");
    editor.src = `/workspace?hostOrigin=${encodeURIComponent(location.origin)}&document=${encodeURIComponent(current.documentId)}&nonce=${crypto.randomUUID()}`;
    await navigator.storage.persist();
    const space = await navigator.storage.estimate();
    element("storage").textContent =
      `브라우저 저장 공간: ${Math.round((space.usage ?? 0) / 1024 / 1024)}MB 사용 / 약 ${Math.round((space.quota ?? 0) / 1024 / 1024)}MB. 복구본을 유일한 저장본으로 사용하지 마세요.`;
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  } finally {
    opening = false;
  }
};
async function save(asNew) {
  if (!port || pendingSave || opening) return;
  pendingSave = true;
  try {
    clearError();
    // Acquire write authority while the user gesture is still active.
    const selected = asNew
      ? await showSaveFilePicker({
          suggestedName: current.name,
          types: [
            {
              description: "PowerPoint",
              accept: {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                  [".pptx"],
              },
            },
          ],
        })
      : handle;
    if (
      !selected ||
      (await selected.requestPermission({ mode: "readwrite" })) !== "granted"
    )
      throw Error("file_write_permission_required");
    pendingHandle = selected;
    pendingSave = true;
    sendCommand("Action_Save");
    update("선택한 파일에 저장 중");
  } catch (error) {
    pendingSave = false;
    pendingHandle = null;
    if (error.name !== "AbortError") showError(error);
  }
}
element("save").onclick = () => save(false);
element("save-as").onclick = () => save(true);
element("export").onclick = async () => {
  if (!port || pendingSave || opening) return;
  pendingSave = true;
  try {
    const selected = await showSaveFilePicker({
      suggestedName: current.name,
      types: [
        {
          description: "PowerPoint",
          accept: {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation":
              [".pptx"],
          },
        },
      ],
    });
    const observed = await call({
      operation: "observe",
      captureSlideIndexes: [],
    });
    const result = await call({
      operation: "export_pptx",
      expectedRevision: observed.revision,
    });
    const bytes = new Uint8Array(result.bytes);
    await writeLocalOfficeFile(selected, bytes, await digest(bytes));
    update(
      modified
        ? "PPTX 내보내기 완료 · 원본 변경은 아직 저장하지 않았습니다"
        : "PPTX 내보내기 완료",
    );
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  } finally {
    pendingSave = false;
  }
};
element("undo").onclick = () => {
  try {
    sendCommand("Send_UNO_Command", { Command: ".uno:Undo" });
  } catch (error) {
    showError(error);
  }
};
element("redo").onclick = () => {
  try {
    sendCommand("Send_UNO_Command", { Command: ".uno:Redo" });
  } catch (error) {
    showError(error);
  }
};
element("pdf-export").onclick = async () => {
  if (!port || pendingSave || opening) return;
  pendingSave = true;
  try {
    const selected = await showSaveFilePicker({
      suggestedName: current.name.replace(/\.pptx$/i, ".pdf"),
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
    });
    const observed = await call({
      operation: "observe",
      captureSlideIndexes: [],
    });
    const result = await call({
      operation: "export_pdf",
      expectedRevision: observed.revision,
    });
    const bytes = new Uint8Array(result.bytes);
    await writeLocalOfficeFile(selected, bytes, await digest(bytes));
    update(
      modified
        ? "PDF 내보내기 완료 · PPTX 변경은 아직 저장하지 않았습니다"
        : "PDF 내보내기 완료",
    );
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  } finally {
    pendingSave = false;
  }
};
window.addEventListener("beforeunload", (event) => {
  if (modified || pendingSave) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Cache completion is independent of file/OPFS durability.
export const localProgramsReady =
  "serviceWorker" in navigator
    ? (async () => {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("offline_program_control_timeout")),
              10000,
            );
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        const workspace = await fetch("/workspace");
        if (!workspace.ok) throw Error("offline_program_cache_failed");
        const onlyOffice = (await workspace.text()).includes(
          "office-runtime-config",
        );
        for (const url of [
          "/local-workspace.css",
          "/local-phone-view.mjs",
          "/design-system/tokens.css",
          "/design-system/base.css",
          "/design-system/components.css",
          "/design-system/patterns.css",
          "/local",
          "/local-workspace.mjs",
          "/local-file.mjs",
          "/local-ai.bundle.js",
          ...(onlyOffice
            ? [
                "/workspace.bundle.js",
                "/comparison-repair.js",
                "/npm/public-api.js",
              ]
            : []),
        ]) {
          const response = await fetch(url);
          if (!response.ok) throw Error("offline_program_cache_failed");
        }
        return true;
      })()
    : Promise.reject(Error("offline_program_cache_unavailable"));
localProgramsReady.catch(() => {});
export const localOffice = {
  call,
  documentScope: () => current?.documentId ?? "",
  generation: () => generation,
  sendCommand,
  isReady: () => !!port && !element("save").disabled,
};
