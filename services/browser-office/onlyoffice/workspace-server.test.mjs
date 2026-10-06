/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOnlyOfficeWorkspaceServer } from "./workspace-server.mjs";
const origins = {
  workspaceOrigin: "http://127.0.0.1:35602",
  sdkOrigin: "http://127.0.0.1:35616",
  inspectionOrigin: "http://127.0.0.1:35617",
  hostOrigins: ["https://spellbook.my"],
};
test("candidate requires three distinct exact origins and a parent allowlist", () => {
  const options = { distributionDirectory: ".", ...origins };
  for (const change of [
    { sdkOrigin: origins.workspaceOrigin },
    { inspectionOrigin: origins.sdkOrigin },
    { hostOrigins: [] },
    { workspaceOrigin: "https://spellbook.my/path" },
    { sdkOrigin: "http://public.example" },
  ])
    assert.throws(() =>
      createOnlyOfficeWorkspaceServer({ ...options, ...change }),
    );
});
test("candidate serves local files, exact parent policy, source disclosure and rejects encoded traversal", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-host-routes-"),
  );
  await writeFile(
    path.join(directory, "workspace.bundle.js"),
    "export const proof=true;",
  );
  const server = createOnlyOfficeWorkspaceServer({
    distributionDirectory: directory,
    bundleDirectory: directory,
    ...origins,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + "/readyz")).status, 503);
    const workspace = await fetch(base + "/workspace");
    assert.equal(workspace.status, 200);
    assert.equal(
      workspace.headers.get("content-security-policy"),
      "frame-ancestors 'self' https://spellbook.my http://127.0.0.1:35602",
    );
    const html = await workspace.text();
    assert.deepEqual(
      JSON.parse(html.match(/application\/json">(.*?)<\/script>/s)[1])
        .hostOrigins,
      [...origins.hostOrigins, origins.workspaceOrigin],
    );
    assert.match(
      await (await fetch(base + "/local")).text(),
      /local-workspace.mjs/,
    );
    assert.match(
      await (await fetch(base + "/licenses")).text(),
      /not admitted for public distribution/,
    );
    assert.equal(
      await (await fetch(base + "/workspace.bundle.js")).text(),
      "export const proof=true;",
    );
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    const denied = await fetch(base + "/%2e%2e%2fpackage.json");
    assert.equal(denied.status, 500);
    assert.equal(await denied.text(), "");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
