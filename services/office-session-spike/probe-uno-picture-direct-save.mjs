import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";

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
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 60_000;
  let extensionFrame;
  while (!extensionFrame) {
    extensionFrame = page
      .frames()
      .find((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (Date.now() >= deadline)
      throw new Error("Native editor extension did not connect.");
    if (!extensionFrame) await page.waitForTimeout(250);
  }
  const report = await extensionFrame.evaluate(() =>
    cool.callRemote(function presentPictureDirectSaveProbe() {
      const frame = uno.idl.com.sun.star.frame.Desktop.create(
        uno.componentContext,
      ).getCurrentFrame();
      const model = frame.getController().getModel();
      const pages = model.getDrawPages();
      const safe = (target, name) => {
        try {
          return target.getPropertyValue(name);
        } catch (_) {
          return null;
        }
      };
      let target = null;
      let slideIndex = -1;
      for (
        let pageIndex = 0;
        pageIndex < pages.getCount() && !target;
        pageIndex++
      ) {
        const drawPage = pages.getByIndex(pageIndex);
        for (
          let shapeIndex = 0;
          shapeIndex < drawPage.getCount();
          shapeIndex++
        ) {
          const shape = drawPage.getByIndex(shapeIndex);
          const bitmap = safe(shape, "Bitmap");
          const sourceSize = safe(bitmap, "Size100thMM");
          const crop = safe(shape, "GraphicCrop");
          const shapeType = shape.getShapeType();
          const fillStyle = String(safe(shape, "FillStyle"));
          const isPicture =
            String(shapeType).endsWith("GraphicObjectShape") ||
            fillStyle.endsWith("BITMAP");
          if (
            isPicture &&
            sourceSize?.Width > 0 &&
            sourceSize?.Height > 0 &&
            crop
          ) {
            target = shape;
            slideIndex = pageIndex;
            break;
          }
        }
      }
      if (!target) throw new Error("picture_not_found");
      const sourceSize = safe(safe(target, "Bitmap"), "Size100thMM");
      const before = safe(target, "GraphicCrop");
      const desired = new uno.idl.com.sun.star.text.GraphicCrop({
        Left: Math.round(sourceSize.Width * 0.15),
        Top: Math.round(sourceSize.Height * 0.1),
        Right: Math.round(sourceSize.Width * 0.08),
        Bottom: Math.round(sourceSize.Height * 0.06),
      });
      const undo = model.getUndoManager();
      const undoBefore = undo.getAllUndoActionTitles().length;
      target.setPropertyValue("GraphicCrop", desired);
      return {
        slideIndex,
        objectName: target.getName(),
        shapeType: target.getShapeType(),
        sourceSize,
        before,
        after: safe(target, "GraphicCrop"),
        undoActionsAdded: undo.getAllUndoActionTitles().length - undoBefore,
      };
    }),
  );
  await requestNativeProbeSave(page);
  await page.waitForTimeout(1_000);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
