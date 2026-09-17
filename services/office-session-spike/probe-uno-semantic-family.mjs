import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { persistenceStateFromObservation } from "./persistence-evidence.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const scenario = process.argv[4];
if (
  ![
    "semantic-assets",
    "smartart-diagram",
    "fontwork",
    "object-3d",
    "equation",
  ].includes(scenario)
)
  throw new Error("A known semantic feature scenario is required.");

const expectedOperations = process.env.SPELLBOOK_PROBE_EXPECTED_OPERATIONS
  ? JSON.parse(process.env.SPELLBOOK_PROBE_EXPECTED_OPERATIONS)
  : null;
if (
  expectedOperations !== null &&
  (!Array.isArray(expectedOperations) ||
    expectedOperations.some((operation) => typeof operation !== "string"))
)
  throw new Error(
    "SPELLBOOK_PROBE_EXPECTED_OPERATIONS must be a JSON string array.",
  );

const IMAGE_ASSET_ID = "00000000-0000-4000-8000-000000000001";
const MEDIA_ASSET_ID = "00000000-0000-4000-8000-000000000002";
const REPLACEMENT_IMAGE_ASSET_ID = "00000000-0000-4000-8000-000000000003";
const REPLACEMENT_MEDIA_ASSET_ID = "00000000-0000-4000-8000-000000000004";
const stable = (value) => JSON.stringify(value);
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

  const call = (request) =>
    page.evaluate(async (input) => {
      const launch = window.__spellbookLaunch;
      const response = await fetch("/native/probe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${launch.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    }, request);
  const history = (direction = null) => {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!frame) throw new Error("Native extension frame was lost.");
    return frame.evaluate(
      (requestedDirection) =>
        cool.callRemote(function spellbookSemanticHistory(value) {
          const undo = uno.idl.com.sun.star.frame.Desktop.create(
            uno.componentContext,
          )
            .getCurrentFrame()
            .getController()
            .getModel()
            .getUndoManager();
          if (value === "undo") undo.undo();
          else if (value === "redo") undo.redo();
          else if (value !== null) throw new Error("invalid_history_direction");
          return {
            undo: undo.getAllUndoActionTitles(),
            redo: undo.getAllRedoActionTitles(),
          };
        }, requestedDirection),
      direction,
    );
  };
  const sameDocument = (left, right) =>
    stable(left.slides) === stable(right.slides) &&
    stable(left.masters) === stable(right.masters);
  const waitForState = async (expected, label) => {
    const stop = Date.now() + 10_000;
    let actual;
    do {
      actual = await call({ operation: "observe" });
      if (sameDocument(actual, expected)) return actual;
      await page.waitForTimeout(100);
    } while (Date.now() < stop);
    throw new Error(`${label} did not restore the exact observed document.`);
  };

  let observed = await call({ operation: "observe" });
  if (probeEnginePatchVersion(observed.engine?.patchLevel) < 24)
    throw new Error("The semantic feature engine candidate is unavailable.");
  const persistenceBefore = persistenceStateFromObservation(observed);
  const operations = [];
  const editWithHistory = async (command, asset = false) => {
    const before = structuredClone(observed);
    const historyBefore = await history();
    const request = asset
      ? {
          ...command,
          operation: command.op,
          expectedRevision: observed.revision,
          expectedSlides: stable(observed.slides),
          permission: { mode: "document", slideIndexes: [], elementIds: [] },
        }
      : {
          operation: "edit",
          expectedRevision: observed.revision,
          expectedSlides: stable(observed.slides),
          command,
          permission: { mode: "document", slideIndexes: [], elementIds: [] },
        };
    observed = await call(request);
    const after = structuredClone(observed);
    const historyAfter = await history();
    if (
      sameDocument(before, after) ||
      historyAfter.undo.length !== historyBefore.undo.length + 1
    )
      throw new Error(
        `${command.op} was not applied as one native Undo action.`,
      );
    await history("undo");
    observed = await waitForState(before, `${command.op} Undo`);
    await history("redo");
    observed = await waitForState(after, `${command.op} Redo`);
    operations.push(command.op);
  };

  const topLevelElements = () =>
    observed.slides[observed.activeSlide].elements.filter(
      (element) => element.parentElementId === null,
    );
  if (scenario === "semantic-assets") {
    const slideIndex = observed.activeSlide;
    await editWithHistory(
      { op: "insert_image", assetId: IMAGE_ASSET_ID, slideIndex },
      true,
    );
    let image = topLevelElements().find((element) =>
      String(element.kind).endsWith("GraphicObjectShape"),
    );
    if (!image) throw new Error("Inserted image was not observed.");
    const imageStableId = image.stableId;
    await editWithHistory(
      {
        op: "replace_image",
        assetId: REPLACEMENT_IMAGE_ASSET_ID,
        elementId: image.elementId,
        slideIndex,
      },
      true,
    );
    image = topLevelElements().find(
      (element) => element.stableId === imageStableId,
    );
    if (image?.picture?.sourcePixelSize?.width !== 2)
      throw new Error(
        "Image replacement did not preserve the target identity and change its content.",
      );
    await editWithHistory(
      { op: "insert_media", assetId: MEDIA_ASSET_ID, slideIndex },
      true,
    );
    let media = topLevelElements().find((element) => element.media);
    if (!media) throw new Error("Inserted media was not observed.");
    await editWithHistory({
      op: "set_media_playback",
      elementId: media.elementId,
      mediaPlayback: {
        loop: media.media.loop !== true,
        muted: media.media.muted !== true,
        volumeDb: -1200,
        zoom: "fit",
      },
    });
    media = topLevelElements().find(
      (element) => element.stableId === media.stableId,
    );
    if (!media) throw new Error("Edited media was not observable.");
    const mediaStableId = media.stableId;
    const mediaSourceId = media.media.sourceId;
    const mediaPlayback = {
      loop: media.media.loop,
      muted: media.media.muted,
      volumeDb: media.media.volumeDb,
      zoom: media.media.zoom,
    };
    await editWithHistory(
      {
        op: "replace_media",
        assetId: REPLACEMENT_MEDIA_ASSET_ID,
        elementId: media.elementId,
        slideIndex,
      },
      true,
    );
    media = topLevelElements().find(
      (element) => element.stableId === mediaStableId,
    );
    if (
      !media ||
      media.media.sourceId === mediaSourceId ||
      stable({
        loop: media.media.loop,
        muted: media.media.muted,
        volumeDb: media.media.volumeDb,
        zoom: media.media.zoom,
      }) !== stable(mediaPlayback)
    )
      throw new Error(
        "Media replacement did not preserve target identity and playback settings while changing content.",
      );
  } else if (scenario === "smartart-diagram") {
    let diagram = topLevelElements().find(
      (element) =>
        element.diagram?.semanticModelAvailable &&
        element.diagram.semanticNodes.length > 0,
    );
    if (!diagram) throw new Error("No semantic SmartArt model was observed.");
    const first = diagram.diagram.semanticNodes[0];
    const replacement = `${first.text} · Spellbook`;
    await editWithHistory({
      op: "set_smartart_node",
      elementId: diagram.elementId,
      smartartNode: {
        expectedText: first.text,
        occurrence: first.occurrence,
        text: replacement,
      },
    });
    diagram = topLevelElements().find(
      (element) => element.stableId === diagram.stableId,
    );
    if (!diagram) throw new Error("Edited SmartArt was not observable.");
    const addedText = "Spellbook semantic node";
    await editWithHistory({
      op: "add_smartart_node",
      elementId: diagram.elementId,
      smartartNode: { expectedText: null, occurrence: 0, text: addedText },
    });
    diagram = topLevelElements().find(
      (element) => element.stableId === diagram.stableId,
    );
    if (!diagram) throw new Error("Expanded SmartArt was not observable.");
    await editWithHistory({
      op: "delete_smartart_node",
      elementId: diagram.elementId,
      smartartNode: { expectedText: addedText, occurrence: 0, text: null },
    });
  } else if (scenario === "fontwork") {
    const target = topLevelElements().find((element) => element.fontwork);
    if (!target) throw new Error("No Fontwork object was observed.");
    await editWithHistory({
      op: "set_fontwork",
      elementId: target.elementId,
      fontwork: {
        style: target.fontwork.style,
        adjust: target.fontwork.adjust,
        distance: Number(target.fontwork.distance ?? 0) + 50,
        start: target.fontwork.start,
        mirror: target.fontwork.mirror,
        outline: target.fontwork.outline !== true,
      },
    });
  } else if (scenario === "object-3d") {
    const target = topLevelElements().find((element) => element.material3d);
    if (!target) throw new Error("No editable 3D material was observed.");
    await editWithHistory({
      op: "set_3d_material",
      elementId: target.elementId,
      material3d: {
        color:
          Number(target.material3d.color ?? 0) === 0x336699
            ? 0x663399
            : 0x336699,
        emission: target.material3d.emission,
        specular: target.material3d.specular,
        specularIntensity: Math.min(
          100,
          Number(target.material3d.specularIntensity ?? 0) + 1,
        ),
        doubleSided: target.material3d.doubleSided !== true,
      },
    });
  } else if (scenario === "equation") {
    const target = topLevelElements().find((element) => element.equation);
    if (!target) throw new Error("No editable equation was observed.");
    const source = String(target.equation.source ?? "").trim();
    await editWithHistory({
      op: "set_equation_source",
      elementId: target.elementId,
      equationSource: source ? `{ ${source} } + 1` : "1 + 1",
    });
  }

  const verifiedOperations = [...new Set(operations)].sort();
  if (
    expectedOperations &&
    stable(verifiedOperations) !==
      stable([...new Set(expectedOperations)].sort())
  )
    throw new Error(
      `Semantic capability drift: expected ${stable(expectedOperations)}, verified ${stable(verifiedOperations)}.`,
    );
  if (process.env.SPELLBOOK_PROBE_SCREENSHOT) {
    const captured = await call({
      operation: "observe",
      captureSlideIndexes: [observed.activeSlide],
    });
    const image = captured.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Semantic mutation returned no verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  await requestNativeProbeSave(page);
  const report = {
    scenario,
    commands: operations,
    enginePatchLevel: observed.engine.patchLevel,
    atomic: true,
    undoExact: true,
    redoExact: true,
    persistenceBefore,
    persistenceExpected: persistenceStateFromObservation(observed),
  };
  if (reportPath)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
