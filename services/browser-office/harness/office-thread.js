/* SPDX-License-Identifier: MPL-2.0 */

"use strict";

// LibreOffice links the engine with Emscripten ASSERTIONS=1 (to keep the
// final link from rewriting the module), and in that mode Embind records a
// stack trace for every C++ object handed to JavaScript, in case it leaks.
// Formatting those traces took most of each full document read (74 of 82 s
// of one edit on a 14-slide deck). Errors here are reported by message.
Error.stackTraceLimit = 0;

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

// This engine keeps no slide sections; the package the product holds does.
// The product sends them with each request, and every observation this
// thread makes for that request includes them.
let packageSections = [];

function observeDocument(request = {}) {
  return spellbookDocumentOperation({
    operation: "observe",
    packageSections,
    ...request,
    captureSlideIndexes: [],
    mutationContracts: spellbookMutationContracts,
    nativeAdapter,
  });
}

function withSavedDocumentModel(path, operation) {
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
    return operation(created);
  } finally {
    created.dispose();
  }
}

function inspectSavedDocument(path, detailSlideIndex, savedSections) {
  return withSavedDocumentModel(path, (created) =>
    spellbookDocumentOperation({
      operation: "observe",
      packageSections: savedSections,
      captureSlideIndexes: [],
      ...(Number.isSafeInteger(detailSlideIndex) ? { detailSlideIndex } : {}),
      mutationContracts: spellbookMutationContracts,
      nativeAdapter,
      documentModel: created,
      inspectPersistedSnapshot: true,
    }),
  );
}

function normalizeSavedDocument(path, outputPath) {
  if (
    typeof outputPath !== "string" ||
    !/^\/tmp\/spellbook\/normalized-[0-9]+\.pptx$/u.test(outputPath)
  )
    throw new Error("Invalid normalized-document output path.");
  withSavedDocumentModel(path, (created) => {
    if (typeof created.storeToURL !== "function")
      throw new Error("Saved PPTX model cannot be normalized.");
    created.storeToURL(`file://${outputPath}`, [
      property("FilterName", zetajs.type.string, "Impress Office Open XML"),
      property("Overwrite", zetajs.type.boolean, true),
    ]);
  });
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
  // The page writes audio and video where the engine's own file calls can
  // read them (this thread's file system is a separate copy).
  const path = request.assetPath;
  if (
    !isImage &&
    (typeof path !== "string" ||
      !new RegExp(
        `^/tmp/spellbook-assets/[0-9a-f-]{36}\\.${extension}$`,
        "u",
      ).test(path))
  )
    throw new Error("invalid_asset_path");
  const undo = model.getUndoManager();
  const undoCount = undo.getAllUndoActionTitles().length;
  let contextOpen = false;
  let phase = "prepare_asset";
  try {
    phase = "create_shape";
    const page = model.getDrawPages().getByIndex(slideIndex);
    const pageWidth = Number(page.getPropertyValue("Width")) || 28_000;
    const pageHeight = Number(page.getPropertyValue("Height")) || 15_750;
    undo.enterUndoContext(isImage ? "AI image edit" : "AI media edit");
    contextOpen = true;
    const inputStream = () =>
      css.io.SequenceInputStream.createStreamFromSequence(context, [
        ...new Int8Array(assetBytes),
      ]);
    if (isImage) {
      const provider = css.graphic.GraphicProvider.create(context);
      const graphic = provider.queryGraphic([
        property(
          "InputStream",
          zetajs.type.interface(css.io.XInputStream),
          inputStream(),
        ),
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
      // The size argument is required: without it the engine probes the
      // file with a media player, which the browser build does not have,
      // and refuses to insert.
      dispatch("InsertAVMedia", [
        property("URL", zetajs.type.string, `file://${path}`),
        property("Size.Width", zetajs.type.long, Math.round(pageWidth * 0.7)),
        property("Size.Height", zetajs.type.long, Math.round(pageHeight * 0.7)),
        property("IsLink", zetajs.type.boolean, false),
      ]);
    }
    const insertedState = observeDocument();
    phase = "verify_insert";
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
      throw new Error(
        `asset_insert_readback_failed:${JSON.stringify({
          operation,
          expectedKind,
          insertedKinds: inserted.map((element) => element.kind),
          beforeCount: before.slides[slideIndex].elements.length,
          afterCount: insertedState.slides[slideIndex].elements.length,
          nativeCountAfterObserve: page.getCount(),
          otherSlidesUnchanged,
        })}`,
      );
    if (operation === "insert_media") {
      // The engine sizes and centres new media on its window rather than the
      // slide, which in this runtime put audio metres off the page. Centre it
      // on the slide: video at 70% of the slide width in 16:9 (the browser
      // engine cannot read a video's own size), audio at the engine's
      // default 5 cm square.
      const media = page.getByIndex(
        Number(String(inserted[0].elementId).split("/")[1]),
      );
      let width = 5_000;
      let height = 5_000;
      if (mediaType.startsWith("video/")) {
        width = Math.round(pageWidth * 0.7);
        height = Math.round((width * 9) / 16);
        if (height > pageHeight * 0.7) {
          height = Math.round(pageHeight * 0.7);
          width = Math.round((height * 16) / 9);
        }
      }
      media.setSize(new css.awt.Size({ Width: width, Height: height }));
      media.setPosition(
        new css.awt.Point({
          X: Math.round((pageWidth - width) / 2),
          Y: Math.round((pageHeight - height) / 2),
        }),
      );
    }
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
    phase = "verify_final";
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
    throw new Error(
      `asset_${phase}:${error instanceof Error ? error.message || error.name : String(error)}`,
      { cause: error },
    );
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
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof WebAssembly.Exception) {
    try {
      const native = zetajs.catchUnoException(error);
      const type = String(zetajs.getAnyType(native));
      message = `${type}:${String(native?.Message ?? native?.message ?? message)}`;
    } catch {
      // A WASM trap need not be a UNO exception. Retain the original error.
    }
  }
  if (!message)
    message =
      error instanceof Error
        ? `${error.name || "Error"}:${error.stack || "no_stack"}`
        : `Unknown native error: ${Object.prototype.toString.call(error)}`;
  post("error", {
    requestId,
    message,
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
          // The page asks for slide images separately ("render-slide"), so
          // the shared program does not capture them itself.
          const nativeRequest =
            event.data.nativeRequest?.operation === "observe"
              ? { ...event.data.nativeRequest, captureSlideIndexes: [] }
              : { ...event.data.nativeRequest, suppressCapture: true };
          packageSections = Array.isArray(nativeRequest.packageSections)
            ? nativeRequest.packageSections
            : [];
          post("native-complete", {
            requestId,
            value: [
              "insert_image",
              "replace_image",
              "insert_media",
              "replace_media",
            ].includes(nativeRequest.operation)
              ? mutateAsset(nativeRequest)
              : spellbookDocumentOperation({
                  ...nativeRequest,
                  mutationContracts: spellbookMutationContracts,
                  nativeAdapter,
                }),
          });
          break;
        case "render-slide": {
          // The engine draws the slide itself, as the server editor does for
          // the AI: no wait for the page to repaint, and a hidden browser
          // tab still gets the current slide.
          if (!model) throw new Error("No browser Office document is open.");
          const index = event.data.slideIndex;
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= slideCount()
          )
            throw new Error("invalid_capture_slide_index");
          const page = model.getDrawPages().getByIndex(index);
          const out = css.io.SequenceOutputStream.create(context);
          const exporter = css.drawing.GraphicExportFilter.create(context);
          exporter.setSourceDocument(page);
          const width = 1280;
          const height = Math.round(
            (width * page.getPropertyValue("Height")) /
              page.getPropertyValue("Width"),
          );
          if (
            !exporter.filter([
              property("MediaType", zetajs.type.string, "image/png"),
              property(
                "OutputStream",
                zetajs.type.interface(css.io.XOutputStream),
                out,
              ),
              property(
                "FilterData",
                zetajs.type.sequence(
                  zetajs.type.struct(css.beans.PropertyValue),
                ),
                [
                  property("PixelWidth", zetajs.type.long, width),
                  property("PixelHeight", zetajs.type.long, height),
                ],
              ),
            ])
          )
            throw new Error("browser_slide_render_failed");
          const png = Uint8Array.from(
            out.getWrittenBytes(),
            (value) => value & 0xff,
          );
          post("slide-rendered", { requestId, slideIndex: index, png });
          break;
        }
        case "show-slide": {
          if (!model) throw new Error("No browser Office document is open.");
          const index = event.data.slideIndex;
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= slideCount()
          )
            throw new Error("invalid_capture_slide_index");
          model
            .getCurrentController()
            .setCurrentPage(model.getDrawPages().getByIndex(index));
          post("slide-shown", { requestId, slideIndex: index });
          break;
        }
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
              Array.isArray(event.data.packageSections)
                ? event.data.packageSections
                : [],
            ),
          });
          break;
        case "normalize-saved":
          normalizeSavedDocument(event.data.path, event.data.outputPath);
          post("normalize-saved-complete", { requestId });
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
