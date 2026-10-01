/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { repairCandidatePptxStructure } from "./ooxml-worker-source.mjs";

const rel =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const c = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const cs = "http://schemas.microsoft.com/office/drawing/2012/chartStyle";
const relationships = (body) =>
  strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
  );
const relationship = (id, kind, target) =>
  `<Relationship Id="${id}" Type="${rel}/${kind}" Target="${target}"/>`;
function fixture(extra = false) {
  return {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    "ppt/presentation.xml": strToU8(
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${rel}"/>`,
    ),
    "ppt/_rels/presentation.xml.rels": relationships(
      relationship("m", "slideMaster", "slideMasters/slideMaster1.xml") +
        relationship("t", "theme", "theme/theme1.xml") +
        (extra ? relationship("extra", "theme", "theme/theme2.xml") : ""),
    ),
    "ppt/slideMasters/slideMaster1.xml": strToU8("<master/>"),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships(
      relationship("t", "theme", "../theme/theme1.xml"),
    ),
    "ppt/theme/theme1.xml": strToU8("<theme name='Author'/>"),
    "ppt/theme/theme2.xml": strToU8("<theme name='Extra'/>"),
    "ppt/slides/slide1.xml": strToU8("<original-shapes/>"),
    "ppt/media/image.png": new Uint8Array([1, 2, 3]),
  };
}
const xml = (bytes) =>
  new DOMParser().parseFromString(strFromU8(bytes), "application/xml");

test("candidate theme repair follows original/master ownership and preserves all theme/slide/media parts", () => {
  const candidate = fixture(true);
  const repaired = repairCandidatePptxStructure(
    zipSync(fixture()),
    zipSync(candidate),
  );
  const parts = unzipSync(repaired.bytes);
  assert.deepEqual(repaired.report.changedParts, [
    "ppt/_rels/presentation.xml.rels",
  ]);
  for (const part of Object.keys(candidate))
    if (!repaired.report.changedParts.includes(part))
      assert.deepEqual(parts[part], candidate[part]);
  assert.doesNotMatch(
    strFromU8(parts["ppt/_rels/presentation.xml.rels"]),
    /Id="extra"/u,
  );
  assert.deepEqual(
    repairCandidatePptxStructure(zipSync(fixture()), repaired.bytes).bytes,
    repaired.bytes,
  );
});

test("candidate theme repair refuses ambiguous ownership and explicitly referenced extra themes", () => {
  const original = fixture(true);
  assert.throws(
    () =>
      repairCandidatePptxStructure(zipSync(original), zipSync(fixture(true))),
    /ambiguous ownership/u,
  );
  const candidate = fixture(true);
  candidate["ppt/presentation.xml"] = strToU8(
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${rel}"><p:extension r:id="extra"/></p:presentation>`,
  );
  assert.throws(
    () => repairCandidatePptxStructure(zipSync(fixture()), zipSync(candidate)),
    /explicit reference/u,
  );
});

test("candidate chart repair orders children without changing values, repeated labels, comments or nested styles", () => {
  const candidate = fixture();
  candidate["ppt/charts/chart1.xml"] = strToU8(
    `<c:chartSpace xmlns:c="${c}"><c:dLbls><!--Keep--><c:showCatName val="0"/><c:dLbl><c:idx val="2"/></c:dLbl><c:dLbl><c:idx val="1"/></c:dLbl><c:showVal val="1"/><c:showLegendKey val="0"/></c:dLbls></c:chartSpace>`,
  );
  candidate["ppt/charts/style1.xml"] = strToU8(
    `<cs:chartStyle xmlns:cs="${cs}" id="102"><cs:dataPointMarkerLayout size="7"/><cs:dataPointMarker><cs:test val="keep"/></cs:dataPointMarker></cs:chartStyle>`,
  );
  const repaired = repairCandidatePptxStructure(
    zipSync(fixture()),
    zipSync(candidate),
  );
  const parts = unzipSync(repaired.bytes);
  const labels = xml(parts["ppt/charts/chart1.xml"]).getElementsByTagNameNS(
    c,
    "dLbls",
  )[0];
  assert.deepEqual(
    [...labels.childNodes]
      .filter((n) => n.nodeType === 1)
      .map((n) => n.localName),
    ["dLbl", "dLbl", "showLegendKey", "showVal", "showCatName"],
  );
  assert.deepEqual(
    [...labels.getElementsByTagNameNS(c, "idx")].map((n) =>
      n.getAttribute("val"),
    ),
    ["2", "1"],
  );
  assert.equal(
    labels.getElementsByTagNameNS(c, "showVal")[0].getAttribute("val"),
    "1",
  );
  assert.match(strFromU8(parts["ppt/charts/chart1.xml"]), /<!--Keep-->/u);
  const style = xml(parts["ppt/charts/style1.xml"]).documentElement;
  assert.deepEqual(
    [...style.childNodes]
      .filter((n) => n.nodeType === 1)
      .map((n) => n.localName),
    ["dataPointMarker", "dataPointMarkerLayout"],
  );
  assert.equal(
    style.getElementsByTagNameNS(cs, "test")[0].getAttribute("val"),
    "keep",
  );
  assert.deepEqual(
    repairCandidatePptxStructure(zipSync(fixture()), repaired.bytes).report
      .changedParts,
    [],
  );
});

test("candidate chart repair refuses unknown children rather than dropping them to pass validation", () => {
  const candidate = fixture();
  candidate["ppt/charts/chart1.xml"] = strToU8(
    `<c:chartSpace xmlns:c="${c}" xmlns:x="urn:unknown"><c:dLbls><x:custom/></c:dLbls></c:chartSpace>`,
  );
  assert.throws(
    () => repairCandidatePptxStructure(zipSync(fixture()), zipSync(candidate)),
    /Unknown chart child/u,
  );
});

test("candidate diagram drawing repair requires the exact declared MIME and matching document root", () => {
  const candidate = fixture();
  candidate["[Content_Types].xml"] = strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/diagrams/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramDrawing+xml"/></Types>',
  );
  candidate["ppt/diagrams/drawing1.xml"] = strToU8(
    '<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:spTree/></dsp:drawing>',
  );
  const repaired = repairCandidatePptxStructure(
    zipSync(fixture()),
    zipSync(candidate),
  );
  const parts = unzipSync(repaired.bytes);
  assert.match(
    strFromU8(parts["[Content_Types].xml"]),
    /application\/vnd\.ms-office\.drawingml\.diagramDrawing\+xml/u,
  );
  assert.deepEqual(
    parts["ppt/diagrams/drawing1.xml"],
    candidate["ppt/diagrams/drawing1.xml"],
  );
  candidate["ppt/diagrams/drawing1.xml"] = strToU8("<unknown/>");
  assert.throws(
    () => repairCandidatePptxStructure(zipSync(fixture()), zipSync(candidate)),
    /disagrees/u,
  );
});

test("SmartArt repair removes only an identity child-space mapping and preserves frame coordinates/content", () => {
  const candidate = fixture();
  const frame = (x = "0", extent = "6096000") =>
    strToU8(
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:graphicFrame><p:xfrm rot="0"><a:off x="1524000" y="1397000"/><a:ext cx="6096000" cy="4064000"/><a:chOff x="${x}" y="0"/><a:chExt cx="${extent}" cy="4064000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><a:keep value="content"/></a:graphicData></a:graphic></p:graphicFrame></p:sld>`,
    );
  candidate["ppt/slides/slide1.xml"] = frame();
  const repaired = repairCandidatePptxStructure(
    zipSync(fixture()),
    zipSync(candidate),
  );
  const result = strFromU8(unzipSync(repaired.bytes)["ppt/slides/slide1.xml"]);
  assert.doesNotMatch(result, /a:chOff|a:chExt/u);
  assert.match(result, /x="1524000" y="1397000"/u);
  assert.match(result, /cx="6096000" cy="4064000"/u);
  assert.match(result, /value="content"/u);
  assert.deepEqual(
    repairCandidatePptxStructure(zipSync(fixture()), repaired.bytes).bytes,
    repaired.bytes,
  );
  for (const invalid of [
    frame("1"),
    frame("0", "6000000"),
    strToU8(
      strFromU8(frame()).replace('x="0" y="0"', 'x="0" y="0" extra="unknown"'),
    ),
  ]) {
    candidate["ppt/slides/slide1.xml"] = invalid;
    assert.throws(
      () =>
        repairCandidatePptxStructure(zipSync(fixture()), zipSync(candidate)),
      /non-identity or unknown/u,
    );
  }
});
