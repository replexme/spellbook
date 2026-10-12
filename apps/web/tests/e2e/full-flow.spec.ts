import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/*
 * Opening a document: the page asks for a browser document view session
 * (POST .../browser/launch) and explains every state while it waits.
 */

const documentId = "e2e-document";
const screenshotDir = path.resolve(
  process.cwd(),
  "../../.tmp-runtime-validation",
);

// AI connection steps are covered by the settings tests in design-system.spec.ts.

test("응답이 늦어져도 같은 문구에 멈추지 않고 다음 준비 단계를 보여준다", async ({
  page,
}) => {
  await page.clock.install();
  await page.route(
    `**/api/documents/${documentId}/browser/launch`,
    async (route) =>
      route.fulfill({
        status: 409,
        json: { error: "document_processing" },
      }),
  );

  await page.goto(`/documents/${documentId}`);
  await expect(
    page.getByRole("status").filter({ hasText: "파일을 확인하고 있어요" }),
  ).toBeVisible();
  await page.clock.fastForward(9_000);
  await expect(
    page.getByRole("status").filter({ hasText: "편집기 준비 중" }),
  ).toBeVisible();
  await page.clock.fastForward(62_000);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "평소보다 오래 걸려요. 계속 시도하고 있어요." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "지금 다시 시도" }),
  ).toBeVisible();
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "native-editor-delayed-progress.png"),
  });
});

test("문서 처리 실패는 무한 대기 대신 복구 방법을 보여준다", async ({
  page,
}) => {
  await page.route(
    `**/api/documents/${documentId}/browser/launch`,
    async (route) =>
      route.fulfill({
        status: 422,
        json: { error: "document_processing_failed" },
      }),
  );

  await page.goto(`/documents/${documentId}`);
  await expect(
    page.getByRole("heading", {
      name: "이 파일을 편집할 수 있게 준비하지 못했어요",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("올린 원본은 그대로 있어요.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "원본 내려받기" }),
  ).toHaveAttribute(
    "href",
    `/api/documents/${documentId}/download?source=original`,
  );
  await expect(
    page.getByRole("link", { name: "파일 목록", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "지금 다시 시도" }),
  ).toHaveCount(0);
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "native-document-processing-failed.png"),
  });
});

test("열지 못하면 저절로 다시 시도하고, 몇 번째 시도인지 알려 준다", async ({
  page,
}) => {
  await page.clock.install();
  let calls = 0;
  await page.route(
    `**/api/documents/${documentId}/browser/launch`,
    async (route) => {
      calls += 1;
      await route.fulfill({ status: 500, json: { error: "internal_error" } });
    },
  );
  await page.goto(`/documents/${documentId}`);
  await expect(
    page.getByRole("heading", { name: "편집기에 연결하지 못했어요" }),
  ).toBeVisible();
  await expect(
    page.getByText("20초 뒤에 자동으로 다시 시도해요 · 두 번째 시도"),
  ).toBeVisible();
  const before = calls;
  await page.clock.fastForward(21_000);
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(
    page.getByText("· 세 번째 시도", { exact: false }),
  ).toBeVisible();
});

test("여는 동안 지난 요청을 보여 주고, 적어 둔 요청은 열리는 대로 보낸다고 알려 준다", async ({
  page,
}) => {
  await page.route(`**/api/documents/${documentId}/browser/launch`, (route) =>
    route.fulfill({ status: 409, json: { error: "document_processing" } }),
  );
  await page.route(`**/api/documents/${documentId}/native/turns`, (route) =>
    route.fulfill({
      json: {
        turns: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            requestText: "표의 숫자 서식을 천 단위 쉼표로 통일해 줘",
            permissionMode: "slides",
            status: "completed",
            assistantText: "12곳을 바꿨어요.",
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            updatedAt: new Date(Date.now() - 86_300_000).toISOString(),
            summary: null,
            beforeVersionId: null,
            afterVersionId: null,
            savedPreviews: [],
            undoneAt: null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/ai/account/status", (route) =>
    route.fulfill({
      json: {
        account: { account: { type: "chatgpt", email: "person@example.test" } },
      },
    }),
  );
  await page.route("**/api/ai/models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            model: "gpt-test",
            displayName: "GPT Test",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
      },
    }),
  );
  await page.goto(`/documents/${documentId}`);
  const panel = page.getByRole("complementary", { name: "AI와 버전 기록" });
  await expect(
    panel.getByText("표의 숫자 서식을 천 단위 쉼표로 통일해 줘"),
  ).toBeVisible();
  await panel
    .getByRole("textbox", { name: "AI에게 요청" })
    .fill("3번 슬라이드 제목을 한 줄로 줄여 줘");
  await panel.getByRole("button", { name: "요청 보내기" }).click();
  await expect(panel.getByText("편집기가 열리는 대로 보낼게요")).toBeVisible();
  await expect(
    panel.getByText("3번 슬라이드 제목을 한 줄로 줄여 줘"),
  ).toBeVisible();
});
