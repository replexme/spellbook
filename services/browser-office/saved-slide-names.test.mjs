import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";
import { inspectOoxmlDocumentWithAssets } from "./ooxml-worker-source.mjs";
const thread = await fs.readFile(
  new URL("./harness/office-thread.js", import.meta.url),
  "utf8",
);
const restore = thread.slice(
  thread.indexOf("function restoreSavedSlideNames("),
  thread.indexOf("function openDocument("),
);
test("saved slide names come from ordered authored slide parts, preserving unnamed slides", async () => {
  const bytes = await fs.readFile(
    new URL(
      "../../eval/public/fixtures/general-native-surface.pptx",
      import.meta.url,
    ),
  );
  const entries = unzipSync(bytes);
  const original = await inspectOoxmlDocumentWithAssets(bytes);
  entries[original.slidePaths[0]] = strToU8(
    strFromU8(entries[original.slidePaths[0]]).replace(
      /<p:cSld(?:\s[^>]*)?>/u,
      '<p:cSld name="Stored &amp; Korean 이름">',
    ),
  );
  const actual = await inspectOoxmlDocumentWithAssets(zipSync(entries));
  assert.equal(actual.slideNames[0], "Stored & Korean 이름");
  assert.equal(actual.slideNames.length, actual.slidePaths.length);
  assert.deepEqual(actual.slideNames.slice(1), original.slideNames.slice(1));
});
test("native open restores stored names instead of a title-derived name and leaves unnamed pages alone", () => {
  const values = ["Changed title", "Automatic title"];
  let writes = 0;
  const document = {
    getDrawPages: () => ({
      getCount: () => 2,
      getByIndex: (index) => ({
        getName: () => values[index],
        setName: (value) => {
          values[index] = value;
          writes++;
        },
      }),
    }),
  };
  const context = vm.createContext({ document, names: ["Saved name", null] });
  vm.runInContext(restore + "restoreSavedSlideNames(document,names)", context);
  assert.deepEqual(values, ["Saved name", "Automatic title"]);
  assert.equal(writes, 1);
  vm.runInContext("restoreSavedSlideNames(document,names)", context);
  assert.equal(writes, 1);
  assert.throws(
    () =>
      vm.runInContext('restoreSavedSlideNames(document,["only one"])', context),
    /invalid_saved_slide_names/,
  );
});
test("a native name setter that does not preserve the saved value is refused", () => {
  const document = {
    getDrawPages: () => ({
      getCount: () => 1,
      getByIndex: () => ({ getName: () => "Derived title", setName: () => {} }),
    }),
  };
  const context = vm.createContext({ document });
  assert.throws(
    () =>
      vm.runInContext(
        restore + 'restoreSavedSlideNames(document,["Saved name"])',
        context,
      ),
    /saved_slide_name_not_restored/,
  );
});

test("native save ownership carries the observed top-level shape index when an export renames a placeholder", async () => {
  const source = await fs.readFile(
    new URL("./harness/app.js", import.meta.url),
    "utf8",
  );
  const program = source.slice(
    source.indexOf("function nativeSnapshotTargets("),
    source.indexOf("function preserveNativeSnapshot("),
  );
  const context = vm.createContext({
    before: {
      slides: [{ elements: [{ elementId: "0/4", name: "object 6" }] }],
    },
    commands: [{ op: "replace_text", elementId: "0/4", text: "Changed title" }],
  });
  const targets = vm.runInContext(
    program + "nativeSnapshotTargets(before,commands)",
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), [
    {
      op: "replace_text",
      elementId: "0/4",
      text: "Changed title",
      slideIndex: 0,
      shapeIndex: 4,
      name: "object 6",
    },
  ]);
});
