/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { unzipSync } from "fflate";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const output = path.resolve(arg("--output", "artifacts/native-image-shape"));
const origin = arg("--origin", "http://127.0.0.1:4173");
const input = await fs.readFile(
  arg("--input", "eval/public/fixtures/native-image-shape.pptx"),
);
await fs.mkdir(output, { recursive: false });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const diagnostics = [];
page.on("pageerror", (error) => diagnostics.push(error.stack));
page.on("requestfailed", (request) =>
  diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const call = (request) =>
  page.evaluate(
    async (value) =>
      (await import("/local-workspace.mjs")).localOffice.call(value),
    request,
  );
const observe = () => call({ operation: "observe", captureSlideIndexes: [0] });
const shape = (state) => state.slides[0].onlyoffice.drawings[1].geometry.preset;
const open = async (bytes) => {
  await page.goto(origin + "/local");
  await page.evaluate(async () => {
    await (
      await import("/local-workspace.mjs")
    ).localProgramsReady;
  });
  await page.evaluate(
    async (input) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("native-image-shape.pptx", {
        create: true,
      });
      const stream = await handle.createWritable();
      await stream.write(new Uint8Array(input));
      await stream.close();
      window.proofHandle = handle;
      window.showOpenFilePicker = async () => [handle];
      window.showSaveFilePicker = async () => handle;
    },
    [...bytes],
  );
  await page.locator("#open").click();
  await page.waitForFunction(
    () => !document.getElementById("save").disabled,
    null,
    { timeout: 180000 },
  );
};
const waitShape = async (wanted) => {
  await page.waitForFunction(
    async (value) => {
      const state = await (
        await import("/local-workspace.mjs")
      ).localOffice.call({ operation: "observe" });
      return state.slides[0].onlyoffice.drawings[1].geometry.preset === value;
    },
    wanted,
    { timeout: 120000 },
  );
  return observe();
};
const permission = { mode: "document", slideIndexes: [], elementIds: [] };
const commands = [
  {
    op: "crop_image",
    elementId: "0/1",
    geometry: "ellipse",
  },
];
try {
  await open(input);
  const before = await observe();
  const aiState = await page.evaluate(async () => {
    const { localOffice } = await import("/local-workspace.mjs");
    const { localOfficeAIState } = await import("/local-file.mjs");
    const documentId = localOffice.documentScope();
    const state = {
      conversationHistory: [
        { request: "설명해줘", response: "사진 설명", status: "completed" },
      ],
      activeGoal: {
        version: 1,
        scope: documentId,
        request: "사진을 원형으로 잘라줘",
        checks: [],
      },
    };
    await localOfficeAIState(documentId, state);
    return { documentId, state };
  });
  assert.equal(shape(before), "rect");
  await page.screenshot({ path: path.join(output, "before.png") });
  await assert.rejects(
    () =>
      call({
        operation: "edit_batch",
        expectedRevision: before.revision,
        expectedSlides: JSON.stringify(before.slides),
        permission,
        commands: [{ ...commands[0], geometry: "line" }],
      }),
    /image_shape/,
  );
  assert.equal((await observe()).revision, before.revision);
  const start = performance.now();
  const edited = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    permission,
    commands,
  });
  const editMs = performance.now() - start;
  assert.equal(shape(edited), "ellipse");
  assert.deepEqual(edited.changedSlideIndexes, [0]);
  assert.deepEqual(
    edited.slides[0].elements[1].onlyoffice.crop,
    before.slides[0].elements[1].onlyoffice.crop,
  );
  assert.deepEqual(edited.slides[0].elements[0], before.slides[0].elements[0]);
  assert.equal(
    edited.slides[0].onlyoffice.drawings[1].imagePath,
    before.slides[0].onlyoffice.drawings[1].imagePath,
  );
  await page.screenshot({ path: path.join(output, "edited.png") });
  await page.locator("#undo").click();
  const undone = await waitShape("rect");
  assert.deepEqual(undone.slides, before.slides);
  await page.locator("#redo").click();
  const redone = await waitShape("ellipse");
  assert.deepEqual(redone.slides, edited.slides);
  await page.locator("#save").click();
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "파일 저장 완료",
    null,
    { timeout: 180000 },
  );
  const saved = Buffer.from(
    await page.evaluate(async () => [
      ...new Uint8Array(
        await (await window.proofHandle.getFile()).arrayBuffer(),
      ),
    ]),
  );
  await fs.writeFile(path.join(output, "result.pptx"), saved);
  const sourceParts = unzipSync(input),
    resultParts = unzipSync(saved);
  const media = Object.keys(sourceParts).filter((name) =>
    name.startsWith("ppt/media/"),
  );
  assert(media.length > 0);
  for (const name of media)
    assert.equal(hash(resultParts[name]), hash(sourceParts[name]));
  assert.match(
    Buffer.from(resultParts["ppt/slides/slide1.xml"]).toString(),
    /prst="ellipse"/,
  );
  await open(saved);
  const reopened = await observe();
  const persisted = await page.evaluate(async () => {
    const { localOffice } = await import("/local-workspace.mjs");
    const { localOfficeAIState } = await import("/local-file.mjs");
    const documentId = localOffice.documentScope();
    return {
      documentId,
      state: await localOfficeAIState(documentId),
      other: await localOfficeAIState("another-document"),
    };
  });
  assert.equal(persisted.documentId, aiState.documentId);
  assert.deepEqual(persisted.state, aiState.state);
  assert.equal(persisted.other, null);
  assert.equal(shape(reopened), "ellipse");
  assert.deepEqual(reopened.slides, edited.slides);
  await page.screenshot({ path: path.join(output, "reopened.png") });
  const report = {
    status: "passed",
    editMs,
    nativeShape: "ellipse",
    invalidGeometryRejected: true,
    undoRedo: true,
    savedReopened: true,
    localGoalSurvivesSaveAndReload: true,
    localGoalDocumentIsolation: true,
    sourceMediaPreserved: true,
    otherElementPreserved: true,
    inputSha256: hash(input),
    resultSha256: hash(saved),
  };
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page
    .screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  await fs.writeFile(path.join(output, "failure.txt"), error.stack);
  await fs.writeFile(
    path.join(output, "diagnostics.json"),
    JSON.stringify(diagnostics, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
