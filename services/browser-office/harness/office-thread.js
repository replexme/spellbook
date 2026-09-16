/* SPDX-License-Identifier: MPL-2.0 */

"use strict";

let zetajs;
let css;
let context;
let desktop;
let model;

function installSpellbookUnoAdapter() {
  globalThis.uno = {
    idl: zetajs.uno,
    componentContext: context,
    Any: zetajs.Any,
    sameUnoObject: zetajs.sameUnoObject,
    type: zetajs.type,
  };
}

let nativeAdapter;

function post(command, details = {}) {
  zetajs.mainPort.postMessage({ command, ...details });
}

function slideCount() {
  return model?.getDrawPages().getCount() ?? 0;
}

function dispatch(command, args = []) {
  const url = {
    val: new css.util.URL({ Complete: `.uno:${command}` }),
  };
  css.util.URLTransformer.create(context).parseStrict(url);
  const controller = model.getCurrentController();
  const dispatcher = controller.queryDispatch(url.val, "_self", 0);
  if (!dispatcher) throw new Error(`UNO command is unavailable: ${command}`);
  dispatcher.dispatch(url.val, args);
}

function property(Name, type, value) {
  return new css.beans.PropertyValue({
    Name,
    Value: new zetajs.Any(type, value),
  });
}

function assetSignatureIsValid(bytes, mediaType) {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16));
  const png =
    view.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => view[index] === value,
    );
  const jpeg = view[0] === 0xff && view[1] === 0xd8;
  const text = (start, end) => String.fromCharCode(...view.slice(start, end));
  const signatures = {
    "image/png": png,
    "image/jpeg": jpeg,
    "audio/mpeg":
      text(0, 3) === "ID3" || (view[0] === 0xff && (view[1] & 0xe0) === 0xe0),
    "audio/wav": text(0, 4) === "RIFF" && text(8, 12) === "WAVE",
    "audio/ogg": text(0, 4) === "OggS",
    "audio/mp4": text(4, 8) === "ftyp",
    "video/mp4": text(4, 8) === "ftyp",
    "video/webm":
      view[0] === 0x1a &&
      view[1] === 0x45 &&
      view[2] === 0xdf &&
      view[3] === 0xa3,
  };
  return signatures[mediaType] === true;
}

function observeDocument(request = {}) {
  return spellbookDocumentOperation({
    operation: "observe",
    ...request,
    mutationContracts: spellbookMutationContracts,
    nativeAdapter,
  });
}

function inspectSavedDocument(path, detailSlideIndex) {
  if (!model) throw new Error("No browser Office document is open.");
  if (
    typeof path !== "string" ||
    !/^\/tmp\/spellbook\/native-[0-9]+\.pptx$/u.test(path)
  )
    throw new Error("Invalid saved-document inspection path.");
  const factory = context.getServiceManager();
  const created = factory.createInstanceWithContext(
    "com.sun.star.comp.Draw.PresentationDocument",
    context,
  );
  if (!created) throw new Error("Saved PPTX model could not be created.");
  try {
    if (typeof created.load !== "function")
      throw new Error("Saved PPTX model is not loadable.");
    created.load([
      property("URL", zetajs.type.string, `file://${path}`),
      property("FilterName", zetajs.type.string, "Impress Office Open XML"),
    ]);
    return spellbookDocumentOperation({
      operation: "observe",
      captureSlideIndexes: [],
      ...(Number.isSafeInteger(detailSlideIndex) ? { detailSlideIndex } : {}),
      mutationContracts: spellbookMutationContracts,
      nativeAdapter,
      documentModel: created,
      inspectPersistedSnapshot: true,
    });
  } finally {
    created.dispose();
  }
}

function mutateAsset(request) {
  const {
    assetBytes,
    mediaType,
    slideIndex,
    expectedRevision,
    permission,
    operation,
    elementId,
  } = request;
  const isImage = operation.endsWith("_image");
  const expectedSlides = (() => {
    try {
      const value = JSON.parse(request.expectedSlides);
      if (!Array.isArray(value) || value.length < 1 || value.length > 500)
        throw new Error("invalid_expected_document");
      return value;
    } catch {
      throw new Error("invalid_expected_document");
    }
  })();
  if (
    ![
      "insert_image",
      "replace_image",
      "insert_media",
      "replace_media",
    ].includes(operation) ||
    !(assetBytes instanceof ArrayBuffer) ||
    !assetBytes.byteLength ||
    assetBytes.byteLength > (isImage ? 5_000_000 : 25_000_000) ||
    !assetSignatureIsValid(assetBytes, mediaType)
  )
    throw new Error("invalid_asset");
  const before = observeDocument();
  if (
    typeof expectedRevision !== "string" ||
    before.revision !== expectedRevision
  )
    throw new Error("document_changed_observe_again");
  if (
    !Number.isSafeInteger(slideIndex) ||
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

  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/webm": "webm",
  }[mediaType];
  if (!extension) throw new Error("unsupported_asset_type");
  const path = `/tmp/spellbook/asset-${Date.now()}.${extension}`;
  const undo = model.getUndoManager();
  const undoCount = undo.getAllUndoActionTitles().length;
  let contextOpen = false;
  try {
    FS.writeFile(path, new Uint8Array(assetBytes));
    const page = model.getDrawPages().getByIndex(slideIndex);
    const pageWidth = Number(page.getPropertyValue("Width")) || 28_000;
    const pageHeight = Number(page.getPropertyValue("Height")) || 15_750;
    undo.enterUndoContext(isImage ? "AI image edit" : "AI media edit");
    contextOpen = true;
    if (isImage) {
      const provider = css.graphic.GraphicProvider.create(context);
      const graphic = provider.queryGraphic([
        property("URL", zetajs.type.string, `file://${path}`),
      ]);
      if (!graphic) throw new Error("asset_decode_failed");
      const shape = model.createInstance(
        "com.sun.star.drawing.GraphicObjectShape",
      );
      const sourceSize = graphic.Size100thMM ?? { Width: 4, Height: 3 };
      const sourceWidth = Math.max(1, Number(sourceSize.Width) || 4);
      const sourceHeight = Math.max(1, Number(sourceSize.Height) || 3);
      const scale = Math.min(
        (pageWidth * 0.7) / sourceWidth,
        (pageHeight * 0.7) / sourceHeight,
      );
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      shape.setPosition(
        new css.awt.Point({
          X: Math.round((pageWidth - width) / 2),
          Y: Math.round((pageHeight - height) / 2),
        }),
      );
      shape.setSize(new css.awt.Size({ Width: width, Height: height }));
      shape.setPropertyValue(
        "Graphic",
        new zetajs.Any(zetajs.type.interface(css.graphic.XGraphic), graphic),
      );
      page.add(shape);
    } else {
      dispatch("InsertAVMedia", [
        property("URL", zetajs.type.string, `file://${path}`),
        property("Size.Width", zetajs.type.long, Math.round(pageWidth * 0.7)),
        property("Size.Height", zetajs.type.long, Math.round(pageHeight * 0.7)),
        property("IsLink", zetajs.type.boolean, false),
      ]);
    }
    const insertedState = observeDocument();
    const beforeStableIds = new Set(
      before.slides[slideIndex].elements.map((element) => element.stableId),
    );
    const inserted = insertedState.slides[slideIndex].elements.filter(
      (element) =>
        element.parentElementId === null &&
        !beforeStableIds.has(element.stableId),
    );
    const expectedKind = isImage ? "GraphicObjectShape" : "MediaShape";
    const otherSlidesUnchanged = before.slides.every(
      (slide, index) =>
        index === slideIndex ||
        JSON.stringify(slide) === JSON.stringify(insertedState.slides[index]),
    );
    if (
      inserted.length !== 1 ||
      insertedState.slides[slideIndex].elements.length !==
        before.slides[slideIndex].elements.length + 1 ||
      !otherSlidesUnchanged ||
      !String(inserted[0].kind).endsWith(expectedKind)
    )
      throw new Error("asset_insert_readback_failed");
    const replacementTarget = operation.startsWith("replace_")
      ? before.slides[slideIndex].elements.find(
          (element) => element.elementId === elementId,
        )
      : null;
    if (operation.startsWith("replace_")) {
      if (!replacementTarget)
        throw new Error("invalid_asset_replacement_target");
      const oldIndex = Number(String(elementId).split("/")[1]);
      const newIndex = Number(inserted[0].elementId.split("/")[1]);
      if (
        !Number.isSafeInteger(oldIndex) ||
        !Number.isSafeInteger(newIndex) ||
        String(elementId).split("/").length !== 2
      )
        throw new Error("invalid_asset_replacement_target");
      page
        .getByIndex(newIndex)
        .setPropertyValue(
          "SpellbookReplaceObject",
          new zetajs.Any(zetajs.type.long, oldIndex),
        );
    }
    undo.leaveUndoContext();
    contextOpen = false;
    const after = observeDocument({
      detailSlideIndex: slideIndex,
      captureSlideIndexes: [slideIndex],
    });
    const beforeCount = before.slides.reduce(
      (total, slide) => total + slide.elements.length,
      0,
    );
    const afterCount = after.slides.reduce(
      (total, slide) => total + slide.elements.length,
      0,
    );
    const replacementPreserved =
      !replacementTarget ||
      (after.slides[slideIndex].elements.some(
        (element) => element.stableId === replacementTarget.stableId,
      ) &&
        !after.slides[slideIndex].elements.some(
          (element) => element.stableId === inserted[0].stableId,
        ));
    if (
      afterCount !== beforeCount + (operation.startsWith("replace_") ? 0 : 1) ||
      !replacementPreserved ||
      undo.getAllUndoActionTitles().length !== undoCount + 1
    )
      throw new Error(
        afterCount !==
          beforeCount + (operation.startsWith("replace_") ? 0 : 1) ||
        !replacementPreserved
          ? "asset_mutation_not_applied"
          : "native_undo_not_recorded",
      );
    const issueKey = (issue) =>
      JSON.stringify({
        slideIndex: issue.slideIndex,
        code: issue.code,
        stableId: issue.stableId ?? null,
        stableIds: issue.stableIds ?? null,
      });
    const beforeIssues = new Set(
      (before.layoutAudit?.issues ?? []).map(issueKey),
    );
    const introducedIssues = (after.layoutAudit?.issues ?? []).filter(
      (issue) => !beforeIssues.has(issueKey(issue)),
    );
    return {
      ...after,
      changedSlideIndexes: [slideIndex],
      visualEvidenceComplete:
        after.images?.length === 1 &&
        after.images[0]?.slideIndex === slideIndex,
      layoutAudit: {
        ...after.layoutAudit,
        introducedIssueCount: introducedIssues.length,
        introducedIssues,
      },
    };
  } catch (error) {
    if (contextOpen) undo.leaveUndoContext();
    while (undo.getAllUndoActionTitles().length > undoCount) undo.undo();
    const rolledBack = observeDocument();
    if (JSON.stringify(rolledBack.slides) !== JSON.stringify(expectedSlides))
      throw new Error(
        `asset_rollback_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    throw error;
  } finally {
    try {
      FS.unlink(path);
    } catch {}
  }
}

function storeDocument(path, requestId) {
  if (!model) throw new Error("No browser Office document is open.");
  model.storeToURL(`file://${path}`, [
    property("FilterName", zetajs.type.string, "Impress Office Open XML"),
    property("Overwrite", zetajs.type.boolean, true),
  ]);
  post("store-complete", {
    requestId,
    path,
    modified: model.isModified(),
  });
}

function closeDocument() {
  if (!model) return;
  try {
    model.close(true);
  } catch {
    model.dispose();
  }
  model = undefined;
}

function openDocument(path, requestId) {
  closeDocument();
  model = desktop.loadComponentFromURL(`file://${path}`, "_default", 0, []);
  const controller = model.getCurrentController();
  controller.getFrame().getContainerWindow().FullScreen = true;
  post("document-ready", { requestId, slideCount: slideCount() });
}

function reportError(error, requestId) {
  post("error", {
    requestId,
    message: error instanceof Error ? error.message : String(error),
  });
}

function start() {
  context = zetajs.getUnoComponentContext();
  css = zetajs.uno.com.sun.star;
  desktop = css.frame.Desktop.create(context);
  installSpellbookUnoAdapter();
  if (typeof createSpellbookBrowserNativeAdapter !== "function")
    throw new Error("Spellbook browser native adapter is unavailable.");
  nativeAdapter = createSpellbookBrowserNativeAdapter({
    uno: globalThis.uno,
    runtimeIdentity: globalThis.spellbookBrowserRuntimeCandidate,
  });
  zetajs.mainPort.onmessage = (event) => {
    const { command, requestId } = event.data;
    try {
      switch (command) {
        case "open":
          openDocument(event.data.path, requestId);
          break;
        case "dispatch":
          dispatch(event.data.unoCommand);
          post("dispatch-complete", {
            requestId,
            unoCommand: event.data.unoCommand,
            slideCount: slideCount(),
          });
          break;
        case "set-editor-sidebar":
          if (typeof event.data.visible !== "boolean")
            throw new Error("Editor sidebar visibility must be boolean.");
          dispatch("Sidebar", [
            property("Sidebar", zetajs.type.boolean, event.data.visible),
          ]);
          post("editor-sidebar-set", {
            requestId,
            visible: event.data.visible,
          });
          break;
        case "set-editor-slide-pane":
          if (typeof event.data.visible !== "boolean")
            throw new Error("Editor slide pane visibility must be boolean.");
          dispatch("LeftPaneImpress", [
            property(
              "LeftPaneImpress",
              zetajs.type.boolean,
              event.data.visible,
            ),
          ]);
          post("editor-slide-pane-set", {
            requestId,
            visible: event.data.visible,
          });
          break;
        case "native":
          if (
            typeof spellbookDocumentOperation !== "function" ||
            typeof spellbookMutationContracts !== "object"
          )
            throw new Error(
              "Spellbook native operation program is unavailable.",
            );
          post("native-complete", {
            requestId,
            value: [
              "insert_image",
              "replace_image",
              "insert_media",
              "replace_media",
            ].includes(event.data.nativeRequest?.operation)
              ? mutateAsset(event.data.nativeRequest)
              : spellbookDocumentOperation({
                  ...event.data.nativeRequest,
                  mutationContracts: spellbookMutationContracts,
                  nativeAdapter,
                }),
          });
          break;
        case "status":
          post("status-complete", {
            requestId,
            modified: Boolean(model?.isModified()),
            slideCount: slideCount(),
          });
          break;
        case "store":
          storeDocument(event.data.path, requestId);
          break;
        case "inspect-saved":
          post("inspect-saved-complete", {
            requestId,
            value: inspectSavedDocument(
              event.data.path,
              event.data.detailSlideIndex,
            ),
          });
          break;
        case "mark-saved":
          if (!model) throw new Error("No browser Office document is open.");
          model.setModified(false);
          post("mark-saved-complete", { requestId });
          break;
        case "close":
          closeDocument();
          post("close-complete", { requestId });
          break;
        default:
          throw new Error(`Unknown browser Office command: ${command}`);
      }
    } catch (error) {
      reportError(error, requestId);
    }
  };
  post("runtime-ready");
}

Module.zetajs.then((bridge) => {
  zetajs = bridge;
  start();
});
