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
} from "./product-runtime-addon.mjs";
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
        const identity = createHash("sha256")
          .update(
            await fs.readFile(
              path.join(dist, "onlyoffice-runtime-assets.json"),
            ),
          )
          .update(await fs.readFile(path.join(base, "sdk.bundle.js")))
          .digest("hex");
        const code = (
          await fs.readFile(
            path.join(sourceRoot, "workspace-cache-worker.js"),
            "utf8",
          )
        ).replace("__RUNTIME_ID__", identity);
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(code);
        return;
      }
      if (pathname === "/licenses") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Spellbook licenses and source</title><h1>Licenses and corresponding source</h1><p><a href="/licensing.html">Pinned ONLYOFFICE distribution licenses, fonts and upstream source archives</a></p><p><a href="/workspace-sources.tar.gz">Current host source archive</a> · <a href="/workspace-source-receipt.json">Bundle and source identity receipt</a></p><p>Host source carries MPL-2.0 notices. ONLYOFFICE distribution carries AGPL-3.0 notices. Auxiliary WASM reproduction remains unverified; this candidate is not admitted for public distribution.</p>',
        );
        return;
      }
      const localRoot = path.resolve(sourceRoot, "..");
      const names = {
        ...localUiFiles,
        "/workspace-sources.tar.gz": path.join(
          base,
          "workspace-sources.tar.gz",
        ),
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
        "/comparison-repair.js": path.join(
          repositoryRoot,
          "services/browser-office/runtime/ooxml-worker.js",
        ),
      };
      const file = names[pathname] ?? path.resolve(dist, "." + pathname);
      if (!names[pathname] && !file.startsWith(dist + path.sep))
        throw Error("path_invalid");
      let bytes = await fs.readFile(file);
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
