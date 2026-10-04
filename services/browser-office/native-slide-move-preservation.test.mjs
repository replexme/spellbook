/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import {
  applyOoxmlCommand,
  preserveOriginalPptxParts,
} from "./ooxml-worker-source.mjs";
const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
test("a declared native move retains separate authored ownership even for indistinguishable native slides", async () => {
  const fixture = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/fixtures/general-native-surface.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(
    applyOoxmlCommand(fixture, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes,
  );
  for (const [part, value] of [
    ["ppt/slides/slide1.xml", "ko-KR"],
    ["ppt/slides/slide2.xml", "ar-SA"],
  ]) {
    const doc = new DOMParser().parseFromString(
      strFromU8(original[part]),
      "text/xml",
    );
    doc.getElementsByTagNameNS(a, "rPr")[0].setAttribute("altLang", value);
    original[part] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  const baseline = Object.fromEntries(
    Object.entries(original).map(([part, bytes]) => [
      part,
      part.startsWith("ppt/slides/") && part.endsWith(".xml")
        ? strToU8(strFromU8(bytes).replace(/ altLang="[^"]+"/g, ""))
        : bytes,
    ]),
  );
  const moved = applyOoxmlCommand(zipSync(baseline), {
    op: "move_slide",
    slideIndex: 0,
    insertIndex: 1,
  }).bytes;
  const saved = unzipSync(
    preserveOriginalPptxParts(
      zipSync(original),
      zipSync(baseline),
      moved,
      ["move_slide"],
      [{ op: "move_slide", slideIndex: 0, targetSlideIndex: 1 }],
    ).bytes,
  );
  const ids = (entries) =>
    [
      ...new DOMParser()
        .parseFromString(strFromU8(entries["ppt/presentation.xml"]), "text/xml")
        .getElementsByTagNameNS(p, "sldId"),
    ].map((node) => node.getAttribute("id"));
  assert.deepEqual(ids(saved), ids(original).reverse());
  for (const [part, bytes] of Object.entries(original))
    if (part !== "ppt/presentation.xml")
      assert.deepEqual(saved[part], bytes, part);
  const changed = unzipSync(moved);
  const doc = new DOMParser().parseFromString(
    strFromU8(changed["ppt/slides/slide1.xml"]),
    "text/xml",
  );
  doc.getElementsByTagNameNS(a, "t")[0].textContent =
    "unrequested retained content change";
  changed["ppt/slides/slide1.xml"] = strToU8(
    new XMLSerializer().serializeToString(doc),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(baseline),
        zipSync(changed),
        ["move_slide"],
        [{ op: "move_slide", slideIndex: 0, targetSlideIndex: 1 }],
      ),
    /changed retained content/,
  );
});

test("native slide deletion removes only its declared authored ownership", async () => {
  const fixture = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/fixtures/general-native-surface.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = applyOoxmlCommand(fixture, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  }).bytes;
  const edited = applyOoxmlCommand(original, {
    op: "delete_slide",
    slideIndex: 0,
  }).bytes;
  const result = preserveOriginalPptxParts(
    original,
    original,
    edited,
    ["delete_slide"],
    [{ op: "delete_slide", slideIndex: 0 }],
  );
  const wanted = unzipSync(edited),
    actual = unzipSync(result.bytes);
  assert.deepEqual(actual, wanted);
  assert.equal(result.report.topology.kind, "delete");
  assert.throws(
    () =>
      preserveOriginalPptxParts(
        original,
        original,
        edited,
        ["delete_slide"],
        [{ op: "delete_slide", slideIndex: 9 }],
      ),
    /coordinates/,
  );
});

test("native slide duplication clones authored details missing from the native baseline", async () => {
  const fixture = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/fixtures/general-native-surface.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(fixture);
  const doc = new DOMParser().parseFromString(
    strFromU8(original["ppt/slides/slide1.xml"]),
    "text/xml",
  );
  doc.getElementsByTagNameNS(a, "rPr")[0].setAttribute("altLang", "ko-KR");
  original["ppt/slides/slide1.xml"] = strToU8(
    new XMLSerializer().serializeToString(doc),
  );
  const baseline = {
    ...original,
    "ppt/slides/slide1.xml": strToU8(
      strFromU8(original["ppt/slides/slide1.xml"]).replace(
        / altLang="[^"]+"/g,
        "",
      ),
    ),
  };
  const edited = applyOoxmlCommand(zipSync(baseline), {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  }).bytes;
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(baseline),
    edited,
    ["duplicate_slide"],
    [{ op: "duplicate_slide", slideIndex: 0 }],
  );
  const saved = unzipSync(result.bytes);
  assert.deepEqual(
    saved["ppt/slides/slide1.xml"],
    original["ppt/slides/slide1.xml"],
  );
  assert.match(strFromU8(saved["ppt/slides/slide2.xml"]), /altLang="ko-KR"/);
  assert.equal(result.report.topology.kind, "duplicate");
});

test("native section changes retain every other authored package part and refuse a different exported list", async () => {
  const original = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/fixtures/general-native-surface.pptx",
        import.meta.url,
      ),
    ),
  );
  const sections = [
    {
      id: "{11111111-1111-4111-8111-111111111111}",
      name: "첫 구역",
      startSlideIndex: 0,
    },
  ];
  const command = { op: "set_sections", sections };
  const edited = applyOoxmlCommand(original, command).bytes;
  const result = preserveOriginalPptxParts(
    original,
    original,
    edited,
    ["set_sections"],
    [command],
  );
  const before = unzipSync(original),
    after = unzipSync(result.bytes);
  for (const [part, bytes] of Object.entries(before))
    if (part !== "ppt/presentation.xml")
      assert.deepEqual(after[part], bytes, part);
  assert.throws(
    () =>
      preserveOriginalPptxParts(
        original,
        original,
        edited,
        ["set_sections"],
        [{ op: "set_sections", sections: [] }],
      ),
    /do not match/,
  );
});
