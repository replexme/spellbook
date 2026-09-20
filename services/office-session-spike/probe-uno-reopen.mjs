import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  assertDocumentPersistenceDelta,
  characterSpacingEquivalent,
  documentPersistenceDeltaDifferences,
  persistenceStateFromObservation,
} from "./persistence-evidence.mjs";
import {
  activeTextFontEvidence,
  normalizeActiveTextFormatting,
} from "./text-format-evidence.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2];
const reportPath = process.argv[3];
if (!url || !reportPath)
  throw new Error("Usage: node probe-uno-reopen.mjs URL PROBE_REPORT.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const expected = report.verificationExpected;
if (!expected?.propertyObject)
  throw new Error("The probe report has no patched-engine persistence data.");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const extensionDeadline = Date.now() + 60_000;
  while (
    !page
      .frames()
      .some((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      )
  ) {
    if (Date.now() >= extensionDeadline)
      throw new Error("Native editor extension did not connect.");
    await page.waitForTimeout(250);
  }
  const observe = (detailSlideIndex = null) =>
    page.evaluate(async (requestedSlideIndex) => {
      const launch = window.__spellbookLaunch;
      const response = await fetch("/native/probe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${launch.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "observe",
          detailSlideIndex: requestedSlideIndex,
        }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    }, detailSlideIndex);
  let observed = await observe();
  const expectedPatchLevel =
    process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL ?? "undo-v3";
  if (observed.engine?.patchLevel !== expectedPatchLevel)
    throw new Error(
      `Expected ${expectedPatchLevel}, got ${observed.engine?.patchLevel}.`,
    );

  const elements = observed.slides.flatMap((slide) => slide.elements);
  const propertyObject = elements.find(
    (element) => element.objectName === expected.propertyObject.objectName,
  );
  if (!propertyObject)
    throw new Error("Saved PPTX has no patched property object.");
  const tableElement = elements.find((element) => element.table);
  const tableCell = tableElement?.table?.cells?.[1]?.[1];
  const namedSlide = observed.slides.find(
    (slide) => slide.name === expected.namedSlide?.name,
  );
  const speakerNotes = observed.slides
    .map((slide) => slide.speakerNotes?.text)
    .find((text) => text === expected.speakerNotes);
  const backgroundColor = observed.slides
    .map((slide) => slide.backgroundColor)
    .find((color) => color === expected.backgroundColor);
  const propertyPaths = [
    "title",
    "description",
    "decorative",
    "textMargins",
    "textAutoGrowHeight",
    "textAutoGrowWidth",
    "textWordWrap",
    "characterSpacing",
    "scriptPosition",
    "shadow",
    "moveProtected",
    "sizeProtected",
    "printable",
  ];
  const differences = [];
  for (const key of propertyPaths) {
    if (key === "characterSpacing") {
      if (
        !characterSpacingEquivalent(
          expected.propertyObject[key],
          propertyObject?.[key],
        )
      )
        differences.push({
          path: `propertyObject.${key}`,
          expected: expected.propertyObject[key],
          actual: propertyObject?.[key],
        });
      continue;
    }
    if (
      JSON.stringify(propertyObject?.[key]) !==
      JSON.stringify(expected.propertyObject[key])
    )
      differences.push({
        path: `propertyObject.${key}`,
        expected: expected.propertyObject[key],
        actual: propertyObject?.[key],
      });
  }
  if (expected.textRange) {
    const textRangeSlideIndex = Number(propertyObject.elementId.split("/")[0]);
    observed = await observe(textRangeSlideIndex);
    const textRangeParagraph = observed.textDetails?.elements
      .find((element) => element.elementId === propertyObject.elementId)
      ?.paragraphs.find(
        (paragraph) =>
          paragraph.paragraphIndex === expected.textRange.paragraphIndex,
      );
    if (textRangeParagraph?.text !== expected.textRange.text)
      differences.push({
        path: "textRange.text",
        expected: expected.textRange.text,
        actual: textRangeParagraph?.text,
      });
    const textRangePortion = textRangeParagraph?.portions.find(
      (portion) =>
        portion.startOffset <= expected.textRange.rangeStart &&
        portion.endOffset > expected.textRange.rangeStart,
    );
    const reopenedFormatting = textRangePortion
      ? Object.fromEntries(
          Object.keys(expected.textRange.formatting).map((key) => [
            key,
            textRangePortion[key],
          ]),
        )
      : null;
    const expectedActiveFormatting = normalizeActiveTextFormatting(
      expected.textRange.formatting,
      expected.textRange.portionText,
    );
    const reopenedActiveFormatting = normalizeActiveTextFormatting(
      reopenedFormatting,
      textRangePortion?.text,
    );
    const activeFormattingEquivalent = (expectedFormat, actualFormat) => {
      if (!expectedFormat && !actualFormat) return true;
      if (!expectedFormat || !actualFormat) return false;
      const keys = new Set([
        ...Object.keys(expectedFormat),
        ...Object.keys(actualFormat),
      ]);
      for (const key of keys) {
        if (key === "spacing") {
          if (!characterSpacingEquivalent(expectedFormat[key], actualFormat[key]))
            return false;
          continue;
        }
        if (JSON.stringify(expectedFormat[key]) !== JSON.stringify(actualFormat[key]))
          return false;
      }
      return true;
    };
    if (!activeFormattingEquivalent(expectedActiveFormatting, reopenedActiveFormatting))
      differences.push({
        path: "textRange.formatting",
        expected: expectedActiveFormatting,
        actual: reopenedActiveFormatting,
      });
    const reopenedTextDetails = observed.textDetails?.elements?.find(
      (element) => element.elementId === propertyObject.elementId,
    );
    const reopenedActiveTextFonts = activeTextFontEvidence(reopenedTextDetails);
    if (
      JSON.stringify(reopenedActiveTextFonts) !==
      JSON.stringify(expected.activeTextFonts)
    )
      differences.push({
        path: "activeTextFonts",
        expected: expected.activeTextFonts,
        actual: reopenedActiveTextFonts,
      });
  }
  if (tableCell !== expected.tableCell)
    differences.push({
      path: "tableCell",
      expected: expected.tableCell,
      actual: tableCell,
    });
  if (expected.tableStructure) {
    const reopenedTableStructure = tableElement
      ? {
          x: tableElement.x,
          y: tableElement.y,
          width: tableElement.width,
          height: tableElement.height,
          rows: tableElement.table.rows,
          columns: tableElement.table.columns,
          rowHeights: tableElement.table.rowHeights,
          columnWidths: tableElement.table.columnWidths,
          mergedRanges: tableElement.table.mergedRanges,
          cells: tableElement.table.cells,
        }
      : null;
    if (
      JSON.stringify(reopenedTableStructure) !==
      JSON.stringify(expected.tableStructure)
    )
      differences.push({
        path: "tableStructure",
        expected: expected.tableStructure,
        actual: reopenedTableStructure,
      });
  }
  if (!namedSlide || namedSlide.hidden !== expected.namedSlide.hidden)
    differences.push({
      path: "namedSlide",
      expected: expected.namedSlide,
      actual: namedSlide,
    });
  if (speakerNotes !== expected.speakerNotes)
    differences.push({
      path: "speakerNotes",
      expected: expected.speakerNotes,
      actual: speakerNotes,
    });
  if (backgroundColor !== expected.backgroundColor)
    differences.push({
      path: "backgroundColor",
      expected: expected.backgroundColor,
      actual: backgroundColor,
    });
  const reopenedPersistence = persistenceStateFromObservation(observed);
  await writeFile(
    path.resolve(path.dirname(reportPath), "reopen-observation.json"),
    `${JSON.stringify(reopenedPersistence, null, 2)}\n`,
  );
  const persistenceDifferences = documentPersistenceDeltaDifferences(
    report,
    reopenedPersistence,
  );
  if (persistenceDifferences.length)
    await writeFile(
      path.resolve(path.dirname(reportPath), "reopen-differences.json"),
      `${JSON.stringify(persistenceDifferences, null, 2)}\n`,
    );
  if (process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT) {
    const image = observed.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Reopened document did not return a verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  assertDocumentPersistenceDelta(
    report,
    reopenedPersistence,
    "Saved PPTX did not preserve the edited document state.",
  );
  if (differences.length)
    throw new Error(
      `Saved PPTX did not preserve patched operations: ${JSON.stringify(differences)}`,
    );
  process.stdout.write(
    `${JSON.stringify(
      {
        reopened: true,
        enginePatchLevel: observed.engine.patchLevel,
        slideCount: observed.slides.length,
        verified: {
          tableCell,
          backgroundColor,
          slideName: namedSlide.name,
          slideHidden: namedSlide.hidden,
          speakerNotes,
          objectName: propertyObject.objectName,
          objectPropertyCount: propertyPaths.length,
          textRange: expected.textRange
            ? {
                text: expected.textRange.text,
                formattingPropertyCount: Object.keys(
                  expected.textRange.formatting,
                ).length,
              }
            : null,
          tableStructure: expected.tableStructure
            ? {
                rows: expected.tableStructure.rows,
                columns: expected.tableStructure.columns,
                rowHeights: expected.tableStructure.rowHeights,
                columnWidths: expected.tableStructure.columnWidths,
              }
            : null,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
