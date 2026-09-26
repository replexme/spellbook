import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import {
  applyOoxmlCommand,
  inspectOoxmlDocument,
  preserveOriginalPptxParts,
  verifyPersistedElementMutation,
  remapPartRelationshipIds,
} from "./ooxml-worker-source.mjs";
import { persistedSlideTopologyMatches } from "./harness/product-persistence.mjs";

test("browser OOXML commands produce deterministic package bytes", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const command = {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  };
  const first = applyOoxmlCommand(source, command);
  const second = applyOoxmlCommand(source, command);
  assert.deepEqual(first.bytes, second.bytes);
});

test("browser OOXML inspection exposes ordered slide identities", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = inspectOoxmlDocument(source);
  const moved = applyOoxmlCommand(source, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 0,
  });
  const observed = inspectOoxmlDocument(moved.bytes);
  assert.equal(original.slideIds.length, 1);
  assert.equal(observed.slideIds.length, 2);
  assert.equal(observed.slideIds[1], original.slideIds[0]);
  assert.notEqual(observed.slideIds[0], original.slideIds[0]);
  assert.deepEqual(moved.report.slideIdsBefore, original.slideIds);
  assert.deepEqual(moved.report.slideIdsAfter, observed.slideIds);
});

const fixtureUrl = new URL(
  "../../eval/public/fixtures/general-native-surface.pptx",
  import.meta.url,
);

test("native snapshot reconciliation keeps the author's unrelated OOXML parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  noEdit["ppt/theme/theme1.xml"] = strToU8(
    `${strFromU8(noEdit["ppt/theme/theme1.xml"])}<!-- normalized -->`,
  );
  noEdit["customXml/LONoise.xml"] = strToU8("<noise/>");
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Preserved edit",
    }).bytes,
  );
  edited["ppt/theme/theme1.xml"] = noEdit["ppt/theme/theme1.xml"];
  edited["customXml/LONoise.xml"] = noEdit["customXml/LONoise.xml"];
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["replace_text"],
  );
  const merged = unzipSync(result.bytes);
  const original = unzipSync(source);
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(result.report.suppressedNoopParts, [
    "customXml/LONoise.xml",
    "ppt/theme/theme1.xml",
  ]);
  assert.deepEqual(
    merged["ppt/theme/theme1.xml"],
    original["ppt/theme/theme1.xml"],
  );
  assert.equal(merged["customXml/LONoise.xml"], undefined);
  assert.match(strFromU8(merged["ppt/slides/slide1.xml"]), /Preserved edit/u);
});

test("native snapshot preserves untouched author shapes when Office inserts a shape", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const slidePath = "ppt/slides/slide1.xml";
  const normalized = new DOMParser().parseFromString(
    strFromU8(original[slidePath]),
    "application/xml",
  );
  const drawingNamespace =
    "http://schemas.openxmlformats.org/drawingml/2006/main";
  normalized.getElementsByTagNameNS(drawingNamespace, "t")[0].textContent =
    "Office normalized this unrelated text";
  const normalizedXml = new XMLSerializer().serializeToString(normalized);
  const noEdit = { ...original, [slidePath]: strToU8(normalizedXml) };
  const changed = new DOMParser().parseFromString(
    normalizedXml,
    "application/xml",
  );
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const tree = changed.getElementsByTagNameNS(
    presentationNamespace,
    "spTree",
  )[0];
  const added = tree
    .getElementsByTagNameNS(presentationNamespace, "sp")[0]
    .cloneNode(true);
  const properties = added.getElementsByTagNameNS(
    presentationNamespace,
    "cNvPr",
  )[0];
  properties.setAttribute("id", "999");
  properties.setAttribute("name", "Added Shape");
  added.getElementsByTagNameNS(drawingNamespace, "t")[0].textContent =
    "New shape";
  tree.appendChild(added);
  const edited = {
    ...noEdit,
    [slidePath]: strToU8(new XMLSerializer().serializeToString(changed)),
  };
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["add_shape"],
  );
  const merged = strFromU8(unzipSync(result.bytes)[slidePath]);
  assert.match(merged, /Spellbook 검증 العربية/u);
  assert.doesNotMatch(merged, /Office normalized this unrelated text/u);
  assert.match(merged, /New shape/u);
  assert.deepEqual(result.report.semanticPatchedParts, [slidePath]);
});

test("native snapshot writes changed table insets where PPTX import reads them", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/ox-table-large.pptx",
        import.meta.url,
      ),
    ),
  );
  const slidePath = "ppt/slides/slide1.xml";
  const edited = unzipSync(source);
  const drawingNamespace =
    "http://schemas.openxmlformats.org/drawingml/2006/main";
  const document = new DOMParser().parseFromString(
    strFromU8(edited[slidePath]),
    "application/xml",
  );
  const cell = document.getElementsByTagNameNS(drawingNamespace, "tc")[1];
  const body = cell.getElementsByTagNameNS(drawingNamespace, "bodyPr")[0];
  body.setAttribute("tIns", "50400");
  body.setAttribute("bIns", "50760");
  edited[slidePath] = strToU8(new XMLSerializer().serializeToString(document));
  const result = preserveOriginalPptxParts(source, source, zipSync(edited), [
    "set_table_cell_format",
  ]);
  const saved = new DOMParser().parseFromString(
    strFromU8(unzipSync(result.bytes)[slidePath]),
    "application/xml",
  );
  const properties = saved
    .getElementsByTagNameNS(drawingNamespace, "tc")[1]
    .getElementsByTagNameNS(drawingNamespace, "tcPr")[0];
  assert.equal(properties.getAttribute("marT"), "50400");
  assert.equal(properties.getAttribute("marB"), "50760");
  assert.deepEqual(result.report.semanticPatchedParts, [slidePath]);

  // A later edit to the same cell must not lose those margins when Impress
  // omits both attributes again from its no-edit and edited exports.
  const secondOriginal = unzipSync(result.bytes);
  const secondNoEdit = new DOMParser().parseFromString(
    strFromU8(secondOriginal[slidePath]),
    "application/xml",
  );
  const secondProperties = secondNoEdit
    .getElementsByTagNameNS(drawingNamespace, "tc")[1]
    .getElementsByTagNameNS(drawingNamespace, "tcPr")[0];
  secondProperties.removeAttribute("marT");
  secondProperties.removeAttribute("marB");
  const noEditEntries = {
    ...secondOriginal,
    [slidePath]: strToU8(new XMLSerializer().serializeToString(secondNoEdit)),
  };
  const secondEdited = unzipSync(zipSync(noEditEntries));
  const secondDocument = new DOMParser().parseFromString(
    strFromU8(secondEdited[slidePath]),
    "application/xml",
  );
  secondDocument
    .getElementsByTagNameNS(drawingNamespace, "tc")[1]
    .getElementsByTagNameNS(drawingNamespace, "tcPr")[0]
    .setAttribute("marL", "95400");
  secondEdited[slidePath] = strToU8(
    new XMLSerializer().serializeToString(secondDocument),
  );
  const second = preserveOriginalPptxParts(
    result.bytes,
    zipSync(noEditEntries),
    zipSync(secondEdited),
    ["set_table_cell_format"],
  );
  const carriedProperties = new DOMParser()
    .parseFromString(
      strFromU8(unzipSync(second.bytes)[slidePath]),
      "application/xml",
    )
    .getElementsByTagNameNS(drawingNamespace, "tc")[1]
    .getElementsByTagNameNS(drawingNamespace, "tcPr")[0];
  assert.equal(carriedProperties.getAttribute("marT"), "50400");
  assert.equal(carriedProperties.getAttribute("marB"), "50760");
});

test("native snapshot reconciliation preserves the original implicit slide layout", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  const relationshipPath = "ppt/slides/_rels/slide1.xml.rels";
  noEdit[relationshipPath] = strToU8(
    strFromU8(noEdit[relationshipPath]).replace(
      "slideLayout7.xml",
      "slideLayout9.xml",
    ),
  );
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Changed edit",
    }).bytes,
  );
  edited[relationshipPath] = noEdit[relationshipPath];
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["replace_text"],
  );
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(
    unzipSync(result.bytes)[relationshipPath],
    unzipSync(source)[relationshipPath],
  );
});

test("native snapshot remaps an edited slide layout by identity after Office renumbers layouts", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/lo-master-layouts.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(source);
  const noEdit = unzipSync(source);
  const second = "ppt/slideLayouts/slideLayout2.xml";
  const tenth = "ppt/slideLayouts/slideLayout10.xml";
  [noEdit[second], noEdit[tenth]] = [original[tenth], original[second]];
  const edited = unzipSync(zipSync(noEdit));
  const relsPath = "ppt/slides/_rels/slide1.xml.rels";
  edited[relsPath] = strToU8(
    strFromU8(edited[relsPath]).replace(
      "../slideLayouts/slideLayout1.xml",
      "../slideLayouts/slideLayout2.xml",
    ),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["set_slide_layout"],
  );
  const merged = unzipSync(result.bytes);
  assert.match(
    strFromU8(merged[relsPath]),
    /Target="\.\.\/slideLayouts\/slideLayout10\.xml"/u,
  );
  assert.deepEqual(merged[tenth], original[tenth]);
  assert.deepEqual(merged[second], original[second]);
  assert.deepEqual(result.report.changedParts, [relsPath]);
});

test("native snapshot refuses an ambiguous slide layout identity", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/lo-master-layouts.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(source);
  const noEdit = unzipSync(source);
  const target = "ppt/slideLayouts/slideLayout2.xml";
  noEdit[target] = strToU8(
    strFromU8(noEdit[target]).replace(
      'name="Title and Content"',
      'name="No original layout has this name"',
    ),
  );
  const edited = unzipSync(zipSync(noEdit));
  const relsPath = "ppt/slides/_rels/slide1.xml.rels";
  edited[relsPath] = strToU8(
    strFromU8(edited[relsPath]).replace(
      "../slideLayouts/slideLayout1.xml",
      "../slideLayouts/slideLayout2.xml",
    ),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
        "set_slide_layout",
      ]),
    /cannot uniquely remap slide layout/u,
  );
  assert.ok(original[target]);
});

test("native relationship edits retain an unchanged original layout even when Office layout names collide", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/lo-transition-media.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(source);
  const noEdit = unzipSync(source);
  for (const part of [
    "ppt/slideLayouts/slideLayout2.xml",
    "ppt/slideLayouts/slideLayout3.xml",
  ])
    noEdit[part] = strToU8(
      strFromU8(noEdit[part]).replace(
        /(<p:cSld\b[^>]*\bname=")[^"]+"/u,
        '$1Default"',
      ),
    );
  const edited = unzipSync(zipSync(noEdit));
  const relsPath = "ppt/slides/_rels/slide1.xml.rels";
  edited[relsPath] = strToU8(
    strFromU8(edited[relsPath])
      .replace(
        "</Relationships>",
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
      )
      .replace(
        "../slideLayouts/slideLayout3.xml",
        "../slideLayouts/slideLayout2.xml",
      ),
  );
  const merged = unzipSync(
    preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
      "set_object_interaction",
    ]).bytes,
  );
  assert.match(
    strFromU8(merged[relsPath]),
    /Target="\.\.\/slideLayouts\/slideLayout3\.xml"/u,
  );
  assert.match(
    strFromU8(merged[relsPath]),
    /Target="https:\/\/example\.com\/"/u,
  );
  assert.deepEqual(
    merged["ppt/slideLayouts/slideLayout3.xml"],
    original["ppt/slideLayouts/slideLayout3.xml"],
  );
});

test("native slide size patch preserves original presentation relationships and unrelated XML", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/lo-master-layouts.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(source);
  const noEdit = unzipSync(source);
  const presentation = "ppt/presentation.xml";
  const relationships = "ppt/_rels/presentation.xml.rels";
  noEdit[presentation] = strToU8(
    strFromU8(noEdit[presentation]).replace('r:id="rId2"', 'r:id="rId13"'),
  );
  noEdit[relationships] = strToU8(
    strFromU8(noEdit[relationships]).replace('Id="rId2"', 'Id="rId13"'),
  );
  const edited = unzipSync(zipSync(noEdit));
  const originalXml = strFromU8(original[presentation]);
  assert.match(originalXml, /<p:sldSz cx="12192000" cy="6858000"\/>/u);
  edited[presentation] = strToU8(
    strFromU8(edited[presentation]).replace('cx="12192000"', 'cx="12228513"'),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["set_slide_size"],
  );
  const merged = unzipSync(result.bytes);
  assert.equal(
    strFromU8(merged[presentation]),
    originalXml.replace('cx="12192000"', 'cx="12228513"'),
  );
  assert.deepEqual(merged[relationships], original[relationships]);
  assert.deepEqual(result.report.changedParts, [presentation]);
  assert.deepEqual(result.report.semanticPatchedParts, [presentation]);

  edited[presentation] = strToU8(
    strFromU8(edited[presentation]).replace('cy="9144000"', 'cy="9144001"'),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
        "set_slide_size",
      ]),
    /also changed other presentation fields/u,
  );
});

test("native snapshot keeps unrequested core metadata while committing slide edits", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Changed edit",
    }).bytes,
  );
  edited["docProps/core.xml"] = strToU8(
    strFromU8(edited["docProps/core.xml"]).replace(
      "2026-01-01T00:00:00Z",
      "2026-09-17T00:00:00Z",
    ),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["replace_text"],
  );
  const original = unzipSync(source);
  const preserved = unzipSync(result.bytes);
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(
    preserved["docProps/core.xml"],
    original["docProps/core.xml"],
  );
});

test("native snapshot keeps extended properties after a direct slide text edit", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const noEdit = { ...original };
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Typed by a person",
    }).bytes,
  );
  noEdit["docProps/app.xml"] = strToU8(
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1629</TotalTime><Application>ZetaOffice</Application></Properties>',
  );
  edited["docProps/app.xml"] = strToU8(
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1630</TotalTime><Application>ZetaOffice</Application></Properties>',
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  const preserved = unzipSync(result.bytes);
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(preserved["docProps/app.xml"], original["docProps/app.xml"]);
  assert.match(
    strFromU8(preserved["ppt/slides/slide1.xml"]),
    /Typed by a person/u,
  );
});

test("native snapshot allows a direct extended-properties-only edit", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  const edited = { ...noEdit };
  edited["docProps/app.xml"] = strToU8(
    strFromU8(noEdit["docProps/app.xml"]).replace(
      "<Company></Company>",
      "<Company>Edited company</Company>",
    ),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  assert.deepEqual(result.report.changedParts, ["docProps/app.xml"]);
  assert.match(
    strFromU8(unzipSync(result.bytes)["docProps/app.xml"]),
    /Edited company/u,
  );
});

test("native snapshot ignores save duration even without a slide change", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const noEdit = { ...original };
  const edited = { ...original };
  const engine =
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1629</TotalTime><Application>ZetaOffice</Application></Properties>';
  noEdit["docProps/app.xml"] = strToU8(engine);
  edited["docProps/app.xml"] = strToU8(
    engine.replace("<TotalTime>1629", "<TotalTime>1630"),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  assert.deepEqual(result.report.changedParts, []);
  assert.deepEqual(
    unzipSync(result.bytes)["docProps/app.xml"],
    original["docProps/app.xml"],
  );
});

test("native snapshot keeps authored properties across a direct slide addition", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const noEdit = { ...original };
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes,
  );
  const engine =
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1629</TotalTime><Application>ZetaOffice</Application></Properties>';
  noEdit["docProps/app.xml"] = strToU8(engine);
  edited["docProps/app.xml"] = strToU8(
    engine.replace("<TotalTime>1629", "<TotalTime>1630"),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  assert.equal(inspectOoxmlDocument(result.bytes).slideIds.length, 2);
  assert.deepEqual(
    unzipSync(result.bytes)["docProps/app.xml"],
    original["docProps/app.xml"],
  );
});

test("native snapshot merges a property edit with a slide edit", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const noEdit = { ...original };
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Typed alongside property edit",
    }).bytes,
  );
  noEdit["docProps/app.xml"] = strToU8(
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1629</TotalTime><Application>ZetaOffice</Application><Company>Before</Company></Properties>',
  );
  edited["docProps/app.xml"] = strToU8(
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>1630</TotalTime><Application>ZetaOffice</Application><Company>After</Company></Properties>',
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  const merged = unzipSync(result.bytes);
  assert.deepEqual(result.report.changedParts, [
    "docProps/app.xml",
    "ppt/slides/slide1.xml",
  ]);
  assert.match(
    strFromU8(merged["docProps/app.xml"]),
    /<Company>After<\/Company>/u,
  );
  assert.match(
    strFromU8(merged["docProps/app.xml"]),
    /<Application>Microsoft Macintosh PowerPoint<\/Application>/u,
  );
  assert.match(
    strFromU8(merged["docProps/app.xml"]),
    /<PresentationFormat>On-screen Show \(4:3\)<\/PresentationFormat>/u,
  );
});

test("native snapshot reconciliation refuses a changed part with remapped references", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  const relationshipPath = "ppt/_rels/presentation.xml.rels";
  noEdit[relationshipPath] = strToU8(
    strFromU8(noEdit[relationshipPath]).replace(
      'Target="slides/slide1.xml"',
      'Target="slides/slide2.xml"',
    ),
  );
  const edited = unzipSync(source);
  edited["ppt/presentation.xml"] = strToU8(
    `${strFromU8(edited["ppt/presentation.xml"])}<!-- author edit -->`,
  );
  edited[relationshipPath] = noEdit[relationshipPath];
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
        "set_sections",
      ]),
    /relationship remapping/u,
  );
});

test("native snapshot comparison ignores the random ids each engine save draws", async () => {
  const source = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const chartPart = "ppt/charts/chart99.xml";
  const slidePart = "ppt/slides/slide1.xml";
  const chart = (category, value) =>
    strToU8(
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:axId val="${category}"/><c:axId val="${value}"/></c:barChart><c:catAx><c:axId val="${category}"/><c:crossAx val="${value}"/></c:catAx><c:valAx><c:axId val="${value}"/><c:crossAx val="${category}"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`,
    );
  const slide = (modification) =>
    strToU8(
      strFromU8(source[slidePart]).replace(
        "</p:sld>",
        `<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:modId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="${modification}"/></p:ext></p:extLst></p:sld>`,
      ),
    );
  const save = (category, value, modification) => ({
    ...source,
    [chartPart]: chart(category, value),
    [slidePart]: slide(modification),
  });
  const original = save(1, 2, 7);
  // A direct human edit, whose budget admits every changed part: the two
  // engine saves differ only in the ids each save draws anew.
  const kept = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(save(87096, 5775388, 1962833182)),
    zipSync(save(52273715, 31502705, 494112455)),
    null,
  );
  assert.deepEqual(kept.report.changedParts, []);

  // An axis that points at a different axis is a change, not a new id.
  const rewired = save(52273715, 31502705, 494112455);
  rewired[chartPart] = strToU8(
    strFromU8(rewired[chartPart]).replace(
      '<c:crossAx val="31502705"/>',
      '<c:crossAx val="52273715"/>',
    ),
  );
  const changed = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(save(87096, 5775388, 1962833182)),
    zipSync(rewired),
    null,
  );
  assert.deepEqual(changed.report.changedParts, [chartPart]);
});

test("native snapshot comparison ignores generated field GUIDs but not field semantics", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const part = "ppt/slideMasters/slideMaster1.xml";
  const noEdit = unzipSync(source);
  const originalXml = strFromU8(noEdit[part]);
  assert.match(originalXml, /<a:fld id="\{[^}]+\}"/u);
  noEdit[part] = strToU8(
    originalXml.replace(/(<a:fld id=")[^"]+(")/u, "$1{AAAAAAAA}$2"),
  );
  const edited = unzipSync(zipSync(noEdit));
  edited[part] = strToU8(
    strFromU8(edited[part]).replace(/(<a:fld id=")[^"]+(")/u, "$1{BBBBBBBB}$2"),
  );
  const guidOnly = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["replace_text"],
  );
  assert.deepEqual(guidOnly.report.changedParts, []);
  assert.deepEqual(unzipSync(guidOnly.bytes)[part], unzipSync(source)[part]);

  edited[part] = strToU8(
    strFromU8(edited[part]).replace('type="slidenum"', 'type="datetime"'),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
        "set_master_theme",
      ]),
    /exactly one edited master theme/u,
  );

  const unrelatedMasterChange = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["insert_table_rows"],
  );
  assert.deepEqual(unrelatedMasterChange.report.changedParts, []);
  assert.deepEqual(unrelatedMasterChange.report.suppressedOutOfBudgetParts, [
    part,
  ]);
  assert.deepEqual(
    unzipSync(unrelatedMasterChange.bytes)[part],
    unzipSync(source)[part],
  );
});

test("master theme edit splits only the selected original layout and retains unrelated theme bytes", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/downloads/lo-master-layouts.pptx",
        import.meta.url,
      ),
    ),
  );
  const original = unzipSync(source);
  const noEdit = unzipSync(source);
  const master = "ppt/slideMasters/slideMaster1.xml";
  const masterRels = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
  const normalizedMaster = "ppt/slideMasters/slideMaster2.xml";
  const normalizedRels = "ppt/slideMasters/_rels/slideMaster2.xml.rels";
  const theme = "ppt/theme/theme2.xml";
  noEdit[normalizedMaster] = original[master].slice();
  const rels = new DOMParser().parseFromString(
    strFromU8(original[masterRels]),
    "application/xml",
  );
  for (const relationship of [...rels.getElementsByTagName("Relationship")]) {
    const target = relationship.getAttribute("Target");
    if (target?.endsWith("theme1.xml"))
      relationship.setAttribute("Target", "../theme/theme2.xml");
    else if (
      target?.includes("slideLayout") &&
      !target.endsWith("slideLayout10.xml")
    )
      relationship.parentNode.removeChild(relationship);
  }
  noEdit[normalizedRels] = strToU8(new XMLSerializer().serializeToString(rels));
  const edited = unzipSync(zipSync(noEdit));
  edited[theme] = strToU8(
    strFromU8(edited[theme])
      .replace('name="Office Theme"', 'name="Spellbook verified theme"')
      .replace(/(<a:accent1>\s*<a:srgbClr val=")[^"]+/u, "$14f46e5"),
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["set_master_theme"],
  );
  const merged = unzipSync(result.bytes);
  const clonedMaster = result.report.changedParts.find(
    (part) =>
      part.startsWith("ppt/slideMasters/slideMaster1-spellbook-") &&
      part.endsWith(".xml"),
  );
  const clonedTheme = result.report.changedParts.find(
    (part) =>
      part.startsWith("ppt/theme/theme1-spellbook-") && part.endsWith(".xml"),
  );
  assert.ok(clonedMaster);
  assert.ok(clonedTheme);
  assert.deepEqual(
    merged["ppt/theme/theme1.xml"],
    original["ppt/theme/theme1.xml"],
  );
  assert.match(strFromU8(merged[clonedTheme]), /Spellbook verified theme/u);
  assert.match(strFromU8(merged[clonedTheme]), /4f46e5/u);
  assert.match(
    strFromU8(merged["ppt/slideLayouts/_rels/slideLayout10.xml.rels"]),
    /slideMaster1-spellbook-/u,
  );
  assert.deepEqual(
    merged["ppt/slideLayouts/_rels/slideLayout2.xml.rels"],
    original["ppt/slideLayouts/_rels/slideLayout2.xml.rels"],
  );
  assert.ok(result.report.semanticPatchedParts.includes(clonedMaster));
  edited[theme] = strToU8(
    strFromU8(edited[theme]).replace(
      'fmtScheme name="Office"',
      'fmtScheme name="Unrequested"',
    ),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, zipSync(noEdit), zipSync(edited), [
        "set_master_theme",
      ]),
    /non-theme mutation/u,
  );
});

test("native snapshot requires a known command and does not preserve unapproved parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const edited = unzipSync(source);
  edited["customXml/unrequested.xml"] = strToU8("<unrequested/>");
  assert.throws(
    () => preserveOriginalPptxParts(source, source, zipSync(edited), []),
    /bounded operation list/u,
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, source, zipSync(edited), [
        "invented_edit",
      ]),
    /unknown operation/u,
  );
  const result = preserveOriginalPptxParts(source, source, zipSync(edited), [
    "insert_table_rows",
  ]);
  assert.deepEqual(result.report.changedParts, []);
  assert.deepEqual(result.report.suppressedOutOfBudgetParts, [
    "customXml/unrequested.xml",
  ]);
  assert.equal(unzipSync(result.bytes)["customXml/unrequested.xml"], undefined);
});

test("native snapshot reconciliation rejects a missing package dependency", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const edited = unzipSync(source);
  const part = "ppt/slides/_rels/slide1.xml.rels";
  edited[part] = strToU8(
    strFromU8(edited[part]).replace(
      /Target="[^"]+"/u,
      'Target="../media/missing.png"',
    ),
  );
  assert.throws(
    () =>
      preserveOriginalPptxParts(source, source, zipSync(edited), [
        "insert_image",
      ]),
    /missing dependency/u,
  );
});

test("browser OOXML worker adds one slide without rewriting existing parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const before = unzipSync(source);
  const { bytes, report } = applyOoxmlCommand(source, {
    op: "add_slide",
    templateSlideIndex: 0,
    insertIndex: 1,
  });
  const after = unzipSync(bytes);
  assert.equal(report.slideCount, 2);
  assert.ok(after["ppt/slides/slide2.xml"]);
  assert.ok(after["ppt/slides/_rels/slide2.xml.rels"]);
  assert.equal(
    hash(after["ppt/slides/slide1.xml"]),
    hash(before["ppt/slides/slide1.xml"]),
  );
  assert.equal(
    hash(after["ppt/theme/theme1.xml"]),
    hash(before["ppt/theme/theme1.xml"]),
  );
  const presentation = strFromU8(after["ppt/presentation.xml"]);
  assert.equal((presentation.match(/<p:sldId\b/gu) ?? []).length, 2);
  assert.deepEqual(slidePaths(after), [
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
  ]);
  assert.deepEqual(report.changedParts, [
    "[Content_Types].xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/presentation.xml",
    "ppt/slides/_rels/slide2.xml.rels",
    "ppt/slides/slide2.xml",
  ]);
});

test("browser OOXML worker duplicates, moves, and deletes through one package topology", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const duplicated = applyOoxmlCommand(source, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 0,
  });
  const duplicateEntries = unzipSync(duplicated.bytes);
  assert.equal(duplicated.report.slideCount, 2);
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "duplicate_slide", slideIndex: 0, insertIndex: 0 },
      duplicated.report.slideIdsBefore,
      duplicated.report.slideIdsAfter,
    ),
    true,
  );
  assert.deepEqual(slidePaths(duplicateEntries), [
    "ppt/slides/slide2.xml",
    "ppt/slides/slide1.xml",
  ]);
  assert.equal(
    hash(duplicateEntries["ppt/slides/slide2.xml"]),
    hash(original["ppt/slides/slide1.xml"]),
  );
  assert.equal(
    hash(duplicateEntries["ppt/slides/slide1.xml"]),
    hash(original["ppt/slides/slide1.xml"]),
  );
  assert.equal(
    hash(duplicateEntries["ppt/theme/theme1.xml"]),
    hash(original["ppt/theme/theme1.xml"]),
  );

  const moved = applyOoxmlCommand(duplicated.bytes, {
    op: "move_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  const movedEntries = unzipSync(moved.bytes);
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "move_slide", slideIndex: 0, insertIndex: 1 },
      moved.report.slideIdsBefore,
      moved.report.slideIdsAfter,
    ),
    true,
  );
  assert.deepEqual(slidePaths(movedEntries), [
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
  ]);
  assert.deepEqual(moved.report.changedParts, ["ppt/presentation.xml"]);
  assert.deepEqual(changedLogicalParts(duplicateEntries, movedEntries), [
    "ppt/presentation.xml",
  ]);

  const deleted = applyOoxmlCommand(moved.bytes, {
    op: "delete_slide",
    slideIndex: 1,
  });
  const deletedEntries = unzipSync(deleted.bytes);
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "delete_slide", slideIndex: 1 },
      deleted.report.slideIdsBefore,
      deleted.report.slideIdsAfter,
    ),
    true,
  );
  assert.equal(deleted.report.slideCount, 1);
  assert.deepEqual(slidePaths(deletedEntries), ["ppt/slides/slide1.xml"]);
  assert.deepEqual(deleted.report.removedParts, ["ppt/slides/slide2.xml"]);
  assert.equal(deletedEntries["ppt/slides/slide2.xml"], undefined);
  assert.equal(deletedEntries["ppt/slides/_rels/slide2.xml.rels"], undefined);
  assert.deepEqual(
    Object.keys(deletedEntries).sort(),
    Object.keys(original).sort(),
  );
  assert.equal(
    hash(deletedEntries["ppt/slides/slide1.xml"]),
    hash(original["ppt/slides/slide1.xml"]),
  );
  assert.equal(
    hash(deletedEntries["ppt/theme/theme1.xml"]),
    hash(original["ppt/theme/theme1.xml"]),
  );
});

test("browser OOXML worker changes slide metadata without rewriting unrelated package parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const renamed = applyOoxmlCommand(source, {
    op: "rename_slide",
    slideIndex: 0,
    name: "Browser 검증 슬라이드",
  });
  const renamedEntries = unzipSync(renamed.bytes);
  assert.equal(renamed.report.previous, "");
  assert.equal(renamed.report.value, "Browser 검증 슬라이드");
  assert.deepEqual(renamed.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(changedLogicalParts(original, renamedEntries), [
    "ppt/slides/slide1.xml",
  ]);
  assert.match(
    strFromU8(renamedEntries["ppt/slides/slide1.xml"]),
    /<p:cSld\b[^>]*name="Browser 검증 슬라이드"/u,
  );

  const hidden = applyOoxmlCommand(renamed.bytes, {
    op: "set_slide_hidden",
    slideIndex: 0,
    hidden: true,
  });
  const hiddenEntries = unzipSync(hidden.bytes);
  assert.equal(hidden.report.previous, false);
  assert.equal(hidden.report.value, true);
  assert.deepEqual(hidden.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.match(
    strFromU8(hiddenEntries["ppt/slides/slide1.xml"]),
    /<p:sld\b[^>]*show="0"/u,
  );
  for (const part of Object.keys(original))
    if (part !== "ppt/slides/slide1.xml")
      assert.equal(hash(hiddenEntries[part]), hash(original[part]), part);

  const visible = applyOoxmlCommand(hidden.bytes, {
    op: "set_slide_hidden",
    slideIndex: 0,
    hidden: false,
  });
  assert.equal(visible.report.previous, true);
  assert.equal(visible.report.value, false);
  assert.doesNotMatch(
    strFromU8(unzipSync(visible.bytes)["ppt/slides/slide1.xml"]),
    /<p:sld\b[^>]*show=/u,
  );
});

test("browser slide metadata validates values and treats identical values as a no-op", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const named = applyOoxmlCommand(source, {
    op: "rename_slide",
    slideIndex: 0,
    name: "Stable name",
  });
  const repeated = applyOoxmlCommand(named.bytes, {
    op: "rename_slide",
    slideIndex: 0,
    name: "Stable name",
  });
  assert.deepEqual(repeated.report.changedParts, []);
  assert.deepEqual(
    changedLogicalParts(unzipSync(named.bytes), unzipSync(repeated.bytes)),
    [],
  );
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "rename_slide",
        slideIndex: 0,
        name: "",
      }),
    /1 to 255 characters/iu,
  );
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "rename_slide",
        slideIndex: 0,
        name: "bad\u0000name",
      }),
    /control character/iu,
  );
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "set_slide_hidden",
        slideIndex: 0,
        hidden: "yes",
      }),
    /hidden must be a boolean/iu,
  );
});

test("browser OOXML worker replaces text without rewriting unrelated package parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const replacement = "Spellbook 국소 저장 العربية";
  const edited = applyOoxmlCommand(source, {
    op: "replace_text",
    elementId: "0/0",
    expectedText: "Spellbook 검증 العربية",
    text: replacement,
  });
  const entries = unzipSync(edited.bytes);
  assert.deepEqual(edited.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.equal(edited.report.persistedSemanticVerified, true);
  assert.deepEqual(changedLogicalParts(original, entries), [
    "ppt/slides/slide1.xml",
  ]);
  assert.match(
    strFromU8(entries["ppt/slides/slide1.xml"]),
    new RegExp(replacement, "u"),
  );
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "replace_text",
        elementId: "0/0",
        expectedText: "stale text",
        text: replacement,
      }),
    /changed after observation/iu,
  );
});

test("saved element readback rejects a lost text, geometry or style edit", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const commands = [
    {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Persisted title",
    },
    {
      op: "move",
      elementId: "0/0",
      expectedX: 5321,
      expectedY: 2540,
      x: 5421,
      y: 2640,
    },
    {
      op: "fill_color",
      elementId: "0/1",
      expectedColor: 0x2563eb,
      color: 0x112233,
    },
  ];
  for (const command of commands) {
    const edited = applyOoxmlCommand(source, command);
    assert.doesNotThrow(() =>
      verifyPersistedElementMutation(source, edited.bytes, command),
    );
    assert.throws(
      () => verifyPersistedElementMutation(source, source, command),
      /browser_package_semantics_not_persisted/u,
      command.op,
    );
  }
});

test("saved opacity readback preserves a themed color", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const entries = unzipSync(source);
  const slide = strFromU8(entries["ppt/slides/slide1.xml"]);
  assert.match(slide, /<a:srgbClr val="2563EB"\/>/u);
  entries["ppt/slides/slide1.xml"] = strToU8(
    slide.replace('<a:srgbClr val="2563EB"/>', '<a:schemeClr val="accent1"/>'),
  );
  const themed = zipSync(entries);
  const command = {
    op: "fill_opacity",
    elementId: "0/1",
    expectedOpacity: 100,
    opacity: 75,
    expectedColor: 0x2563eb,
  };
  const edited = applyOoxmlCommand(themed, command);
  assert.doesNotThrow(() =>
    verifyPersistedElementMutation(themed, edited.bytes, command),
  );
  assert.match(
    strFromU8(unzipSync(edited.bytes)["ppt/slides/slide1.xml"]),
    /<a:schemeClr val="accent1"><a:alpha val="75000"\/><\/a:schemeClr>/u,
  );
});

test("browser OOXML worker applies observed geometry deltas to one slide part", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const moved = applyOoxmlCommand(source, {
    op: "move",
    elementId: "0/0",
    expectedX: 5321,
    expectedY: 2540,
    x: 5421,
    y: 2640,
  });
  assert.deepEqual(moved.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.deepEqual(changedLogicalParts(original, unzipSync(moved.bytes)), [
    "ppt/slides/slide1.xml",
  ]);
  const movedTransform = firstShapeTransform(unzipSync(moved.bytes));
  assert.equal(movedTransform.offset.getAttribute("x"), "950400");
  assert.equal(movedTransform.offset.getAttribute("y"), "950400");

  const resized = applyOoxmlCommand(moved.bytes, {
    op: "resize",
    elementId: "0/0",
    expectedWidth: 8406,
    expectedHeight: 1265,
    width: 8506,
    height: 1365,
  });
  assert.deepEqual(resized.report.changedParts, ["ppt/slides/slide1.xml"]);
  const resizedTransform = firstShapeTransform(unzipSync(resized.bytes));
  assert.equal(resizedTransform.extent.getAttribute("cx"), "5065200");
  assert.equal(resizedTransform.extent.getAttribute("cy"), "858960");

  const unchanged = applyOoxmlCommand(resized.bytes, {
    op: "move",
    elementId: "0/0",
    expectedX: 5421,
    expectedY: 2640,
    x: 5421,
    y: 2640,
  });
  assert.deepEqual(unchanged.report.changedParts, []);
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "move",
        elementId: "0/0/0",
        expectedX: 0,
        expectedY: 0,
        x: 1,
        y: 1,
      }),
    /top-level shape/iu,
  );
});

test("moving or resizing a placeholder writes the position it inherits first", async () => {
  const fixture = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  // The first shape becomes a placeholder with no a:xfrm of its own, as
  // PowerPoint saves titles and bodies that keep their layout position.
  const withPlaceholder = (placeholder, layout) => {
    const slide = strFromU8(fixture["ppt/slides/slide1.xml"])
      .replace(
        '<p:cNvSpPr txBox="1"/><p:nvPr/>',
        `<p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr>`,
      )
      .replace(
        '<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5029200" cy="822960"/></a:xfrm>',
        "",
      );
    const rels = strFromU8(fixture["ppt/slides/_rels/slide1.xml.rels"]).replace(
      "slideLayout7.xml",
      layout,
    );
    return zipSync({
      ...fixture,
      "ppt/slides/slide1.xml": strToU8(slide),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(rels),
    });
  };
  const move = {
    op: "move",
    elementId: "0/0",
    expectedX: 0,
    expectedY: 0,
    x: 100,
    y: -100,
  };

  // A title takes its layout's position; only the moved offset changes.
  const title = firstShapeTransform(
    unzipSync(
      applyOoxmlCommand(
        withPlaceholder('<p:ph type="ctrTitle"/>', "slideLayout1.xml"),
        move,
      ).bytes,
    ),
  );
  assert.equal(title.offset.getAttribute("x"), String(685800 + 36000));
  assert.equal(title.offset.getAttribute("y"), String(2130425 - 36000));
  assert.equal(title.extent.getAttribute("cx"), "7772400");
  assert.equal(title.extent.getAttribute("cy"), "1470025");

  // A footer whose layout placeholder has no position takes the master's,
  // matched by type although the layout and master number it differently.
  const footer = firstShapeTransform(
    unzipSync(
      applyOoxmlCommand(
        withPlaceholder(
          '<p:ph type="ftr" sz="quarter" idx="11"/>',
          "slideLayout7.xml",
        ),
        {
          op: "resize",
          elementId: "0/0",
          expectedWidth: 1000,
          expectedHeight: 1000,
          width: 1100,
          height: 1000,
        },
      ).bytes,
    ),
  );
  assert.equal(footer.offset.getAttribute("x"), "3124200");
  assert.equal(footer.extent.getAttribute("cx"), String(2895600 + 36000));
  assert.equal(footer.extent.getAttribute("cy"), "365125");

  // A shape that is not a placeholder still needs its own position.
  assert.throws(
    () => applyOoxmlCommand(withPlaceholder("", "slideLayout1.xml"), move),
    /xfrm/u,
  );
});

test("browser OOXML worker writes local shape appearance without touching theme parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const commands = [
    {
      op: "rotate",
      elementId: "0/1",
      expectedRotation: 0,
      rotation: 1500,
    },
    {
      op: "fill_color",
      elementId: "0/1",
      expectedColor: 0x2563eb,
      color: 0x112233,
    },
    {
      op: "line_color",
      elementId: "0/1",
      expectedColor: 0x1e3a8a,
      color: 0x445566,
    },
    {
      op: "line_width",
      elementId: "0/1",
      expectedWidth: 26,
      width: 100,
    },
    {
      op: "fill_opacity",
      elementId: "0/1",
      expectedOpacity: 100,
      opacity: 75,
      expectedColor: 0x112233,
    },
    {
      op: "line_opacity",
      elementId: "0/1",
      expectedOpacity: 100,
      opacity: 60,
      expectedColor: 0x445566,
    },
  ];
  let candidate = source;
  for (const command of commands) {
    const result = applyOoxmlCommand(candidate, command);
    assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
    candidate = result.bytes;
  }
  const entries = unzipSync(candidate);
  assert.deepEqual(changedLogicalParts(original, entries), [
    "ppt/slides/slide1.xml",
  ]);
  const appearance = secondShapeAppearance(entries);
  assert.equal(appearance.transform.getAttribute("rot"), "900000");
  assert.equal(appearance.fillColor.getAttribute("val"), "112233");
  assert.equal(appearance.fillAlpha.getAttribute("val"), "75000");
  assert.equal(appearance.line.getAttribute("w"), "36000");
  assert.equal(appearance.lineColor.getAttribute("val"), "445566");
  assert.equal(appearance.lineAlpha.getAttribute("val"), "60000");
  assert.equal(
    hash(entries["ppt/theme/theme1.xml"]),
    hash(original["ppt/theme/theme1.xml"]),
  );
});

test("a colour command adds no opacity and draws a fill or line that was not drawn", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const shapeProperties = (bytes, index) => {
    const slide = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
    return [...slide.matchAll(/<p:spPr>[\s\S]*?<\/p:spPr>/gu)][index][0];
  };

  // The rectangle's fill has no opacity of its own; recolouring it must not
  // invent one (it was written as val="undefined", read back as 0%).
  const recolored = applyOoxmlCommand(source, {
    op: "fill_color",
    elementId: "0/1",
    expectedColor: 0x2563eb,
    expectedSolid: true,
    color: 0x112233,
  });
  assert.match(
    shapeProperties(recolored.bytes, 1),
    /<a:solidFill><a:srgbClr val="112233"\/><\/a:solidFill>/u,
  );
  assert.doesNotMatch(shapeProperties(recolored.bytes, 1), /<a:alpha/u);

  // The text box draws neither a fill nor a line. Their hidden colours
  // already equal the requested ones, which must still become visible.
  const fillCommand = {
    op: "fill_color",
    elementId: "0/0",
    expectedColor: 0x729fcf,
    expectedSolid: false,
    color: 0x729fcf,
  };
  const filled = applyOoxmlCommand(source, fillCommand);
  assert.deepEqual(filled.report.changedParts, ["ppt/slides/slide1.xml"]);
  assert.doesNotThrow(() =>
    verifyPersistedElementMutation(source, filled.bytes, fillCommand),
  );
  const outlined = applyOoxmlCommand(filled.bytes, {
    op: "line_color",
    elementId: "0/0",
    expectedColor: 0x3465a4,
    expectedSolid: false,
    color: 0x3465a4,
  });
  const textBox = shapeProperties(outlined.bytes, 0);
  assert.doesNotMatch(textBox, /<a:noFill\/>/u);
  assert.match(
    textBox,
    /<a:solidFill><a:srgbClr val="729FCF"\/><\/a:solidFill><a:ln><a:solidFill><a:srgbClr val="3465A4"\/><\/a:solidFill><\/a:ln>/u,
  );
});

test("browser OOXML worker writes local text appearance without touching theme parts", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(source);
  const commands = [
    {
      op: "font_size",
      elementId: "0/0",
      expectedSize: 2400,
      size: 2800,
    },
    {
      op: "bold",
      elementId: "0/0",
      expectedBold: false,
      bold: true,
    },
    {
      op: "italic",
      elementId: "0/0",
      expectedItalic: false,
      italic: true,
    },
    {
      op: "underline",
      elementId: "0/0",
      expectedUnderline: false,
      underline: true,
    },
    {
      op: "strikethrough",
      elementId: "0/0",
      expectedStrikethrough: false,
      strikethrough: true,
    },
    {
      op: "font_family",
      elementId: "0/0",
      expectedFamily: "Liberation Sans",
      family: "Noto Sans",
    },
    {
      op: "font_color",
      elementId: "0/0",
      expectedColor: 0x11181f,
      color: 0x334455,
    },
    {
      op: "paragraph_alignment",
      elementId: "0/0",
      expectedAlignment: "left",
      alignment: "center",
    },
  ];
  let candidate = source;
  for (const command of commands) {
    const result = applyOoxmlCommand(candidate, command);
    assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
    candidate = result.bytes;
  }
  const entries = unzipSync(candidate);
  assert.deepEqual(changedLogicalParts(original, entries), [
    "ppt/slides/slide1.xml",
  ]);
  const appearance = firstTextAppearance(entries);
  assert.equal(appearance.runProperties.getAttribute("sz"), "2800");
  assert.equal(appearance.runProperties.getAttribute("b"), "1");
  assert.equal(appearance.runProperties.getAttribute("i"), "1");
  assert.equal(appearance.runProperties.getAttribute("u"), "sng");
  assert.equal(appearance.runProperties.getAttribute("strike"), "sngStrike");
  assert.deepEqual(
    [appearance.latin, appearance.eastAsian, appearance.complex].map(
      (element) => element.getAttribute("typeface"),
    ),
    ["Noto Sans", "Noto Sans", "Noto Sans"],
  );
  assert.equal(appearance.color.getAttribute("val"), "334455");
  assert.equal(appearance.paragraphProperties.getAttribute("algn"), "ctr");
  assert.equal(
    hash(entries["ppt/theme/theme1.xml"]),
    hash(original["ppt/theme/theme1.xml"]),
  );
});

test("browser sections preserve identity across topology and change only presentation metadata", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const duplicated = applyOoxmlCommand(source, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  const beforeSections = unzipSync(duplicated.bytes);
  const sectioned = applyOoxmlCommand(duplicated.bytes, {
    op: "set_sections",
    sections: [
      {
        id: "{11111111-1111-4111-8111-111111111111}",
        name: "Opening",
        startSlideIndex: 0,
      },
      {
        id: "{22222222-2222-4222-8222-222222222222}",
        name: "Details",
        startSlideIndex: 1,
      },
    ],
  });
  assert.deepEqual(sectioned.report.changedParts, ["ppt/presentation.xml"]);
  assert.deepEqual(
    changedLogicalParts(beforeSections, unzipSync(sectioned.bytes)),
    ["ppt/presentation.xml"],
  );
  assert.deepEqual(inspectOoxmlDocument(sectioned.bytes).sections, [
    {
      id: "{11111111-1111-4111-8111-111111111111}",
      name: "Opening",
      startSlideIndex: 0,
      slideCount: 1,
    },
    {
      id: "{22222222-2222-4222-8222-222222222222}",
      name: "Details",
      startSlideIndex: 1,
      slideCount: 1,
    },
  ]);
  const inserted = applyOoxmlCommand(sectioned.bytes, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  assert.deepEqual(
    inspectOoxmlDocument(inserted.bytes).sections.map(
      ({ startSlideIndex, slideCount }) => ({ startSlideIndex, slideCount }),
    ),
    [
      { startSlideIndex: 0, slideCount: 2 },
      { startSlideIndex: 2, slideCount: 1 },
    ],
  );
  const deleted = applyOoxmlCommand(inserted.bytes, {
    op: "delete_slide",
    slideIndex: 1,
  });
  assert.deepEqual(
    inspectOoxmlDocument(deleted.bytes).sections.map(
      ({ startSlideIndex, slideCount }) => ({ startSlideIndex, slideCount }),
    ),
    [
      { startSlideIndex: 0, slideCount: 1 },
      { startSlideIndex: 1, slideCount: 1 },
    ],
  );
  const cleared = applyOoxmlCommand(deleted.bytes, {
    op: "set_sections",
    sections: [],
  });
  assert.deepEqual(inspectOoxmlDocument(cleared.bytes).sections, []);
  assert.throws(
    () =>
      applyOoxmlCommand(duplicated.bytes, {
        op: "set_sections",
        sections: [
          {
            id: "{11111111-1111-4111-8111-111111111111}",
            name: "Bad boundary",
            startSlideIndex: 1,
          },
        ],
      }),
    /start at slide 0/iu,
  );
});

test("browser OOXML worker clones and garbage-collects owned dependency graphs", async () => {
  const source = withOwnedDependencyGraph(
    new Uint8Array(await readFile(fixtureUrl)),
  );
  const duplicated = applyOoxmlCommand(source, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  const duplicateEntries = unzipSync(duplicated.bytes);
  const clonedChart = "ppt/charts/chart1-spellbook-1.xml";
  const clonedWorkbook =
    "ppt/embeddings/Microsoft_Excel_Worksheet1-spellbook-1.xlsx";
  assert.ok(duplicateEntries[clonedChart]);
  assert.ok(
    duplicateEntries[
      `${clonedChart.slice(0, 11)}_rels/${clonedChart.slice(11)}.rels`
    ],
  );
  assert.ok(duplicateEntries[clonedWorkbook]);
  assert.equal(
    hash(duplicateEntries[clonedChart]),
    hash(duplicateEntries["ppt/charts/chart1.xml"]),
  );
  assert.equal(
    hash(duplicateEntries[clonedWorkbook]),
    hash(duplicateEntries["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"]),
  );

  const deleted = applyOoxmlCommand(duplicated.bytes, {
    op: "delete_slide",
    slideIndex: 1,
  });
  const deletedEntries = unzipSync(deleted.bytes);
  assert.deepEqual(deleted.report.removedParts, [
    clonedChart,
    clonedWorkbook,
    "ppt/slides/slide2.xml",
  ]);
  assert.equal(deletedEntries[clonedChart], undefined);
  assert.equal(deletedEntries[clonedWorkbook], undefined);
  assert.ok(deletedEntries["ppt/charts/chart1.xml"]);
  assert.ok(deletedEntries["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"]);
});

test("browser OOXML worker refuses to delete the final slide", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "delete_slide",
        slideIndex: 0,
      }),
    /last slide cannot be deleted/iu,
  );
});

test("browser OOXML worker rejects non-PPTX and unsupported commands", async () => {
  assert.throws(
    () =>
      applyOoxmlCommand(new Uint8Array([1, 2, 3]), {
        op: "add_slide",
        templateSlideIndex: 0,
        insertIndex: 1,
      }),
    /PPTX ZIP end record is missing/iu,
  );
  const source = new Uint8Array(await readFile(fixtureUrl));
  assert.throws(
    () =>
      applyOoxmlCommand(source, {
        op: "unsupported_edit",
      }),
    /Unsupported browser OOXML operation/iu,
  );
});

test("browser OOXML worker rejects unsafe package paths before mutation", () => {
  const unsafe = zipSync({
    "../outside.xml": strToU8("<outside/>", true),
  });
  assert.throws(
    () =>
      applyOoxmlCommand(unsafe, {
        op: "add_slide",
        templateSlideIndex: 0,
        insertIndex: 1,
      }),
    /Unsafe or duplicate PPTX ZIP entry/iu,
  );
});

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function changedLogicalParts(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter(
      (name) =>
        !before[name] ||
        !after[name] ||
        hash(before[name]) !== hash(after[name]),
    )
    .sort();
}

function slidePaths(entries) {
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const relationshipAttributeNamespace =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const packageRelationshipNamespace =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  const presentation = new DOMParser().parseFromString(
    strFromU8(entries["ppt/presentation.xml"]),
    "application/xml",
  );
  const relationships = new DOMParser().parseFromString(
    strFromU8(entries["ppt/_rels/presentation.xml.rels"]),
    "application/xml",
  );
  const targets = new Map(
    [
      ...relationships.getElementsByTagNameNS(
        packageRelationshipNamespace,
        "Relationship",
      ),
    ].map((relationship) => [
      relationship.getAttribute("Id"),
      relationship.getAttribute("Target"),
    ]),
  );
  return [
    ...presentation.getElementsByTagNameNS(presentationNamespace, "sldId"),
  ].map((slideId) => {
    const relationshipId = slideId.getAttributeNS(
      relationshipAttributeNamespace,
      "id",
    );
    const target = targets.get(relationshipId);
    assert.ok(target, `Missing relationship ${relationshipId}`);
    return new URL(
      target,
      "https://package.invalid/ppt/presentation.xml",
    ).pathname.replace(/^\//u, "");
  });
}

function firstShapeTransform(entries) {
  const drawingNamespace =
    "http://schemas.openxmlformats.org/drawingml/2006/main";
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const slide = new DOMParser().parseFromString(
    strFromU8(entries["ppt/slides/slide1.xml"]),
    "application/xml",
  );
  const shape = slide.getElementsByTagNameNS(presentationNamespace, "sp")[0];
  const transform = shape.getElementsByTagNameNS(drawingNamespace, "xfrm")[0];
  return {
    offset: transform.getElementsByTagNameNS(drawingNamespace, "off")[0],
    extent: transform.getElementsByTagNameNS(drawingNamespace, "ext")[0],
  };
}

function secondShapeAppearance(entries) {
  const drawingNamespace =
    "http://schemas.openxmlformats.org/drawingml/2006/main";
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const slide = new DOMParser().parseFromString(
    strFromU8(entries["ppt/slides/slide1.xml"]),
    "application/xml",
  );
  const shape = slide.getElementsByTagNameNS(presentationNamespace, "sp")[1];
  const properties = shape.getElementsByTagNameNS(
    presentationNamespace,
    "spPr",
  )[0];
  const transform = properties.getElementsByTagNameNS(
    drawingNamespace,
    "xfrm",
  )[0];
  const fills = properties.getElementsByTagNameNS(
    drawingNamespace,
    "solidFill",
  );
  const line = properties.getElementsByTagNameNS(drawingNamespace, "ln")[0];
  const fillColor = fills[0].getElementsByTagNameNS(
    drawingNamespace,
    "srgbClr",
  )[0];
  const lineColor = line.getElementsByTagNameNS(drawingNamespace, "srgbClr")[0];
  return {
    transform,
    fillColor,
    fillAlpha: fillColor.getElementsByTagNameNS(drawingNamespace, "alpha")[0],
    line,
    lineColor,
    lineAlpha: lineColor.getElementsByTagNameNS(drawingNamespace, "alpha")[0],
  };
}

function firstTextAppearance(entries) {
  const drawingNamespace =
    "http://schemas.openxmlformats.org/drawingml/2006/main";
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const slide = new DOMParser().parseFromString(
    strFromU8(entries["ppt/slides/slide1.xml"]),
    "application/xml",
  );
  const shape = slide.getElementsByTagNameNS(presentationNamespace, "sp")[0];
  const paragraph = shape.getElementsByTagNameNS(drawingNamespace, "p")[0];
  const runProperties = paragraph.getElementsByTagNameNS(
    drawingNamespace,
    "rPr",
  )[0];
  const color = runProperties.getElementsByTagNameNS(
    drawingNamespace,
    "srgbClr",
  )[0];
  return {
    runProperties,
    latin: runProperties.getElementsByTagNameNS(drawingNamespace, "latin")[0],
    eastAsian: runProperties.getElementsByTagNameNS(drawingNamespace, "ea")[0],
    complex: runProperties.getElementsByTagNameNS(drawingNamespace, "cs")[0],
    color,
    paragraphProperties: paragraph.getElementsByTagNameNS(
      drawingNamespace,
      "pPr",
    )[0],
  };
}

function withOwnedDependencyGraph(source) {
  const entries = unzipSync(source);
  const slideRelationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  const slideRelationships = strFromU8(entries[slideRelationshipsPath]).replace(
    "</Relationships>",
    '<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
  );
  entries[slideRelationshipsPath] = strToU8(slideRelationships);
  entries["ppt/charts/chart1.xml"] = strToU8(
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
  );
  entries["ppt/charts/_rels/chart1.xml.rels"] = strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/></Relationships>',
  );
  entries["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"] = strToU8(
    "owned-workbook-fixture",
  );
  const contentTypes = strFromU8(entries["[Content_Types].xml"]).replace(
    "</Types>",
    '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>',
  );
  entries["[Content_Types].xml"] = strToU8(contentTypes);
  return zipSync(entries, { level: 6 });
}

function withAuthoredTransitionSound(source) {
  const entries = unzipSync(source);
  const slidePath = "ppt/slides/slide1.xml";
  const relationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  entries["ppt/media/transition.wav"] = strToU8("RIFF");
  entries[relationshipsPath] = strToU8(
    strFromU8(entries[relationshipsPath]).replace(
      "</Relationships>",
      '<Relationship Id="rIdTransitionSound" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/transition.wav"/></Relationships>',
    ),
  );
  const authored =
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="slow" advTm="5000" p14:dur="2000"><p:sndAc><p:stSnd><p:snd r:embed="rIdTransitionSound" name="transition.wav"/></p:stSnd></p:sndAc></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow" advTm="5000"><p:sndAc><p:stSnd><p:snd r:embed="rIdTransitionSound" name="transition.wav"/></p:stSnd></p:sndAc></p:transition></mc:Fallback></mc:AlternateContent>';
  const slide = strFromU8(entries[slidePath]);
  const withTransition = slide.replace(/<\/p:sld>\s*$/u, `${authored}</p:sld>`);
  assert.notEqual(withTransition, slide);
  entries[slidePath] = strToU8(withTransition);
  return { entries, slidePath };
}

function withEngineTransition(entries, slidePath, transition) {
  const slide = strFromU8(entries[slidePath]).replace(
    /<mc:AlternateContent[\s\S]*<\/mc:AlternateContent>/u,
    transition,
  );
  return { ...entries, [slidePath]: strToU8(slide) };
}

test("native snapshot keeps the author's transition when the edit did not change it", async () => {
  const fixture = new Uint8Array(await readFile(fixtureUrl));
  const { entries, slidePath } = withAuthoredTransitionSound(fixture);
  const source = zipSync(entries);
  const engineTransition = '<p:transition spd="slow" advTm="5000"/>';
  const noEdit = withEngineTransition(entries, slidePath, engineTransition);
  const edited = {
    ...noEdit,
    [slidePath]: strToU8(
      strFromU8(noEdit[slidePath]).replace(
        "Spellbook 검증 العربية",
        "Transition untouched",
      ),
    ),
  };
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["replace_text"],
  );
  const merged = strFromU8(unzipSync(result.bytes)[slidePath]);
  assert.match(merged, /Transition untouched/u);
  assert.match(merged, /p14:dur="2000"/u);
  assert.equal((merged.match(/rIdTransitionSound/gu) ?? []).length, 2);
});

test("native snapshot carries the author's transition sound into an edited transition", async () => {
  const fixture = new Uint8Array(await readFile(fixtureUrl));
  const { entries, slidePath } = withAuthoredTransitionSound(fixture);
  const source = zipSync(entries);
  const noEdit = withEngineTransition(
    entries,
    slidePath,
    '<p:transition spd="slow" advTm="5000"/>',
  );
  const edited = withEngineTransition(
    entries,
    slidePath,
    '<p:transition spd="med" advTm="5000"><p:fade/></p:transition>',
  );
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    ["set_slide_transition"],
  );
  const merged = strFromU8(unzipSync(result.bytes)[slidePath]);
  assert.match(
    merged,
    /<p:transition spd="med" advTm="5000"><p:fade\/><p:sndAc><p:stSnd><p:snd r:embed="rIdTransitionSound" name="transition.wav"\/><\/p:stSnd><\/p:sndAc><\/p:transition>/u,
  );
  assert.ok(result.report.semanticPatchedParts.includes(slidePath));
});

test("native snapshot accepts a direct human edit without an operation list", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const noEdit = unzipSync(source);
  const edited = unzipSync(
    applyOoxmlCommand(source, {
      op: "replace_text",
      elementId: "0/0",
      expectedText: "Spellbook 검증 العربية",
      text: "Typed by a person",
    }).bytes,
  );
  edited["ppt/vbaProject.bin"] = strToU8("macro");
  const result = preserveOriginalPptxParts(
    source,
    zipSync(noEdit),
    zipSync(edited),
    null,
  );
  const merged = unzipSync(result.bytes);
  assert.match(
    strFromU8(merged["ppt/slides/slide1.xml"]),
    /Typed by a person/u,
  );
  assert.equal(merged["ppt/vbaProject.bin"], undefined);
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
});

function withSmartArtGraph(entries, { ids, drawing, data }) {
  const slidePath = "ppt/slides/slide1.xml";
  const relationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  const type = (name) =>
    name === "diagramDrawing"
      ? "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"
      : `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`;
  const next = { ...entries };
  const relationships = strFromU8(next[relationshipsPath]).replace(
    /<Relationship [^>]*diagram[^>]*\/>/gu,
    "",
  );
  const added = [
    ["dm", "diagramData", "../diagrams/data1.xml"],
    ["lo", "diagramLayout", "../diagrams/layout1.xml"],
    ["qs", "diagramQuickStyle", "../diagrams/quickStyle1.xml"],
    ["cs", "diagramColors", "../diagrams/colors1.xml"],
    ...(drawing ? [["dr", "diagramDrawing", "../diagrams/drawing1.xml"]] : []),
  ]
    .map(
      ([role, name, target]) =>
        `<Relationship Id="${ids[role]}" Type="${type(name)}" Target="${target}"/>`,
    )
    .join("");
  next[relationshipsPath] = strToU8(
    relationships.replace("</Relationships>", `${added}</Relationships>`),
  );
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Diagram 90"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="${ids.dm}" r:lo="${ids.lo}" r:qs="${ids.qs}" r:cs="${ids.cs}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  next[slidePath] = strToU8(
    strFromU8(next[slidePath])
      .replace(
        /<p:graphicFrame>[\s\S]*?Diagram 90[\s\S]*?<\/p:graphicFrame>/u,
        "",
      )
      .replace("</p:spTree>", `${frame}</p:spTree>`),
  );
  for (const name of ["layout1", "quickStyle1", "colors1"])
    next[`ppt/diagrams/${name}.xml`] = strToU8(`<${name}/>`);
  next["ppt/diagrams/data1.xml"] = strToU8(`<dataModel>${data}</dataModel>`);
  const contentTypes = strFromU8(next["[Content_Types].xml"]).replace(
    /<Override PartName="\/ppt\/diagrams\/drawing1.xml"[^>]*\/>/u,
    "",
  );
  if (drawing) {
    next["ppt/diagrams/drawing1.xml"] = strToU8("<cachedDrawing/>");
    next["[Content_Types].xml"] = strToU8(
      contentTypes.replace(
        "</Types>",
        '<Override PartName="/ppt/diagrams/drawing1.xml" ContentType="application/vnd.ms-office.drawingml.diagramDrawing+xml"/></Types>',
      ),
    );
  } else {
    delete next["ppt/diagrams/drawing1.xml"];
    next["[Content_Types].xml"] = strToU8(contentTypes);
  }
  return next;
}

test("native snapshot maps renumbered relationships back and drops a stale SmartArt drawing", async () => {
  const fixture = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const authorIds = {
    dm: "rId12",
    lo: "rId13",
    qs: "rId14",
    cs: "rId15",
    dr: "rId16",
  };
  const engineIds = { dm: "rId21", lo: "rId22", qs: "rId23", cs: "rId24" };
  const original = withSmartArtGraph(fixture, {
    ids: authorIds,
    drawing: true,
    data: "Before",
  });
  const noEdit = withSmartArtGraph(fixture, {
    ids: engineIds,
    drawing: false,
    data: "Before",
  });
  const edited = withSmartArtGraph(fixture, {
    ids: engineIds,
    drawing: false,
    data: "After",
  });
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(noEdit),
    zipSync(edited),
    ["set_smartart_node"],
  );
  const merged = unzipSync(result.bytes);
  const slide = strFromU8(merged["ppt/slides/slide1.xml"]);
  const relationships = strFromU8(merged["ppt/slides/_rels/slide1.xml.rels"]);
  assert.match(slide, /r:dm="rId12" r:lo="rId13" r:qs="rId14" r:cs="rId15"/u);
  assert.match(strFromU8(merged["ppt/diagrams/data1.xml"]), /After/u);
  assert.equal(merged["ppt/diagrams/drawing1.xml"], undefined);
  assert.doesNotMatch(relationships, /diagramDrawing/u);
  assert.doesNotMatch(
    strFromU8(merged["[Content_Types].xml"]),
    /diagrams\/drawing1\.xml/u,
  );
  assert.match(relationships, /Id="rId12"[^>]*diagramData/u);
});

test("native snapshot rebinds a restored transition sound to its own relationship", async () => {
  const fixture = new Uint8Array(await readFile(fixtureUrl));
  const { entries, slidePath } = withAuthoredTransitionSound(fixture);
  const relationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  const engineRelationships = (extra) =>
    strToU8(
      strFromU8(entries[relationshipsPath])
        .replace(/<Relationship Id="rIdTransitionSound"[^>]*\/>/u, "")
        .replace("</Relationships>", `${extra}</Relationships>`),
    );
  // The engine drops the sound and later reuses its id for a new hyperlink.
  const noEdit = withEngineTransition(
    entries,
    slidePath,
    '<p:transition spd="slow" advTm="5000"/>',
  );
  delete noEdit["ppt/media/transition.wav"];
  noEdit[relationshipsPath] = engineRelationships("");
  const edited = {
    ...noEdit,
    [relationshipsPath]: engineRelationships(
      '<Relationship Id="rIdTransitionSound" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide1.xml"/>',
    ),
  };
  const result = preserveOriginalPptxParts(
    zipSync(entries),
    zipSync(noEdit),
    zipSync(edited),
    ["set_object_interaction"],
  );
  const merged = unzipSync(result.bytes);
  const slide = strFromU8(merged[slidePath]);
  const relationships = strFromU8(merged[relationshipsPath]);
  const soundIds = [...slide.matchAll(/<p:snd r:embed="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  assert.equal(soundIds.length, 2);
  assert.equal(new Set(soundIds).size, 1);
  assert.notEqual(soundIds[0], "rIdTransitionSound");
  assert.match(
    relationships,
    new RegExp(
      `<Relationship Id="${soundIds[0]}" Type="[^"]*/audio" Target="../media/transition.wav"/>`,
      "u",
    ),
  );
  assert.match(
    relationships,
    /<Relationship Id="rIdTransitionSound" Type="[^"]*\/slide" Target="slide1.xml"\/>/u,
  );
  assert.ok(merged["ppt/media/transition.wav"]);
  assert.ok(result.report.semanticPatchedParts.includes(relationshipsPath));
});

test("native snapshot declares content types for author parts the engine dropped", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const printerSettings = "ppt/printerSettings/printerSettings1.bin";
  const sound = "ppt/media/Cortázar.wav";
  original[sound] = strToU8("RIFF");
  original["[Content_Types].xml"] = strToU8(
    strFromU8(original["[Content_Types].xml"]).replace(
      "</Types>",
      '<Override PartName="/ppt/media/Cort%C3%A1zar.wav" ContentType="audio/wav"/></Types>',
    ),
  );
  // Like LibreOffice: no printer settings, no unreferenced sound, and a
  // manifest that no longer declares either.
  const noEdit = { ...original };
  delete noEdit[printerSettings];
  delete noEdit[sound];
  noEdit["[Content_Types].xml"] = strToU8(
    strFromU8(original["[Content_Types].xml"])
      .replace(/<Default Extension="bin"[^>]*\/>/u, "")
      .replace(/<Override PartName="\/ppt\/media\/Cort[^>]*\/>/u, ""),
  );
  const edited = {
    ...noEdit,
    "ppt/media/image-new.png": strToU8("PNG"),
    "[Content_Types].xml": strToU8(
      strFromU8(noEdit["[Content_Types].xml"]).replace(
        "<Default ",
        '<Default Extension="png" ContentType="image/png"/><Default ',
      ),
    ),
  };
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(noEdit),
    zipSync(edited),
    ["insert_image"],
  );
  const merged = unzipSync(result.bytes);
  const contentTypes = strFromU8(merged["[Content_Types].xml"]);
  assert.ok(merged[printerSettings]);
  assert.ok(merged[sound]);
  assert.ok(merged["ppt/media/image-new.png"]);
  assert.match(
    contentTypes,
    /<Default Extension="bin" ContentType="application\/vnd.openxmlformats-officedocument.presentationml.printerSettings"\/>/u,
  );
  assert.match(
    contentTypes,
    /<Default Extension="png" ContentType="image\/png"\/>/u,
  );
  assert.match(
    contentTypes,
    /<Override PartName="\/ppt\/media\/Cort%C3%A1zar.wav" ContentType="audio\/wav"\/>/u,
  );
  assert.ok(result.report.semanticPatchedParts.includes("[Content_Types].xml"));
});

test("native snapshot keeps the author's manifest when the engine declares .rels explicitly", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  assert.match(
    strFromU8(original["[Content_Types].xml"]),
    /<Default Extension="rels" /u,
  );
  // LibreOffice also writes an Override for the package relationships part,
  // which the author's Default for the "rels" extension already covers.
  const engineSave = (text) => ({
    ...original,
    "[Content_Types].xml": strToU8(
      strFromU8(original["[Content_Types].xml"]).replace(
        "</Types>",
        '<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      ),
    ),
    "ppt/slides/slide1.xml": strToU8(
      strFromU8(original["ppt/slides/slide1.xml"]).replace(
        "Spellbook 검증 العربية",
        text,
      ),
    ),
  });
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(engineSave("Spellbook 검증 العربية")),
    zipSync(engineSave("Edited")),
    ["replace_text"],
  );
  const merged = unzipSync(result.bytes);
  assert.deepEqual(
    merged["[Content_Types].xml"],
    original["[Content_Types].xml"],
  );
  assert.deepEqual(result.report.changedParts, ["ppt/slides/slide1.xml"]);
});

test("native snapshot removes the data part's pointer to a dropped SmartArt drawing", async () => {
  const fixture = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const authorIds = {
    dm: "rId12",
    lo: "rId13",
    qs: "rId14",
    cs: "rId15",
    dr: "rId16",
  };
  const engineIds = { dm: "rId21", lo: "rId22", qs: "rId23", cs: "rId24" };
  // LibreOffice writes the imported data model back with the author's
  // drawing pointer even when it does not write the drawing itself.
  const data = (text) =>
    `${text}<dgm:extLst xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId16" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst>`;
  const result = preserveOriginalPptxParts(
    zipSync(
      withSmartArtGraph(fixture, {
        ids: authorIds,
        drawing: true,
        data: data("Before"),
      }),
    ),
    zipSync(
      withSmartArtGraph(fixture, {
        ids: engineIds,
        drawing: false,
        data: data("Before"),
      }),
    ),
    zipSync(
      withSmartArtGraph(fixture, {
        ids: engineIds,
        drawing: false,
        data: data("After"),
      }),
    ),
    ["set_smartart_node"],
  );
  const merged = unzipSync(result.bytes);
  const dataModel = strFromU8(merged["ppt/diagrams/data1.xml"]);
  assert.match(dataModel, /After/u);
  assert.doesNotMatch(dataModel, /dataModelExt|extLst/u);
  assert.equal(merged["ppt/diagrams/drawing1.xml"], undefined);
  assert.ok(
    result.report.semanticPatchedParts.includes("ppt/diagrams/data1.xml"),
  );
});

test("native snapshot restores the transition sound on a slide the edit changed", async () => {
  const fixture = new Uint8Array(await readFile(fixtureUrl));
  const { entries, slidePath } = withAuthoredTransitionSound(fixture);
  const relationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  const engineTransition = '<p:transition spd="slow" advTm="5000"/>';
  const noEdit = withEngineTransition(entries, slidePath, engineTransition);
  delete noEdit["ppt/media/transition.wav"];
  noEdit[relationshipsPath] = strToU8(
    strFromU8(entries[relationshipsPath]).replace(
      /<Relationship Id="rIdTransitionSound"[^>]*\/>/u,
      "",
    ),
  );
  // The edit adds a hyperlink relationship under the id the author's sound
  // used, and changes the slide XML itself.
  const edited = {
    ...noEdit,
    [slidePath]: strToU8(
      strFromU8(noEdit[slidePath]).replace(
        "Spellbook 검증 العربية",
        "Linked text",
      ),
    ),
    [relationshipsPath]: strToU8(
      strFromU8(noEdit[relationshipsPath]).replace(
        "</Relationships>",
        '<Relationship Id="rIdTransitionSound" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide1.xml"/></Relationships>',
      ),
    ),
  };
  const result = preserveOriginalPptxParts(
    zipSync(entries),
    zipSync(noEdit),
    zipSync(edited),
    ["set_object_interaction"],
  );
  const merged = unzipSync(result.bytes);
  const slide = strFromU8(merged[slidePath]);
  const relationships = strFromU8(merged[relationshipsPath]);
  assert.match(slide, /Linked text/u);
  assert.match(slide, /p14:dur="2000"/u);
  const soundId = slide.match(/<p:snd r:embed="([^"]+)"/u)?.[1];
  assert.ok(soundId && soundId !== "rIdTransitionSound");
  assert.match(
    relationships,
    new RegExp(
      `<Relationship Id="${soundId}" Type="[^"]*/audio" Target="../media/transition.wav"/>`,
      "u",
    ),
  );
});

test("native snapshot rebinds a kept slide to renumbered engine relationships", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const slidePath = "ppt/slides/slide1.xml";
  const relationshipsPath = "ppt/slides/_rels/slide1.xml.rels";
  const image = (id) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/picture.jpeg"/>`;
  const layout =
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout7.xml"/>';
  const hyperlink = (target) =>
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`;
  const relationships = (...items) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`,
    );
  original["ppt/media/picture.jpeg"] = strToU8("JPEG");
  original[relationshipsPath] = relationships(
    layout,
    image("rIdAuthorPicture"),
  );
  original[slidePath] = strToU8(
    strFromU8(original[slidePath]).replace(
      "</p:spTree>",
      '<p:pic><p:nvPicPr><p:cNvPr id="77" name="Picture 77"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdAuthorPicture"/></p:blipFill><p:spPr/></p:pic></p:spTree>',
    ),
  );
  // The engine renumbers the picture and the edit only retargets a link in
  // the .rels, so the slide XML of both engine saves is identical.
  const engineSlide = strToU8(
    strFromU8(original[slidePath]).replace("rIdAuthorPicture", "rId2"),
  );
  const noEdit = {
    ...original,
    [slidePath]: engineSlide,
    [relationshipsPath]: relationships(
      layout,
      image("rId2"),
      hyperlink("https://before.example/"),
    ),
  };
  const edited = {
    ...noEdit,
    [relationshipsPath]: relationships(
      layout,
      image("rId2"),
      hyperlink("https://after.example/"),
    ),
  };
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(noEdit),
    zipSync(edited),
    ["set_object_interaction"],
  );
  const merged = unzipSync(result.bytes);
  assert.match(strFromU8(merged[slidePath]), /<a:blip r:embed="rId2"\/>/u);
  assert.match(
    strFromU8(merged[relationshipsPath]),
    /https:\/\/after\.example\//u,
  );
  assert.ok(result.report.semanticPatchedParts.includes(slidePath));
});

// An engine save that renumbers shape ids, rewrites the target's text and,
// as LibreOffice's live-document export does, drops the empty rectangle's
// paragraph alignment although the command never touched it.
function withEngineSave(entries, { shadow, keepRectangleAlignment }) {
  const slidePath = "ppt/slides/slide1.xml";
  const slide = strFromU8(entries[slidePath])
    .replace('id="2" name="TextBox 1"', 'id="67" name="TextBox 1"')
    .replace('id="3" name="Rectangle 2"', 'id="68" name="Rectangle 2"')
    .replace(
      '<a:latin typeface="Liberation Sans"/>',
      `${shadow ? '<a:effectLst><a:outerShdw dist="12700" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>' : ""}<a:latin typeface="Arial"/>`,
    )
    .replace(
      '<a:p><a:pPr algn="ctr"/></a:p>',
      keepRectangleAlignment
        ? '<a:p><a:pPr marR="0" algn="ctr"/><a:endParaRPr sz="1800"/></a:p>'
        : '<a:p><a:endParaRPr sz="1800"/></a:p>',
    );
  return { ...entries, [slidePath]: strToU8(slide) };
}

test("native snapshot keeps the authored XML of shapes a command did not name", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const noEdit = withEngineSave(original, {
    shadow: false,
    keepRectangleAlignment: true,
  });
  const edited = withEngineSave(original, {
    shadow: true,
    keepRectangleAlignment: false,
  });
  const preserve = (sourceTargets) =>
    strFromU8(
      unzipSync(
        preserveOriginalPptxParts(
          zipSync(original),
          zipSync(noEdit),
          zipSync(edited),
          ["text_shadow"],
          sourceTargets,
        ).bytes,
      )["ppt/slides/slide1.xml"],
    );
  const targeted = preserve([
    { op: "text_shadow", slideIndex: 0, name: "TextBox 1" },
  ]);
  assert.match(
    targeted,
    /<p:cNvPr id="3" name="Rectangle 2"\/>[\s\S]*<a:p><a:pPr algn="ctr"\/><\/a:p>/u,
  );
  // The named shape takes only the shadow the command added, in the engine's
  // element order; its id and font stay as the author wrote them although
  // the engine renumbered the shape and renamed Liberation Sans to Arial.
  assert.match(
    targeted,
    /<p:cNvPr id="2" name="TextBox 1"\/>[\s\S]*<a:effectLst><a:outerShdw dist="12700" dir="2700000"><a:srgbClr val="000000"\/><\/a:outerShdw><\/a:effectLst><a:latin typeface="Liberation Sans"\/>/u,
  );
  assert.doesNotMatch(targeted, /typeface="Arial"|id="67"/u);
  // Without the command's targets the rectangle looks changed by the edit,
  // so the merge cannot tell the engine's rewrite from an intended change.
  const untargeted = preserve(null);
  assert.doesNotMatch(untargeted, /<a:pPr algn="ctr"\/>/u);
});

// An engine save of the rectangle as LibreOffice writes it: explicit insets,
// no empty list style, an explicit end-of-paragraph font, lower-case colors
// and a size rounded through 1/100 mm.
function withEngineRectangle(entries, fill) {
  const slidePath = "ppt/slides/slide1.xml";
  const slide = strFromU8(entries[slidePath])
    .replace('id="3" name="Rectangle 2"', 'id="68" name="Rectangle 2"')
    .replace(
      '<a:ext cx="2926080" cy="1005840"/>',
      '<a:ext cx="2925720" cy="1005480"/>',
    )
    .replace('<a:srgbClr val="2563EB"/>', `<a:srgbClr val="${fill}"/>`)
    .replace('<a:srgbClr val="1E3A8A"/>', '<a:srgbClr val="1e3a8a"/>')
    .replace(
      '<a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/></a:p>',
      '<a:bodyPr lIns="90000" rIns="90000" tIns="45000" bIns="45000" anchor="ctr"><a:noAutofit/></a:bodyPr><a:p><a:pPr algn="ctr"/><a:endParaRPr sz="1800"><a:latin typeface="Calibri"/></a:endParaRPr></a:p>',
    );
  return { ...entries, [slidePath]: strToU8(slide) };
}

test("native snapshot takes only what the command changed inside the shape it named", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const authored = strFromU8(original["ppt/slides/slide1.xml"]);
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(withEngineRectangle(original, "2563eb")),
        zipSync(withEngineRectangle(original, "4f46e5")),
        ["fill_color"],
        [{ op: "fill_color", slideIndex: 0, name: "Rectangle 2" }],
      ).bytes,
    )["ppt/slides/slide1.xml"],
  );
  assert.equal(
    merged,
    authored.replace('<a:srgbClr val="2563EB"/>', '<a:srgbClr val="4f46e5"/>'),
  );
});

test("native snapshot never keeps the author's color beside a new engine color", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const slidePath = "ppt/slides/slide1.xml";
  // The author filled the rectangle with a theme color; the engine writes the
  // resolved RGB value, before the command and after it.
  const themed = {
    ...original,
    [slidePath]: strToU8(
      strFromU8(original[slidePath]).replace(
        '<a:srgbClr val="2563EB"/>',
        '<a:schemeClr val="accent1"/>',
      ),
    ),
  };
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(themed),
        zipSync(withEngineRectangle(original, "4472c4")),
        zipSync(withEngineRectangle(original, "ff0000")),
        ["fill_color"],
        [{ op: "fill_color", slideIndex: 0, name: "Rectangle 2" }],
      ).bytes,
    )[slidePath],
  );
  assert.match(
    merged,
    /<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><a:solidFill><a:srgbClr val="ff0000"\/><\/a:solidFill>/u,
  );
  assert.doesNotMatch(merged, /schemeClr val="accent1"\/><a:srgbClr/u);
});

test("native snapshot takes the engine's element where the command changed its structure", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const paragraphs = (text) =>
    text
      .map(
        (value) =>
          `<a:p><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="11181f"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${value}</a:t></a:r></a:p>`,
      )
      .join("");
  const engineSave = (text) => {
    const slidePath = "ppt/slides/slide1.xml";
    const slide = strFromU8(original[slidePath])
      .replace('id="2" name="TextBox 1"', 'id="67" name="TextBox 1"')
      .replace(/<a:p><a:r><a:rPr sz="2400">[\s\S]*?<\/a:p>/u, paragraphs(text));
    return { ...original, [slidePath]: strToU8(slide) };
  };
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(engineSave(["Spellbook 검증 العربية"])),
        zipSync(engineSave(["First", "Second"])),
        ["replace_text"],
        [{ op: "replace_text", slideIndex: 0, name: "TextBox 1" }],
      ).bytes,
    )["ppt/slides/slide1.xml"],
  );
  // Two paragraphs cannot be matched to one, so the text body is the
  // engine's; the rest of the shape stays authored.
  assert.match(
    merged,
    /<p:cNvPr id="2" name="TextBox 1"\/>[\s\S]*<a:bodyPr wrap="none"><a:spAutoFit\/><\/a:bodyPr><a:lstStyle\/><a:p><a:r><a:rPr sz="2400">[\s\S]*<a:t>First<\/a:t>[\s\S]*<a:t>Second<\/a:t>/u,
  );
});

// The fixture slide with a connector from the text box to the rectangle and
// an entrance animation on the rectangle, as the author wrote them.
const connectorXml = (id, from, to) =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector 3"/><p:cNvCxnSpPr><a:stCxn id="${from}" idx="2"/><a:endCxn id="${to}" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="3429000" y="1737360"/><a:ext cx="0" cy="274320"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>`;
const timingXml = (spid, duration, extra = "") =>
  `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="10" presetClass="entr" presetSubtype="0" fill="hold"${extra} nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="6" dur="${duration}"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
function withConnectorAndAnimation(entries, { ids, timing }) {
  const slidePath = "ppt/slides/slide1.xml";
  const [textBox, rectangle, connector] = ids;
  const slide = strFromU8(entries[slidePath])
    .replace('id="2" name="TextBox 1"', `id="${textBox}" name="TextBox 1"`)
    .replace(
      'id="3" name="Rectangle 2"',
      `id="${rectangle}" name="Rectangle 2"`,
    )
    .replace(
      "</p:spTree>",
      `${connectorXml(connector, textBox, rectangle)}</p:spTree>`,
    )
    .replace("</p:clrMapOvr>", `</p:clrMapOvr>${timing ?? ""}`);
  return { ...entries, [slidePath]: strToU8(slide) };
}

test("native snapshot keeps the author's connector and animation on a slide it edits", async () => {
  const fixture = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const slidePath = "ppt/slides/slide1.xml";
  const original = withConnectorAndAnimation(fixture, {
    ids: [2, 3, 4],
    timing: timingXml(3, 500),
  });
  // The engine renumbers every shape, writes its own animation XML and, on
  // the edited save, the rectangle's new fill.
  const engineSave = (fill, duration) =>
    withConnectorAndAnimation(withEngineRectangle(fixture, fill), {
      ids: [67, 68, 69],
      timing: timingXml(68, duration, ' grpId="0"'),
    });
  const preserve = (edited) =>
    strFromU8(
      unzipSync(
        preserveOriginalPptxParts(
          zipSync(original),
          zipSync(engineSave("2563eb", 500)),
          zipSync(edited),
          ["fill_color"],
          [{ op: "fill_color", slideIndex: 0, name: "Rectangle 2" }],
        ).bytes,
      )[slidePath],
    );
  const authored = strFromU8(original[slidePath]);

  // The command changed only the rectangle's fill: the connector and the
  // animation stay exactly as the author wrote them, naming the author's ids.
  assert.equal(
    preserve(engineSave("4f46e5", 500)),
    authored.replace('<a:srgbClr val="2563EB"/>', '<a:srgbClr val="4f46e5"/>'),
  );

  // When the engine's animation changed as well, the slide takes it, but
  // pointed at the rectangle under the author's id.
  const retimed = preserve(engineSave("4f46e5", 1000));
  assert.match(
    retimed,
    /<p:cTn id="6" dur="1000"\/><p:tgtEl><p:spTgt spid="3"\/>/u,
  );
  assert.match(retimed, /grpId="0"/u);
  assert.match(
    retimed,
    /<a:stCxn id="2" idx="2"\/><a:endCxn id="3" idx="0"\/>/u,
  );
  assert.doesNotMatch(retimed, /spid="68"|id="6[789]"/u);
});

test("native snapshot takes the engine's slide when a shape reference cannot follow its shape", async () => {
  const fixture = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const slidePath = "ppt/slides/slide1.xml";
  // The author's animation names a shape the slide does not have.
  const original = withConnectorAndAnimation(fixture, {
    ids: [2, 3, 4],
    timing: timingXml(99, 500),
  });
  const engineSave = (fill) =>
    withConnectorAndAnimation(withEngineRectangle(fixture, fill), {
      ids: [67, 68, 69],
      timing: timingXml(68, 500),
    });
  const edited = engineSave("4f46e5");
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(engineSave("2563eb")),
        zipSync(edited),
        ["fill_color"],
        [{ op: "fill_color", slideIndex: 0, name: "Rectangle 2" }],
      ).bytes,
    )[slidePath],
  );
  assert.equal(merged, strFromU8(edited[slidePath]));
});

test("native snapshot adds a new notes master to the author's presentation parts", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const relationship = (id, type, target) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const relationships = (...items) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`,
    );
  const contentType = (part, type) =>
    `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
  // The engine's presentation part differs from the author's throughout:
  // one master per layout, renumbered relationships, dropped defaults.
  const enginePresentation = (notes) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/><p:sldMasterId id="2147483650" r:id="rId3"/></p:sldMasterIdLst>${notes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId13"/></p:notesMasterIdLst>' : ""}<p:sldIdLst><p:sldId id="256" r:id="rId14"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="7772400" cy="10058400"/></p:presentation>`,
    );
  const engineRelationships = (notes) =>
    relationships(
      relationship("rId1", "theme", "theme/theme1.xml"),
      relationship("rId2", "slideMaster", "slideMasters/slideMaster1.xml"),
      relationship("rId3", "slideMaster", "slideMasters/slideMaster2.xml"),
      ...(notes
        ? [
            relationship(
              "rId13",
              "notesMaster",
              "notesMasters/notesMaster1.xml",
            ),
          ]
        : []),
      relationship("rId14", "slide", "slides/slide1.xml"),
    );
  const engineSave = (notes) => {
    const entries = {
      ...original,
      "ppt/presentation.xml": enginePresentation(notes),
      "ppt/_rels/presentation.xml.rels": engineRelationships(notes),
      "ppt/slideMasters/slideMaster2.xml":
        original["ppt/slideMasters/slideMaster1.xml"],
      "ppt/slideMasters/_rels/slideMaster2.xml.rels":
        original["ppt/slideMasters/_rels/slideMaster1.xml.rels"],
    };
    if (!notes) return entries;
    return {
      ...entries,
      "ppt/notesMasters/notesMaster1.xml": strToU8(
        '<p:notesMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      ),
      "ppt/notesMasters/_rels/notesMaster1.xml.rels": relationships(
        relationship("rId1", "theme", "../theme/theme12.xml"),
      ),
      "ppt/theme/theme12.xml": original["ppt/theme/theme1.xml"],
      "ppt/notesSlides/notesSlide1.xml": strToU8(
        '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      ),
      "ppt/notesSlides/_rels/notesSlide1.xml.rels": relationships(
        relationship("rId1", "slide", "../slides/slide1.xml"),
        relationship("rId2", "notesMaster", "../notesMasters/notesMaster1.xml"),
      ),
      "ppt/slides/_rels/slide1.xml.rels": relationships(
        relationship("rId1", "slideLayout", "../slideLayouts/slideLayout7.xml"),
        relationship("rId2", "notesSlide", "../notesSlides/notesSlide1.xml"),
      ),
      "[Content_Types].xml": strToU8(
        strFromU8(original["[Content_Types].xml"]).replace(
          "</Types>",
          `${contentType("ppt/notesMasters/notesMaster1.xml", "presentationml.notesMaster")}${contentType("ppt/notesSlides/notesSlide1.xml", "presentationml.notesSlide")}${contentType("ppt/theme/theme12.xml", "theme")}</Types>`,
        ),
      ),
    };
  };
  const merged = unzipSync(
    preserveOriginalPptxParts(
      zipSync(original),
      zipSync(engineSave(false)),
      zipSync(engineSave(true)),
      ["set_speaker_notes"],
    ).bytes,
  );
  const presentation = strFromU8(merged["ppt/presentation.xml"]);
  const presentationRelationships = strFromU8(
    merged["ppt/_rels/presentation.xml.rels"],
  );
  // Only the notes master joins the author's presentation part.
  assert.equal(
    presentation.replace(
      /<p:notesMasterIdLst><p:notesMasterId r:id="rIdSpellbook1"\/><\/p:notesMasterIdLst>/u,
      "",
    ),
    strFromU8(original["ppt/presentation.xml"]),
  );
  assert.match(presentation, /<\/p:sldMasterIdLst><p:notesMasterIdLst>/u);
  assert.match(
    presentationRelationships,
    /<Relationship Id="rIdSpellbook1" Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/notesMaster" Target="notesMasters\/notesMaster1.xml"\/><\/Relationships>/u,
  );
  assert.doesNotMatch(presentationRelationships, /slideMaster2/u);
  assert.equal(merged["ppt/slideMasters/slideMaster2.xml"], undefined);
  for (const part of [
    "ppt/notesMasters/notesMaster1.xml",
    "ppt/theme/theme12.xml",
    "ppt/notesSlides/notesSlide1.xml",
  ])
    assert.ok(merged[part], part);
  assert.match(
    strFromU8(merged["ppt/slides/_rels/slide1.xml.rels"]),
    /notesSlides\/notesSlide1.xml/u,
  );
  assert.match(
    strFromU8(merged["[Content_Types].xml"]),
    /notesMaster1.xml" ContentType="application\/vnd.openxmlformats-officedocument.presentationml.notesMaster\+xml"/u,
  );
});

test("native snapshot adds new comment authors but leaves other presentation changes to the merge", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const relationship = (id, type, target) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const relationships = (...items) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`,
    );
  // The engine numbers its relationships its own way; the comment authors
  // part is new, and the slide's comments are listed in its relationships.
  const engineSave = (comments, slideId = "256") => ({
    ...original,
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/><p:sldMasterId id="2147483650" r:id="rId3"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="${slideId}" r:id="${comments ? "rId5" : "rId4"}"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": relationships(
      relationship("rId2", "slideMaster", "slideMasters/slideMaster1.xml"),
      relationship("rId3", "slideMaster", "slideMasters/slideMaster2.xml"),
      ...(comments
        ? [
            relationship("rId4", "commentAuthors", "commentAuthors.xml"),
            relationship("rId5", "slide", "slides/slide1.xml"),
          ]
        : [relationship("rId4", "slide", "slides/slide1.xml")]),
    ),
    "ppt/slideMasters/slideMaster2.xml":
      original["ppt/slideMasters/slideMaster1.xml"],
    "ppt/slideMasters/_rels/slideMaster2.xml.rels":
      original["ppt/slideMasters/_rels/slideMaster1.xml.rels"],
    ...(comments
      ? {
          "ppt/commentAuthors.xml": strToU8(
            '<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" name="Spellbook AI" initials="AI" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>',
          ),
          "ppt/comments/comment1.xml": strToU8(
            '<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0" idx="1"><p:pos x="10" y="10"/><p:text>Spellbook comment</p:text></p:cm></p:cmLst>',
          ),
          "ppt/slides/_rels/slide1.xml.rels": relationships(
            relationship(
              "rId1",
              "slideLayout",
              "../slideLayouts/slideLayout7.xml",
            ),
            relationship("rId2", "comments", "../comments/comment1.xml"),
          ),
        }
      : {}),
  });
  const preserve = (edited) =>
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(engineSave(false)),
        zipSync(edited),
        ["add_comment"],
      ).bytes,
    );
  const merged = preserve(engineSave(true));
  assert.deepEqual(
    merged["ppt/presentation.xml"],
    original["ppt/presentation.xml"],
  );
  assert.equal(
    strFromU8(merged["ppt/_rels/presentation.xml.rels"]),
    strFromU8(original["ppt/_rels/presentation.xml.rels"]).replace(
      "</Relationships>",
      '<Relationship Id="rIdSpellbook1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors" Target="commentAuthors.xml"/></Relationships>',
    ),
  );
  assert.ok(merged["ppt/commentAuthors.xml"]);
  assert.ok(merged["ppt/comments/comment1.xml"]);

  // Deleting that comment, the deck's last, drops the authors part again, and
  // its relationship leaves the author's copy.
  const deleted = unzipSync(
    preserveOriginalPptxParts(
      zipSync(merged),
      zipSync(engineSave(true)),
      zipSync(engineSave(false)),
      ["delete_comment"],
    ).bytes,
  );
  assert.deepEqual(
    deleted["ppt/presentation.xml"],
    original["ppt/presentation.xml"],
  );
  assert.equal(
    strFromU8(deleted["ppt/_rels/presentation.xml.rels"]),
    strFromU8(original["ppt/_rels/presentation.xml.rels"]),
  );
  assert.equal(deleted["ppt/commentAuthors.xml"], undefined);
  assert.equal(deleted["ppt/comments/comment1.xml"], undefined);
  assert.doesNotMatch(
    strFromU8(deleted["[Content_Types].xml"]),
    /commentAuthors|comments\/comment1/u,
  );

  // A presentation change beyond the new relationship is not this merge's
  // to make: the engine's save is not accepted in its place either.
  assert.throws(
    () => preserve(engineSave(true, "257")),
    /missing dependency|consistent with its relationships/u,
  );
});

test("native snapshot keeps the author's presentation part through the engine's notes size rewrite", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  // The engine's saves disagree only about the notes page size, which it
  // rewrites on its own; neither save may replace the author's parts.
  const engineSave = (notesSize) => ({
    ...original,
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/><p:sldMasterId id="2147483650" r:id="rId3"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId4"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz ${notesSize}/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster2.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    "ppt/slideMasters/slideMaster2.xml":
      original["ppt/slideMasters/slideMaster1.xml"],
    "ppt/slideMasters/_rels/slideMaster2.xml.rels":
      original["ppt/slideMasters/_rels/slideMaster1.xml.rels"],
  });
  const merged = unzipSync(
    preserveOriginalPptxParts(
      zipSync(original),
      zipSync(engineSave('cx="6858000" cy="9144000"')),
      zipSync(engineSave('cx="7772400" cy="10058400"')),
      ["set_speaker_notes"],
    ).bytes,
  );
  for (const part of [
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ])
    assert.deepEqual(merged[part], original[part], part);
});

test("native snapshot pairs the engine's slides with the author's by deck position", async () => {
  // Adding and duplicating slides leaves the author's part names out of deck
  // order: slide1, then the duplicate slide3, then the added slide2.
  let bytes = new Uint8Array(await readFile(fixtureUrl));
  bytes = applyOoxmlCommand(bytes, {
    op: "add_slide",
    templateSlideIndex: 0,
    insertIndex: 1,
  }).bytes;
  bytes = applyOoxmlCommand(bytes, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  }).bytes;
  const original = unzipSync(bytes);
  const order = (entries) => {
    const presentation = strFromU8(entries["ppt/presentation.xml"]);
    const targets = Object.fromEntries(
      [
        ...strFromU8(entries["ppt/_rels/presentation.xml.rels"]).matchAll(
          /Id="([^"]+)"[^>]*Target="slides\/([^"]+)"/gu,
        ),
      ].map((match) => [match[1], match[2]]),
    );
    return [...presentation.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/gu)].map(
      (match) => targets[match[1]],
    );
  };
  const authored = order(original);
  assert.deepEqual(authored, ["slide1.xml", "slide3.xml", "slide2.xml"]);
  // The engine saves the same deck with its slides named by position.
  const rename = { "slide3.xml": "slide2.xml", "slide2.xml": "slide3.xml" };
  const engineSave = (third) => {
    const entries = {};
    for (const [part, value] of Object.entries(original)) {
      const match = part.match(
        /^ppt\/slides\/(_rels\/)?(slide[23]\.xml)(\.rels)?$/u,
      );
      entries[
        match
          ? `ppt/slides/${match[1] ?? ""}${rename[match[2]]}${match[3] ?? ""}`
          : part
      ] = value;
    }
    entries["ppt/_rels/presentation.xml.rels"] = strToU8(
      strFromU8(original["ppt/_rels/presentation.xml.rels"]).replace(
        /slides\/slide([23])\.xml/gu,
        (_, digit) => `slides/slide${digit === "2" ? "3" : "2"}.xml`,
      ),
    );
    entries["ppt/slides/slide3.xml"] = strToU8(
      strFromU8(original["ppt/slides/slide2.xml"]).replace(
        "</p:cSld>",
        `${third}</p:cSld>`,
      ),
    );
    return entries;
  };
  const merged = unzipSync(
    preserveOriginalPptxParts(
      zipSync(original),
      zipSync(engineSave("")),
      zipSync(engineSave("<!-- edited -->")),
      ["rename_slide"],
    ).bytes,
  );
  // The third slide changed: under the author's name for it, not the engine's.
  assert.match(strFromU8(merged["ppt/slides/slide2.xml"]), /<!-- edited -->/u);
  assert.deepEqual(
    merged["ppt/slides/slide3.xml"],
    original["ppt/slides/slide3.xml"],
  );
  assert.deepEqual(order(merged), authored);
});

test("native snapshot ignores targets for commands that restructure the shape tree", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const noEdit = withEngineSave(original, {
    shadow: false,
    keepRectangleAlignment: true,
  });
  const edited = withEngineSave(original, {
    shadow: true,
    keepRectangleAlignment: false,
  });
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(noEdit),
        zipSync(edited),
        ["z_order"],
        [{ op: "z_order", slideIndex: 0, name: "TextBox 1" }],
      ).bytes,
    )["ppt/slides/slide1.xml"],
  );
  assert.doesNotMatch(merged, /<a:pPr algn="ctr"\/>/u);
});

test("native snapshot keeps slides a confined command did not target as authored", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(
    applyOoxmlCommand(source, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes,
  );
  const [firstSlide, secondSlide] = slidePaths(original);
  const engineSave = (entries, shadow) => {
    const next = { ...entries };
    for (const part of [firstSlide, secondSlide])
      next[part] = strToU8(
        strFromU8(entries[part]).replace(
          '<a:latin typeface="Liberation Sans"/>',
          `${part === firstSlide && shadow ? '<a:effectLst><a:outerShdw dist="12700"/></a:effectLst>' : ""}<a:latin typeface="Arial"/>`,
        ),
      );
    // The engine's export of the untouched slide also differs between saves.
    next[secondSlide] = strToU8(
      strFromU8(next[secondSlide]).replace(
        "</p:sld>",
        shadow ? "<!-- later save --></p:sld>" : "</p:sld>",
      ),
    );
    return next;
  };
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(engineSave(original, false)),
    zipSync(engineSave(original, true)),
    ["text_shadow"],
    [{ op: "text_shadow", slideIndex: 0, name: "TextBox 1" }],
  );
  const merged = unzipSync(result.bytes);
  assert.match(strFromU8(merged[firstSlide]), /outerShdw/u);
  assert.deepEqual(merged[secondSlide], original[secondSlide]);
  assert.ok(!result.report.changedParts.includes(secondSlide));
});

// Two slides as the engine saves them: without the author's color mapping
// override, every shape renumbered by `shift`, the rectangle's empty
// paragraph with or without its alignment, and the first slide's background
// in `background`.
function withTwoSlideEngineSave(
  entries,
  paths,
  { shift, alignment, background },
) {
  const next = { ...entries };
  for (const [index, part] of paths.entries()) {
    let slide = strFromU8(entries[part])
      .replace("<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>", "")
      .replace(
        'id="2" name="TextBox 1"',
        `id="${66 + shift + index * 10}" name="TextBox 1"`,
      )
      .replace(
        'id="3" name="Rectangle 2"',
        `id="${67 + shift + index * 10}" name="Rectangle 2"`,
      )
      .replace(
        '<a:p><a:pPr algn="ctr"/></a:p>',
        alignment
          ? '<a:p><a:pPr marR="0" algn="ctr"/><a:endParaRPr sz="1800"/></a:p>'
          : '<a:p><a:endParaRPr sz="1800"/></a:p>',
      );
    if (index === 0)
      slide = slide.replace(
        '<a:srgbClr val="F8FAFC"/>',
        `<a:srgbClr val="${background}"/>`,
      );
    next[part] = strToU8(slide);
  }
  return next;
}

test("native snapshot keeps every slide but the one a slide command names as authored", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(
    applyOoxmlCommand(source, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes,
  );
  const paths = slidePaths(original);
  // Between its two saves the engine renumbered every shape (the edit added
  // a layout earlier in its save order) and dropped the empty paragraph's
  // alignment on both slides; only the first slide's background was edited.
  const result = preserveOriginalPptxParts(
    zipSync(original),
    zipSync(
      withTwoSlideEngineSave(original, paths, {
        shift: 0,
        alignment: true,
        background: "F8FAFC",
      }),
    ),
    zipSync(
      withTwoSlideEngineSave(original, paths, {
        shift: 1,
        alignment: false,
        background: "112233",
      }),
    ),
    ["set_background"],
    [{ op: "set_background", slideIndex: 0 }],
  );
  const merged = unzipSync(result.bytes);
  const first = strFromU8(merged[paths[0]]);
  assert.match(first, /<a:srgbClr val="112233"\/>/u);
  // The slide command changed no shape: both keep the author's XML and ids.
  assert.match(
    first,
    /<p:cNvPr id="2" name="TextBox 1"\/>[\s\S]*<p:cNvPr id="3" name="Rectangle 2"\/>[\s\S]*<a:p><a:pPr algn="ctr"\/><\/a:p>/u,
  );
  assert.deepEqual(merged[paths[1]], original[paths[1]]);
  assert.ok(!result.report.changedParts.includes(paths[1]));

  // Without its slide the command is not confined, and the engine's rewrite
  // of the other slide reaches the file.
  const unconfined = unzipSync(
    preserveOriginalPptxParts(
      zipSync(original),
      zipSync(
        withTwoSlideEngineSave(original, paths, {
          shift: 0,
          alignment: true,
          background: "F8FAFC",
        }),
      ),
      zipSync(
        withTwoSlideEngineSave(original, paths, {
          shift: 1,
          alignment: false,
          background: "112233",
        }),
      ),
      ["set_background"],
      null,
    ).bytes,
  );
  assert.notDeepEqual(unconfined[paths[1]], original[paths[1]]);
});

test("native snapshot pairs shapes the engine renumbered between its saves", async () => {
  const original = unzipSync(new Uint8Array(await readFile(fixtureUrl)));
  const renumbered = (entries, from, to) => {
    const part = "ppt/slides/slide1.xml";
    return {
      ...entries,
      [part]: strToU8(
        strFromU8(entries[part])
          .replace('id="67" name="TextBox 1"', `id="${to}" name="TextBox 1"`)
          .replace(
            'id="68" name="Rectangle 2"',
            `id="${to + 1}" name="Rectangle 2"`,
          ),
      ),
    };
  };
  const noEdit = withEngineSave(original, {
    shadow: false,
    keepRectangleAlignment: true,
  });
  // A layout added earlier in the engine's save order moved every id by 3.
  const edited = renumbered(
    withEngineSave(original, { shadow: true, keepRectangleAlignment: false }),
    67,
    70,
  );
  const merged = strFromU8(
    unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(noEdit),
        zipSync(edited),
        ["text_shadow"],
        [{ op: "text_shadow", slideIndex: 0, name: "TextBox 1" }],
      ).bytes,
    )["ppt/slides/slide1.xml"],
  );
  assert.match(
    merged,
    /<p:cNvPr id="3" name="Rectangle 2"\/>[\s\S]*<a:p><a:pPr algn="ctr"\/><\/a:p>/u,
  );
  assert.match(
    merged,
    /<p:cNvPr id="2" name="TextBox 1"\/>[\s\S]*<a:outerShdw dist="12700"/u,
  );
  assert.doesNotMatch(merged, /id="7[01]"/u);
});

test("native snapshot keeps a slide the engine only renumbered as authored", async () => {
  const source = new Uint8Array(await readFile(fixtureUrl));
  const original = unzipSync(
    applyOoxmlCommand(source, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes,
  );
  const paths = slidePaths(original);
  const save = (shift, background) =>
    zipSync(
      withTwoSlideEngineSave(original, paths, {
        shift,
        alignment: true,
        background,
      }),
    );
  // A direct human edit names no operation, so nothing confines it.
  const result = preserveOriginalPptxParts(
    zipSync(original),
    save(0, "F8FAFC"),
    save(4, "112233"),
    null,
  );
  assert.ok(result.report.changedParts.includes(paths[0]));
  assert.ok(!result.report.changedParts.includes(paths[1]));
  assert.deepEqual(unzipSync(result.bytes)[paths[1]], original[paths[1]]);
});

test("relationship remapping leaves an empty relationship id alone", () => {
  const part = "ppt/slides/slide1.xml";
  const relationships = (entries) =>
    strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`,
    );
  const image = (id) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`;
  const slide = strToU8(
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Media 1"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
  );
  const remapped = strFromU8(
    remapPartRelationshipIds(
      part,
      slide,
      relationships(image("rId5")),
      relationships(image("rId1")),
    ),
  );
  assert.match(remapped, /r:embed="rId5"/u);
  assert.match(remapped, /r:id=""/u);
});
