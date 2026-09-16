import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { readRepositoryIdentity } from "./repository-identity.mjs";
import { createHarnessServer } from "./server.mjs";
import { applyOoxmlCommand } from "./ooxml-worker-source.mjs";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceRoot, "../..");
const repositoryIdentity = readRepositoryIdentity(repositoryRoot);
const rendererCallTimeoutMs = 10_000;
const unsupportedOperationProbe = "execute_arbitrary_command";
const mutationContract = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "contracts/native-edit-capabilities.json"),
  ),
);
assert.equal(
  Object.hasOwn(
    mutationContract.mutationModel.operations,
    unsupportedOperationProbe,
  ),
  false,
  "The fail-closed probe must not reject a supported PPTX operation.",
);
const fixture = new Uint8Array(
  await readFile(
    path.join(
      repositoryRoot,
      "eval/public/fixtures/general-native-surface.pptx",
    ),
  ),
);
const outputFlag = process.argv.indexOf("--output");
const outputRoot = path.resolve(
  outputFlag >= 0
    ? process.argv[outputFlag + 1]
    : "artifacts/browser-office/product-bridge",
);
await mkdir(outputRoot, { recursive: true });
const candidateRuntimePath = optionalFlagValue("--candidate-runtime");
const enduranceCycles = integerFlagValue("--endurance-cycles", 0);
const serializationProbes = !process.argv.includes(
  "--skip-serialization-probes",
);
const candidateRuntime = candidateRuntimePath
  ? await admitCandidateRuntime({ runtimeDirectory: candidateRuntimePath })
  : null;

const server = createHarnessServer(
  candidateRuntime
    ? {
        runtimeRoot: candidateRuntime.runtimeDirectory,
        runtimeIdentity: candidateRuntime.runtimeIdentity,
        upstream: candidateRuntime.upstream,
      }
    : {},
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const pageErrors = [];
  const requestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    }),
  );
  await page.goto(
    `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}&verifySerialization=1`,
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  await connectProductHost(page, origin);
  await openProductFixture(page, fixture, "open-1");
  const opened = await waitForEvent(page, { type: "open-complete" });
  assert.equal(opened.slideCount > 0, true);
  assert.equal(opened.recovered, false);

  const before = await nativeTask(page, "observe-before", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  let serializationProbe = null;
  if (serializationProbes) {
    serializationProbe = await evaluateRenderer(
      page,
      () => globalThis.spellbookBrowserOffice.verifySerializedState(),
      undefined,
      "reopen serialized PPTX without changing the live document",
    );
    assert.equal(serializationProbe.retainedRevision, before.revision);
    assert.equal(serializationProbe.slideCount, before.slides.length);
    await writeFile(
      path.join(outputRoot, "serialization-probe.json"),
      `${JSON.stringify(serializationProbe, null, 2)}\n`,
    );
  }
  const patchedBrowserRuntime = await evaluateRenderer(page, () => {
    return (
      globalThis.spellbookBrowserRuntimeAdmitted?.(
        globalThis.spellbookBrowserRuntimeCandidate,
      ) === true
    );
  });
  if (enduranceCycles > 0 && !patchedBrowserRuntime)
    throw new Error(
      "Browser product endurance requires an admitted candidate runtime.",
    );
  const target = before.slides
    .flatMap((slide) => slide.elements)
    .find((element) => typeof element.text === "string" && element.text);
  assert.ok(target, "The product bridge fixture needs editable text.");
  const geometryTarget = before.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element) =>
        element.elementId !== target.elementId &&
        Number.isSafeInteger(element.x) &&
        Number.isSafeInteger(element.y) &&
        Number.isSafeInteger(element.width) &&
        Number.isSafeInteger(element.height) &&
        element.textAutoGrowHeight !== true,
    );
  assert.ok(geometryTarget, "The product bridge fixture needs a fixed shape.");
  await assert.rejects(
    nativeTask(page, "unsupported-edit", {
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      command: {
        op: unsupportedOperationProbe,
        elementId: target.elementId,
      },
      permission: {
        mode: "selection",
        elementIds: [target.elementId],
        slideIndexes: [],
      },
      suppressCapture: true,
    }),
    patchedBrowserRuntime
      ? /unsupported_native_operation/u
      : /browser_native_runtime_patch_required/u,
  );
  const moved = await nativeTask(page, "move-1", {
    operation: "edit",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    command: {
      op: "move",
      elementId: geometryTarget.elementId,
      x: geometryTarget.x + 100,
      y: geometryTarget.y + 100,
    },
    permission: {
      mode: "selection",
      elementIds: [geometryTarget.elementId],
      slideIndexes: [],
    },
    suppressCapture: true,
  });
  const movedTarget = moved.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.elementId === geometryTarget.elementId);
  assert.equal(movedTarget?.x, geometryTarget.x + 100);
  assert.equal(movedTarget?.y, geometryTarget.y + 100);
  if (serializationProbes) {
    const editedSerializationProbe = await evaluateRenderer(
      page,
      () => globalThis.spellbookBrowserOffice.verifySerializedState(),
      undefined,
      "reopen an edited PPTX as a model-only document",
    );
    assert.equal(editedSerializationProbe.retainedRevision, moved.revision);
    await writeFile(
      path.join(outputRoot, "edited-serialization-probe.json"),
      `${JSON.stringify(editedSerializationProbe, null, 2)}\n`,
    );
  }
  await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });
  const resized = await nativeTask(page, "resize-1", {
    operation: "edit",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    command: {
      op: "resize",
      elementId: geometryTarget.elementId,
      width: geometryTarget.width + 100,
      height: geometryTarget.height + 100,
    },
    permission: {
      mode: "selection",
      elementIds: [geometryTarget.elementId],
      slideIndexes: [],
    },
    suppressCapture: true,
  });
  const resizedTarget = resized.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.elementId === geometryTarget.elementId);
  assert.equal(resizedTarget?.width, geometryTarget.width + 100);
  assert.equal(resizedTarget?.height, geometryTarget.height + 100);
  await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });
  const appearanceEdits = [
    {
      op: "fill_color",
      command: { color: 0xd97706 },
      property: "fill",
      expected: 0xd97706,
    },
    ...(patchedBrowserRuntime
      ? [
          {
            op: "rotate",
            command: { degrees: 15 },
            property: "rotation",
            expected: 1_500,
          },
          {
            op: "line_color",
            command: { color: 0x0f766e },
            property: "lineColor",
            expected: 0x0f766e,
          },
          {
            op: "line_width",
            command: { size: 2 },
            property: "lineWidth",
            expected: 200,
          },
          {
            op: "fill_opacity",
            command: { opacity: 63 },
            property: "fillOpacity",
            expected: 63,
          },
          {
            op: "line_opacity",
            command: { opacity: 57 },
            property: "lineOpacity",
            expected: 57,
          },
        ]
      : []),
  ];
  for (const edit of appearanceEdits) {
    const changed = await nativeTask(page, `appearance-${edit.op}`, {
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      command: {
        op: edit.op,
        elementId: geometryTarget.elementId,
        ...edit.command,
      },
      permission: {
        mode: "selection",
        elementIds: [geometryTarget.elementId],
        slideIndexes: [],
      },
      suppressCapture: true,
    });
    const changedTarget = changed.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === geometryTarget.elementId);
    assert.equal(
      changedTarget?.[edit.property],
      edit.expected,
      `${edit.op} did not reach its requested value.`,
    );
    const undo = await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Undo",
    });
    assert.equal(
      undo.revision,
      before.revision,
      `${edit.op} did not restore the original revision.`,
    );
  }
  if (patchedBrowserRuntime) {
    const formatting = target.wholeTextFormatting;
    assert.ok(formatting, "The product bridge fixture needs uniform text.");
    const fontFamily =
      formatting.fontFamily === "Carlito" ? "Aptos" : "Carlito";
    const textFormattingEdits = [
      {
        op: "font_size",
        command: { size: Number(formatting.fontSize) + 1 },
        matches: (element) =>
          Number(element.wholeTextFormatting?.fontSize) ===
          Number(formatting.fontSize) + 1,
      },
      {
        op: "bold",
        command: { bold: Number(formatting.fontWeight) < 150 },
        matches: (element) =>
          Number(element.wholeTextFormatting?.fontWeight) ===
          (Number(formatting.fontWeight) < 150 ? 150 : 100),
      },
      {
        op: "italic",
        command: {
          italic: String(formatting.fontStyle).toUpperCase().includes("NONE"),
        },
        matches: (element) =>
          String(element.wholeTextFormatting?.fontStyle)
            .toUpperCase()
            .includes("NONE") !==
          String(formatting.fontStyle).toUpperCase().includes("NONE"),
      },
      {
        op: "underline",
        command: { underline: Number(target.underline ?? 0) === 0 },
        matches: (element) =>
          (Number(element.underline ?? 0) !== 0) ===
          (Number(target.underline ?? 0) === 0),
      },
      {
        op: "strikethrough",
        command: { strikethrough: Number(target.strikethrough ?? 0) === 0 },
        matches: (element) =>
          (Number(element.strikethrough ?? 0) !== 0) ===
          (Number(target.strikethrough ?? 0) === 0),
      },
      {
        op: "font_family",
        command: { family: fontFamily },
        matches: (element) =>
          element.wholeTextFormatting?.fontFamily === fontFamily,
      },
      {
        op: "font_color",
        command: { color: target.color === 0x0f766e ? 0xd97706 : 0x0f766e },
        matches: (element) =>
          element.color === (target.color === 0x0f766e ? 0xd97706 : 0x0f766e),
      },
      {
        op: "paragraph_alignment",
        command: {
          alignment:
            Number(target.paragraphAlignment) === 3 ? "left" : "center",
        },
        matches: (element) =>
          Number(element.paragraphAlignment) ===
          (Number(target.paragraphAlignment) === 3 ? 0 : 3),
      },
    ];
    for (const edit of textFormattingEdits) {
      const changed = await nativeTask(page, `text-format-${edit.op}`, {
        operation: "edit",
        expectedRevision: before.revision,
        expectedSlides: JSON.stringify(before.slides),
        command: {
          op: edit.op,
          elementId: target.elementId,
          ...edit.command,
        },
        permission: {
          mode: "selection",
          elementIds: [target.elementId],
          slideIndexes: [],
        },
        suppressCapture: true,
      });
      const changedTarget = changed.slides
        .flatMap((slide) => slide.elements)
        .find((element) => element.elementId === target.elementId);
      assert.equal(
        edit.matches(changedTarget),
        true,
        `${edit.op} did not reach its requested value.`,
      );
      const undo = await sendHostCommand(page, "Send_UNO_Command", {
        Command: ".uno:Undo",
      });
      assert.equal(
        undo.revision,
        before.revision,
        `${edit.op} did not restore the original revision.`,
      );
    }
  } else {
    for (const { command, elementId } of [
      { command: { op: "font_size", size: 24 }, elementId: target.elementId },
      { command: { op: "bold", bold: true }, elementId: target.elementId },
      { command: { op: "italic", italic: true }, elementId: target.elementId },
      {
        command: { op: "underline", underline: true },
        elementId: target.elementId,
      },
      {
        command: { op: "strikethrough", strikethrough: true },
        elementId: target.elementId,
      },
      {
        command: { op: "font_family", family: "Carlito" },
        elementId: target.elementId,
      },
      {
        command: { op: "font_color", color: 0x0f766e },
        elementId: target.elementId,
      },
      {
        command: { op: "paragraph_alignment", alignment: "center" },
        elementId: target.elementId,
      },
      {
        command: { op: "rotate", degrees: 15 },
        elementId: geometryTarget.elementId,
      },
      {
        command: { op: "line_color", color: 0x0f766e },
        elementId: geometryTarget.elementId,
      },
      {
        command: { op: "line_width", size: 2 },
        elementId: geometryTarget.elementId,
      },
      {
        command: { op: "fill_opacity", opacity: 63 },
        elementId: geometryTarget.elementId,
      },
      {
        command: { op: "line_opacity", opacity: 57 },
        elementId: geometryTarget.elementId,
      },
    ])
      await assert.rejects(
        nativeTask(page, `${command.op}-gated`, {
          operation: "edit",
          expectedRevision: before.revision,
          expectedSlides: JSON.stringify(before.slides),
          command: {
            ...command,
            elementId,
          },
          permission: {
            mode: "selection",
            elementIds: [elementId],
            slideIndexes: [],
          },
          suppressCapture: true,
        }),
        /browser_native_runtime_patch_required/u,
      );
  }
  let nativeSnapshotPersisted = false;
  if (patchedBrowserRuntime) {
    const batchText = `${target.text} · saved batch`;
    const batch = await nativeTask(page, "native-snapshot-batch", {
      operation: "edit_batch",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      commands: [
        { op: "replace_text", elementId: target.elementId, text: batchText },
        {
          op: "move",
          elementId: geometryTarget.elementId,
          x: geometryTarget.x + 100,
          y: geometryTarget.y + 100,
        },
      ],
      permission: {
        mode: "selection",
        elementIds: [target.elementId, geometryTarget.elementId],
        slideIndexes: [],
      },
      suppressCapture: true,
    });
    assert.equal(
      batch.slides
        .flatMap((slide) => slide.elements)
        .find((element) => element.elementId === target.elementId)?.text,
      batchText,
    );
    await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Undo",
    });
    const afterBatchUndo = await nativeTask(page, "native-snapshot-undone", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(afterBatchUndo.revision, before.revision);
    nativeSnapshotPersisted = true;
  }
  const endurance =
    enduranceCycles > 0
      ? await runProductEndurance({
          page,
          cycles: enduranceCycles,
          baseline: before,
          textTarget: target,
          geometryTarget,
          pageErrors,
          requestFailures,
        })
      : {
          status: "not-requested",
          cycles: 0,
          operations: [],
        };
  const replacement = `${target.text} · product bridge`;
  const edited = await nativeTask(page, "edit-1", {
    operation: "edit",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    command: {
      op: "replace_text",
      elementId: target.elementId,
      text: replacement,
    },
    permission: {
      mode: "selection",
      elementIds: [target.elementId],
      slideIndexes: [],
    },
    suppressCapture: true,
  });
  assert.equal(
    edited.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === target.elementId)?.text,
    replacement,
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await connectProductHost(page, origin);
  await openProductFixture(page, fixture, "open-recovered");
  const recoveredOpen = await waitForEvent(page, {
    type: "open-complete",
    requestId: "open-recovered",
  });
  assert.equal(recoveredOpen.recovered, true);
  const recoveredEdit = await nativeTask(page, "observe-recovered", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(
    recoveredEdit.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === target.elementId)?.text,
    replacement,
  );

  await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });
  const restored = await nativeTask(page, "observe-restored", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(
    restored.revision,
    before.revision,
    `Undo state differs at ${firstDifference(
      { slides: before.slides, masters: before.masters },
      { slides: restored.slides, masters: restored.masters },
      "document",
    )}`,
  );

  await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Redo",
  });
  const redone = await nativeTask(page, "observe-redone", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(
    redone.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === target.elementId)?.text,
    replacement,
  );
  await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });

  const editedForSave = await nativeTask(page, "edit-2", {
    operation: "edit",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    command: {
      op: "replace_text",
      elementId: target.elementId,
      text: replacement,
    },
    permission: {
      mode: "selection",
      elementIds: [target.elementId],
      slideIndexes: [],
    },
    suppressCapture: true,
  });
  assert.notEqual(editedForSave.revision, before.revision);
  const save = await requestProductSave(page, { duplicate: true });
  await page.waitForTimeout(100);
  assert.equal(
    (await hostEventCount(page, "save")) - save.previousCount,
    1,
    "Concurrent host save commands must share one export request.",
  );
  const savedPayload = await consumeSavedBytes(page, save.requestId);
  const savedBytes = savedPayload.bytes;
  assert.equal(savedBytes[0], 0x50);
  assert.equal(savedBytes[1], 0x4b);
  const savedPackage = unzipSync(Uint8Array.from(savedBytes));
  const changedParts = changedLogicalParts(unzipSync(fixture), savedPackage);
  assert.deepEqual(
    changedParts,
    ["ppt/slides/slide1.xml"],
    "A single text edit must not rewrite unrelated OOXML parts.",
  );
  assert.ok(
    strFromU8(savedPackage["ppt/slides/slide1.xml"]).includes(replacement),
    "The localized OOXML part must contain the edited text.",
  );
  const savedRevision =
    '"saved:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"';
  await acknowledgeProductSave(page, save.requestId, savedRevision);
  const undoAfterSave = await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });
  assert.equal(undoAfterSave.revision, before.revision);
  assert.equal(
    (
      await evaluateRenderer(page, () =>
        globalThis.spellbookBrowserOffice.diagnostics(),
      )
    ).commandCount,
    1,
  );
  const undoAfterSaveState = await nativeTask(page, "undo-after-save", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(
    undoAfterSaveState.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === target.elementId)?.text,
    target.text,
  );
  const redoAfterSave = await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Redo",
  });
  assert.equal(redoAfterSave.revision, editedForSave.revision);
  assert.equal(
    (
      await evaluateRenderer(page, () =>
        globalThis.spellbookBrowserOffice.diagnostics(),
      )
    ).commandCount,
    0,
  );

  // A validated save may be acknowledged after the user has already edited
  // again. The later edit must remain dirty and recover from the saved file.
  const overlappingSave = await requestProductSave(page);
  const overlappingPayload = await consumeSavedBytes(
    page,
    overlappingSave.requestId,
  );
  assert.equal(sha256(overlappingPayload.bytes), sha256(savedBytes));
  const laterReplacement = `${replacement} · after save request`;
  const laterEdit = await nativeTask(page, "edit-after-save-request", {
    operation: "edit",
    expectedRevision: editedForSave.revision,
    expectedSlides: JSON.stringify(editedForSave.slides),
    command: {
      op: "replace_text",
      elementId: target.elementId,
      text: laterReplacement,
    },
    permission: {
      mode: "selection",
      elementIds: [target.elementId],
      slideIndexes: [],
    },
    suppressCapture: true,
  });
  assert.notEqual(laterEdit.revision, editedForSave.revision);
  const overlappingRevision =
    '"saved:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"';
  await acknowledgeProductSave(
    page,
    overlappingSave.requestId,
    overlappingRevision,
    { modified: true },
  );
  const laterUndone = await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Undo",
  });
  assert.equal(laterUndone.revision, editedForSave.revision);
  const laterRedone = await sendHostCommand(page, "Send_UNO_Command", {
    Command: ".uno:Redo",
  });
  assert.equal(laterRedone.revision, laterEdit.revision);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await connectProductHost(page, origin);
  await openProductFixture(
    page,
    savedBytes,
    "post-save-recovered",
    "product-bridge.pptx",
    overlappingRevision,
  );
  const postSaveOpen = await waitForEvent(page, {
    type: "open-complete",
    requestId: "post-save-recovered",
  });
  assert.equal(postSaveOpen.recovered, true);
  const postSaveObservation = await nativeTask(page, "post-save-observed", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(
    postSaveObservation.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === target.elementId)?.text,
    laterReplacement,
  );

  let staleAcknowledgedJournalDiscarded = false;
  if (patchedBrowserRuntime) {
    await evaluateRenderer(
      page,
      async ({ original, accepted }) => {
        const { openBrowserDocumentJournal } = await import(
          "/harness/opfs-journal.mjs"
        );
        const journal = await openBrowserDocumentJournal({
          identity: "document:product-bridge:product-bridge.pptx",
        });
        await journal.save({
          fileName: "product-bridge.pptx",
          baseBytes: Uint8Array.from(original),
          candidateBytes: Uint8Array.from(accepted),
          commands: [{ op: "replace_text" }],
        });
      },
      { original: Array.from(fixture), accepted: Array.from(savedBytes) },
      "seed acknowledged browser recovery checkpoint",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await connectProductHost(page, origin);
    await openProductFixture(
      page,
      savedBytes,
      "acknowledged-journal-open",
      "product-bridge.pptx",
      overlappingRevision,
    );
    const acknowledgedOpen = await waitForEvent(page, {
      type: "open-complete",
      requestId: "acknowledged-journal-open",
    });
    assert.equal(acknowledgedOpen.recovered, false);
    const acknowledgedState = await nativeTask(
      page,
      "acknowledged-journal-observed",
      { operation: "observe", captureSlideIndexes: [] },
    );
    assert.equal(
      acknowledgedState.slides
        .flatMap((slide) => slide.elements)
        .find((element) => element.elementId === target.elementId)?.text,
      replacement,
    );
    staleAcknowledgedJournalDiscarded = true;
  }

  const slideStructure = await verifyProductSlideStructure(browser, origin);
  const readingOrder = patchedBrowserRuntime
    ? await verifyProductReadingOrder(browser, origin)
    : { status: "candidate-runtime-required" };

  const result = {
    status: "browser-product-bridge-verified",
    crossOriginIsolated: await evaluateRenderer(
      page,
      () => crossOriginIsolated,
      undefined,
      "read cross-origin isolation",
    ),
    slideCount: opened.slideCount,
    editedElementId: target.elementId,
    replacement,
    undoRestoredRevision: restored.revision,
    recovered: recoveredOpen.recovered,
    postSaveEditRecovered: postSaveOpen.recovered,
    staleAcknowledgedJournalDiscarded,
    serializationProbe,
    nativeSnapshotPersisted,
    patchedBrowserRuntime,
    candidateRuntime: candidateRuntime
      ? {
          receiptSha256: candidateRuntime.receiptSha256,
          spellbookSourceRevision:
            candidateRuntime.receipt.spellbookSourceRevision,
          libreOffice: candidateRuntime.receipt.libreOffice,
          toolchain: candidateRuntime.receipt.toolchain,
          artifacts: candidateRuntime.receipt.artifacts,
        }
      : null,
    integrationSource: repositoryIdentity,
    verifiedElementOperations: [
      "replace_text",
      "move",
      "resize",
      ...appearanceEdits.map(({ op }) => op),
      ...(patchedBrowserRuntime
        ? [
            "font_size",
            "bold",
            "italic",
            "underline",
            "strikethrough",
            "font_family",
            "font_color",
            "paragraph_alignment",
          ]
        : []),
    ],
    savedRevision,
    savedBytes: savedBytes.length,
    fixtureSha256: sha256(fixture),
    savedSha256: sha256(savedBytes),
    changedParts,
    endurance,
    slideStructure,
    readingOrder,
    pageErrors,
    requestFailures,
  };
  assert.equal(result.crossOriginIsolated, true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requestFailures, []);
  await writeFile(
    path.join(outputRoot, "saved-product-bridge.pptx"),
    Uint8Array.from(savedBytes),
  );
  await writeFile(
    path.join(outputRoot, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function verifyProductSlideStructure(browser, origin) {
  const sourceDuplicated = applyOoxmlCommand(fixture, {
    op: "duplicate_slide",
    slideIndex: 0,
    insertIndex: 1,
  });
  const source = applyOoxmlCommand(sourceDuplicated.bytes, {
    op: "replace_text",
    elementId: "1/0",
    expectedText: "Spellbook 검증 العربية",
    text: "Spellbook 두 번째 슬라이드",
  }).bytes;
  const fileName = `product-structure-${Date.now()}.pptx`;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const pageErrors = [];
  const requestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    }),
  );
  try {
    await page.goto(
      `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await connectProductHost(page, origin);
    await openProductFixture(page, source, "structure-open", fileName);
    const opened = await waitForEvent(page, {
      type: "open-complete",
      requestId: "structure-open",
    });
    assert.equal(opened.recovered, false);
    const before = await nativeTask(page, "structure-before", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(before.slides.length, 2);
    const permission = {
      mode: "document",
      elementIds: [],
      slideIndexes: [],
    };
    const nativeSlideStructureReady = await evaluateRenderer(page, () => {
      const runtime = globalThis.spellbookBrowserRuntimeCandidate;
      return (
        globalThis.spellbookBrowserRuntimeAdmitted?.(runtime) === true &&
        runtime.nativeSlideStructureReady === true
      );
    });
    if (!nativeSlideStructureReady) {
      const gatedCommands = [
        { op: "insert_slide", slideIndex: 0 },
        { op: "duplicate_slide", slideIndex: 0 },
        { op: "delete_slide", slideIndex: 0 },
        { op: "move_slide", slideIndex: 0, targetSlideIndex: 1 },
        { op: "rename_slide", slideIndex: 0, name: "Renamed slide" },
        { op: "set_slide_hidden", slideIndex: 0, hidden: true },
      ];
      for (const command of gatedCommands)
        await assert.rejects(
          nativeTask(page, `structure-gated-${command.op}`, {
            operation: "edit",
            expectedRevision: before.revision,
            expectedSlides: JSON.stringify(before.slides),
            command,
            permission,
            suppressCapture: true,
          }),
          /browser_native_slide_structure_not_ready/u,
        );
      const unchanged = await nativeTask(page, "structure-gated-after", {
        operation: "observe",
        captureSlideIndexes: [],
      });
      assert.equal(unchanged.revision, before.revision);
      assert.equal(unchanged.slides.length, before.slides.length);
      return {
        status: "browser-product-slide-structure-gated",
        nativeSlideStructureReady,
        rejectedOperations: gatedCommands.map(({ op }) => op),
        unchangedRevision: unchanged.revision,
        pageErrors,
        requestFailures,
      };
    }
    const duplicated = await nativeTask(page, "structure-duplicate", {
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      command: { op: "duplicate_slide", slideIndex: 0 },
      permission,
      suppressCapture: true,
    });
    assert.equal(duplicated.slides.length, 3);
    const moved = await nativeTask(page, "structure-move", {
      operation: "edit",
      expectedRevision: duplicated.revision,
      expectedSlides: JSON.stringify(duplicated.slides),
      command: {
        op: "move_slide",
        slideIndex: 2,
        targetSlideIndex: 0,
      },
      permission,
      suppressCapture: true,
    });
    assert.equal(moved.slides.length, 3);
    const deleted = await nativeTask(page, "structure-delete", {
      operation: "edit",
      expectedRevision: moved.revision,
      expectedSlides: JSON.stringify(moved.slides),
      command: { op: "delete_slide", slideIndex: 1 },
      permission,
      suppressCapture: true,
    });
    assert.equal(deleted.slides.length, 2);

    let expected = applyOoxmlCommand(source, {
      op: "duplicate_slide",
      slideIndex: 0,
      insertIndex: 1,
    }).bytes;
    expected = applyOoxmlCommand(expected, {
      op: "move_slide",
      slideIndex: 2,
      insertIndex: 0,
    }).bytes;
    expected = applyOoxmlCommand(expected, {
      op: "delete_slide",
      slideIndex: 1,
    }).bytes;

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await connectProductHost(page, origin);
    await openProductFixture(page, source, "structure-recovered", fileName);
    const recovered = await waitForEvent(page, {
      type: "open-complete",
      requestId: "structure-recovered",
    });
    assert.equal(recovered.recovered, true);
    const observed = await nativeTask(page, "structure-observed", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(observed.revision, deleted.revision);

    await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Undo",
    });
    const undone = await nativeTask(page, "structure-undone", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(undone.revision, moved.revision);
    await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Redo",
    });
    const redone = await nativeTask(page, "structure-redone", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(redone.revision, deleted.revision);

    await evaluateRenderer(page, () =>
      globalThis.__spellbookProductHost.port.postMessage({
        type: "command",
        messageId: "Action_Save",
        values: { Notify: true },
      }),
    );
    const save = await waitForEvent(page, { type: "save" });
    const savedBytes = Uint8Array.from(
      await evaluateRenderer(
        page,
        (requestId) => {
          const event = globalThis.__spellbookProductHost.events.find(
            (candidate) =>
              candidate.type === "save" && candidate.requestId === requestId,
          );
          return Array.from(new Uint8Array(event.bytes));
        },
        save.requestId,
      ),
    );
    assert.deepEqual(savedBytes, expected);
    await evaluateRenderer(
      page,
      ({ requestId }) =>
        globalThis.__spellbookProductHost.port.postMessage({
          type: "save-result",
          requestId,
          ok: true,
          revision:
            '"structure:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
        }),
      { requestId: save.requestId },
    );
    await waitForEvent(page, { type: "save-response", success: true });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(requestFailures, []);
    return {
      status: "browser-product-slide-structure-verified",
      sourceSlideCount: before.slides.length,
      savedSlideCount: redone.slides.length,
      recovered: recovered.recovered,
      exactPackageBytes: true,
      changedParts: changedLogicalParts(
        unzipSync(source),
        unzipSync(savedBytes),
      ),
    };
  } finally {
    await page.close();
  }
}

async function verifyProductReadingOrder(browser, origin) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const pageErrors = [];
  const requestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    }),
  );
  try {
    await page.goto(
      `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await connectProductHost(page, origin);
    const fileName = `reading-order-${Date.now()}.pptx`;
    await openProductFixture(page, fixture, "reading-order-open", fileName);
    await waitForEvent(page, {
      type: "open-complete",
      requestId: "reading-order-open",
    });
    const before = await nativeTask(page, "reading-order-before", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    const slide = before.slides.find(
      (candidate) =>
        candidate.elements.filter((element) => element.parentElementId === null)
          .length >= 2,
    );
    assert.ok(slide, "The reading-order fixture needs two top-level objects.");
    const original = slide.elements.filter(
      (element) => element.parentElementId === null,
    );
    const requested = [...original].reverse();
    const expectedStableOrder = requested.map((element) => element.stableId);
    const permission = {
      mode: "document",
      elementIds: [],
      slideIndexes: [],
    };
    const changed = await nativeTask(page, "reading-order-edit", {
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      command: {
        op: "set_reading_order",
        elementIds: requested.map((element) => element.elementId),
      },
      permission,
      suppressCapture: true,
    });
    const topLevelStableIds = (state) =>
      state.slides[slide.slideIndex].elements
        .filter((element) => element.parentElementId === null)
        .map((element) => element.stableId);
    assert.deepEqual(topLevelStableIds(changed), expectedStableOrder);

    await sendHostCommand(page, "Send_UNO_Command", { Command: ".uno:Undo" });
    const undone = await nativeTask(page, "reading-order-undone", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.deepEqual(
      topLevelStableIds(undone),
      original.map((element) => element.stableId),
    );

    await sendHostCommand(page, "Send_UNO_Command", { Command: ".uno:Redo" });
    const redone = await nativeTask(page, "reading-order-redone", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.deepEqual(topLevelStableIds(redone), expectedStableOrder);

    const save = await requestProductSave(page);
    const saved = await consumeSavedBytes(page, save.requestId);
    await acknowledgeProductSave(
      page,
      save.requestId,
      '"saved:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
    );
    await openProductFixture(
      page,
      saved.bytes,
      "reading-order-reopen",
      `reading-order-reopened-${Date.now()}.pptx`,
    );
    await waitForEvent(page, {
      type: "open-complete",
      requestId: "reading-order-reopen",
    });
    const reopened = await nativeTask(page, "reading-order-reopened", {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.deepEqual(topLevelStableIds(reopened), expectedStableOrder);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(requestFailures, []);
    return {
      status: "browser-product-reading-order-verified",
      slideIndex: slide.slideIndex,
      objectCount: expectedStableOrder.length,
      undo: true,
      redo: true,
      reopened: true,
      pageErrors,
      requestFailures,
    };
  } finally {
    await page.close();
  }
}

async function runProductEndurance({
  page,
  cycles,
  baseline,
  textTarget,
  geometryTarget,
  pageErrors,
  requestFailures,
}) {
  const operations = enduranceOperations(textTarget, geometryTarget);
  const expectedSlides = JSON.stringify(baseline.slides);
  const exactPackageCheckInterval = Math.max(1, Math.floor(cycles / 10));
  let exactPackageChecks = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const operation = operations[cycle % operations.length];
    const taskPrefix = `endurance-${cycle + 1}-${operation.op}`;
    const edited = await nativeTask(page, `${taskPrefix}-edit`, {
      operation: "edit",
      expectedRevision: baseline.revision,
      expectedSlides,
      command: operation.command,
      permission: {
        mode: "selection",
        elementIds: [operation.command.elementId],
        slideIndexes: [],
      },
      suppressCapture: true,
    });
    assert.notEqual(
      edited.revision,
      baseline.revision,
      `${taskPrefix} did not change the document revision.`,
    );
    assert.equal(
      operation.matches(elementForOperation(edited, operation)),
      true,
      `${taskPrefix} did not reach its requested value.`,
    );
    const observed = await nativeTask(page, `${taskPrefix}-observe`, {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(observed.revision, edited.revision);

    const undone = await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Undo",
    });
    assert.equal(
      undone.revision,
      baseline.revision,
      `${taskPrefix} Undo did not restore the baseline revision.`,
    );
    const restored = await nativeTask(page, `${taskPrefix}-restored`, {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(
      restored.revision,
      baseline.revision,
      `${taskPrefix} restored state differs at ${firstDifference(
        { slides: baseline.slides, masters: baseline.masters },
        { slides: restored.slides, masters: restored.masters },
        "document",
      )}`,
    );

    const redone = await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Redo",
    });
    assert.equal(
      redone.revision,
      edited.revision,
      `${taskPrefix} Redo did not restore the edited revision.`,
    );
    const observedRedo = await nativeTask(page, `${taskPrefix}-redone`, {
      operation: "observe",
      captureSlideIndexes: [],
    });
    assert.equal(
      operation.matches(elementForOperation(observedRedo, operation)),
      true,
      `${taskPrefix} Redo did not restore the requested value.`,
    );

    const reset = await sendHostCommand(page, "Send_UNO_Command", {
      Command: ".uno:Undo",
    });
    assert.equal(reset.revision, baseline.revision);

    const save = await requestProductSave(page);
    const verifyExactPackage =
      cycle === 0 ||
      cycle === cycles - 1 ||
      (cycle + 1) % exactPackageCheckInterval === 0;
    const saved = await consumeSavedBytes(
      page,
      save.requestId,
      verifyExactPackage,
    );
    assert.equal(saved.byteLength, fixture.byteLength);
    assert.equal(saved.magic, "PK");
    if (verifyExactPackage) {
      exactPackageChecks += 1;
      assert.deepEqual(
        saved.bytes,
        fixture,
        `${taskPrefix} save changed the baseline package after Undo.`,
      );
    }
    await acknowledgeProductSave(
      page,
      save.requestId,
      `"endurance:${String(cycle + 1).padStart(3, "0")}"`,
    );
    assert.deepEqual(
      pageErrors,
      [],
      `${taskPrefix} emitted a browser page error.`,
    );
    assert.deepEqual(
      requestFailures,
      [],
      `${taskPrefix} emitted a browser request failure.`,
    );
  }
  const final = await nativeTask(page, "endurance-final-observe", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  assert.equal(final.revision, baseline.revision);
  return {
    status: "browser-product-endurance-verified",
    cycles,
    nativeTasksPerCycle: 4,
    undoRedoCommandsPerCycle: 3,
    savesPerCycle: 1,
    exactPackageChecks,
    operations: operations.map(({ op }) => op),
    finalRevision: final.revision,
  };
}

function enduranceOperations(textTarget, geometryTarget) {
  const formatting = textTarget.wholeTextFormatting;
  assert.ok(formatting, "The endurance fixture needs uniform text.");
  const alternate = (value, first, second) =>
    Number(value) === first ? second : first;
  const alternateColor = (value) => alternate(value, 0x0f766e, 0xd97706);
  return [
    {
      op: "replace_text",
      command: {
        op: "replace_text",
        elementId: textTarget.elementId,
        text: `${textTarget.text} · endurance`,
      },
      target: "text",
      matches: (element) => element.text === `${textTarget.text} · endurance`,
    },
    {
      op: "move",
      command: {
        op: "move",
        elementId: geometryTarget.elementId,
        x: geometryTarget.x + 100,
        y: geometryTarget.y + 100,
      },
      target: "geometry",
      matches: (element) =>
        element.x === geometryTarget.x + 100 &&
        element.y === geometryTarget.y + 100,
    },
    {
      op: "resize",
      command: {
        op: "resize",
        elementId: geometryTarget.elementId,
        width: geometryTarget.width + 100,
        height: geometryTarget.height + 100,
      },
      target: "geometry",
      matches: (element) =>
        element.width === geometryTarget.width + 100 &&
        element.height === geometryTarget.height + 100,
    },
    {
      op: "fill_color",
      command: {
        op: "fill_color",
        elementId: geometryTarget.elementId,
        color: alternateColor(geometryTarget.fill),
      },
      target: "geometry",
      matches: (element) =>
        element.fill === alternateColor(geometryTarget.fill),
    },
    {
      op: "rotate",
      command: {
        op: "rotate",
        elementId: geometryTarget.elementId,
        degrees: Number(geometryTarget.rotation ?? 0) / 100 + 15,
      },
      target: "geometry",
      matches: (element) =>
        element.rotation === Number(geometryTarget.rotation ?? 0) + 1_500,
    },
    {
      op: "line_color",
      command: {
        op: "line_color",
        elementId: geometryTarget.elementId,
        color: alternateColor(geometryTarget.lineColor),
      },
      target: "geometry",
      matches: (element) =>
        element.lineColor === alternateColor(geometryTarget.lineColor),
    },
    {
      op: "line_width",
      command: {
        op: "line_width",
        elementId: geometryTarget.elementId,
        size: alternate(geometryTarget.lineWidth, 200, 300) / 100,
      },
      target: "geometry",
      matches: (element) =>
        element.lineWidth === alternate(geometryTarget.lineWidth, 200, 300),
    },
    {
      op: "fill_opacity",
      command: {
        op: "fill_opacity",
        elementId: geometryTarget.elementId,
        opacity: alternate(geometryTarget.fillOpacity, 63, 57),
      },
      target: "geometry",
      matches: (element) =>
        element.fillOpacity === alternate(geometryTarget.fillOpacity, 63, 57),
    },
    {
      op: "line_opacity",
      command: {
        op: "line_opacity",
        elementId: geometryTarget.elementId,
        opacity: alternate(geometryTarget.lineOpacity, 57, 63),
      },
      target: "geometry",
      matches: (element) =>
        element.lineOpacity === alternate(geometryTarget.lineOpacity, 57, 63),
    },
    {
      op: "font_size",
      command: {
        op: "font_size",
        elementId: textTarget.elementId,
        size: Number(formatting.fontSize) + 1,
      },
      target: "text",
      matches: (element) =>
        Number(element.wholeTextFormatting?.fontSize) ===
        Number(formatting.fontSize) + 1,
    },
    {
      op: "bold",
      command: {
        op: "bold",
        elementId: textTarget.elementId,
        bold: Number(formatting.fontWeight) < 150,
      },
      target: "text",
      matches: (element) =>
        Number(element.wholeTextFormatting?.fontWeight) ===
        (Number(formatting.fontWeight) < 150 ? 150 : 100),
    },
    {
      op: "italic",
      command: {
        op: "italic",
        elementId: textTarget.elementId,
        italic: String(formatting.fontStyle).toUpperCase().includes("NONE"),
      },
      target: "text",
      matches: (element) =>
        String(element.wholeTextFormatting?.fontStyle)
          .toUpperCase()
          .includes("NONE") !==
        String(formatting.fontStyle).toUpperCase().includes("NONE"),
    },
    {
      op: "underline",
      command: {
        op: "underline",
        elementId: textTarget.elementId,
        underline: Number(textTarget.underline ?? 0) === 0,
      },
      target: "text",
      matches: (element) =>
        (Number(element.underline ?? 0) !== 0) ===
        (Number(textTarget.underline ?? 0) === 0),
    },
    {
      op: "strikethrough",
      command: {
        op: "strikethrough",
        elementId: textTarget.elementId,
        strikethrough: Number(textTarget.strikethrough ?? 0) === 0,
      },
      target: "text",
      matches: (element) =>
        (Number(element.strikethrough ?? 0) !== 0) ===
        (Number(textTarget.strikethrough ?? 0) === 0),
    },
    {
      op: "font_family",
      command: {
        op: "font_family",
        elementId: textTarget.elementId,
        family: formatting.fontFamily === "Carlito" ? "Aptos" : "Carlito",
      },
      target: "text",
      matches: (element) =>
        element.wholeTextFormatting?.fontFamily ===
        (formatting.fontFamily === "Carlito" ? "Aptos" : "Carlito"),
    },
    {
      op: "font_color",
      command: {
        op: "font_color",
        elementId: textTarget.elementId,
        color: alternateColor(textTarget.color),
      },
      target: "text",
      matches: (element) => element.color === alternateColor(textTarget.color),
    },
    {
      op: "paragraph_alignment",
      command: {
        op: "paragraph_alignment",
        elementId: textTarget.elementId,
        alignment:
          Number(textTarget.paragraphAlignment) === 3 ? "left" : "center",
      },
      target: "text",
      matches: (element) =>
        Number(element.paragraphAlignment) ===
        (Number(textTarget.paragraphAlignment) === 3 ? 0 : 3),
    },
  ];
}

function elementForOperation(observation, operation) {
  return observation.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.elementId === operation.command.elementId);
}

async function requestProductSave(page, { duplicate = false } = {}) {
  const previousCount = await hostEventCount(page, "save");
  await evaluateRenderer(
    page,
    (sendTwice) => {
      const saveCommand = {
        type: "command",
        messageId: "Action_Save",
        values: { Notify: true },
      };
      globalThis.__spellbookProductHost.port.postMessage(saveCommand);
      if (sendTwice)
        globalThis.__spellbookProductHost.port.postMessage(saveCommand);
    },
    duplicate,
  );
  const save = await waitForNewHostEvent(page, "save", previousCount);
  return { ...save, previousCount };
}

async function acknowledgeProductSave(
  page,
  requestId,
  revision,
  { modified = false } = {},
) {
  const responseCount = await hostEventCount(page, "save-response");
  const modifiedCount = await evaluateRenderer(
    page,
    (expectedModified) =>
      globalThis.__spellbookProductHost.events.filter(
        (event) =>
          event.type === "modified" && event.modified === expectedModified,
      ).length,
    modified,
  );
  await evaluateRenderer(
    page,
    ({ id, savedRevision }) =>
      globalThis.__spellbookProductHost.port.postMessage({
        type: "save-result",
        requestId: id,
        ok: true,
        revision: savedRevision,
      }),
    { id: requestId, savedRevision: revision },
  );
  const response = await waitForNewHostEvent(
    page,
    "save-response",
    responseCount,
  );
  assert.equal(response.success, true);
  assert.equal(response.modified, modified);
  await page.waitForFunction(
    ({ previousCount, expectedModified }) =>
      globalThis.__spellbookProductHost.events.filter(
        (event) =>
          event.type === "modified" && event.modified === expectedModified,
      ).length > previousCount,
    { previousCount: modifiedCount, expectedModified: modified },
    { timeout: 30_000 },
  );
}

async function consumeSavedBytes(page, requestId, includeBytes = true) {
  const saved = await evaluateRenderer(
    page,
    ({ id, returnBytes }) => {
      const event = globalThis.__spellbookProductHost.events.find(
        (candidate) => candidate.type === "save" && candidate.requestId === id,
      );
      if (!(event?.bytes instanceof ArrayBuffer))
        throw new Error("Browser save event has no PPTX bytes.");
      const bytes = new Uint8Array(event.bytes);
      const result = {
        byteLength: bytes.byteLength,
        magic: String.fromCharCode(bytes[0], bytes[1]),
        ...(returnBytes ? { bytes: Array.from(bytes) } : {}),
      };
      event.bytes = null;
      return result;
    },
    { id: requestId, returnBytes: includeBytes },
  );
  return {
    ...saved,
    ...(includeBytes ? { bytes: Uint8Array.from(saved.bytes) } : {}),
  };
}

async function hostEventCount(page, type) {
  return evaluateRenderer(
    page,
    (eventType) =>
      globalThis.__spellbookProductHost.events.filter(
        (event) => event.type === eventType,
      ).length,
    type,
  );
}

async function waitForNewHostEvent(page, type, previousCount) {
  await page.waitForFunction(
    ({ eventType, count }) =>
      globalThis.__spellbookProductHost?.events.filter(
        (event) => event.type === eventType,
      ).length > count,
    { eventType: type, count: previousCount },
    { timeout: 30_000 },
  );
  return evaluateRenderer(
    page,
    ({ eventType, count }) =>
      globalThis.__spellbookProductHost.events.filter(
        (event) => event.type === eventType,
      )[count],
    { eventType: type, count: previousCount },
  );
}

async function connectProductHost(page, origin) {
  await page.waitForFunction(
    () => document.body.dataset.state === "runtime-ready",
    null,
    { timeout: 60_000 },
  );
  await evaluateRenderer(
    page,
    (hostOrigin) => {
      const events = [];
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => events.push(event.data);
      channel.port1.start();
      globalThis.__spellbookProductHost = {
        events,
        port: channel.port1,
      };
      window.postMessage(
        {
          type: "spellbook.browser-office-connect",
          protocolVersion: 1,
        },
        hostOrigin,
        [channel.port2],
      );
    },
    origin,
  );
  await waitForEvent(page, { type: "ready" });
}

async function openProductFixture(
  page,
  bytes,
  requestId,
  fileName = "product-bridge.pptx",
  revision = '"baseline:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
) {
  await evaluateRenderer(
    page,
    ({ source, id, name, currentRevision }) => {
      const value = Uint8Array.from(source);
      globalThis.__spellbookProductHost.port.postMessage(
        {
          type: "open",
          requestId: id,
          documentId: `product-bridge:${name}`,
          fileName: name,
          revision: currentRevision,
          maxBytes: 64 * 1024 * 1024,
          bytes: value.buffer,
        },
        [value.buffer],
      );
    },
    {
      source: Array.from(bytes),
      id: requestId,
      name: fileName,
      currentRevision: revision,
    },
  );
}

async function waitForEvent(page, expected) {
  try {
    await withWallClockTimeout(
      page.waitForFunction(
        (match) =>
          globalThis.__spellbookProductHost?.events.some((event) =>
            Object.entries(match).every(([key, value]) => event[key] === value),
          ),
        expected,
        { timeout: 30_000 },
      ),
      "wait for expected browser event",
      35_000,
    );
  } catch (error) {
    const events = await evaluateRenderer(
      page,
      () =>
        (globalThis.__spellbookProductHost?.events ?? []).map((event) => ({
          type: event.type,
          id: event.id,
          error: event.error,
          messageId: event.messageId,
          command: event.command,
          requestId: event.requestId,
          modified: event.modified,
          valueRevision: event.value?.revision,
          bytes:
            event.bytes instanceof ArrayBuffer
              ? `<${event.bytes.byteLength} bytes>`
              : undefined,
        })),
      undefined,
      "read timed-out browser events",
    ).catch((diagnosticError) => [
      `<renderer-unresponsive:${diagnosticError.message}>`,
    ]);
    const diagnostics = await evaluateRenderer(
      page,
      () => globalThis.spellbookBrowserOffice?.diagnostics?.(),
      undefined,
      "read timed-out browser diagnostics",
    ).catch((diagnosticError) => ({
      unavailable: diagnosticError.message,
    }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; expected=${JSON.stringify(expected)}; events=${JSON.stringify(events)}; diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
  return evaluateRenderer(
    page,
    (match) =>
      globalThis.__spellbookProductHost.events.find((event) =>
        Object.entries(match).every(([key, value]) => event[key] === value),
      ),
    expected,
  );
}

async function nativeTask(page, id, request) {
  await evaluateRenderer(
    page,
    ({ taskId, nativeRequest }) =>
      globalThis.__spellbookProductHost.port.postMessage({
        id: taskId,
        request: nativeRequest,
      }),
    { taskId: id, nativeRequest: request },
  );
  const event = await waitForEvent(page, { id });
  if (event.error) throw new Error(event.error);
  return event.value;
}

async function sendHostCommand(page, messageId, values) {
  const requestId = `host-command-${messageId}-${Date.now()}-${Math.random()}`;
  await evaluateRenderer(
    page,
    ({ command, payload, requestId: id }) =>
      globalThis.__spellbookProductHost.port.postMessage({
        type: "command",
        messageId: command,
        values: payload,
        requestId: id,
      }),
    { command: messageId, payload: values, requestId },
  );
  return waitForEvent(page, {
    type: "command-complete",
    messageId,
    requestId,
  });
}

async function evaluateRenderer(
  page,
  pageFunction,
  argument,
  label = "browser renderer evaluation",
) {
  return withWallClockTimeout(
    page.evaluate(pageFunction, argument),
    label,
    rendererCallTimeoutMs,
  );
}

async function withWallClockTimeout(promise, label, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function optionalFlagValue(name, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function integerFlagValue(name, fallback, argv = process.argv) {
  const value = optionalFlagValue(name, argv);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function firstDifference(left, right, path = "slides") {
  if (Object.is(left, right)) return null;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return path;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function changedLogicalParts(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => !equalBytes(before[name], after[name]))
    .sort();
}

function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
