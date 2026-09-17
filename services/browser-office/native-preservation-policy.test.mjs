import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNativePackagePart,
  nativePreservationBudget,
} from "./native-preservation-policy.mjs";

test("browser package category mapping covers every native budget category", () => {
  const cases = {
    "[Content_Types].xml": "package_manifest",
    "_rels/.rels": "package_relationships",
    "docProps/core.xml": "document_properties",
    "ppt/presentation.xml": "presentation",
    "ppt/_rels/presentation.xml.rels": "presentation_relationships",
    "ppt/slides/slide1.xml": "slide_parts",
    "ppt/slides/_rels/slide1.xml.rels": "slide_relationships",
    "ppt/notesSlides/notesSlide1.xml": "notes_parts",
    "ppt/notesSlides/_rels/notesSlide1.xml.rels": "notes_relationships",
    "ppt/notesMasters/notesMaster1.xml": "notes_master_parts",
    "ppt/notesMasters/_rels/notesMaster1.xml.rels":
      "notes_master_relationships",
    "ppt/slideLayouts/slideLayout1.xml": "slide_layout_parts",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels":
      "slide_layout_relationships",
    "ppt/slideMasters/slideMaster1.xml": "slide_master_parts",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels":
      "slide_master_relationships",
    "ppt/theme/theme1.xml": "theme_parts",
    "ppt/charts/chart1.xml": "chart_parts",
    "ppt/embeddings/Book1.xlsx": "embedded_workbooks",
    "ppt/media/image1.png": "media_parts",
    "ppt/diagrams/data1.xml": "diagram_parts",
    "ppt/comments/comment1.xml": "comments",
    "customXml/item1.xml": "custom_xml",
    "ppt/vbaProject.bin": "macros",
    "unknown/file.xml": "unknown",
  };
  for (const [part, expected] of Object.entries(cases))
    assert.equal(classifyNativePackagePart(part), expected, part);
});

test("browser preservation budget comes from operation families", () => {
  const table = nativePreservationBudget(["insert_table_rows"]);
  assert.deepEqual([...table.allowedCategories], ["slide_parts"]);
  assert.equal(table.allowPartCreationOrDeletion, false);

  const design = nativePreservationBudget(["set_master_theme"]);
  assert.ok(design.allowedCategories.has("slide_master_parts"));
  assert.equal(design.allowedCategories.has("unknown"), false);

  const image = nativePreservationBudget(["insert_image"]);
  assert.ok(image.allowedCategories.has("media_parts"));
  assert.equal(image.allowPartCreationOrDeletion, true);
});
