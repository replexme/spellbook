import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeAssets } from "../office-session-spike/probe-assets.mjs";
import { applyZetaJsOverlay } from "./zetajs-overlay.mjs";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceRoot, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(serviceRoot, "upstream.json"), "utf8"),
);

export function buildRoutes(
  root = serviceRoot,
  upstream = manifest,
  options = {},
) {
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "runtime");
  const runtimeIdentity = options.runtimeIdentity;
  const routes = new Map([
    [
      "/",
      route(path.join(root, "harness/index.html"), "text/html; charset=utf-8"),
    ],
    [
      "/workspace",
      route(path.join(root, "harness/index.html"), "text/html; charset=utf-8"),
    ],
    [
      "/harness/app.js",
      route(
        path.join(root, "harness/app.js"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/browser-visual-evidence.mjs",
      route(
        path.join(root, "browser-visual-evidence.mjs"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/runtime-admission.js",
      route(
        path.join(root, "harness/runtime-admission.js"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/opfs-journal.mjs",
      route(
        path.join(root, "opfs-journal.mjs"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/save-transaction.mjs",
      route(
        path.join(root, "save-transaction.mjs"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/product-history.mjs",
      route(
        path.join(root, "product-history.mjs"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/product-persistence.mjs",
      route(
        path.join(root, "harness/product-persistence.mjs"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/persistence-evidence.mjs",
      route(
        path.join(
          repositoryRoot,
          "services/office-session-spike/persistence-evidence.mjs",
        ),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/document-state-evidence.mjs",
      route(
        path.join(
          repositoryRoot,
          "services/office-session-spike/document-state-evidence.mjs",
        ),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/office-thread.js",
      route(
        path.join(root, "harness/office-thread.js"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/mutation-contract.generated.js",
      route(
        path.join(
          repositoryRoot,
          "services/office-editor/extension/mutation-contract.generated.js",
        ),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/operations.js",
      route(
        path.join(
          repositoryRoot,
          "services/office-editor/extension/operations.js",
        ),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/native-transform-adapter.js",
      route(
        path.join(root, "harness/native-transform-adapter.js"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/harness/styles.css",
      route(path.join(root, "harness/styles.css"), "text/css; charset=utf-8"),
    ],
    [
      "/fixtures/general-native-surface.pptx",
      route(
        path.join(
          repositoryRoot,
          "eval/public/fixtures/general-native-surface.pptx",
        ),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ],
    [
      "/runtime/ooxml-worker.js",
      route(
        path.join(root, "runtime/ooxml-worker.js"),
        "text/javascript; charset=utf-8",
      ),
    ],
    [
      "/runtime/browser-candidate.js",
      runtimeIdentity
        ? inlineRoute(
            `globalThis.spellbookBrowserRuntimeCandidate = Object.freeze(${JSON.stringify(runtimeIdentity)});\n`,
            "text/javascript; charset=utf-8",
          )
        : route(
            path.join(root, "runtime/browser-candidate.js"),
            "text/javascript; charset=utf-8",
          ),
    ],
  ]);

  if (options.browserProbeSource) {
    routes.set(
      "/fixtures/browser-probe.pptx",
      route(
        path.resolve(options.browserProbeSource),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    );
    routes.set(
      "/extensions/org.spellbook.editor/browser-probe.html",
      inlineRoute(
        `<!doctype html><meta charset="utf-8"><script>globalThis.cool={callRemote(_operation,direction){return parent.spellbookBrowserOffice.probeHistory(direction);}};<\/script>`,
        "text/html; charset=utf-8",
      ),
    );
    for (const [assetId, asset] of probeAssets)
      routes.set(
        `/fixtures/probe-assets/${assetId}`,
        inlineRoute(asset.bytes, asset.mediaType),
      );
  }

  for (const asset of upstream.runtimeAssets) {
    const requestedPath =
      asset.path ?? path.basename(new URL(asset.url).pathname);
    routes.set(
      `/runtime/${requestedPath}`,
      route(path.join(runtimeRoot, asset.storedPath), asset.contentType, {
        ...(asset.contentEncoding
          ? { "Content-Encoding": asset.contentEncoding }
          : {}),
        ...upstream.requiredAssetHeaders,
      }),
    );
  }
  const bridgeAsset = upstream.javascriptBridge.runtimeAsset;
  const bridgeRequestedPath =
    bridgeAsset.path ?? path.basename(new URL(bridgeAsset.url).pathname);
  routes.set(
    `/runtime/${bridgeRequestedPath}`,
    route(
      path.join(root, "runtime", bridgeAsset.storedPath),
      bridgeAsset.contentType,
      {
        ...(bridgeAsset.contentEncoding
          ? { "Content-Encoding": bridgeAsset.contentEncoding }
          : {}),
        ...upstream.requiredAssetHeaders,
        "Cache-Control": "no-store",
      },
      (source) => {
        const digest = createHash("sha256").update(source).digest("hex");
        if (digest !== bridgeAsset.sha256)
          throw new Error("Pinned ZetaJS asset failed source admission.");
        return applyZetaJsOverlay(source);
      },
    ),
  );
  // Korean fonts, font rules and the Korean UI setting the engine does not
  // carry. The page writes them into the engine's file system before it
  // starts (runtime-files.json).
  const fonts = JSON.parse(
    readFileSync(path.join(root, "runtime-files.json"), "utf8"),
  );
  const install = [];
  for (const font of fonts.fonts) {
    routes.set(
      `/runtime/fonts/${font.file}`,
      route(
        path.join(root, "runtime", "fonts", font.file),
        "font/otf",
        upstream.requiredAssetHeaders,
      ),
    );
    // The engine's own font folder: its Qt drawing layer only lists fonts
    // found there (another folder was written but never drawn with).
    install.push({
      url: `fonts/${font.file}`,
      directory: "/instdir/share/fonts/truetype",
      name: font.file,
    });
  }
  fonts.fontconfig.forEach((file, index) => {
    // Before the stock 60-/65- rules, in the listed order.
    const name = `${57 + index}-${path.basename(file)}`;
    routes.set(
      `/runtime/fonts/${name}`,
      route(
        path.join(root, file),
        "application/xml; charset=utf-8",
        upstream.requiredAssetHeaders,
      ),
    );
    install.push({
      url: `fonts/${name}`,
      directory: "/instdir/share/fontconfig/conf.d",
      name,
    });
  });
  for (const file of fonts.registry) {
    const name = path.basename(file);
    routes.set(
      `/runtime/registry/${name}`,
      route(
        path.join(root, file),
        "application/xml; charset=utf-8",
        upstream.requiredAssetHeaders,
      ),
    );
    install.push({
      url: `registry/${name}`,
      directory: "/instdir/share/registry",
      name,
    });
  }
  routes.set(
    "/runtime/files.json",
    inlineRoute(
      JSON.stringify(install),
      "application/json",
      upstream.requiredAssetHeaders,
    ),
  );
  return routes;
}

export function createHarnessServer(options = {}) {
  const upstream = options.upstream ?? manifest;
  const root = options.root ?? serviceRoot;
  const routes =
    options.routes ??
    buildRoutes(root, upstream, {
      runtimeRoot: options.runtimeRoot,
      runtimeIdentity: options.runtimeIdentity,
      browserProbeSource: options.browserProbeSource,
    });
  const hostOrigin = validateHostOrigin(
    options.hostOrigin ?? process.env.SPELLBOOK_BROWSER_HOST_ORIGIN,
  );
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    for (const [name, value] of Object.entries(
      upstream.requiredDocumentHeaders,
    ))
      response.setHeader(name, value);
    if (pathname === "/workspace" && hostOrigin)
      response.setHeader(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${hostOrigin}`,
      );
    if (pathname === "/readyz") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: "ok",
          protocolVersion: 1,
          buildCommit: upstream.source.buildCommit,
          candidateCommit: upstream.source.candidateCommit,
          ...upstream.sourceCandidate,
        }),
      );
      return;
    }
    if (
      pathname === "/browser-probe/save" &&
      request.method === "POST" &&
      options.browserProbeOutput
    ) {
      const chunks = [];
      let bytes = 0;
      request.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        const value = Buffer.concat(chunks);
        if (
          !value.byteLength ||
          value.byteLength > 64 * 1024 * 1024 ||
          value[0] !== 0x50 ||
          value[1] !== 0x4b
        ) {
          response.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ error: "invalid_browser_probe_pptx" }));
          return;
        }
        try {
          writeFileSync(path.resolve(options.browserProbeOutput), value, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          response.writeHead(error?.code === "EEXIST" ? 409 : 500, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(
            JSON.stringify({
              error:
                error?.code === "EEXIST"
                  ? "browser_probe_output_exists"
                  : "browser_probe_save_failed",
            }),
          );
          return;
        }
        response.writeHead(201, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ bytes: value.byteLength }));
      });
      return;
    }
    const target = routes.get(pathname);
    if (!target || (target.file && !existsSync(target.file))) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (target.transform && target.body === undefined) {
      try {
        target.body = target.transform(readFileSync(target.file, "utf8"));
      } catch (_) {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("Browser UNO bridge unavailable");
        return;
      }
    }
    response.writeHead(200, target.headers);
    if (request.method === "HEAD") response.end();
    else if (target.body !== undefined) response.end(target.body);
    else createReadStream(target.file).pipe(response);
  });
}

function validateHostOrigin(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (parsed.origin !== value || !["http:", "https:"].includes(parsed.protocol))
    throw new Error("SPELLBOOK_BROWSER_HOST_ORIGIN must be an HTTP origin.");
  return parsed.origin;
}

export function configuredServerPort(
  argv = process.argv,
  environment = process.env,
) {
  const portFlag = argv.indexOf("--port");
  const port = Number(
    portFlag >= 0 ? argv[portFlag + 1] : (environment.PORT ?? 4173),
  );
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  return port;
}

function route(file, contentType, headers = {}, transform = null) {
  return {
    file,
    ...(transform ? { transform } : {}),
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...headers,
    },
  };
}

function inlineRoute(body, contentType, headers = {}) {
  return {
    body,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...headers,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = configuredServerPort();
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createHarnessServer();
  server.listen(port, host, () => {
    process.stdout.write(
      `Spellbook Browser Office: http://${host}:${port}/?autorun=1\n`,
    );
  });
}
