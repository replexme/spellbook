import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { createProbe } from "./host.mjs";

test("local session isolates original, rejects unauthorized writes, and versions saved candidates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spellbook-office-host-"));
  const source = path.join(root, "source.pptx");
  await writeFile(source, Buffer.from("PK\u0003\u0004spellbook-test-package"));
  const original = await readFile(source);
  const output = path.join(root, "run");
  const { server, token, receipt } = await createProbe({
    source,
    output,
    port: 0,
    fileId: "isolated-candidate",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/wopi/files/isolated-candidate`;
  assert.equal((await fetch(base)).status, 401);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(
      base,
      { headers: { host: "attacker.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  const headers = { authorization: `Bearer ${token}` };
  const info = await (await fetch(base, { headers })).json();
  assert.equal(info.Size, original.length);
  assert.equal(info.SupportsLocks, false);
  assert.equal(info.Version, "0");
  assert.equal(info.UserCanWrite, true);
  assert.equal(info.DisableCopy, false);
  assert.equal(info.DisableExport, false);
  assert.equal(info.DisablePrint, false);
  assert.equal(
    (
      await fetch(`${base}/contents`, {
        method: "POST",
        headers: { "x-wopi-override": "PUT" },
        body: original,
      })
    ).status,
    401,
  );
  const invalid = await fetch(`${base}/contents`, {
    method: "POST",
    headers: { ...headers, "x-wopi-override": "PUT" },
    body: "invalid",
  });
  assert.equal(invalid.status, 400);
  assert.equal(receipt().version, 0);
  const saved = await fetch(`${base}/contents`, {
    method: "POST",
    headers: { ...headers, "x-wopi-override": "PUT" },
    body: original,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("x-wopi-itemversion"), "1");
  assert.deepEqual(await readFile(path.join(output, "saved-1.pptx")), original);
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(
    await readFile(path.join(output, "original.pptx")),
    original,
  );
  assert.equal(receipt().events.filter((e) => e.type === "put-file").length, 1);
  assert.equal(
    (
      await fetch(`${base}/contents`, {
        method: "POST",
        headers,
        body: original,
      })
    ).status,
    404,
  );
  const got = Buffer.from(
    await (await fetch(`${base}/contents`, { headers })).arrayBuffer(),
  );
  assert.deepEqual(got, original);
});

test("probe rejects nonlocal editor destinations before reading source", async () => {
  await assert.rejects(
    createProbe({
      source: "not-read",
      output: "not-created",
      editorOrigin: "https://example.com",
    }),
    /local HTTP editor/,
  );
});

test("probe rejects ambiguous WOPI file identities before reading source", async () => {
  await assert.rejects(
    createProbe({
      source: "not-read",
      output: "not-created",
      fileId: "../shared-session",
    }),
    /fileId/,
  );
});

test("native command probe is enabled explicitly per conformance session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spellbook-native-probe-"));
  const source = path.join(root, "source.pptx");
  await writeFile(source, Buffer.from("PK\u0003\u0004spellbook-test-package"));
  const { server, token } = await createProbe({
    source,
    output: path.join(root, "run"),
    port: 0,
    native: true,
    nativeProbe: true,
    fileId: "native-command-probe",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const image = await fetch(
    `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000001`,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(
    [...Buffer.from(await image.arrayBuffer()).subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const media = await fetch(
    `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000002`,
  );
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "audio/wav");
  const mediaBytes = Buffer.from(await media.arrayBuffer());
  assert.equal(mediaBytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(mediaBytes.subarray(8, 12).toString("ascii"), "WAVE");
  const replacementImage = await fetch(
    `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000003`,
  );
  assert.equal(replacementImage.status, 200);
  assert.equal(replacementImage.headers.get("content-type"), "image/png");
  const replacementMedia = await fetch(
    `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000004`,
  );
  assert.equal(replacementMedia.status, 200);
  assert.equal(replacementMedia.headers.get("content-type"), "audio/wav");
  const sameSizeImage = await fetch(
    `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000005`,
  );
  assert.equal(sameSizeImage.status, 200);
  assert.equal(sameSizeImage.headers.get("content-type"), "image/png");
  const sameSizeBytes = Buffer.from(await sameSizeImage.arrayBuffer());
  assert.equal(sameSizeBytes.readUInt32BE(16), 2);
  assert.equal(sameSizeBytes.readUInt32BE(20), 1);
  assert.equal(
    (
      await fetch(
        `${origin}/api/documents/probe/assets/00000000-0000-4000-8000-000000000006`,
      )
    ).status,
    404,
  );
  const pendingProbe = fetch(`${origin}/native/probe`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operation: "observe" }),
  });
  let task;
  for (let attempt = 0; attempt < 20 && !task; attempt += 1) {
    const poll = await (
      await fetch(`${origin}/native/poll?after=0`, { headers })
    ).json();
    task = poll.task;
    if (!task) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task?.request.operation, "observe");
  assert.equal(
    (
      await fetch(`${origin}/native/result`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: task.id, value: { revision: "r1" } }),
      })
    ).status,
    200,
  );
  assert.deepEqual(await (await pendingProbe).json(), { revision: "r1" });
});

test("native probe mode cannot be enabled on a non-native session", async () => {
  await assert.rejects(
    createProbe({
      source: "not-read",
      output: "not-created",
      nativeProbe: true,
    }),
    /requires a native session/,
  );
});
