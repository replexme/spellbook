/* SPDX-License-Identifier: MPL-2.0 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { unzipSync, strFromU8 } from "fflate";

// Font licensing and source preservation do not prove that text can render.
// Inspect the actual input's DrawingML text against the generated fallback
// catalog. This checks character coverage, not shaping or layout fidelity.
export function assessOnlyOfficeFontCoverage(allFontsSource, pptxBytes) {
  const array = (name) => {
    const match = allFontsSource.match(new RegExp(`window\\["${name}"\\]\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
    if (!match) throw new Error(`Font catalog omits ${name}`);
    return JSON.parse(match[1]);
  };
  const ranges = array("__fonts_ranges"), infos = array("__fonts_infos");
  if (ranges.length % 3 !== 0) throw new Error("Invalid font coverage ranges");
  const codePoints = new Map();
  for (const [part, bytes] of Object.entries(unzipSync(pptxBytes))) {
    if (!/^ppt\/.+\.xml$/u.test(part)) continue;
    const document = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
    const texts = document.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t");
    for (let i = 0; i < texts.length; i++) {
      for (const character of texts[i].textContent ?? "") {
        if (/\s/u.test(character)) continue;
        const point = character.codePointAt(0);
        if (!codePoints.has(point)) codePoints.set(point, new Set());
        codePoints.get(point).add(part);
      }
    }
  }
  const missing = [];
  for (const [point, parts] of codePoints) {
    let covered = false;
    for (let i = 0; i < ranges.length; i += 3) {
      if (ranges[i] <= point && point <= ranges[i + 1] && infos[ranges[i + 2]]) {
        covered = true;
        break;
      }
    }
    if (!covered) missing.push({ codePoint: `U+${point.toString(16).toUpperCase()}`, character: String.fromCodePoint(point), parts: [...parts].sort() });
  }
  return { valid: missing.length === 0, checkedCodePoints: codePoints.size, missing, scope: "Generated fallback catalog coverage of input DrawingML text; excludes shaping, glyph metrics and visual fidelity" };
}

export async function readOnlyOfficeFontCoverage(candidateRoot, pptxBytes) {
  const source = await readFile(path.join(candidateRoot, "dist/sdkjs/common/AllFonts.js"), "utf8");
  return assessOnlyOfficeFontCoverage(source, pptxBytes);
}
