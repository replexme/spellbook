/* Only the embedding host can establish the port; document text and model
 * output cannot turn into scripts. The host checks the editor origin.
 */
window.presentNative = {
  observe: (detailSlideIndex = null) =>
    cool.callRemote(spellbookDocumentOperation, {
      operation: "observe",
      detailSlideIndex,
      mutationContracts: spellbookMutationContracts,
    }),
  edit: (request) =>
    cool.callRemote(spellbookDocumentOperation, {
      ...request,
      operation: "edit",
      mutationContracts: spellbookMutationContracts,
    }),
  editBatch: (request) =>
    cool.callRemote(spellbookDocumentOperation, {
      ...request,
      operation: "edit_batch",
      mutationContracts: spellbookMutationContracts,
    }),
};
let connection;
let readyTimer;
const bridgeSessionId = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;
const assetSignatureIsValid = (bytes, mediaType) => {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16));
  const png =
    view.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => view[index] === value,
    );
  const jpeg = view[0] === 0xff && view[1] === 0xd8;
  const riff = String.fromCharCode(...view.slice(0, 4)) === "RIFF";
  const wave = riff && String.fromCharCode(...view.slice(8, 12)) === "WAVE";
  const webm =
    view[0] === 0x1a &&
    view[1] === 0x45 &&
    view[2] === 0xdf &&
    view[3] === 0xa3;
  const ogg = String.fromCharCode(...view.slice(0, 4)) === "OggS";
  const mp3 =
    String.fromCharCode(...view.slice(0, 3)) === "ID3" ||
    (view[0] === 0xff && (view[1] & 0xe0) === 0xe0);
  const isoMedia = String.fromCharCode(...view.slice(4, 8)) === "ftyp";
  return (
    {
      "image/png": png,
      "image/jpeg": jpeg,
      "audio/mpeg": mp3,
      "audio/wav": wave,
      "audio/ogg": ogg,
      "video/webm": webm,
      "video/mp4": isoMedia,
      "audio/mp4": isoMedia,
    }[mediaType] === true
  );
};
const elementCount = (state) =>
  state.slides.reduce((total, slide) => total + slide.elements.length, 0);
const waitForInsertedAsset = async (before, slideIndex, operation) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await window.presentNative.observe(slideIndex);
    const targetCount = state.slides[slideIndex]?.elements.length;
    const beforeTargetCount = before.slides[slideIndex]?.elements.length;
    const otherSlidesUnchanged = before.slides.every(
      (slide) =>
        slide.slideIndex === slideIndex ||
        state.slides[slide.slideIndex]?.elements.length ===
          slide.elements.length,
    );
    if (
      targetCount === beforeTargetCount + 1 &&
      elementCount(state) === elementCount(before) + 1 &&
      otherSlidesUnchanged
    ) {
      const beforeStableIds = new Set(
        before.slides[slideIndex].elements.map((element) => element.stableId),
      );
      const added = state.slides[slideIndex].elements.filter(
        (element) =>
          element.parentElementId === null &&
          !beforeStableIds.has(element.stableId),
      );
      const expectedKind = operation.endsWith("_image")
        ? "GraphicObjectShape"
        : "MediaShape";
      if (added.length === 1 && String(added[0].kind).endsWith(expectedKind))
        return state;
    }
  }
  throw new Error("asset_was_not_inserted");
};
const mutateAsset = async (request) => {
  const {
    assetBytes,
    mediaType,
    slideIndex,
    expectedRevision,
    expectedSlides,
    permission,
    operation,
    elementId,
    fileName,
  } = request;
  const isImage = operation.endsWith("_image");
  const maximumBytes = isImage ? 5_000_000 : 25_000_000;
  const imageTypes = ["image/png", "image/jpeg"];
  const mediaTypes = [
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "video/mp4",
    "video/webm",
  ];
  if (
    ![
      "insert_image",
      "replace_image",
      "insert_media",
      "replace_media",
    ].includes(operation) ||
    !(assetBytes instanceof ArrayBuffer) ||
    !assetBytes.byteLength ||
    assetBytes.byteLength > maximumBytes ||
    !(isImage ? imageTypes : mediaTypes).includes(mediaType) ||
    !assetSignatureIsValid(assetBytes, mediaType) ||
    typeof expectedSlides !== "string"
  )
    throw new Error("invalid_asset");
  const before = await window.presentNative.observe();
  if (
    typeof expectedRevision !== "string" ||
    before.revision !== expectedRevision
  )
    throw new Error("document_changed_observe_again");
  if (
    !Number.isInteger(slideIndex) ||
    slideIndex < 0 ||
    slideIndex >= before.slides.length ||
    before.activeSlide !== slideIndex
  )
    throw new Error("asset_slide_changed");
  if (
    !permission ||
    !["selection", "slides", "document"].includes(permission.mode) ||
    (operation.startsWith("insert_") && permission.mode === "selection") ||
    (permission.mode === "slides" &&
      !permission.slideIndexes?.includes(slideIndex)) ||
    (permission.mode === "selection" &&
      !permission.elementIds?.includes(elementId))
  )
    throw new Error("outside_edit_permission");
  const extensionByType = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const extension = extensionByType[mediaType];
  if (!extension) throw new Error("unsupported_asset_type");
  const safeName =
    typeof fileName === "string" && fileName.trim()
      ? fileName.trim().slice(0, 200)
      : `AI-asset.${extension}`;
  const file = new File([assetBytes], safeName, {
    type: mediaType,
  });
  const editorMap = window.parent.app?.map;
  if (!editorMap) throw new Error("native_editor_map_unavailable");
  let checkpoint;
  editorMap.fire("blockUI", { message: "AI가 자산을 편집하고 있습니다…" });
  try {
    checkpoint = await cool.callRemote(spellbookDocumentOperation, {
      operation: "asset_begin",
      assetOperation: operation,
      elementId,
      slideIndex,
      expectedRevision,
      expectedSlides,
      permission,
      mutationContracts: spellbookMutationContracts,
    });
    editorMap.fire(isImage ? "insertgraphic" : "insertmultimedia", { file });
    await waitForInsertedAsset(before, slideIndex, operation);
    return await cool.callRemote(spellbookDocumentOperation, {
      operation: "asset_finish",
      assetOperation: operation,
      elementId,
      slideIndex,
      expectedSlides,
      beforeAudit: before.layoutAudit,
      undoCount: checkpoint.undoCount,
      beforeElementIds: checkpoint.beforeElementIds,
      mutationContracts: spellbookMutationContracts,
    });
  } catch (error) {
    if (checkpoint)
      await cool
        .callRemote(spellbookDocumentOperation, {
          operation: "asset_abort",
          undoCount: checkpoint.undoCount,
          expectedSlides,
          mutationContracts: spellbookMutationContracts,
        })
        .catch(() => undefined);
    throw error;
  } finally {
    editorMap.fire("unblockUI");
  }
};
window.addEventListener("message", (event) => {
  if (
    event.source !== window.top ||
    event.data?.type !== "spellbook.connect" ||
    (event.data.bridgeSessionId !== undefined &&
      event.data.bridgeSessionId !== bridgeSessionId) ||
    !event.ports[0]
  )
    return;
  if (connection) return;
  connection = event.ports[0];
  clearInterval(readyTimer);
  const completed = new Map();
  let tail = Promise.resolve();
  connection.onmessage = (event) => {
    const message = event.data;
    if (
      !message?.id ||
      ![
        "observe",
        "edit",
        "edit_batch",
        "insert_image",
        "replace_image",
        "insert_media",
        "replace_media",
        "selection",
        "reveal",
        "undo_turn",
      ].includes(message.request?.operation)
    )
      return;
    if (!completed.has(message.id)) {
      const task = tail.then(() =>
        [
          "insert_image",
          "replace_image",
          "insert_media",
          "replace_media",
        ].includes(message.request.operation)
          ? mutateAsset(message.request)
          : cool.callRemote(spellbookDocumentOperation, {
              ...message.request,
              mutationContracts: spellbookMutationContracts,
            }),
      );
      tail = task.catch(() => undefined);
      completed.set(message.id, task);
      // Pending/result receipts are bounded to this active page session.
      if (completed.size > 100) completed.delete(completed.keys().next().value);
    }
    completed.get(message.id).then(
      (value) => connection.postMessage({ id: message.id, value }),
      (error) =>
        connection.postMessage({ id: message.id, error: error.message }),
    );
  };
  // Tell the host what is selected so the request box can say
  // "선택 · 제목 상자 (3번)". Selection changes surface as command-state and
  // slide changes; reads are coalesced and queued behind document operations.
  const editorMap = window.parent.app?.map;
  let selectionQueued = false;
  let lastSelection = "";
  const publishSelection = () => {
    if (selectionQueued || !connection) return;
    selectionQueued = true;
    setTimeout(() => {
      selectionQueued = false;
      const task = tail.then(() =>
        cool.callRemote(spellbookDocumentOperation, {
          operation: "selection",
          mutationContracts: spellbookMutationContracts,
        }),
      );
      tail = task.catch(() => undefined);
      task.then(
        (value) => {
          const key = JSON.stringify(value);
          if (key === lastSelection) return;
          lastSelection = key;
          connection.postMessage({ type: "selection", value });
        },
        () => undefined,
      );
    }, 350);
  };
  editorMap?.on?.("commandstatechanged", publishSelection);
  editorMap?.on?.("updateparts", publishSelection);
  connection.postMessage({ type: "ready" });
  publishSelection();
});
function applySpellbookToolbarTypography() {
  try {
    const parentDoc = window.parent?.document;
    if (
      !parentDoc ||
      parentDoc.getElementById("spellbook-injected-toolbar-style")
    )
      return;
    const style = parentDoc.createElement("style");
    style.id = "spellbook-injected-toolbar-style";
    style.textContent = `
      :root {
        --header-font-size: 11px !important;
        --default-font-size: 11px !important;
        --medium-font-size: 11px !important;
        --overflow-group-font-size: 10px !important;
        --header-height: 28px !important;
        --sidebar-header-height: 28px !important;
        --notebookbar-element-height: 48px !important;
        --btn-size: 24px !important;
      }
      html, body, .notebookbar, .notebookbar *, .ui-content, #Home-container, #navigation-sidebar, .navigation-header, .main-nav {
        font-family: -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      }
      .main-nav,
      .main-nav.hasnotebookbar {
        height: 28px !important;
        min-height: 28px !important;
      }
      .main-nav .ui-tab,
      .ui-tab.jsdialog,
      .ui-tab.notebookbar {
        font-size: 11px !important;
        font-weight: 500 !important;
        height: 28px !important;
        line-height: 28px !important;
        padding: 0 10px !important;
        letter-spacing: -0.01em !important;
      }
      .notebookbar, .notebookbar .ui-content {
        font-size: 10px !important;
      }
      .notebookbar .ui-overflow-group-label,
      #Home-container .ui-overflow-group-label,
      .ui-overflow-group-label {
        display: none !important;
      }
      .unotoolbutton.notebookbar .unolabel,
      .has-label.has-dropdown:not(.inline) .unolabel,
      .unotoolbutton.notebookbar.has-label,
      .menubutton.has-label button,
      .notebookbar button,
      .notebookbar .ui-text,
      .notebookbar span.unolabel,
      .notebookbar span,
      .notebookbar label,
      .notebookbar p {
        font-family: -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
        font-size: 10px !important;
        font-weight: 500 !important;
        line-height: 1.2 !important;
        letter-spacing: -0.01em !important;
      }
      .navigation-header {
        font-size: 11px !important;
        font-weight: 600 !important;
        height: 28px !important;
        padding: 4px 8px !important;
      }
      .navigation-header .navigation-title {
        display: none !important;
      }
    `;
    parentDoc.head.appendChild(style);

    const fixPaste = () => {
      const pasteButtons = parentDoc.querySelectorAll(
        "#Home-container button, .notebookbar button, #buttonpaste",
      );
      for (const btn of pasteButtons) {
        if (btn.textContent && btn.textContent.includes("Paste")) {
          btn.innerHTML = btn.innerHTML.replace(/\bPaste\b/g, "붙여넣기");
        }
      }
    };
    fixPaste();
    const pasteObserver = new MutationObserver(fixPaste);
    pasteObserver.observe(parentDoc.body, { childList: true, subtree: true });
  } catch {}
}
applySpellbookToolbarTypography();

const announceReady = () => {
  if (connection) {
    clearInterval(readyTimer);
    return;
  }
  window.top.postMessage(
    { type: "spellbook.extension-ready", bridgeSessionId },
    "*",
  );
};
announceReady();
readyTimer = setInterval(announceReady, 250);
window.presentNative
  .observe()
  .then((state) => {
    document.getElementById("state").textContent =
      `${state.slides.length}개 슬라이드 연결됨`;
  })
  .catch((error) => {
    document.getElementById("state").textContent =
      `문서를 연결하지 못했습니다: ${error.message}`;
  });
