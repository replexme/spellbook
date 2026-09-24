import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { buildRoutes } from "./server.mjs";

/*
 * Writes the browser Office editor as a static Firebase Hosting site: the
 * routes the harness server serves, with the same bytes and headers, plus the
 * site's firebase.json.
 *
 * - The frame opens inside the normal Spellbook page (ads run there), so it
 *   isolates itself with Document-Isolation-Policy. Browsers without it cannot
 *   run the engine and are refused by the product.
 * - Firebase drops a Content-Encoding header set on stored files and
 *   compresses on its own, so the engine is stored uncompressed.
 * - Firebase does not revalidate compressed responses, so runtime files live
 *   under a folder named by their content and are cached for good; only the
 *   small pointer script and the documents are fetched on every open.
 *
 *   node export-static.mjs --runtime <verified build dir> --out <dir> \
 *     --host-origin https://spellbook.replex.me [--site <firebase site>]
 */

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PREFIX = "/runtime/";
const IMMUTABLE = "public, max-age=31536000, immutable";

export const FRAME_ISOLATION = Object.freeze({
  "Document-Isolation-Policy": "isolate-and-require-corp",
});

// The product opens only the workspace; the conformance shell and its
// fixtures stay on the development server.
function served(route) {
  return (
    route === "/workspace" ||
    route.startsWith("/harness/") ||
    route.startsWith(RUNTIME_PREFIX)
  );
}

// Firebase stores the engine uncompressed (see above).
function storedSource(target) {
  const encoding = target.headers["Content-Encoding"];
  if (!encoding) return target;
  if (encoding !== "br") throw new Error(`Unsupported encoding ${encoding}.`);
  return { file: target.file.replace(/\.br$/u, "") };
}

function headerList(headers) {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

/**
 * Where each served route is written and which headers it carries. Pure:
 * `version` names the runtime folder and is derived from the files' bytes.
 */
export function planStaticSite(
  routes,
  { version, hostOrigins, documentHeaders, readyz },
) {
  if (!/^[0-9a-f]{16}$/u.test(version))
    throw new Error("Runtime version must be 16 hex characters.");
  if (!hostOrigins.length)
    throw new Error("At least one host origin is required.");
  for (const origin of hostOrigins)
    if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
      throw new Error(`Invalid host origin: ${origin}`);
  const base = { ...documentHeaders, ...FRAME_ISOLATION };
  const files = [];
  const headers = [];
  const rewrites = [];
  const add = (requestPath, file, source, routeHeaders) => {
    files.push({ file, source });
    headers.push({ source: requestPath, headers: headerList(routeHeaders) });
    if (`/${file}` !== requestPath)
      rewrites.push({ source: requestPath, destination: `/${file}` });
  };
  for (const [route, target] of routes) {
    if (!served(route)) continue;
    const { "Content-Encoding": _encoding, ...own } = target.headers;
    const source = storedSource(target);
    if (route.startsWith(RUNTIME_PREFIX)) {
      const name = route.slice(RUNTIME_PREFIX.length);
      add(
        `${RUNTIME_PREFIX}${version}/${name}`,
        `runtime/${version}/${name}`,
        source,
        { ...base, ...own, "Cache-Control": IMMUTABLE },
      );
    } else if (route === "/workspace") {
      add(route, "workspace.html", source, {
        ...base,
        ...own,
        "Content-Security-Policy": `frame-ancestors 'self' ${hostOrigins.join(" ")}`,
      });
    } else {
      add(route, route.slice(1), source, { ...base, ...own });
    }
  }
  const candidate = routes.get(`${RUNTIME_PREFIX}browser-candidate.js`);
  if (typeof candidate?.body !== "string")
    throw new Error("The runtime identity script must be generated.");
  // The page loads this unversioned pointer on every open; it names the
  // folder the rest of the runtime is read from.
  add(
    `${RUNTIME_PREFIX}browser-candidate.js`,
    "runtime/browser-candidate.js",
    {
      body: `${candidate.body}globalThis.spellbookBrowserRuntimeBase = ${JSON.stringify(`${RUNTIME_PREFIX}${version}/`)};\n`,
    },
    { ...base, ...candidate.headers, "Cache-Control": "no-store" },
  );
  add(
    "/readyz",
    "readyz.json",
    { body: JSON.stringify(readyz) },
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  );
  return {
    files,
    firebase: {
      hosting: { public: ".", ignore: ["firebase.json"], headers, rewrites },
    },
  };
}

async function sourceBytes(source) {
  if (source.body !== undefined) return Buffer.from(source.body);
  if (source.transform)
    return Buffer.from(source.transform(await readFile(source.file, "utf8")));
  return readFile(source.file);
}

export async function exportStatic({
  runtimeDirectory,
  outDirectory,
  hostOrigins,
  site,
}) {
  const admitted = await admitCandidateRuntime({ runtimeDirectory });
  const routes = buildRoutes(serviceRoot, admitted.upstream, {
    runtimeRoot: admitted.runtimeDirectory,
    runtimeIdentity: admitted.runtimeIdentity,
  });
  // Name the runtime folder by everything served from it.
  const digest = createHash("sha256");
  for (const route of [...routes.keys()].sort()) {
    if (!route.startsWith(RUNTIME_PREFIX)) continue;
    const bytes = await sourceBytes(storedSource(routes.get(route)));
    digest.update(
      `${route}\0${createHash("sha256").update(bytes).digest("hex")}\n`,
    );
  }
  const version = digest.digest("hex").slice(0, 16);
  const plan = planStaticSite(routes, {
    version,
    hostOrigins,
    documentHeaders: admitted.upstream.requiredDocumentHeaders,
    readyz: {
      status: "ok",
      protocolVersion: 1,
      buildCommit: admitted.upstream.source.buildCommit,
      candidateCommit: admitted.upstream.source.candidateCommit,
      ...admitted.upstream.sourceCandidate,
      runtimeVersion: version,
      receiptSha256: admitted.receiptSha256,
    },
  });
  for (const { file, source } of plan.files) {
    const destination = path.join(outDirectory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await sourceBytes(source));
  }
  if (site) plan.firebase.hosting.site = site;
  await writeFile(
    path.join(outDirectory, "firebase.json"),
    `${JSON.stringify(plan.firebase, null, 2)}\n`,
  );
  return {
    files: plan.files.length,
    runtimeVersion: version,
    receiptSha256: admitted.receiptSha256,
  };
}

function flagValues(name) {
  const values = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1])
      values.push(process.argv[index + 1]);
  });
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runtimeDirectory] = flagValues("--runtime");
  const [outDirectory] = flagValues("--out");
  const [site] = flagValues("--site");
  if (!runtimeDirectory || !outDirectory)
    throw new Error("--runtime and --out are required.");
  const result = await exportStatic({
    runtimeDirectory,
    outDirectory: path.resolve(outDirectory),
    hostOrigins: flagValues("--host-origin"),
    site,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
