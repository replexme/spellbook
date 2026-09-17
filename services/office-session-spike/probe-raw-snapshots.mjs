import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const labels = [
  "native-snapshot-original",
  "native-snapshot-no-edit",
  "native-snapshot-edited",
  "native-snapshot-preserved",
];

export async function captureNativeSnapshots(page, scope) {
  const directory = process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR;
  if (!directory || !page) return;
  if (!/^[a-z0-9-]+$/u.test(scope))
    throw new Error("Native snapshot diagnostic scope is invalid.");
  const destination = path.join(path.resolve(directory), scope);
  await mkdir(destination, { recursive: true });
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
