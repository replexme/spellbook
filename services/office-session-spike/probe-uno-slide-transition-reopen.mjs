import { readFile } from "node:fs/promises";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import { assertDocumentPersistenceDelta } from "./persistence-evidence.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2];
const reportPath = process.argv[3];
if (!url || !reportPath)
  throw new Error(
    "Usage: node probe-uno-slide-transition-reopen.mjs URL REPORT.json",
  );
const report = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
const expected = report.persistenceExpected;
if (!expected?.slides || !expected?.masters)
  throw new Error("The slide-transition report has no persistence data.");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 60_000;
  while (
    !page
      .frames()
      .some((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      )
  ) {
    if (Date.now() >= deadline)
      throw new Error("Native editor extension did not connect.");
    await page.waitForTimeout(250);
  }
  const observed = await page.evaluate(async () => {
    const launch = window.__spellbookLaunch;
    const response = await fetch("/native/probe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${launch.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "observe" }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  });
  if (probeEnginePatchVersion(observed.engine?.patchLevel) < 7)
    throw new Error(
      `Expected undo-v7 or newer, got ${observed.engine?.patchLevel}.`,
    );
  assertDocumentPersistenceDelta(
    report,
    observed,
    "Saved PPTX did not preserve the exact slide transition state.",
  );
  process.stdout.write(
    `${JSON.stringify({ reopened: true, enginePatchLevel: observed.engine.patchLevel, operation: "set_slide_transition" }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
