/* SPDX-License-Identifier: MPL-2.0 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { localUiFiles } from "../local-ui-assets.mjs";
import {
  addOnlyOfficeProductBootstrap,
  addOnlyOfficeProductResourceHost,
  addOnlyOfficeProductSdk,
} from "./product-runtime-addon.mjs";
import { patchOnlyOfficeDocumentFontConversionWorker } from "./document-fonts.mjs";
import { onlyOfficeDocumentFontPrograms } from "./product-programs.mjs";
import { patchOnlyOfficeDistributedAlignment } from "./distributed-alignment.mjs";
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceRoot, "../../..");
function validOrigin(value) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("workspace_origin_invalid");
  return value;
}
export function createOnlyOfficeWorkspaceServer({
  distributionDirectory,
  bundleDirectory = path.join(sourceRoot, "workspace-dist"),
  workspaceOrigin,
  sdkOrigin,
  inspectionOrigin,
  hostOrigins,
  admission = null,
  publicReleaseAdmitted = false,
} = {}) {
  const dist = path.resolve(distributionDirectory),
    base = path.resolve(bundleDirectory);
  [
    workspaceOrigin,
    sdkOrigin,
    inspectionOrigin,
    ...(hostOrigins ?? []),
  ].forEach(validOrigin);
  if (
    !hostOrigins?.length ||
    new Set([workspaceOrigin, sdkOrigin, inspectionOrigin]).size !== 3
  )
    throw Error("workspace_isolation_origins_required");
  hostOrigins = [...new Set([...hostOrigins, workspaceOrigin])];
  const config = { sdkOrigin, inspectionOrigin, hostOrigins };
  const localRoot = path.resolve(sourceRoot, "..");
  const names = {
    ...localUiFiles,
    ...onlyOfficeDocumentFontPrograms(base),
    "/comparison-repair.js": path.join(
      repositoryRoot,
      "services/browser-office/runtime/ooxml-worker.js",
    ),
    "/workspace-sources.tar.gz": path.join(base, "workspace-sources.tar.gz"),
    "/workspace-source-receipt.json": path.join(
      base,
      "workspace-source-receipt.json",
    ),
    "/local": path.join(localRoot, "local-workspace.html"),
    "/local-workspace.mjs": path.join(localRoot, "local-workspace.mjs"),
    "/local-phone-view.mjs": path.join(localRoot, "local-phone-view.mjs"),
    "/local-ai.bundle.js": path.join(base, "local-ai.bundle.js"),
    "/local-file.mjs": path.join(localRoot, "local-file.mjs"),
    "/workspace.bundle.js": path.join(base, "workspace.bundle.js"),
    "/sdk.bundle.js": path.join(base, "sdk.bundle.js"),
  };
  const readProgram = async (pathname) => {
    const file = names[pathname] ?? path.resolve(dist, "." + pathname);
    if (!names[pathname] && !file.startsWith(dist + path.sep))
      throw Error("path_invalid");
    let bytes = await fs.readFile(file);
    if (pathname === "/sdkjs/slide/sdk-all.js")
      bytes = Buffer.from(
        addOnlyOfficeProductSdk(
          patchOnlyOfficeDistributedAlignment(bytes.toString()),
        ),
      );
    if (pathname === "/wasm/x2t/conversion-worker-lKNm6_YF.js")
      bytes = Buffer.from(
        patchOnlyOfficeDocumentFontConversionWorker(bytes.toString()),
      );
    if (pathname === "/web-apps/apps/presentationeditor/main/index.html")
      bytes = Buffer.from(
        addOnlyOfficeProductBootstrap(bytes.toString()).replace(
          "</head>",
          '<script type="module" src="/sdk.bundle.js?clientOrigin=' +
            encodeURIComponent(workspaceOrigin) +
            '"></script></head>',
        ),
      );
    if (pathname === "/assets/officeHost-C2hljZhH.js") {
      let text = addOnlyOfficeProductResourceHost(bytes.toString());
      for (const [before, after] of [
        [
          "e.map(e=>e.unregister())",
          'e.filter(r=>!["/verification-cache-worker.js","/document_editor_service_worker.js","/sw.js"].some(p=>(r.active??r.waiting??r.installing)?.scriptURL.includes(p))).map(e=>e.unregister())',
        ],
        [
          "e.map(e=>window.caches.delete(e))",
          'e.filter(n=>!n.startsWith("spellbook-office-public-assets-")).map(e=>window.caches.delete(e))',
        ],
      ]) {
        if (text.split(before).length !== 2)
          throw Error("pinned_cache_cleanup_patch_mismatch");
        text = text.replace(before, after);
      }
      bytes = Buffer.from(text);
    }
    return { file, bytes };
  };
  const runtimeIdentity = async () =>
    createHash("sha256")
      .update(await fs.readFile(path.join(dist, "distribution-manifest.json")))
      .update(await fs.readFile(path.join(base, "sdk.bundle.js")))
      .update(
        await fs.readFile(path.join(base, "workspace-source-receipt.json")),
      )
      .update(
        await fs.readFile(path.join(sourceRoot, "workspace-cache-worker.js")),
      )
      .update(JSON.stringify(config))
      .digest("hex");
  let publishedManifest, publishedVersion;
  const publicPrograms = async (identity) => {
    if (identity === publishedVersion) return publishedManifest;
    publishedVersion = identity;
    publishedManifest = (async () => {
      const distribution = JSON.parse(
        await fs.readFile(
          path.join(dist, "distribution-manifest.json"),
          "utf8",
        ),
      );
      if (!Array.isArray(distribution.files))
        throw Error("public_program_distribution_manifest_invalid");
      const hashes = Object.create(null);
      for (const entry of distribution.files) {
        if (
          typeof entry.path !== "string" ||
          entry.path.startsWith("/") ||
          entry.path.split("/").includes("..") ||
          /[?#\\]/.test(entry.path) ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
          throw Error("public_program_distribution_entry_invalid");
        hashes["/" + entry.path] = entry.sha256;
      }
      for (const pathname of new Set([
        ...Object.keys(names),
        "/sdkjs/slide/sdk-all.js",
        "/wasm/x2t/conversion-worker-lKNm6_YF.js",
        "/web-apps/apps/presentationeditor/main/index.html",
        "/assets/officeHost-C2hljZhH.js",
      ])) {
        try {
          hashes[pathname] = createHash("sha256")
            .update((await readProgram(pathname)).bytes)
            .digest("hex");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          delete hashes[pathname];
        }
      }
      return { runtimeIdentity: identity, hashes };
    })();
    return publishedManifest;
  };
  return createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "no-store");
      if (pathname === "/readyz") {
        res.writeHead(admission ? 200 : 503, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            ready: !!admission,
            engine: "onlyoffice",
            admission,
            publicReleaseAdmitted,
          }),
        );
        return;
      }
      if (pathname === "/workspace") {
        res.setHeader(
          "Content-Security-Policy",
          "frame-ancestors 'self' " + hostOrigins.join(" "),
        );
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style><script id="office-runtime-config" type="application/json">' +
            JSON.stringify(config).replaceAll("<", "\\u003c") +
            '</script><script type="module" src="/workspace.bundle.js"></script>',
        );
        return;
      }
      if (
        [
          "/verification-cache-worker.js",
          "/document_editor_service_worker.js",
          "/sw.js",
        ].includes(pathname)
      ) {
        res.setHeader("Service-Worker-Allowed", "/");
        const identity = await runtimeIdentity();
        const code = (
          await fs.readFile(
            path.join(sourceRoot, "workspace-cache-worker.js"),
            "utf8",
          )
        ).replace("__RUNTIME_ID__", identity);
        res.setHeader("X-Spellbook-Runtime-Identity", identity);
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(code);
        return;
      }
      if (pathname === "/public-programs.json") {
        const manifest = await publicPrograms(await runtimeIdentity());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(manifest));
        return;
      }
      if (pathname === "/licenses") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Spellbook licenses and source</title><h1>Licenses and corresponding source</h1><p><a href="/licensing.html">Pinned ONLYOFFICE distribution licenses, fonts and upstream source archives</a></p><p><a href="/workspace-sources.tar.gz">Current host and native SDK adaptation source archive</a> · <a href="/workspace-source-receipt.json">Bundle and source identity receipt</a></p><p>The archive also includes the MPL-2.0 libeot decoder source, notices, bounded-output patch and local Emscripten rebuild script. Customer embedded fonts are document-owned private inputs and are not included.</p><p>Host integration source carries MPL-2.0 notices. Native SDK adaptations and the ONLYOFFICE distribution carry AGPL-3.0 notices. ' +
            (admission?.auxiliaryWasmRebuildVerified
              ? '<a href="/sources/auxiliary-build-receipt.json">Four auxiliary JS/WASM pairs reproduced from the provided source.</a> '
              : "Auxiliary WASM reproduction remains unverified. ") +
            (publicReleaseAdmitted
              ? "</p>"
              : "This candidate is not admitted for public distribution.</p>"),
        );
        return;
      }
      const { file, bytes } = await readProgram(pathname);
      const type =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".wasm": "application/wasm",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ttf": "font/ttf",
          ".otf": "font/otf",
        }[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(bytes);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(e?.code === "ENOENT" ? 404 : 500);
      res.end();
    }
  });
}
