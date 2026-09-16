import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";

import {
  applyOoxmlCommand,
  inspectOoxmlDocument,
} from "./ooxml-worker-source.mjs";

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
