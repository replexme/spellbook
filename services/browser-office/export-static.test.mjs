import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { existsSync } from "node:fs";
import { licensePage, planStaticSite } from "./export-static.mjs";
import { buildRoutes } from "./server.mjs";

const upstream = JSON.parse(
  readFileSync(new URL("./upstream.json", import.meta.url), "utf8"),
);
const version = "0123456789abcdef";

function plan() {
  const routes = buildRoutes(undefined, upstream, {
    runtimeIdentity: { buildReady: true },
  });
  return planStaticSite(routes, {
    version,
    hostOrigins: ["https://spellbook.replex.me"],
    documentHeaders: upstream.requiredDocumentHeaders,
    readyz: { status: "ok" },
    licenses: "<p>notice</p>",
  });
}

function headersFor(site, requestPath) {
  const rule = site.firebase.hosting.headers.find(
    ({ source }) => source === requestPath,
  );
  assert.ok(rule, `${requestPath} has headers`);
  return Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]));
}

test("the editor frame isolates itself and only the product may embed it", () => {
  const site = plan();
  const headers = headersFor(site, "/workspace");
  assert.equal(
    headers["Document-Isolation-Policy"],
    "isolate-and-require-corp",
  );
  assert.equal(headers["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(
    headers["Content-Security-Policy"],
    "frame-ancestors 'self' https://spellbook.replex.me",
  );
  assert.deepEqual(
    site.firebase.hosting.rewrites.find(
      ({ source }) => source === "/workspace",
    ),
    { source: "/workspace", destination: "/workspace.html" },
  );
  // The conformance shell and its fixtures are not published.
  const written = site.files.map(({ file }) => file);
  assert.ok(!written.includes("index.html"));
  assert.ok(!written.some((file) => file.startsWith("fixtures/")));
});

test("engine files are stored uncompressed under a content-named folder", () => {
  const site = plan();
  const wasm = site.files.find(
    ({ file }) => file === `runtime/${version}/soffice.wasm`,
  );
  assert.ok(wasm);
  assert.match(wasm.source.file, /\/soffice\.wasm$/u);
  const headers = headersFor(site, `/runtime/${version}/soffice.wasm`);
  assert.equal(headers["Content-Encoding"], undefined);
  assert.equal(headers["Content-Type"], "application/wasm");
  assert.equal(headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "cross-origin");
  assert.equal(
    headersFor(site, `/runtime/${version}/zeta.js`)["Cache-Control"],
    "public, max-age=31536000, immutable",
  );
});

test("the pointer script names the runtime folder and is never cached", () => {
  const site = plan();
  const pointer = site.files.find(
    ({ file }) => file === "runtime/browser-candidate.js",
  );
  assert.match(
    pointer.source.body,
    /spellbookBrowserRuntimeBase = "\/runtime\/0123456789abcdef\/";\n$/u,
  );
  assert.equal(
    headersFor(site, "/runtime/browser-candidate.js")["Cache-Control"],
    "no-store",
  );
});

test("everything the workspace document references is published", () => {
  const site = plan();
  const written = new Set(site.files.map(({ file }) => `/${file}`));
  const document = readFileSync(
    new URL("./harness/index.html", import.meta.url),
    "utf8",
  );
  for (const [, reference] of document.matchAll(/(?:src|href)="(\/[^"]+)"/gu))
    assert.ok(written.has(reference), `${reference} is published`);
  for (const { destination } of site.firebase.hosting.rewrites)
    assert.ok(written.has(destination), `${destination} is published`);
});

test("refuses a host origin that is not an https origin", () => {
  const routes = buildRoutes(undefined, upstream, {
    runtimeIdentity: { buildReady: true },
  });
  assert.throws(() =>
    planStaticSite(routes, {
      version,
      hostOrigins: ["http://spellbook.replex.me"],
      documentHeaders: {},
      readyz: {},
    }),
  );
});

test("the license notice names the exact source of every shipped component", () => {
  const fonts = JSON.parse(
    readFileSync(new URL("./fonts.json", import.meta.url), "utf8"),
  );
  const page = licensePage({
    upstream,
    fonts,
    publicCommit: "a".repeat(40),
    receiptSha256: "b".repeat(64),
    contact: "hello@replex.me",
  });
  const { qt, emscripten } = upstream.toolchain;
  assert.ok(page.includes(qt.commit));
  assert.ok(page.includes(qt.qtbaseCommit));
  assert.ok(page.includes(emscripten.commit));
  assert.ok(page.includes(upstream.source.candidateCommit));
  assert.ok(page.includes(`tree/${"a".repeat(40)}/services/browser-office`));
  assert.ok(page.includes("mailto:hello@replex.me"));
  assert.ok(page.includes(fonts.source.commit));
  const site = plan();
  const headers = headersFor(site, "/licenses");
  assert.equal(headers["Document-Isolation-Policy"], undefined);
  for (const { file, source } of site.files.filter(({ file }) =>
    file.startsWith("licenses/"),
  ))
    assert.ok(existsSync(source.file), `${file} has its text`);
});

test("Korean fonts and font rules ship in the versioned runtime folder", () => {
  const site = plan();
  const written = new Set(site.files.map(({ file }) => file));
  for (const name of [
    "fonts.json",
    "fonts/NotoSansKR-Regular.otf",
    "fonts/NotoSansKR-Bold.otf",
    "fonts/57-spellbook-font-aliases.conf",
    "fonts/58-spellbook-korean-fallback.conf",
    "fonts/59-spellbook-browser-korean.conf",
  ])
    assert.ok(
      written.has(`runtime/${version}/${name}`),
      `${name} is published`,
    );
  const listing = JSON.parse(
    site.files.find(({ file }) => file === `runtime/${version}/fonts.json`)
      .source.body,
  );
  assert.deepEqual(
    listing.map(({ directory }) => directory),
    [
      "/instdir/share/fonts/spellbook",
      "/instdir/share/fonts/spellbook",
      "/instdir/share/fontconfig/conf.d",
      "/instdir/share/fontconfig/conf.d",
      "/instdir/share/fontconfig/conf.d",
    ],
  );
});
