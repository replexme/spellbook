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

const LICENSE_TEXTS = Object.freeze([
  ["GPL-3.0.txt", "licenses/GPL-3.0.txt"],
  ["LGPL-3.0.txt", "licenses/LGPL-3.0.txt"],
  ["MPL-2.0.txt", "../../LICENSES/MPL-2.0.txt"],
  ["emscripten-LICENSE.txt", "licenses/emscripten-LICENSE.txt"],
  ["zetajs-LICENSE.txt", "licenses/zetajs-LICENSE.txt"],
  ["NotoSansKR-OFL.txt", "licenses/NotoSansKR-OFL.txt"],
]);

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

/**
 * The notice for the engine sent to users' browsers: each component's
 * license and the exact source this build was made from. Qt for WebAssembly
 * is GPL-3.0/LGPL-3.0 licensed, so its corresponding source is named here.
 */
export function licensePage({
  upstream,
  fonts,
  publicCommit,
  receiptSha256,
  contact,
}) {
  const spellbook = `https://github.com/replexme/spellbook/tree/${publicCommit}`;
  const { emsdk, emscripten, qt } = upstream.toolchain;
  const zetajs = new URL(upstream.javascriptBridge.runtimeAsset.url);
  const zetajsCommit = zetajs.pathname.split("/")[3];
  const rows = [
    [
      "LibreOffice (with Spellbook patches)",
      "MPL-2.0; parts under other upstream licenses",
      `${upstream.source.repository} commit ${upstream.source.candidateCommit}`,
      `${spellbook}/services/browser-office/libreoffice/patches`,
    ],
    [
      "Qt 5.15 for WebAssembly",
      "LGPL-3.0 / GPL-3.0 (by module)",
      `${qt.repository} commit ${qt.commit} (qtbase ${qt.qtbaseCommit})`,
      qt.repository.replace(/\.git$/u, `/tree/${qt.commit}`),
    ],
    [
      "Emscripten runtime",
      "MIT / University of Illinois NCSA",
      `${emscripten.repository} commit ${emscripten.commit}; emsdk ${emsdk.version} commit ${emsdk.commit}`,
      emscripten.repository.replace(/\.git$/u, `/tree/${emscripten.commit}`),
    ],
    [
      "ZetaJS",
      "MIT",
      `https://github.com/allotropia/zetajs commit ${zetajsCommit}`,
      `https://github.com/allotropia/zetajs/tree/${zetajsCommit}`,
    ],
    [
      "Noto Sans KR (Korean font)",
      "OFL-1.1",
      `${fonts.source.repository} commit ${fonts.source.commit}`,
      `${fonts.source.repository}/tree/${fonts.source.commit}/Sans/SubsetOTF/KR`,
    ],
    [
      "Spellbook editor shell",
      "MPL-2.0",
      `https://github.com/replexme/spellbook commit ${publicCommit}`,
      `${spellbook}/services/browser-office`,
    ],
  ];
  const table = rows
    .map(
      ([name, license, source, link]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(license)}</td><td><a href="${escapeHtml(link)}">${escapeHtml(source)}</a></td></tr>`,
    )
    .join("\n");
  const texts = LICENSE_TEXTS.map(
    ([name]) => `<li><a href="/licenses/${name}">${name}</a></li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spellbook 편집기 오픈소스 고지</title>
<style>
body{font:15px/1.6 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px 16px;color:#1f2937;background:#fff}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f9fafb}code{overflow-wrap:anywhere}
</style>
</head>
<body>
<h1>Spellbook 편집기 오픈소스 고지</h1>
<p>Spellbook의 PPT 편집기는 여러분의 브라우저에서 실행되는 LibreOffice(WebAssembly)입니다. 아래는 이 편집기에 들어 있는 구성요소의 라이선스와, 지금 받은 빌드를 만든 정확한 소스 위치입니다.</p>
<table>
<thead><tr><th>구성요소</th><th>라이선스</th><th>이 빌드의 소스</th></tr></thead>
<tbody>
${table}
</tbody>
</table>
<h2>빌드 방법</h2>
<p>툴체인과 빌드 절차: <a href="${spellbook}/services/browser-office/libreoffice">${spellbook}/services/browser-office/libreoffice</a> (<code>Dockerfile.toolchain</code>, <code>build-candidate-runtime.sh</code>). 빌드 기록 SHA-256: <code>${escapeHtml(receiptSha256)}</code></p>
<h2>소스 제공</h2>
<p>위 링크에서 소스를 받을 수 없으면 <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>로 요청해 주세요. 이 빌드의 전체 대응 소스를 배포에 드는 실비 이상 받지 않고, 이 빌드를 마지막으로 제공한 날부터 최소 3년 동안 제공합니다.</p>
<h2>라이선스 전문</h2>
<ul>
${texts}
</ul>
</body>
</html>
`;
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
  { version, hostOrigins, documentHeaders, readyz, licenses },
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
  // The license notice is an ordinary page: no isolation, no embedding.
  add(
    "/licenses",
    "licenses.html",
    { body: licenses },
    {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  );
  for (const [name, file] of LICENSE_TEXTS)
    add(
      `/licenses/${name}`,
      `licenses/${name}`,
      { file: path.join(serviceRoot, file) },
      {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
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
    licenses: licensePage({
      upstream: admitted.upstream,
      fonts: JSON.parse(
        await readFile(path.join(serviceRoot, "runtime-files.json"), "utf8"),
      ),
      publicCommit: admitted.receipt.spellbookSourceRevision,
      receiptSha256: admitted.receiptSha256,
      contact: "hello@replex.me",
    }),
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
