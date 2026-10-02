/* SPDX-License-Identifier: MPL-2.0 */
import { nativeExportDifferences } from "./ooxml-worker-source.mjs";

// A cold native serializer may materialize derived layout state. Capture a
// bounded stable same-engine baseline before any edit; never treat it as saved
// authored content. The actual component callback owns each captured export.
export async function captureStableOnlyOfficeBaseline(page, save) {
  await page.evaluate(() => {
    window.__comparisonCaptureBaseline = true;
  });
  let ms = 0,
    prior = null;
  const transitions = [];
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await save(page);
      ms += result.ms;
      const bytes = Buffer.from(result.base64, "base64");
      if (prior) {
        const differences = nativeExportDifferences(prior, bytes);
        transitions.push(differences);
        if (!differences.length)
          return { ...result, ms, attempts: attempt + 1, transitions };
      }
      prior = bytes;
    }
    throw new Error("candidate_baseline_export_unstable");
  } finally {
    await page.evaluate(() => {
      window.__comparisonCaptureBaseline = false;
    });
  }
}
