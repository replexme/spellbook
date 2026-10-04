/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { preserveOriginalPptxParts } from "./ooxml-worker-source.mjs";
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
const row = (text, dash = "") =>
  `<a:tr h="360000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>${dash ? `<a:lnL><a:prstDash val="${dash}"/></a:lnL>` : ""}</a:tcPr></a:tc></a:tr>`;
async function fixture(nonSequential = false) {
  const original = unzipSync(
    new Uint8Array(
      await readFile(
        new URL(
          "../../eval/public/fixtures/general-native-surface.pptx",
          import.meta.url,
        ),
      ),
    ),
  );
  let part = "ppt/slides/slide1.xml";
  const document = new DOMParser().parseFromString(
    strFromU8(original[part]),
    "text/xml",
  );
  const first = document.getElementsByTagNameNS(p, "sp")[0];
  const table = new DOMParser().parseFromString(
    `<p:graphicFrame xmlns:p="${p}" xmlns:a="${a}"><p:nvGraphicFramePr><p:cNvPr id="2" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="720000" cy="720000"/></p:xfrm><a:graphic><a:graphicData uri="${a}/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="720000"/></a:tblGrid>${row("same", "sysDash")}${row("same", "dash")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    "text/xml",
  ).documentElement;
  first.parentNode.replaceChild(document.importNode(table, true), first);
  original[part] = strToU8(new XMLSerializer().serializeToString(document));
  if (nonSequential) {
    original["ppt/slides/slide9.xml"] = original[part];
    delete original[part];
    original["ppt/slides/_rels/slide9.xml.rels"] =
      original["ppt/slides/_rels/slide1.xml.rels"];
    delete original["ppt/slides/_rels/slide1.xml.rels"];
    const rels = "ppt/_rels/presentation.xml.rels";
    original[rels] = strToU8(
      strFromU8(original[rels]).replace(
        "slides/slide1.xml",
        "slides/slide9.xml",
      ),
    );
    original["[Content_Types].xml"] = strToU8(
      strFromU8(original["[Content_Types].xml"]).replace(
        "/ppt/slides/slide1.xml",
        "/ppt/slides/slide9.xml",
      ),
    );
    part = "ppt/slides/slide9.xml";
  }
  const baseline = {
    ...original,
    [part]: strToU8(
      strFromU8(original[part]).replace(
        /<a:lnL><a:prstDash val="[^"]+"\/><\/a:lnL>/g,
        "",
      ),
    ),
  };
  return { original, baseline, part };
}
for (const op of ["insert_table_rows", "delete_table_rows"])
  test(`native ${op} uses declared coordinates even when engine rows are indistinguishable`, async () => {
    const { original, baseline, part } = await fixture(
      op === "delete_table_rows",
    );
    const document = new DOMParser().parseFromString(
      strFromU8(baseline[part]),
      "text/xml",
    );
    const rows = [...document.getElementsByTagNameNS(a, "tr")];
    if (op === "delete_table_rows") rows[1].parentNode.removeChild(rows[1]);
    else {
      const added = new DOMParser().parseFromString(
        `<root xmlns:a="${a}">${row("")}</root>`,
        "text/xml",
      ).documentElement.firstChild;
      rows[1].parentNode.insertBefore(
        document.importNode(added, true),
        rows[1],
      );
    }
    const edited = {
      ...baseline,
      [part]: strToU8(new XMLSerializer().serializeToString(document)),
    };
    const saved = unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(baseline),
        zipSync(edited),
        [op],
        [
          {
            op,
            slideIndex: 0,
            shapeIndex: 0,
            name: "Table",
            index: 1,
            count: 1,
          },
        ],
      ).bytes,
    );
    const result = new DOMParser().parseFromString(
      strFromU8(saved[part]),
      "text/xml",
    );
    const final = [...result.getElementsByTagNameNS(a, "tr")];
    assert.equal(final.length, op === "delete_table_rows" ? 1 : 3);
    assert.equal(
      final[0].getElementsByTagNameNS(a, "prstDash")[0].getAttribute("val"),
      "sysDash",
    );
    if (op === "insert_table_rows") {
      assert.equal(final[1].getElementsByTagNameNS(a, "t")[0].textContent, "");
      assert.equal(
        final[2].getElementsByTagNameNS(a, "prstDash")[0].getAttribute("val"),
        "dash",
      );
    }
    for (const [name, bytes] of Object.entries(original))
      if (name !== part) assert.deepEqual(saved[name], bytes, name);
  });

for (const op of ["insert_table_rows", "delete_table_rows"])
  test(`native ${op} preserves hyperlinks and original style through relationship renumbering`, async () => {
    const { original, baseline, part } = await fixture();
    const rel =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const rels = "ppt/slides/_rels/slide1.xml.rels";
    const hyperlink = (id) => `<a:hlinkClick xmlns:r="${rel}" r:id="${id}"/>`;
    original[part] = strToU8(
      strFromU8(original[part]).replace(
        /<a:rPr sz="1800"\/>/g,
        `<a:rPr sz="1800">${hyperlink("rIdAuthor")}</a:rPr>`,
      ),
    );
    baseline[part] = strToU8(
      strFromU8(baseline[part]).replace(
        /<a:rPr sz="1800"\/>/g,
        `<a:rPr sz="1800">${hyperlink("rIdNative")}</a:rPr>`,
      ),
    );
    const link = (id) =>
      `<Relationship Id="${id}" Type="${rel}/hyperlink" Target="https://example.com/authored-row" TargetMode="External"/>`;
    original[rels] = strToU8(
      strFromU8(original[rels]).replace(
        "</Relationships>",
        link("rIdAuthor") + "</Relationships>",
      ),
    );
    baseline[rels] = strToU8(
      strFromU8(original[rels]).replace("rIdAuthor", "rIdNative"),
    );
    const doc = new DOMParser().parseFromString(
      strFromU8(baseline[part]),
      "text/xml",
    );
    const rows = [...doc.getElementsByTagNameNS(a, "tr")];
    if (op === "delete_table_rows") rows[1].parentNode.removeChild(rows[1]);
    else {
      const newRow = new DOMParser().parseFromString(
        `<root xmlns:a="${a}">${row("")}</root>`,
        "text/xml",
      ).documentElement.firstChild;
      rows[1].parentNode.insertBefore(doc.importNode(newRow, true), rows[1]);
    }
    const edited = {
      ...baseline,
      [part]: strToU8(new XMLSerializer().serializeToString(doc)),
    };
    const saved = unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(baseline),
        zipSync(edited),
        [op],
        [
          {
            op,
            slideIndex: 0,
            shapeIndex: 0,
            name: "Table",
            index: 1,
            count: 1,
          },
        ],
      ).bytes,
    );
    const result = new DOMParser().parseFromString(
      strFromU8(saved[part]),
      "text/xml",
    );
    const remaining = [...result.getElementsByTagNameNS(a, "tr")];
    assert.equal(
      remaining[0]
        .getElementsByTagNameNS(a, "hlinkClick")[0]
        .getAttributeNS(rel, "id"),
      "rIdAuthor",
    );
    assert.equal(
      remaining[0].getElementsByTagNameNS(a, "prstDash")[0].getAttribute("val"),
      "sysDash",
    );
    assert.deepEqual(saved[rels], original[rels]);
    if (op === "insert_table_rows") {
      assert.equal(
        remaining[1].getElementsByTagNameNS(a, "hlinkClick").length,
        0,
      );
      assert.equal(
        remaining[2]
          .getElementsByTagNameNS(a, "hlinkClick")[0]
          .getAttributeNS(rel, "id"),
        "rIdAuthor",
      );
    }
  });

for (const op of ["insert_table_columns", "delete_table_columns"])
  test(`native ${op} retains authored cell properties at declared column coordinates`, async () => {
    const { original, part } = await fixture();
    const doc = new DOMParser().parseFromString(
      strFromU8(original[part]),
      "text/xml",
    );
    const grid = doc.getElementsByTagNameNS(a, "tblGrid")[0];
    grid.firstChild.setAttribute("w", "360000");
    grid.appendChild(grid.firstChild.cloneNode(true));
    for (const row of [...doc.getElementsByTagNameNS(a, "tr")]) {
      const cell = row.getElementsByTagNameNS(a, "tc")[0],
        duplicate = cell.cloneNode(true);
      duplicate
        .getElementsByTagNameNS(a, "prstDash")[0]
        .setAttribute("val", "dot");
      row.appendChild(duplicate);
    }
    original[part] = strToU8(new XMLSerializer().serializeToString(doc));
    const baseline = {
      ...original,
      [part]: strToU8(
        strFromU8(original[part]).replace(
          /<a:lnL><a:prstDash val="[^"]+"\/><\/a:lnL>/g,
          "",
        ),
      ),
    };
    const editedDoc = new DOMParser().parseFromString(
      strFromU8(baseline[part]),
      "text/xml",
    );
    const editedGrid = editedDoc.getElementsByTagNameNS(a, "tblGrid")[0];
    if (op === "delete_table_columns")
      editedGrid.removeChild(editedGrid.lastChild);
    else
      editedGrid.insertBefore(
        editedGrid.firstChild.cloneNode(true),
        editedGrid.lastChild,
      );
    for (const row of [...editedDoc.getElementsByTagNameNS(a, "tr")]) {
      const cells = [...row.getElementsByTagNameNS(a, "tc")];
      if (op === "delete_table_columns") row.removeChild(cells[1]);
      else {
        const added = cells[0].cloneNode(true);
        added.getElementsByTagNameNS(a, "t")[0].textContent = "";
        row.insertBefore(added, cells[1]);
      }
    }
    const edited = {
      ...baseline,
      [part]: strToU8(new XMLSerializer().serializeToString(editedDoc)),
    };
    const saved = unzipSync(
      preserveOriginalPptxParts(
        zipSync(original),
        zipSync(baseline),
        zipSync(edited),
        [op],
        [
          {
            op,
            slideIndex: 0,
            shapeIndex: 0,
            name: "Table",
            index: 1,
            count: 1,
          },
        ],
      ).bytes,
    );
    const result = new DOMParser().parseFromString(
      strFromU8(saved[part]),
      "text/xml",
    );
    const rows = [...result.getElementsByTagNameNS(a, "tr")];
    assert.equal(
      result.getElementsByTagNameNS(a, "gridCol").length,
      op === "delete_table_columns" ? 1 : 3,
    );
    for (const [index, row] of rows.entries()) {
      const cells = [...row.getElementsByTagNameNS(a, "tc")];
      assert.equal(
        cells[0].getElementsByTagNameNS(a, "prstDash")[0].getAttribute("val"),
        index === 0 ? "sysDash" : "dash",
      );
      if (op === "insert_table_columns") {
        assert.equal(
          cells[1].getElementsByTagNameNS(a, "t")[0].textContent,
          "",
        );
        assert.equal(
          cells[2].getElementsByTagNameNS(a, "prstDash")[0].getAttribute("val"),
          "dot",
        );
      }
    }
    for (const [name, bytes] of Object.entries(original))
      if (name !== part) assert.deepEqual(saved[name], bytes, name);
  });
