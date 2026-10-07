/* SPDX-License-Identifier: MPL-2.0 */
// Local, real subscription model + real editor. No paid cloud runner or mocks.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { AppServerClient } from "../apps/ai-connector/dist/app-server-client.js";
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const output = path.resolve(
  flag("--output", "artifacts/native-customer-workflow"),
);
const agentPath = path.resolve(
  flag("--agent", "apps/ai-connector/dist/native-agent.js"),
);
const { runNativeTurn } = await import(pathToFileURL(agentPath).href);
const origin = flag("--origin", "http://127.0.0.1:4173");
const repetitions = Number(flag("--repetitions", "3"));
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10)
  throw Error("invalid_repetitions");
await fs.mkdir(output, { recursive: false });
const home = await fs.mkdtemp(
  path.join(os.tmpdir(), "spellbook-workflow-auth-"),
);
let client, browser;
const records = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  await fs.copyFile(
    path.join(os.homedir(), ".codex/auth.json"),
    path.join(home, "auth.json"),
  );
  await fs.chmod(path.join(home, "auth.json"), 0o600);
  client = await AppServerClient.start(home);
  const catalog = await client.models();
  const model = catalog.find(
    (item) => item.model === flag("--model", "gpt-6-astra"),
  );
  if (!model) throw Error("requested_model_unavailable");
  const settings = { provider: "codex", model: model.model, effort: "medium" };
  browser = await chromium.launch({ headless: true });
  const cases = [
    {
      id: "circle",
      fixture: "native-image-shape.pptx",
      request:
        "사진을 원형으로 잘라서 들어가게 해줘 지금은 너무 네모라 부자연스러워",
    },
    {
      id: "title",
      fixture: "native-image-shape.pptx",
      request: "제목 프로필을 고객 소개로 바꿔줘. 사진은 그대로 유지해줘.",
    },
    {
      id: "continued-multi-circle",
      fixture: "native-image-shape.pptx",
      request: "진행해",
      continuedGoal: "모든 사진을 원형으로 잘라줘. 제목은 유지해줘.",
      duplicateSlide: true,
    },
    {
      id: "mixed",
      fixture: "native-image-shape.pptx",
      request: "사진을 원형으로 잘라주고 제목 프로필을 고객 소개로 바꿔줘.",
    },
  ];
  const selectedCases = flag("--cases", "circle,title").split(",");
  assert(
    selectedCases.every((id) => cases.some((test) => test.id === id)),
    "Unknown case",
  );
  for (let trial = 0; trial < repetitions; trial++)
    for (const test of cases.filter((test) =>
      selectedCases.includes(test.id),
    )) {
      const context = await browser.newContext({
          viewport: { width: 1440, height: 960 },
        }),
        page = await context.newPage();
      const diagnostics = [];
      page.on("pageerror", (error) => diagnostics.push(error.message));
      let input = await fs.readFile(
        path.resolve("eval/public/fixtures", test.fixture),
      );
      if (test.duplicateSlide) {
        const parts = unzipSync(input),
          encode = (text) => new TextEncoder().encode(text),
          read = (name) => new TextDecoder().decode(parts[name]);
        parts["ppt/slides/slide2.xml"] = parts["ppt/slides/slide1.xml"];
        parts["ppt/slides/_rels/slide2.xml.rels"] =
          parts["ppt/slides/_rels/slide1.xml.rels"];
        parts["ppt/presentation.xml"] = encode(
          read("ppt/presentation.xml").replace(
            "</p:sldIdLst>",
            '<p:sldId id="257" r:id="rId8"/></p:sldIdLst>',
          ),
        );
        parts["ppt/_rels/presentation.xml.rels"] = encode(
          read("ppt/_rels/presentation.xml.rels").replace(
            "</Relationships>",
            '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
          ),
        );
        parts["[Content_Types].xml"] = encode(
          read("[Content_Types].xml").replace(
            "</Types>",
            '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
          ),
        );
        input = Buffer.from(zipSync(parts));
      }
      try {
        await page.goto(origin + "/local");
        await page.evaluate(
          async () =>
            await (
              await import("/local-workspace.mjs")
            ).localProgramsReady,
        );
        await page.evaluate(
          async (bytes) => {
            const root = await navigator.storage.getDirectory(),
              handle = await root.getFileHandle("owned-evaluation.pptx", {
                create: true,
              });
            const stream = await handle.createWritable();
            await stream.write(new Uint8Array(bytes));
            await stream.close();
            window.proofHandle = handle;
            window.showOpenFilePicker = async () => [handle];
            window.showSaveFilePicker = async () => handle;
          },
          [...input],
        );
        await page.locator("#open").click();
        await page.waitForFunction(
          () => !document.getElementById("save").disabled,
          null,
          { timeout: 180000 },
        );
        const call = async (request) => {
          const response = await page.evaluate(async (request) => {
            try {
              return {
                value: await (
                  await import("/local-workspace.mjs")
                ).localOffice.call(request),
              };
            } catch (error) {
              return { error: error.message };
            }
          }, request);
          if (response.error) throw Error(response.error);
          return response.value;
        };
        const before = await call({
          operation: "observe",
          detailSlideIndex: 0,
          captureSlideIndexes: [0],
        });
        const tools = [],
          host = [];
        const started = performance.now();
        const adapter = {
          supportsImageGeneration: false,
          runStructuredTurn: (content, schema, timeout, options) =>
            client.runStructuredTurn(content, schema, timeout, {
              ...options,
              onTool: async (name, ...args) => {
                const start = performance.now();
                const result = await options.onTool(name, ...args);
                tools.push({
                  name,
                  ms: performance.now() - start,
                  success: result.success,
                  args: args[0],
                  error: result.success
                    ? null
                    : result.contentItems
                        ?.filter((item) => item.type === "inputText")
                        .map((item) => item.text)
                        .join("\n"),
                });
                return result;
              },
            }),
        };
        const result = await runNativeTurn(adapter, {
          requestText: test.request,
          documentScope: test.id,
          ...(test.continuedGoal
            ? {
                activeGoal: {
                  version: 1,
                  scope: test.id,
                  request: test.continuedGoal,
                  checks: [],
                },
                conversationHistory: Array.from({ length: 12 }, () => ({
                  request: "어떤 사진이야?",
                  response: "사진을 설명합니다",
                  status: "completed",
                })),
              }
            : {}),
          permission: { mode: "document", elementIds: [], slideIndexes: [] },
          initialObservation: before,
          modelSettings: settings,
          signal: AbortSignal.timeout(240000),
          onText: () => {},
          onTool: () => {},
          host: {
            call: async (request) => {
              const start = performance.now();
              let result;
              try {
                result = await call(request);
              } catch (error) {
                host.push({
                  operation: request.operation,
                  ms: performance.now() - start,
                  commands: request.commands,
                  command: request.command,
                  dryRun: request.dryRun,
                  error: error.message,
                });
                throw error;
              }
              host.push({
                operation: request.operation,
                ms: performance.now() - start,
                commands: request.commands,
                command: request.command,
                dryRun: request.dryRun,
              });
              return result;
            },
          },
        });
        const elapsedMs = performance.now() - started,
          after = await call({
            operation: "observe",
            detailSlideIndex: 0,
            captureSlideIndexes: before.slides.map((slide) => slide.slideIndex),
          });
        for (const image of after.images)
          await fs.writeFile(
            path.join(
              output,
              `${test.id}-${trial + 1}-slide-${image.slideIndex + 1}.png`,
            ),
            typeof image.pngBase64 === "string"
              ? Buffer.from(image.pngBase64, "base64")
              : Buffer.from(image.pngBytes),
          );
        const circles = after.slides.every(
          (slide) =>
            slide.onlyoffice.drawings[1].geometry.preset === "ellipse" &&
            Math.abs(slide.elements[1].width - slide.elements[1].height) <= 1,
        );
        const title =
          after.slides[0].elements[0].text.replace(/[\r\n]+$/, "") ===
          "고객 소개";
        const objective =
          test.id === "title"
            ? title
            : test.id === "mixed"
              ? circles && title
              : circles;
        const preserved =
          test.id !== "title" && test.id !== "mixed"
            ? after.slides.every(
                (slide, index) =>
                  JSON.stringify(slide.elements[0]) ===
                  JSON.stringify(before.slides[index].elements[0]),
              )
            : test.id === "mixed"
              ? ["x", "y", "width", "height"].every(
                  (key) =>
                    after.slides[0].elements[1][key] ===
                    before.slides[0].elements[1][key],
                ) &&
                JSON.stringify(after.slides[0].elements[1].onlyoffice.crop) ===
                  JSON.stringify(before.slides[0].elements[1].onlyoffice.crop)
              : JSON.stringify(after.slides[0].elements[1]) ===
                JSON.stringify(before.slides[0].elements[1]);
        await page.screenshot({
          path: path.join(output, `${test.id}-${trial + 1}.png`),
        });
        await page.locator("#save").click();
        await page.waitForFunction(
          () =>
            document.getElementById("status").textContent === "파일 저장 완료",
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
        await fs.writeFile(
          path.join(output, `${test.id}-${trial + 1}.pptx`),
          saved,
        );
        const source = unzipSync(input),
          parts = unzipSync(saved);
        const sourceMediaPreserved = Object.keys(source)
          .filter((name) => name.startsWith("ppt/media/"))
          .every(
            (name) => parts[name] && hash(parts[name]) === hash(source[name]),
          );
        await page.goto(origin + "/local");
        await page.evaluate(
          async () =>
            await (
              await import("/local-workspace.mjs")
            ).localProgramsReady,
        );
        await page.evaluate(async () => {
          const handle = await (
            await navigator.storage.getDirectory()
          ).getFileHandle("owned-evaluation.pptx");
          window.showOpenFilePicker = async () => [handle];
        });
        await page.locator("#open").click();
        await page.waitForFunction(
          () => !document.getElementById("save").disabled,
          null,
          { timeout: 180000 },
        );
        const reopened = await call({ operation: "observe" });
        const savedReopened =
          JSON.stringify(reopened.slides) === JSON.stringify(after.slides);
        const record = {
          id: test.id,
          trial: trial + 1,
          settings,
          elapsedMs,
          objective,
          actualTitle: after.slides[0].elements[0].text,
          preserved,
          sourceMediaPreserved,
          savedReopened,
          tools,
          host,
          result,
          diagnostics,
        };
        records.push(record);
        console.log(
          JSON.stringify({
            id: test.id,
            trial: trial + 1,
            elapsedMs,
            objective,
            preserved,
            savedReopened,
            outcome: result.task?.outcome,
            tools: tools.map((tool) => tool.name),
          }),
        );
        await fs.writeFile(
          path.join(output, "results.json"),
          JSON.stringify({ agentPath, settings, records }, null, 2),
        );
      } catch (error) {
        await fs.writeFile(
          path.join(output, `${test.id}-${trial + 1}-failure.json`),
          JSON.stringify({ error: error.stack, diagnostics }, null, 2),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  const successful = records.filter(
    (row) =>
      row.objective &&
      row.preserved &&
      row.savedReopened &&
      row.sourceMediaPreserved &&
      row.result.task?.outcome === "fulfilled",
  );
  const summary = {
    trials: records.length,
    successful: successful.length,
    meanMs: records.reduce((n, row) => n + row.elapsedMs, 0) / records.length,
    successfulMeanMs: successful.length
      ? successful.reduce((n, row) => n + row.elapsedMs, 0) / successful.length
      : null,
  };
  await fs.writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  if (flag("--require-success", "false") === "true")
    assert.equal(successful.length, records.length);
} finally {
  client?.close();
  await browser?.close();
  await fs.rm(home, { recursive: true, force: true });
}
