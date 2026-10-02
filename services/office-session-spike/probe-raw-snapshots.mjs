import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const labels = [
  "native-snapshot-original",
  "native-snapshot-no-edit",
  "native-snapshot-edited",
  "native-snapshot-preserved",
  "native-coverage-baseline",
  "native-coverage-candidate",
];

export async function captureNativeSnapshots(
  page,
  scope,
  directory = process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR,
) {
  if (!directory || !page) return;
  if (!/^[a-z0-9-]+$/u.test(scope))
    throw new Error("Native snapshot diagnostic scope is invalid.");
  const destination = path.join(path.resolve(directory), scope);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    const diagnostics = await page.evaluate(() =>
      globalThis.spellbookBrowserOffice?.diagnostics?.(),
    );
    if (diagnostics && !Array.isArray(diagnostics))
      await writeFile(
        path.join(destination, "diagnostics.json"),
        `${JSON.stringify(diagnostics, null, 2)}\n`,
        { mode: 0o600 },
      );
  } catch (error) {
    process.stderr.write(
      `Unable to capture ${scope}/diagnostics: ${error.message}\n`,
    );
  }
  for (const label of labels) {
    try {
      const bytes = await page.evaluate(
        (requestedLabel) =>
          globalThis.spellbookBrowserOffice?.artifact(requestedLabel),
        label,
      );
      if (bytes?.length)
        await writeFile(
          path.join(destination, `${label}.pptx`),
          Buffer.from(bytes),
          {
            mode: 0o600,
          },
        );
    } catch (error) {
      process.stderr.write(
        `Unable to capture ${scope}/${label}: ${error.message}\n`,
      );
    }
  }
}

// Every declared probe closes through the same collector, including errors
// before a local `page` binding was initialized. Capture failure must never
// leak the browser or hide the original probe's cleanup.
export async function closeNativeProbe(browser, scope) {
  try {
    for (const context of browser.contexts())
      for (const page of context.pages())
        await captureNativeSnapshots(page, scope);
  } catch (error) {
    process.stderr.write(`Unable to collect ${scope}: ${error.message}\n`);
  } finally {
    await browser.close();
  }
}
