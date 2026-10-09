/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import { createOnlyOfficeProgramSymbolAssets } from "./program-symbol-font.mjs";
import * as resourceObjectStore from "../../document-resources/object-store.mjs";
import {readOwnedLinkedImages} from "../../document-resources/linked-image-snapshots.mjs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createOnlyOfficeWorkspaceServer } from "./workspace-server.mjs";
import { admitSelectedOnlyOffice } from "../engine-selection.mjs";
import { captureOnlyOfficeSlide } from "./slide-capture.mjs";
import { patchOnlyOfficeDistributedAlignment } from "./distributed-alignment.mjs";
import { addOnlyOfficeProductSdk } from "./product-runtime-addon.mjs";
import { presentationReferenceEpoch, installPresentationReferenceDate } from "./presentation-render-clock.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const host = (
  sdkOrigin,
) => `<!doctype html><meta charset="utf-8"><div id="editor" style="width:1280px;height:900px"></div><script type="module">
import {createOfficeEditor} from ${JSON.stringify(sdkOrigin + "/npm/public-api.js")};
window.renderError=null;
try {
const index=await (await fetch('/__render-resources')).json();
const payloads=new Map();
for(const image of index?.manifest?.images??[]){if(!payloads.has(image.sha256))payloads.set(image.sha256,await(await fetch('/__render-resources?sha256='+image.sha256)).arrayBuffer());}
const renderResources=index?{manifest:index.manifest,assets:index.manifest.images.map(image=>({...image,sourceSha256:index.manifest.sourceSha256,bytes:payloads.get(image.sha256)}))}:null;
const file=new File([await (await fetch('/__document')).arrayBuffer()],'preview.pptx',{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
window.previewEditor=await createOfficeEditor(document.querySelector('#editor'),{hostUrl:${JSON.stringify(sdkOrigin + "/office-host.html")},file,spellbookRenderResources:renderResources,fileName:file.name,lang:'ko',mode:'view',saveBehavior:'callback',onError:e=>window.renderError=e.message});
} catch(e){window.renderError=e.message;}
</script>`;

export async function loadOnlyOfficeDiagnosticFontAssets(directory) {
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(directory, "onlyoffice-browser-font-assets.json"),
      "utf8",
    ),
  );
  const files = [
    "onlyoffice-browser-font-assets.json",
    manifest.allFonts,
    manifest.fontSelection,
    manifest.fontSourceMap,
    "server/FileConverter/bin/AllFonts.js",
    ...manifest.fontThumbnails,
    ...manifest.fonts,
  ];
  const assets = new Map();
  for (const file of files) {
    if (!file || path.isAbsolute(file) || file.split("/").includes(".."))
      throw Error("diagnostic_font_path_invalid");
    assets.set("/" + file, await fs.readFile(path.join(directory, file)));
  }
  return {
    assets,
    identity: {
      sha256: sha(
        Buffer.from(
          JSON.stringify(
            [...assets].map(([file, bytes]) => ({ file, sha256: sha(bytes) })),
          ),
        ),
      ),
      scope:
        "Local diagnostic font installation; not the admitted public font distribution",
    },
  };
}

export async function createOnlyOfficeHeadlessRenderer({
  distributionDirectory = path.resolve(import.meta.dirname, "distribution"),
  bundleDirectory = path.resolve(import.meta.dirname, "workspace-dist"),
  timeoutMs = 180000,
  diagnosticFontDirectory = null,
} = {}) {
  const admission = await admitSelectedOnlyOffice(distributionDirectory);
  const hostSourceSha256 = sha(
    await fs.readFile(
      path.join(bundleDirectory, "workspace-source-receipt.json"),
    ),
  );
  const programSymbols = await createOnlyOfficeProgramSymbolAssets(distributionDirectory);
  const productSdkSha256 = sha(
    Buffer.from(
      addOnlyOfficeProductSdk(patchOnlyOfficeDistributedAlignment(
        await fs.readFile(
          path.join(distributionDirectory, "sdkjs/slide/sdk-all.js"),
          "utf8",
        ),
      )),
    ),
  );
  // Explicit local experiments record an overlay separately from the admitted
  // distribution. Production never silently substitutes a different font pack.
  let fontOverlay = null;
  let fontAssets = new Map();
  if (diagnosticFontDirectory) {
    const loaded = await loadOnlyOfficeDiagnosticFontAssets(
      diagnosticFontDirectory,
    );
    fontAssets = loaded.assets;
    fontOverlay = loaded.identity;
  }
  const servers = [createServer(), createServer(), createServer()];
  let browser,
    currentDocument = null, currentResources = null;
  try {
    for (const server of servers)
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    const origins = servers.map(
      (server) => "http://127.0.0.1:" + server.address().port,
    );
    const [workspaceOrigin, sdkOrigin, inspectionOrigin] = origins;
    for (const server of servers) {
      const routes = createOnlyOfficeWorkspaceServer({
        distributionDirectory,
        bundleDirectory,
        workspaceOrigin,
        sdkOrigin,
        inspectionOrigin,
        hostOrigins: [workspaceOrigin],
        admission,
        publicReleaseAdmitted: true,
      });
      const route = routes.listeners("request")[0];
      server.on("request", (request, response) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (fontAssets.has(pathname)) {
          const type = pathname.endsWith(".js")
            ? "text/javascript"
            : pathname.endsWith(".json")
              ? "application/json"
              : "application/octet-stream";
          response.writeHead(200, {
            "content-type": type,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          });
          response.end(fontAssets.get(pathname));
        } else if (request.url === "/__render") {
          response.writeHead(200, {
            "content-type": "text/html",
            "cache-control": "no-store",
          });
          response.end(host(sdkOrigin));
        } else if (pathname === "/__render-resources") {
          const requested=new URL(request.url,"http://localhost").searchParams.get("sha256");
          if(requested===null){
            response.writeHead(200,{"content-type":"application/json","cache-control":"private, no-store"});
            response.end(JSON.stringify(currentResources?{manifest:currentResources.manifest}:null));
          }else{
            const image=currentResources?.assets.find(asset=>asset.sha256===requested);
            response.writeHead(image?200:404,{"content-type":image?.contentType??"application/json","cache-control":"private, no-store"});
            response.end(image?image.bytes:JSON.stringify({error:"external_image_snapshot_relationship_missing"}));
          }
        } else if (request.url === "/__document" && currentDocument) {
          response.writeHead(200, {
            "content-type":
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "cache-control": "no-store",
          });
          response.end(currentDocument);
        } else route(request, response);
      });
    }
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.SPELLBOOK_CHROMIUM_EXECUTABLE || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader"],
    });
    let rendering = false;
    return {
      identity: {
        name: "ONLYOFFICE",
        distributionSha256: admission.distributionSha256,
        hostSourceSha256,
        productSdkSha256,
        programFonts: programSymbols.identity,
        ...(fontOverlay ? { diagnosticFontAssets: fontOverlay } : {}),
      },
      async renderFile(
        inputPath,
        { outputDirectory, slideIndexes = null, resourceScope = null, referenceDateTime = null } = {},
      ) {
        if (rendering) throw Error("onlyoffice_render_busy");
        rendering = true;
        let context, page;
        const errors = [],
          deniedRequests = [],
          failedRequests = [],
          consoleErrors = [];
        let privateFontHttpRequests = 0;
        const started = performance.now();
        try {
          const referenceEpoch = presentationReferenceEpoch(referenceDateTime);
          const renderedAt = new Date().toISOString();
          const bytes = await fs.readFile(inputPath);
          if (!bytes.length || bytes.length > 64 * 1024 * 1024)
            throw Error("onlyoffice_render_input_size_invalid");
          if(resourceScope?.dataDirectory)process.env.SPELLBOOK_DATA_DIR=resourceScope.dataDirectory;
          currentResources=resourceScope?await readOwnedLinkedImages({...resourceScope,sourceBytes:bytes,objectStore:resourceObjectStore}):null;
          currentDocument = bytes;
          await fs.mkdir(outputDirectory, { recursive: true });
          context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            serviceWorkers: "block",
            timezoneId: process.env.SPELLBOOK_RENDER_TIME_ZONE || "Asia/Seoul",
          });
          if (referenceEpoch !== null)
            await context.addInitScript(installPresentationReferenceDate, referenceEpoch);
          context.on("request", request => {
            if (new URL(request.url()).pathname.startsWith("/fonts/document-"))
              privateFontHttpRequests += 1;
          });
          await context.addInitScript(() => {
            window.__renderFontPicks = [];
            window.onLogPickFont = (value) =>
              window.__renderFontPicks.push(value);
          });
          await context.route("**/*", (route) => {
            const url = new URL(route.request().url());
            if (
              origins.includes(url.origin) ||
              ["blob:", "data:"].includes(url.protocol)
            )
              return route.continue();
            deniedRequests.push(url.origin);
            return route.abort();
          });
          page = await context.newPage();
          page.on("requestfailed", (request) => {
            const url = new URL(request.url());
            failedRequests.push({
              origin: url.origin,
              path: url.pathname,
              error: request.failure()?.errorText,
            });
          });
          page.on("pageerror", (e) => {
            errors.push(e.message);
            console.error("[onlyoffice-render]", e.message);
          });
          page.on("console", (message) => {
            if (message.type() === "error") {
              consoleErrors.push(message.text());
              console.error("[onlyoffice-render]", message.text());
            }
          });
          await page.goto(workspaceOrigin + "/__render");
          await page.waitForFunction(
            () =>
              window.previewEditor?.getState().status === "ready" ||
              window.renderError,
            null,
            { timeout: timeoutMs },
          );
          const error = await page.evaluate(() => window.renderError);
          if (error) throw Error(error);
          const frame = page
            .frames()
            .find((frame) => frame.url().includes("/presentationeditor/"));
          if (!frame) throw Error("onlyoffice_render_frame_missing");
          const slideCount = await frame.evaluate(
            () => Asc.editor.WordControl.m_oLogicDocument.Slides.length,
          );
          const indexes =
            slideIndexes ?? Array.from({ length: slideCount }, (_, i) => i);
          if (
            !Array.isArray(indexes) ||
            indexes.some(
              (i) => !Number.isSafeInteger(i) || i < 0 || i >= slideCount,
            ) ||
            new Set(indexes).size !== indexes.length
          )
            throw Error("onlyoffice_render_slide_indexes_invalid");
          const openedMs = performance.now() - started,
            images = [];
          for (const slideIndex of indexes) {
            await frame.evaluate(
              (index) => Asc.editor.WordControl.GoToPage(index),
              slideIndex,
            );
            const captured = await frame.evaluate(
              captureOnlyOfficeSlide,
              slideIndex,
            );
            const file = path.join(
              outputDirectory,
              `slide-${slideIndex + 1}.png`,
            );
            const png = Buffer.from(captured.pngBase64, "base64");
            await fs.writeFile(file, png);
            images.push({
              slideIndex,
              file,
              sha256: sha(png),
              width: captured.width,
              height: captured.height,
            });
          }
          await page.screenshot({
            path: path.join(outputDirectory, "editor.png"),
          });
          const fontPicks = await frame.evaluate(
            () => window.__renderFontPicks ?? [],
          );
          const nativeShapes = await frame.evaluate(() => {
            const visit = (shape) => ({
              id: shape.nvSpPr?.cNvPr?.id,
              type: shape.constructor.name,
              x: shape.x,
              y: shape.y,
              width: shape.extX,
              height: shape.extY,
              ...(shape.getTypeOfSmartArt
                ? {
                    smartArt: {
                      type: shape.getTypeOfSmartArt(),
                      canGenerate: shape.isCanGenerateSmartArt?.(),
                      layout: shape.layoutDef?.uniqueId,
                      points: shape.getDataModel?.()?.getDataModel?.()?.ptLst
                        ?.list?.length,
                      recalculation: shape.recalcInfo,
                    },
                  }
                : {}),
              transform: shape.spPr?.xfrm
                ? {
                    x: shape.spPr.xfrm.offX,
                    y: shape.spPr.xfrm.offY,
                    width: shape.spPr.xfrm.extX,
                    height: shape.spPr.xfrm.extY,
                    childWidth: shape.spPr.xfrm.chExtX,
                    childHeight: shape.spPr.xfrm.chExtY,
                  }
                : null,
              children: shape.spTree?.map(visit),
            });
            return Asc.editor.WordControl.m_oLogicDocument.Slides.map((slide) =>
              slide.cSld.spTree.map(visit),
            );
          });
          const paragraphFormats = await frame.evaluate(() =>
            Asc.editor.WordControl.m_oLogicDocument.Slides.flatMap(
              (slide, slideIndex) =>
                slide.cSld.spTree.flatMap((shape) =>
                  (shape.txBody?.content?.Content ?? []).map((paragraph) => ({
                    slideIndex,
                    shapeId: shape.nvSpPr?.cNvPr?.id,
                    alignment: paragraph.Pr?.Jc,
                    compiledAlignment:
                      paragraph.Get_CompiledPr2?.(false)?.ParaPr?.Jc,
                    fonts: paragraph.Content?.filter(
                      (run) => run.Pr?.RFonts,
                    ).map((run) => run.Pr.RFonts),
                  })),
                ),
            ),
          );
          const result = {
            renderContext: {
              renderedAt,
              referenceDateTime: referenceEpoch === null ? null : new Date(referenceEpoch).toISOString(),
              ...await frame.evaluate(() => ({ dateTime: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })),
            },
            inputSha256: sha(bytes),
            renderer: this.identity,
            slideCount,
            images,
            openedMs,
            totalMs: performance.now() - started,
            errors,
            documentFonts: await frame.evaluate(() =>
              window.parent[Symbol.for("spellbook.onlyoffice.documentFonts/v1")]?.report ?? null),
            privateFontHttpRequests,
            deniedRequests,
            fontPicks,
            paragraphFormats,
            nativeShapes,
          };
          await fs.writeFile(
            path.join(outputDirectory, "render.json"),
            JSON.stringify(result, null, 2),
          );
          return result;
        } catch (error) {
          await page
            ?.screenshot({ path: path.join(outputDirectory, "failure.png") })
            .catch(() => {});
          const frames = [];
          for (const frame of page?.frames() ?? []) {
            const url = new URL(frame.url());
            const state = await frame
              .evaluate(() => ({
                editorStatus: window.previewEditor?.getState().status ?? null,
                renderError: window.renderError ?? null,
                nativeSlides:
                  window.Asc?.editor?.WordControl?.m_oLogicDocument?.Slides
                    ?.length ?? null,
                resources: performance
                  .getEntriesByType("resource")
                  .map((entry) => {
                    const resource = new URL(entry.name);
                    return {
                      origin: resource.origin,
                      path: resource.pathname,
                      durationMs: entry.duration,
                      bytes: entry.transferSize,
                    };
                  }),
              }))
              .catch(() => null);
            frames.push({ origin: url.origin, path: url.pathname, state });
          }
          await fs
            .writeFile(
              path.join(outputDirectory, "failure.json"),
              JSON.stringify(
                {
                  renderer: this.identity,
                  elapsedMs: performance.now() - started,
                  error: String(error.stack ?? error),
                  errors,
                  deniedRequests,
                  failedRequests,
                  consoleErrors,
                  frames,
                },
                null,
                2,
              ),
            )
            .catch(() => {});
          if (fontOverlay) {
            const states = [];
            for (const frame of page?.frames() ?? []) {
              const value = await frame
                .evaluate(() =>
                  window.AscFonts
                    ? {
                        families: Object.keys(AscFonts.g_map_font_index ?? {}),
                        files: (AscFonts.g_font_files ?? []).map((f) => ({
                          id: f.Id,
                          status: f.Status,
                          streamIndex: f.stream_index,
                        })),
                      }
                    : null,
                )
                .catch(() => null);
              if (value) states.push(value);
            }
            await fs.writeFile(
              path.join(outputDirectory, "font-load-failure.json"),
              JSON.stringify(states, null, 2),
            );
          }
          throw error;
        } finally {
          await context?.close();
          currentDocument = null;
          currentResources = null;
          rendering = false;
        }
      },
      async close() {
        await browser?.close();
        for (const server of servers) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    };
  } catch (error) {
    await browser?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    throw error;
  }
}

if (process.argv[1] === import.meta.filename) {
  const [inputPath, outputDirectory, ...selected] = process.argv.slice(2);
  if (!inputPath || !outputDirectory)
    throw Error(
      "Usage: headless-renderer.mjs INPUT.pptx OUTPUT [SLIDE_INDEX...]",
    );
  let resourceScope=null;
  try {resourceScope=JSON.parse(await fs.readFile(inputPath+'.render-resources.json','utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const renderer = await createOnlyOfficeHeadlessRenderer();
  try {
    const result = await renderer.renderFile(inputPath, {
      outputDirectory,
      resourceScope,
      slideIndexes: selected.length ? selected.map(Number) : null,
    });
    process.stdout.write(
      JSON.stringify({
        renderer: renderer.identity,
        images: result.images.map((image) => image.file),
      }) + "\n",
    );
  } finally {
    await renderer.close();
  }
}
