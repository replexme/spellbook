/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { preserveOriginalPptxParts } from "./ooxml-worker-source.mjs";

const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const part = "ppt/slides/slide1.xml", rel = "ppt/slides/_rels/slide1.xml.rels";
const transform = (prefix, x = 1000, y = 2000) => `<${prefix}:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="3000" cy="4000"/></${prefix}:xfrm>`;
const picture = (x, y, image) => `<p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${image}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform("a", x, y)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
function frame({ native = false, x = 1000, y = 2000, vml = false } = {}) {
  const object = `<p:oleObj name="Worksheet" r:id="${native ? "rIdOleNative" : "rIdOleAuthor"}" imgW="3000" imgH="4000" progId="Excel.Sheet.12"><p:${native ? "embed" : "link"}/>${native || !vml ? picture(x, y, native ? "rIdImageNative" : "rIdImageAuthor") : ""}</p:oleObj>`;
  const content = native || vml ? object : `<mc:AlternateContent><mc:Choice Requires="v">${object.replace(picture(x, y, "rIdImageAuthor"), "")}</mc:Choice><mc:Fallback>${object}</mc:Fallback></mc:AlternateContent>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${native ? 100 : 6}" name="Object 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${transform("p", x, y)}<a:graphic><a:graphicData uri="${p.replace('/main', '/ole')}">${content}</a:graphicData></a:graphic></p:graphicFrame>`;
}
const text = (value, height = 4000) => `<p:sp><p:nvSpPr><p:cNvPr id="7" name="Text Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform("a").replace('cy="4000"', `cy="${height}"`)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slide = shapes => `<p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
const relationships = native => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${native ? 'rIdOleNative' : 'rIdOleAuthor'}" Type="${r}/oleObject" Target="${native ? '../embeddings/import.bin' : 'file:///author.xlsx'}"${native ? '' : ' TargetMode="External"'}/><Relationship Id="${native ? 'rIdImageNative' : 'rIdImageAuthor'}" Type="${r}/image" Target="../media/preview.emf"/></Relationships>`;
async function snapshots({ vml = false, human = false } = {}) {
  const fixture = new Uint8Array(await readFile(new URL("../../eval/public/fixtures/general-native-surface.pptx", import.meta.url)));
  const source = unzipSync(fixture);
  source[part] = strToU8(slide(frame({ vml }) + (human ? text("Keep") : "")));
  source[rel] = strToU8(relationships(false));
  source["ppt/media/preview.emf"] = Uint8Array.of(1, 2, 3);
  const baseline = { ...source, [part]: strToU8(slide(frame({ native: true }) + (human ? text("Keep") : ""))), [rel]: strToU8(relationships(true)), "ppt/embeddings/import.bin": Uint8Array.of(4, 5, 6) };
  const edited = { ...baseline, [part]: strToU8(slide(frame({ native: true, x: human ? 1000 : 1320, y: human ? 2000 : 2080 }) + (human ? text("Keep HUMAN_VERIFIED", 6000) : ""))) };
  return { source, baseline, edited };
}
const geometryIntent = [{ op: "move", slideIndex: 0, shapeIndex: 0, name: "Object 5" }];
const preserve = ({ source, baseline, edited }, human = false) => unzipSync(preserveOriginalPptxParts(zipSync(source), zipSync(baseline), zipSync(edited), human ? null : ["move"], human ? null : geometryIntent).bytes);
const parse = bytes => new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
const serialize = node => new XMLSerializer().serializeToString(node);
function unchangedParts(source, saved) {
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(source).sort());
  for (const name of Object.keys(source)) if (name !== part) assert.deepEqual(saved[name], source[name], name);
}

test("linked OLE move retains original relationships and alternate-content previews", async () => {
  const input = await snapshots(), saved = preserve(input);
  unchangedParts(input.source, saved);
  const expected = parse(input.source[part]);
  for (const off of expected.getElementsByTagNameNS(a, "off")) { off.setAttribute("x", "1320"); off.setAttribute("y", "2080"); }
  assert.equal(serialize(parse(saved[part])), serialize(expected));
  assert.equal(parse(saved[part]).getElementsByTagNameNS(p, "link").length, 2);
  assert.equal(parse(saved[part]).getElementsByTagNameNS(p, "embed").length, 0);
});

test("VML-only authored OLE geometry keeps the original preview representation", async () => {
  const input = await snapshots({ vml: true }), saved = preserve(input);
  unchangedParts(input.source, saved);
  const expected = parse(input.source[part]);
  for (const off of expected.getElementsByTagNameNS(a, "off")) { off.setAttribute("x", "1320"); off.setAttribute("y", "2080"); }
  assert.equal(serialize(parse(saved[part])), serialize(expected));
  assert.equal(parse(saved[part]).getElementsByTagNameNS(p, "pic").length, 0);
});

test("OLE resize updates both frame and authored fallback while retaining position", async () => {
  const input = await snapshots();
  input.edited[part] = strToU8(strFromU8(input.baseline[part]).replaceAll('cx="3000" cy="4000"', 'cx="4500" cy="5000"'));
  const saved = unzipSync(preserveOriginalPptxParts(zipSync(input.source), zipSync(input.baseline), zipSync(input.edited), ["resize"], [{...geometryIntent[0],op:"resize"}]).bytes);
  unchangedParts(input.source, saved);
  const expected = parse(input.source[part]);
  for (const ext of expected.getElementsByTagNameNS(a, "ext")) { ext.setAttribute("cx", "4500"); ext.setAttribute("cy", "5000"); }
  assert.equal(serialize(parse(saved[part])), serialize(expected));
});

test("human text and autofit changes preserve unrelated OLE XML in the author's ID space", async () => {
  const input = await snapshots({ vml: true, human: true }), saved = preserve(input, true);
  unchangedParts(input.source, saved);
  const doc = parse(saved[part]), before = parse(input.source[part]);
  assert.equal(serialize(doc.getElementsByTagNameNS(p, "graphicFrame")[0]), serialize(before.getElementsByTagNameNS(p, "graphicFrame")[0]));
  assert.equal(doc.getElementsByTagNameNS(a, "t")[0].textContent, "Keep HUMAN_VERIFIED");
  assert.equal(doc.getElementsByTagNameNS(p, "sp")[0].getElementsByTagNameNS(a, "ext")[0].getAttribute("cy"), "6000");
});

test("direct OLE geometry rejects payload, relationship, crop and program changes", async () => {
  for (const mutate of [
    input => { input.edited["ppt/media/preview.emf"] = Uint8Array.of(9); },
    input => { input.edited["ppt/embeddings/import.bin"] = Uint8Array.of(9); },
    input => { input.edited[rel] = strToU8(relationships(true).replace("import.bin", "other.bin")); },
    input => { input.edited[part] = strToU8(strFromU8(input.edited[part]).replace('<a:stretch>', '<a:srcRect l="100"/><a:stretch>')); },
    input => { input.edited[part] = strToU8(strFromU8(input.edited[part]).replace('Excel.Sheet.12', 'PowerPoint.Slide.8')); },
    input => { input.edited[part] = strToU8(strFromU8(input.edited[part]).replace('<p:xfrm>', '<p:xfrm rot="100" >')); },
  ]) {
    const input = await snapshots(); mutate(input);
    assert.throws(() => preserve(input), /cannot isolate direct move/);
  }
});
