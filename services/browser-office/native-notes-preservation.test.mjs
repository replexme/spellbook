/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { preserveOriginalPptxParts } from "./ooxml-worker-source.mjs";
const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (body) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const rel = (id, kind, target) =>
  `<Relationship Id="${id}" Type="${r}/${kind}" Target="${target}"/>`;
function fixture() {
  const original = {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      rels(rel("p", "officeDocument", "ppt/presentation.xml")),
    ),
    "ppt/presentation.xml": strToU8(
      `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      rels(
        rel("s1", "slide", "slides/slide1.xml") +
          rel("s2", "slide", "slides/slide2.xml"),
      ),
    ),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(
      `<p:sldLayout xmlns:p="${p}"/>`,
    ),
    "ppt/theme/theme1.xml": strToU8(`<a:theme xmlns:a="${a}" name="Author"/>`),
  };
  const noEdit = { ...original };
  for (let n = 1; n <= 2; n++) {
    original[`ppt/slides/slide${n}.xml`] = strToU8(
      `<p:sld xmlns:p="${p}"><p:cSld><p:spTree/></p:cSld></p:sld>`,
    );
    original[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
      rels(rel("layout", "slideLayout", "../slideLayouts/slideLayout1.xml")),
    );
    noEdit[`ppt/slides/slide${n}.xml`] = original[`ppt/slides/slide${n}.xml`];
    noEdit[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
      rels(
        rel("layout", "slideLayout", "../slideLayouts/slideLayout1.xml") +
          rel("notes", "notesSlide", `../notesSlides/notesSlide${n}.xml`),
      ),
    );
    noEdit[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
      `<p:notes xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t></a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    );
    noEdit[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = strToU8(
      rels(
        rel("slide", "slide", `../slides/slide${n}.xml`) +
          rel("master", "notesMaster", "../notesMasters/notesMaster1.xml"),
      ),
    );
  }
  noEdit["ppt/notesMasters/notesMaster1.xml"] = strToU8(
    `<p:notesMaster xmlns:p="${p}"/>`,
  );
  noEdit["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = strToU8(
    rels(rel("theme", "theme", "../theme/theme1.xml")),
  );
  const edited = {
    ...noEdit,
    "ppt/notesSlides/notesSlide1.xml": strToU8(
      strFromU8(noEdit["ppt/notesSlides/notesSlide1.xml"]).replace(
        "<a:t></a:t>",
        "<a:t>Requested notes</a:t>",
      ),
    ),
  };
  return { original, noEdit, edited };
}
test("new authored notes retain both incoming and master links while unrelated empty notes stay absent", () => {
  const { original, noEdit, edited } = fixture();
  const result = unzipSync(
    preserveOriginalPptxParts(
      ...[original, noEdit, edited].map((x) => zipSync(x)),
      ["set_speaker_notes"],
      [{ op: "set_speaker_notes", slideIndex: 0 }],
    ).bytes,
  );
  assert.match(
    strFromU8(result["ppt/slides/_rels/slide1.xml.rels"]),
    /notesSlide1.xml/,
  );
  assert.match(
    strFromU8(result["ppt/notesSlides/notesSlide1.xml"]),
    /Requested notes/,
  );
  assert.ok(result["ppt/notesSlides/_rels/notesSlide1.xml.rels"]);
  assert.match(
    strFromU8(result["ppt/_rels/presentation.xml.rels"]),
    /notesMaster1.xml/,
  );
  assert.match(strFromU8(result["ppt/presentation.xml"]), /notesMasterId/);
  assert.deepEqual(
    result["ppt/slides/_rels/slide2.xml.rels"],
    original["ppt/slides/_rels/slide2.xml.rels"],
  );
  assert.equal(result["ppt/notesSlides/notesSlide2.xml"], undefined);
  assert.deepEqual(
    result["ppt/theme/theme1.xml"],
    original["ppt/theme/theme1.xml"],
  );
});
test("a notes operation on another slide cannot promote an orphan changed notes page", () => {
  const { original, noEdit, edited } = fixture();
  const result = unzipSync(
    preserveOriginalPptxParts(
      ...[original, noEdit, edited].map((x) => zipSync(x)),
      ["set_speaker_notes"],
      [{ op: "set_speaker_notes", slideIndex: 1 }],
    ).bytes,
  );
  assert.deepEqual(
    result["ppt/slides/_rels/slide1.xml.rels"],
    original["ppt/slides/_rels/slide1.xml.rels"],
  );
  assert.equal(result["ppt/notesSlides/_rels/notesSlide1.xml.rels"], undefined);
  assert.equal(result["ppt/notesSlides/notesSlide1.xml"], undefined);
});
