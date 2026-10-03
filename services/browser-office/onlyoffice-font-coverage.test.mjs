/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { assessOnlyOfficeFontCoverage } from "./onlyoffice-font-coverage.mjs";

const document = zipSync({ "ppt/slides/slide1.xml": strToU8('<slide xmlns:text="http://schemas.openxmlformats.org/drawingml/2006/main"><text:t>Spellbook 검증 العربية</text:t></slide>') });
const catalog = (arabic) => `window["__fonts_infos"] = [["Latin"],["Korean"],["Arabic"]];window["__fonts_ranges"] = ${JSON.stringify([32,126,0,0xac00,0xd7af,1,...(arabic ? [0x600,0x6ff,2] : [])])};`;

test("licensed Latin/Korean fonts cannot conceal missing Arabic input characters", () => {
  const missing = assessOnlyOfficeFontCoverage(catalog(false), document);
  assert.equal(missing.valid, false);
  assert(missing.missing.every((item) => item.parts.includes("ppt/slides/slide1.xml")));
  assert(missing.missing.some((item) => item.character === "ع"));
  assert.equal(assessOnlyOfficeFontCoverage(catalog(true), document).valid, true);
});

test("missing or malformed fallback metadata cannot prove text coverage", () => {
  assert.throws(() => assessOnlyOfficeFontCoverage("", document), /omits/);
  assert.throws(() => assessOnlyOfficeFontCoverage('window["__fonts_infos"] = [];window["__fonts_ranges"] = [1];', document), /Invalid/);
});
