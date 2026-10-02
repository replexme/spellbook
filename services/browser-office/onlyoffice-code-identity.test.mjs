/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOnlyOfficeCodeIdentity } from "./onlyoffice/code-identity.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "candidate-code-identity-"));
  const write = async (name, value = name) => {
    const p = path.join(root, "dist", name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, value);
  };
  try {
    for (const engine of ["slide", "cell"])
      for (const half of ["sdk-all.js", "sdk-all-min.js"])
        await write(`sdkjs/${engine}/${half}`);
    await write("npm/public-api.js");
    await write("wasm/x2t/x2t.wasm");
    await run(root, write);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ignored native-history SDK half, converter and host changes invalidate the code identity", async () => {
  await fixture(async (root, write) => {
    const original = await readOnlyOfficeCodeIdentity(root);
    assert.equal(original.files.length, 6);
    await write("sdkjs/slide/sdk-all-min.js", "changed-native-history");
    const updated = await readOnlyOfficeCodeIdentity(root);
    assert.notEqual(updated.sha256, original.sha256);
    await write("npm/host-new.js", "new-host");
    assert.notEqual(
      (await readOnlyOfficeCodeIdentity(root)).sha256,
      updated.sha256,
    );
  });
});

test("font and non-code assets stay explicitly outside this code proof", async () => {
  await fixture(async (root, write) => {
    const before = await readOnlyOfficeCodeIdentity(root);
    await write("fonts/font.ttf", "changed-font");
    assert.deepEqual(await readOnlyOfficeCodeIdentity(root), before);
    assert.match(before.scope, /excludes fonts/);
  });
});

test("missing SDK halves or symlinked generated code cannot produce a complete identity", async () => {
  await fixture(async (root, write) => {
    const missing = path.join(root, "dist/sdkjs/cell/sdk-all-min.js");
    await rm(missing);
    await assert.rejects(readOnlyOfficeCodeIdentity(root), /SDK is incomplete/);
    await write("sdkjs/cell/sdk-all-min.js");
    await symlink(
      path.join(root, "dist/npm/public-api.js"),
      path.join(root, "dist/npm/aliased.js"),
    );
    await assert.rejects(readOnlyOfficeCodeIdentity(root), /regular file/);
  });
});
