import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./extension/operations.js", import.meta.url),
  "utf8",
);
const helpers = source.slice(
  source.indexOf("  function sha256Bytes("),
  source.indexOf("  const pictureDetails ="),
);
const load = (model = {}, uno = {}, request = {}) =>
  new Function(
    "model",
    "uno",
    "request",
    `${helpers}\nreturn { sha256Bytes, sourceContentDigest };`,
  )(model, uno, request);

test("picture cache uses current compressed bytes and still detects same-size replacements", () => {
  let pixelReads = 0;
  let closes = 0;
  let content = [1, 2, 3];
  const cache = new Map();
  const bitmap = {
    getSize: () => ({ Width: 2, Height: 1 }),
    Size100thMM: { Width: 100, Height: 50 },
    getDIB: () => { pixelReads++; return content; },
    getMaskDIB: () => [0],
  };
  const shape = {
    getShapeType: () => "GraphicObjectShape", Bitmap: bitmap,
    Graphic: { Linked: false }, GraphicCrop: {},
    get GraphicStream() {
      let read = false;
      return {
        readBytes(out) { out.val = read ? [] : content; read = true; return out.val.length; },
        closeInput() { closes++; },
      };
    },
  };
  const pictureSource = source.slice(source.indexOf("  const pictureDetails ="), source.indexOf("  const chartSeriesState ="));
  const observe = new Function("request", "model", "uno", "safeProperty", "safeCall", "enumName", "cropFractions",
    `${helpers}\n${pictureSource}\nreturn pictureDetails;`)(
      { nativeAdapter: { pictureContentDigests: cache } }, {}, {},
      (object, key) => object?.[key], (object, key) => object?.[key]?.(), value => value, () => ({}));
  const first = observe(shape).pixelContentSha256;
  assert.equal(observe(shape).pixelContentSha256, first);
  assert.equal(pixelReads, 1);
  content = [3, 2, 1];
  assert.notEqual(observe(shape).pixelContentSha256, first);
  assert.equal(pixelReads, 2);
  assert.equal(closes, 3);
  shape.Graphic.Linked = true;
  observe(shape);
  assert.equal(closes, 3, "linked assets are never opened to populate the cache");
  assert.equal(pixelReads, 3, "unavailable cache evidence falls back to pixel inspection");
});

test("engine asset SHA-256 matches standard vectors across block boundaries", () => {
  const { sha256Bytes } = load();
  for (const value of [
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1_000_000),
  ]) {
    const bytes = Buffer.from(value);
    assert.equal(
      sha256Bytes(bytes),
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});

test("embedded media reads a clone and releases streams and child storage", () => {
  const releases = [];
  let reads = 0;
  const input = {
    readBytes(out) {
      out.val = reads++ ? [] : [-1, 0, 1];
      return out.val.length;
    },
    closeInput() {
      releases.push("input");
    },
  };
  const child = {
    cloneStreamElement(name) {
      assert.equal(name, "audio.wav");
      return {
        getInputStream: () => input,
        dispose: () => releases.push("stream"),
      };
    },
    dispose() {
      releases.push("storage");
    },
  };
  const root = {
    openStorageElement: () => child,
    dispose() {
      throw new Error("Must not dispose document-owned storage");
    },
  };
  const { sourceContentDigest } = load({ getDocumentStorage: () => root });
  assert.equal(
    sourceContentDigest("vnd.sun.star.Package:Media/audio.wav"),
    createHash("sha256")
      .update(new Uint8Array([255, 0, 1]))
      .digest("hex"),
  );
  assert.deepEqual(releases, ["input", "stream", "storage"]);
});

test("saved package content is authoritative when UNO storage lacks its original path", () => {
  const expected = createHash("sha256").update("audio").digest("hex");
  const { sourceContentDigest } = load(
    {
      getDocumentStorage() {
        throw new Error("Unavailable package storage");
      },
    },
    {},
    { packageAssetHashes: { "ppt/media/audio.wav": expected } },
  );
  assert.equal(
    sourceContentDigest("vnd.sun.star.Package:ppt/media/audio.wav"),
    expected,
  );
  assert.equal(
    sourceContentDigest("vnd.sun.star.Package:ppt/media/../audio.wav"),
    null,
  );
  assert.equal(sourceContentDigest("https://example.test/audio.wav"), null);
});

test("failed asset reads release storage instead of locking subsequent insertions", () => {
  let disposed = false;
  const child = {
    cloneStreamElement() {
      throw new Error("Unreadable stream");
    },
    dispose() {
      disposed = true;
    },
  };
  const { sourceContentDigest } = load({
    getDocumentStorage: () => ({ openStorageElement: () => child }),
  });
  assert.equal(
    sourceContentDigest("vnd.sun.star.Package:Media/audio.wav"),
    null,
  );
  assert.equal(disposed, true);
});
