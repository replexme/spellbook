import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import {
  installNativeBridgeTrace,
  waitForNativeBridge,
} from "./native-bridge-probe.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await installNativeBridgeTrace(page);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
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
    if (Date.now() >= deadline) {
      const officeFrame = page
        .frames()
        .find((frame) => frame.url().includes("/browser/"));
      const registeredExtensions = officeFrame
        ? await officeFrame
            .evaluate(() => Object.keys(globalThis.app?.map?._extensions ?? {}))
            .catch(() => [])
        : [];
      throw new Error(
        `Native editor extension did not connect: ${JSON.stringify({ frames: page.frames().map((frame) => frame.url()), registeredExtensions, body: (await page.locator("body").innerText()).slice(0, 2_000), browserErrors: browserErrors.slice(-20) })}`,
      );
    }
    await page.waitForTimeout(250);
  }
  await waitForNativeBridge(page);
  await requestNativeProbeSave(page);
  await page.waitForTimeout(1_000);
  process.stdout.write("No-op save requested.\n");
} finally {
  await browser.close();
}
