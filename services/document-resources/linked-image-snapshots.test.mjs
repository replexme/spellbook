/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import * as objectStore from "./object-store.mjs";
import { prepareOwnedLinkedImages as prepareOriginal } from "./prepare-linked-images.mjs";
import { readOwnedLinkedImages as readOriginal } from "./linked-image-snapshots.mjs";
import { fetchLinkedPublicImage } from "./public-image-reader.mjs";
import { preparePptxLinkedRenderInput } from "../browser-office/ooxml-worker-source.mjs";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "spellbook-owned-image-test-"),
);
process.env.SPELLBOOK_DATA_DIR = root;
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage();
test.after(async () => {
  await browser.close();
  await fs.rm(root, { recursive: true, force: true });
});
const validatorSource = await fs.readFile(
  import.meta.dirname + "/../browser-office/external-raster.mjs",
  "utf8",
);
const validateImage = (bytes) =>
  page.evaluate(
    async ({ source, bytes }) => {
      const uri = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      try {
        return await (
          await import(uri)
        ).validateExternalRaster(new Uint8Array(bytes));
      } finally {
        URL.revokeObjectURL(uri);
      }
    },
    { source: validatorSource, bytes: [...bytes] },
  );
const prepareOwnedLinkedImages = (value) =>
  prepareOriginal({ ...value, objectStore });
const readOwnedLinkedImages = (value) =>
  readOriginal({ ...value, objectStore });
const sourceBytes = new Uint8Array(
  await fs.readFile(
    new URL(
      "../../eval/public/downloads/ox-linked-picture.pptx",
      import.meta.url,
    ),
  ),
);
const gif = new Uint8Array(
  Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = () => ({
  accountId: "resource-owner.test",
  documentId: randomUUID(),
});
const prepare = (value) =>
  prepareOwnedLinkedImages({
    sourceBytes,
    fetchImage: async () => gif,
    validateImage,
    ...value,
  });

test("actual object store admits one immutable source-bound image and decodes it", async () => {
  const scope = owner(),
    before = sourceBytes.slice(),
    result = await prepare(scope);
  assert.equal(result.fetched, 1);
  assert.equal(result.manifest.sourceSha256, sha(sourceBytes));
  assert.deepEqual(sourceBytes, before);
  const read = await readOwnedLinkedImages({
    ...scope,
    sourceSha256: sha(sourceBytes),
    sourceBytes,
  });
  assert.equal(read.assets.length, 1);
  assert.equal(read.assets[0].sha256, sha(gif));
  assert.deepEqual([...read.assets[0].bytes], [...gif]);
  const projected = await preparePptxLinkedRenderInput(sourceBytes, {
    validateImage,
    resolveImage: async (request) =>
      read.assets.find(
        (asset) =>
          asset.ownerPart === request.ownerPart &&
          asset.relationshipId === request.relationshipId &&
          asset.url === request.url,
      ),
  });
  assert.equal(projected.images[0].sha256, sha(gif));
  assert.deepEqual(sourceBytes, before);
});
test("published source reopens when the remote URL is unavailable and never fetches", async () => {
  const scope = owner();
  await prepare(scope);
  const result = await prepare({
    ...scope,
    fetchImage: () => {
      throw Error("remote is unavailable");
    },
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.reused, 1);
});
test("edited child reuses unchanged authored relationship bytes while binding the new source", async () => {
  const scope = owner();
  await prepare(scope);
  const entries = unzipSync(sourceBytes);
  entries["docProps/core.xml"] = strToU8(
    strFromU8(entries["docProps/core.xml"]).replace(
      "</cp:coreProperties>",
      "<cp:keywords>edited child</cp:keywords></cp:coreProperties>",
    ),
  );
  const child = zipSync(entries, { level: 6 });
  assert.notEqual(sha(child), sha(sourceBytes));
  const result = await prepare({
    ...scope,
    sourceBytes: child,
    parentSourceSha256: sha(sourceBytes),
    fetchImage: () => {
      throw Error("unchanged link was refetched");
    },
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.manifest.sourceSha256, sha(child));
});
test("changed authored URL is not rebound to the parent picture", async () => {
  const scope = owner();
  await prepare(scope);
  const entries = unzipSync(sourceBytes),
    part = "ppt/slides/_rels/slide1.xml.rels";
  entries[part] = strToU8(
    strFromU8(entries[part]).replace(
      "http://www.google.com/intl/en/images/logo.gif",
      "https://images.example.test/new.png",
    ),
  );
  const child = zipSync(entries, { level: 6 });
  let requested;
  await prepare({
    ...scope,
    sourceBytes: child,
    parentSourceSha256: sha(sourceBytes),
    fetchImage: (url) => {
      requested = url;
      return gif;
    },
  });
  assert.equal(requested, "https://images.example.test/new.png");
});
test("other account or document has no access to the committed private snapshot", async () => {
  const scope = owner();
  await prepare(scope);
  await assert.rejects(
    readOwnedLinkedImages({
      ...scope,
      accountId: "another-owner.test",
      sourceSha256: sha(sourceBytes),
      sourceBytes,
    }),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    readOwnedLinkedImages({
      ...scope,
      documentId: randomUUID(),
      sourceSha256: sha(sourceBytes),
      sourceBytes,
    }),
    (error) => error.code === "ENOENT",
  );
});
test("wrong source cannot read an image even with a known source address", async () => {
  const scope = owner();
  await prepare(scope);
  await assert.rejects(
    readOwnedLinkedImages({
      ...scope,
      sourceSha256: "a".repeat(64),
      sourceBytes,
    }),
    /source_binding_mismatch/,
  );
});
test("corrupted stored image rejects reopen instead of silently refetching", async () => {
  const scope = owner();
  await prepare(scope);
  const blob = path.join(
    root,
    "accounts",
    Buffer.from(scope.accountId).toString("base64url"),
    "documents",
    scope.documentId,
    "render-resources",
    "blobs",
    sha(gif),
  );
  await fs.writeFile(blob, Buffer.from("corrupt"));
  await assert.rejects(
    prepare({
      ...scope,
      fetchImage: () => {
        throw Error("must not refetch");
      },
    }),
    /payload_hash_mismatch/,
  );
});
test("failed image decode never commits a usable source manifest", async () => {
  const scope = owner();
  await assert.rejects(
    prepare({
      ...scope,
      validateImage: () => {
        throw Error("external_image_decode_failed");
      },
    }),
    /decode_failed/,
  );
  await assert.rejects(
    readOwnedLinkedImages({
      ...scope,
      sourceSha256: sha(sourceBytes),
      sourceBytes,
    }),
    (error) => error.code === "ENOENT",
  );
});
test("source is copied before an asynchronous fetch can mutate caller bytes", async () => {
  const scope = owner(),
    input = sourceBytes.slice(),
    expected = sha(input);
  const result = await prepare({
    ...scope,
    sourceBytes: input,
    fetchImage: async () => {
      input.fill(0);
      return gif;
    },
  });
  assert.equal(result.manifest.sourceSha256, expected);
});
test("a noncooperative fetch is cancelled without committing a snapshot", async () => {
  const scope = owner(),
    controller = new AbortController();
  setTimeout(() => controller.abort(Error("closed by owner")), 25);
  await assert.rejects(
    prepare({
      ...scope,
      signal: controller.signal,
      fetchImage: () => new Promise(() => {}),
    }),
    /closed by owner/,
  );
  await assert.rejects(
    readOwnedLinkedImages({
      ...scope,
      sourceSha256: sha(sourceBytes),
      sourceBytes,
    }),
    (error) => error.code === "ENOENT",
  );
});
test("simultaneous producers read back the same first committed snapshot", async () => {
  const scope = owner();
  const png = Uint8Array.from(
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 30;
      c.height = 20;
      c.getContext("2d").fillRect(0, 0, 30, 20);
      return [
        ...new Uint8Array(
          await (await new Promise((r) => c.toBlob(r))).arrayBuffer(),
        ),
      ];
    }),
  );
  const [a, b] = await Promise.all([
    prepare(scope),
    prepare({ ...scope, fetchImage: async () => png }),
  ]);
  assert.equal(a.manifest.images[0].sha256, b.manifest.images[0].sha256);
  const read = await readOwnedLinkedImages({
    ...scope,
    sourceSha256: sha(sourceBytes),
    sourceBytes,
  });
  assert.equal(read.assets[0].sha256, a.manifest.images[0].sha256);
});
test("source URL reader refuses local destinations, credentials, other protocols and nonstandard ports", async () => {
  for (const url of [
    "http://127.0.0.1/a.gif",
    "https://[::1]/a.gif",
    "http://user:password@example.com/a.gif",
    "file:///etc/passwd",
    "https://example.com:8443/a.gif",
  ])
    await assert.rejects(
      fetchLinkedPublicImage(url),
      /external_image_(uri_not_public_http|destination_not_public)/,
    );
});

test("ordinary source with no consumed external image performs no storage or network operations", async () => {
  const entries = unzipSync(sourceBytes),
    part = "ppt/slides/slide1.xml";
  entries[part] = strToU8(
    strFromU8(entries[part]).replace(/r:link="[^"]+"/g, ""),
  );
  const noImage = zipSync(entries, { level: 6 });
  const forbidden = () => {
    throw Error("no-image source touched a resource provider");
  };
  const result = await prepareOriginal({
    ...owner(),
    sourceBytes: noImage,
    validateImage: forbidden,
    fetchImage: forbidden,
    objectStore: {
      accountPrefix: forbidden,
      getObject: forbidden,
      objectHead: forbidden,
      putObjectIfAbsent: forbidden,
    },
  });
  assert.equal(result.manifest.images.length, 0);
});
test("a child snapshot reuses validated parent blobs without decoding or uploading image bodies", async () => {
  const scope = owner();
  await prepare(scope);
  const entries = unzipSync(sourceBytes);
  entries["docProps/core.xml"] = strToU8(
    strFromU8(entries["docProps/core.xml"]).replace(
      "</cp:coreProperties>",
      "<cp:keywords>no redundant payload upload</cp:keywords></cp:coreProperties>",
    ),
  );
  const child = zipSync(entries, { level: 6 }),
    writes = [];
  const countedStore = {
    ...objectStore,
    putObjectIfAbsent: (name, data, type) => {
      writes.push({ name, size: data.length });
      return objectStore.putObjectIfAbsent(name, data, type);
    },
  };
  const result = await prepareOriginal({
    ...scope,
    sourceBytes: child,
    parentSourceSha256: sha(sourceBytes),
    fetchImage: () => {
      throw Error("refetched parent");
    },
    validateImage: () => {
      throw Error("decoded parent again");
    },
    objectStore: countedStore,
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.reused, 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].name.endsWith("/sources/" + sha(child) + ".json"));
});
