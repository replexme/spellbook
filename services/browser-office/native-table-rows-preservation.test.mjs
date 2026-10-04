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
