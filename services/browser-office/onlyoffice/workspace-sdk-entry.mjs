/* SPDX-License-Identifier: MPL-2.0 */
import { installOnlyOfficeProductPort } from "./product-native-port.mjs";
import { initializeOnlyOfficeSections } from "./section-artifact.mjs";
const owner = parent.parent,
  ownerOrigin = new URL(import.meta.url).searchParams.get("clientOrigin");
if (!ownerOrigin || new URL(ownerOrigin).origin !== ownerOrigin)
  throw Error("trusted_sdk_owner_missing");
let installed = false;
window.addEventListener("message", async (event) => {
  if (
    installed ||
    event.source !== owner ||
    event.origin !== ownerOrigin ||
    event.data?.type !== "spellbook.onlyoffice-sdk-initialize" ||
    typeof event.data.sessionId !== "string" ||
    event.data.sessionId.length < 32 ||
    event.ports.length !== 1
  )
    return;
  installed = true;
  const config = event.data;
  const view = event.ports[0];
  try {
    const until = Date.now() + 180000;
    while (!window.Asc?.editor?.WordControl?.m_oLogicDocument?.Slides?.length) {
      if (Date.now() > until) throw Error("native_sdk_timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
    const registration = await navigator.serviceWorker.register(
      "/document_editor_service_worker.js",
      { scope: "/" },
    );
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("public_asset_cache_control_timeout")),
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
    const resources = [
      "/reset.html",
      "/onlyoffice-browser-font-source-map.json",
      "/server/FileConverter/bin/font_selection.bin",
    ]
      .map((p) => new URL(p, location.origin).href)
      .concat([
        location.href,
        ...performance.getEntriesByType("resource").map((e) => e.name),
        ...parent.performance.getEntriesByType("resource").map((e) => e.name),
        parent.location.href,
      ]);
    const urls = [...new Set(resources)]
      .map((u) => new URL(u))
      .filter(
        (u) =>
          u.origin === location.origin &&
          !u.searchParams.has("file") &&
          !u.searchParams.has("src") &&
          (/^\/(?:assets|npm|sdkjs|web-apps|wasm|fonts)\//.test(u.pathname) ||
            [
              "/office-host.html",
              "/sdk.bundle.js",
              "/comparison-repair.js",
              "/plugins.json",
              "/themes.json",
              "/onlyoffice-runtime-assets.json",
              "/onlyoffice-browser-font-assets.json",
              "/onlyoffice-browser-font-source-map.json",
              "/server/FileConverter/bin/font_selection.bin",
              "/reset.html",
            ].includes(u.pathname)),
      );
    for (let i = 0; i < urls.length; i += 8)
      await Promise.all(
        urls.slice(i, i + 8).map(async (url) => {
          const response = await fetch(url.href);
          if (!response.ok) throw Error("public_asset_cache_warmup_failed");
        }),
      );
    initializeOnlyOfficeSections(config.sections);
    installOnlyOfficeProductPort({
      clientWindow: owner,
      clientOrigin: ownerOrigin,
      sessionId: config.sessionId,
    });
    view.onmessage = async ({ data }) => {
      try {
        const editor = window.Asc.editor,
          m = editor.WordControl.m_oLogicDocument;
        let value;
        if (data.method === "fit_view") {
          editor.WordControl.zoom_FitToPage();
          value = { fitted: true };
        } else if (data.method === "export_pdf") {
          const authority =
            parent[Symbol.for("spellbook.onlyoffice.resourceHost/v1")];
          if (!authority) throw Error("pdf_export_authority_missing");
          value = await authority.exportPdf();
        } else if (data.method === "selection") {
          const activeSlide = Math.max(0, m.CurPage ?? 0),
            tree = m.Slides[activeSlide]?.cSld.spTree ?? [];
          const paths = new Map();
          const walk = (items, prefix) =>
            items.forEach((shape, i) => {
              const path = prefix + "/" + i;
              paths.set(shape.Id, path);
              if (shape.spTree) walk(shape.spTree, path);
            });
          walk(tree, String(activeSlide));
          const graphics = m.Slides[activeSlide]?.graphicObjects;
          const selected =
            graphics?.selection?.groupSelection?.selectedObjects ??
            graphics?.selectedObjects ??
            [];
          value = {
            activeSlide,
            selectedIds: selected.map((o) => paths.get(o.Id)).filter(Boolean),
          };
        } else if (data.method === "capture") {
          const index = data.slideIndex;
          if (!Number.isSafeInteger(index) || !m.Slides[index])
            throw Error("slide_invalid");
          const slide = m.Slides[index],
            canvas = document.createElement("canvas");
          canvas.width = 1280;
          canvas.height = Math.round((1280 * slide.Height) / slide.Width);
          const g = new AscCommon.CGraphics();
          g.init(
            canvas.getContext("2d"),
            canvas.width,
            canvas.height,
            slide.Width,
            slide.Height,
          );
          g.m_oFontManager = AscCommon.g_fontManager;
          g.transform(1, 0, 0, 1, 0, 0);
          const previous = AscCommon.IsShapeToImageConverter;
          try {
            AscCommon.IsShapeToImageConverter = true;
            slide.draw(g);
            value = {
              slideIndex: index,
              pngBase64: canvas.toDataURL("image/png").split(",")[1],
            };
          } finally {
            AscCommon.IsShapeToImageConverter = previous;
          }
        } else if (data.method === "reveal") {
          if (
            !Number.isSafeInteger(data.slideIndex) ||
            !m.Slides[data.slideIndex]
          )
            throw Error("slide_invalid");
          editor.WordControl.GoToPage(data.slideIndex);
          if (data.elementId != null) {
            if (
              typeof data.elementId !== "string" ||
              !/^\d+(?:\/\d+)+$/.test(data.elementId) ||
              Number(data.elementId.split("/")[0]) !== data.slideIndex
            )
              throw Error("element_invalid");
            let shape = m.Slides[data.slideIndex];
            for (const index of data.elementId.split("/").slice(1).map(Number))
              shape = (shape?.cSld?.spTree ?? shape?.spTree)?.[index];
            if (!shape) throw Error("element_missing");
            const graphics = m.Slides[data.slideIndex].graphicObjects;
            graphics.resetSelection();
            graphics.selectObject(shape, 0);
            editor.WordControl.m_oDrawingDocument.OnUpdateOverlay();
          }
          value = true;
        } else throw Error("view_method_unavailable");
        view.postMessage({ id: data.id, value });
      } catch (e) {
        view.postMessage({ id: data.id, error: e.message });
      }
    };
    view.start();
    view.postMessage({ type: "ready" });
  } catch (e) {
    view.postMessage({ type: "error", error: e.message });
  }
});
owner.postMessage({ type: "spellbook.onlyoffice-sdk-ready" }, ownerOrigin);
