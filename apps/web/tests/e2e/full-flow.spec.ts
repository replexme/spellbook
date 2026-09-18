import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const documentId = "e2e-document";
const originalVersionId = "e2e-original";
const candidateVersionId = "e2e-candidate";
const editId = "e2e-edit";
const screenshotDir = path.resolve(
  process.cwd(),
  "../../.tmp-runtime-validation",
);

const originalGraph = graph("e2e/original.svg", "분기 실적 보고서");
const candidateGraph = graph("e2e/candidate.svg", "2026년 3분기 실적");

// AI connection steps are covered by the settings tests in design-system.spec.ts.

test("편집기 기동 지연을 실패가 아닌 진행 상태로 설명한다", async ({
  page,
}) => {
  await page.route(
    `**/api/documents/${documentId}/native/launch`,
    async (route) =>
      route.fulfill({
        status: 503,
        json: { error: "office_editor_starting" },
      }),
  );

  await page.goto(`/documents/${documentId}`);
  await expect(
    page.getByRole("status").filter({ hasText: "편집기 준비 중 · 처음 열 때는 1분쯤 걸려요" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "지금 다시 시도" }),
  ).not.toBeVisible();
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "native-editor-starting.png"),
  });
});

test("응답이 늦어져도 같은 문구에 멈추지 않고 다음 준비 단계를 보여준다", async ({
  page,
}) => {
  await page.clock.install();
  await page.route(
    `**/api/documents/${documentId}/native/launch`,
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
    page.getByRole("status").filter({ hasText: "평소보다 오래 걸려요. 계속 시도하고 있어요." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "지금 다시 시도" })).toBeVisible();
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "native-editor-delayed-progress.png"),
  });
});

test("문서 처리 실패는 무한 대기 대신 복구 방법을 보여준다", async ({
  page,
}) => {
  await page.route(
    `**/api/documents/${documentId}/native/launch`,
    async (route) =>
      route.fulfill({
        status: 422,
        json: { error: "document_processing_failed" },
      }),
  );

  await page.goto(`/documents/${documentId}`);
  await expect(
    page.getByRole("heading", { name: "이 파일을 편집할 수 있게 준비하지 못했어요" }),
  ).toBeVisible();
  await expect(page.getByText("올린 원본은 그대로 있어요.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "원본 내려받기" })).toHaveAttribute(
    "href",
    `/api/documents/${documentId}/download?source=original`,
  );
  await expect(page.getByRole("link", { name: "파일 목록", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "지금 다시 시도" })).toHaveCount(0);
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "native-document-processing-failed.png"),
  });
});

test("열지 못하면 저절로 다시 시도하고, 몇 번째 시도인지 알려 준다", async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  await page.route(`**/api/documents/${documentId}/native/launch`, async (route) => {
    calls += 1;
    await route.fulfill({ status: 500, json: { error: "internal_error" } });
  });
  await page.goto(`/documents/${documentId}`);
  await expect(page.getByRole("heading", { name: "편집기에 연결하지 못했어요" })).toBeVisible();
  await expect(page.getByText("20초 뒤에 자동으로 다시 시도해요 · 두 번째 시도")).toBeVisible();
  const before = calls;
  await page.clock.fastForward(21_000);
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(page.getByText("· 세 번째 시도", { exact: false })).toBeVisible();
});

test("여는 동안 지난 요청을 보여 주고, 적어 둔 요청은 열리는 대로 보낸다고 알려 준다", async ({ page }) => {
  await page.route(`**/api/documents/${documentId}/native/launch`, (route) =>
    route.fulfill({ status: 503, json: { error: "office_editor_starting" } }),
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
    route.fulfill({ json: { account: { account: { type: "chatgpt", email: "person@example.test" } } } }),
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
  await expect(panel.getByText("표의 숫자 서식을 천 단위 쉼표로 통일해 줘")).toBeVisible();
  await panel.getByRole("textbox", { name: "AI에게 요청" }).fill("3번 슬라이드 제목을 한 줄로 줄여 줘");
  await panel.getByRole("button", { name: "요청 보내기" }).click();
  await expect(panel.getByText("편집기가 열리는 대로 보낼게요")).toBeVisible();
  await expect(panel.getByText("3번 슬라이드 제목을 한 줄로 줄여 줘")).toBeVisible();
});

// These scenarios exercise the retired graph-overlay editor. The active
// product route mounts NativeDocument and is covered by design-system.spec.ts
// plus tests/production/full-flow.spec.ts against the real Collabora runtime.
const legacyTest = test.skip;

legacyTest(
  "직접 편집은 실제 명령과 버전을 전송하고 모델 선택은 다음 AI 요청에 전달된다",
  async ({ page }) => {
    const state = { ...readyDocument(), latestEdit: null as any };
    let manual: any, ai: any;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/ai/models")
        return route.fulfill({
          json: {
            models: [
              {
                model: "account-default",
                displayName: "Account Default",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium", description: "Balanced" },
                ],
                isDefault: true,
              },
              {
                model: "account-deep",
                displayName: "Account Deep",
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast" },
                  { reasoningEffort: "high", description: "Deep" },
                ],
                isDefault: false,
              },
            ],
          },
        });
      if (url.pathname.endsWith("/manual-edits")) {
        manual = route.request().postDataJSON();
        state.graph = graph("e2e/manual.svg", manual.command.commands[0].text);
        return route.fulfill({
          status: 202,
          json: { editRequestId: "manual" },
        });
      }
      if (url.pathname.endsWith("/edits")) {
        ai = route.request().postDataJSON();
        return route.fulfill({ status: 202, json: { editRequestId: "ai" } });
      }
      if (url.pathname.endsWith("/conversation"))
        return route.fulfill({ json: { messages: [] } });
      if (url.pathname === `/api/documents/${documentId}`)
        return route.fulfill({ json: state });
      if (url.pathname === "/api/assets")
        return route.fulfill({
          contentType: "image/svg+xml",
          body: slideSvg("직접 편집 미리보기"),
        });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`/documents/${documentId}`);
    await page.getByRole("button", { name: "제목", exact: true }).click();
    await page
      .getByRole("button", { name: "직접 편집 · 1개 선택", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "요소 텍스트", exact: true })
      .fill("직접 수정한 제목");
    await page
      .getByRole("button", { name: "텍스트 저장", exact: true })
      .click();
    await expect
      .poll(() => manual?.command.commands[0].text)
      .toBe("직접 수정한 제목");
    expect(manual.baseVersionId).toBe(originalVersionId);
    expect(manual.command.commands[0]).toMatchObject({
      op: "replace_text",
      target: {
        elementId: originalGraph.slides[0].elements[0].elementId,
        sourceHash: originalGraph.slides[0].elements[0].sourceHash,
      },
    });
    expect(manual.command.baseDocumentSha256).toBe(
      originalGraph.documentSha256,
    );
    await page.locator(".model-control > summary").click();
    await page
      .getByLabel("실행 모델", { exact: true })
      .selectOption("account-deep");
    await page.getByLabel("추론 강도", { exact: true }).selectOption("high");
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "direct-tools-model-desktop.png"),
    });
    await page.locator(".model-control > summary").click();
    await page
      .getByRole("textbox", { name: "질문하거나 수정을 요청하세요" })
      .fill("선택한 내용을 검토해줘");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect
      .poll(() => ai?.modelSettings)
      .toEqual({ model: "account-deep", effort: "high" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(screenshotDir, "direct-tools-model-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  },
);

for (const change of ["added", "deleted", "moved"] as const) {
  legacyTest(
    `전후 비교는 페이지 번호가 아닌 슬라이드 정체성으로 ${change}를 표시한다`,
    async ({ page }) => {
      const original = structuredClone(originalGraph);
      const second = {
        ...structuredClone(original.slides[0]),
        slideIndex: 1,
        partUri: "/ppt/slides/slide2.xml",
        previewObject: "e2e/original-2.svg",
        elements: original.slides[0].elements.map((e) => ({
          ...e,
          elementId: `second-${e.elementId}`,
        })),
      };
      if (change !== "added") original.slides.push(second);
      const candidate = structuredClone(original);
      if (change === "added") candidate.slides.push(second);
      if (change === "deleted") candidate.slides.pop();
      if (change === "moved")
        candidate.slides = candidate.slides
          .reverse()
          .map((s, i) => ({ ...s, slideIndex: i }));
      const state = {
        ...candidateDocument(),
        graph: original,
        candidateGraph: candidate,
      };
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/conversation"))
          return route.fulfill({ json: { messages: [] } });
        if (url.pathname === `/api/documents/${documentId}`)
          return route.fulfill({ json: state });
        if (url.pathname === "/api/assets")
          return route.fulfill({
            contentType: "image/svg+xml",
            body: slideSvg("전후 비교"),
          });
        return route.fulfill({ status: 404, body: "{}" });
      });
      await page.goto(`/documents/${documentId}`);
      if (change === "added") await page.locator(".slide-thumb").nth(1).click();
      await page
        .getByRole("button", { name: "수정 전후 비교", exact: true })
        .click();
      if (change === "added")
        await expect(
          page.getByText("새로 추가된 슬라이드입니다."),
        ).toBeVisible();
      if (change === "deleted") {
        await page.locator(".slide-thumb").nth(1).click();
        await expect(
          page.getByText("이 슬라이드는 삭제되었습니다."),
        ).toBeVisible();
      }
      if (change === "moved")
        await expect(
          page.locator(".slide-canvas > img").first(),
        ).toHaveAttribute("src", /original-2\.svg/);
      await fs.mkdir(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, `slide-comparison-${change}.png`),
      });
    },
  );
}

legacyTest(
  "새 페이지를 탐색하고 페이지 삭제 뒤에도 작업 화면과 이미지 첨부를 유지한다",
  async ({ page }) => {
    const two = structuredClone(originalGraph);
    two.slides.push({
      ...structuredClone(two.slides[0]),
      slideIndex: 1,
      partUri: "/ppt/slides/slide2.xml",
    });
    const state = {
      ...readyDocument(),
      graph: two,
      status: "editing",
      candidateGraph: null as typeof originalGraph | null,
    };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/documents/${documentId}/assets`)
        return route.fulfill({
          status: 201,
          json: { assetId: "test-asset", fileName: "로고.png" },
        });
      if (url.pathname.endsWith("/conversation"))
        return route.fulfill({ json: { messages: [] } });
      if (url.pathname === `/api/documents/${documentId}`)
        return route.fulfill({ json: state });
      if (url.pathname === "/api/assets")
        return route.fulfill({
          contentType: "image/svg+xml",
          body: slideSvg("새 페이지"),
        });
      return route.fulfill({ status: 404, body: "{}" });
    });
    await page.goto(`/documents/${documentId}`);
    await expect(page.locator(".slide-thumb")).toHaveCount(2);
    await page.locator(".slide-thumb").nth(1).click();
    await expect(page.locator(".canvas-caption")).toContainText("슬라이드 2");
    state.candidateGraph = structuredClone(originalGraph);
    await expect(page.locator(".slide-thumb")).toHaveCount(1, {
      timeout: 10000,
    });
    await expect(page.locator(".canvas-caption")).toContainText("슬라이드 1");
    await page.locator('.attachment-button input[type="file"]').setInputFiles({
      name: "로고.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture"),
    });
    await expect(page.getByRole("textbox")).toHaveValue(
      "방금 첨부한 로고.png 이미지를 ",
    );
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "extended-editing-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "extended-editing-mobile.png"),
      fullPage: true,
    });
  },
);

legacyTest(
  "AI의 편집 권한 요청은 사용자의 허용 뒤에만 바뀐다",
  async ({ page }) => {
    const state = {
      ...readyDocument(),
      status: "editing",
      aiPermission: { mode: "read_only", slideIndexes: [] as number[] },
    };
    const request = {
      id: "permission-1",
      editRequestId: editId,
      role: "tool",
      content: "제목을 수정하려면 1번 슬라이드 편집 권한이 필요합니다.",
      status: "permission_pending",
      metadata: { permission: { mode: "slides", slideIndexes: [0] } },
    };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/conversation"))
        return route.fulfill({ json: { messages: [request] } });
      if (url.pathname.endsWith("/permission")) {
        const input = route.request().postDataJSON();
        if (input.messageId) {
          expect(input.decision).toBe("grant");
          request.status = "permission_granted";
          state.aiPermission = request.metadata.permission;
        } else state.aiPermission = input.permission;
        return route.fulfill({ json: { permission: state.aiPermission } });
      }
      if (url.pathname === `/api/documents/${documentId}`)
        return route.fulfill({ json: state });
      if (url.pathname === "/api/assets")
        return route.fulfill({
          contentType: "image/svg+xml",
          body: slideSvg("분기 실적 보고서"),
        });
      return route.fulfill({ status: 404, body: "{}" });
    });
    await page.goto(`/documents/${documentId}`);
    await expect(
      page.getByText("AI 권한 · 보기·대화만", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "이 범위 편집 허용" }),
    ).toBeVisible();
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "conversation-permission-request.png"),
    });
    expect(state.aiPermission.mode).toBe("read_only");
    await page.getByRole("button", { name: "이 범위 편집 허용" }).click();
    await expect(
      page.getByText("AI 권한 · 지정 슬라이드 편집 (1번)", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "대화 이력" })).toContainText(
      "사용자가 편집 권한을 허용했습니다.",
    );
    await page
      .getByText("AI 권한 · 지정 슬라이드 편집 (1번)", { exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "AI 편집 권한" })
      .selectOption("read_only");
    await page.getByRole("button", { name: "권한 적용" }).click();
    await expect(
      page.getByText("AI 권한 · 보기·대화만", { exact: true }),
    ).toBeVisible();
  },
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/documents/*/conversation", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
});

legacyTest(
  "대화 작업 공간은 응답 중 추가 지시, 진행 표시와 재접속을 지원한다",
  async ({ page }) => {
    const state = readyDocument();
    state.status = "editing";
    const messages = [
      {
        id: "1",
        editRequestId: editId,
        role: "user",
        content: "이 슬라이드의 핵심을 설명하고 제목을 짧게 바꿔줘",
        status: "completed",
      },
      {
        id: "2",
        editRequestId: editId,
        role: "assistant",
        content: "**현재 슬라이드**의 제목과 내용을 확인하고 있습니다.",
        status: "streaming",
      },
      {
        id: "3",
        editRequestId: editId,
        role: "tool",
        content: "현재 슬라이드의 화면과 요소 확인",
        status: "streaming",
      },
    ];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/conversation")) {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          expect(body.requestId).toBeTruthy();
          messages.push({
            id: "4",
            editRequestId: editId,
            role: "user",
            content: body.text,
            status: "accepted",
          });
          return route.fulfill({ json: { id: "4", status: "queued" } });
        }
        return route.fulfill({ json: { messages, status: state.status } });
      }
      if (url.pathname === `/api/documents/${documentId}`)
        return route.fulfill({ json: state });
      if (url.pathname === "/api/assets")
        return route.fulfill({
          contentType: "image/svg+xml",
          body: slideSvg("분기 실적 보고서"),
        });
      return route.fulfill({ status: 404, body: "{}" });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/documents/${documentId}`);
    const timeline = page.getByRole("region", { name: "대화 이력" });
    await expect(timeline.locator("strong")).toHaveText("현재 슬라이드");
    await expect(page.getByRole("textbox")).toBeEnabled();
    await page.getByRole("textbox").fill("색상과 배치는 유지해줘");
    await page.getByRole("textbox").press("Enter");
    await expect(timeline).toContainText("진행 중인 작업에 전달됨");
    await expect(page.getByRole("button", { name: "작업 중단" })).toBeVisible();
    const box = await timeline.boundingBox();
    expect(box!.height).toBeGreaterThan(400);
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "conversation-workspace-running.png"),
    });
    await page.reload();
    await expect(timeline).toContainText("색상과 배치는 유지해줘");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "conversation-workspace-mobile.png"),
      fullPage: true,
    });
  },
);

legacyTest(
  "채팅은 긴 입력과 한글 조합을 보존하고 실행 기록·복사·읽던 위치를 지원한다",
  async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const state = readyDocument();
    const messages = [
      {
        id: "tool-1",
        editRequestId: editId,
        role: "tool",
        status: "completed",
        content: "슬라이드 화면 확인",
      },
      {
        id: "tool-2",
        editRequestId: editId,
        role: "tool",
        status: "completed",
        content: "요소 위치 확인",
      },
      {
        id: "answer-1",
        editRequestId: editId,
        role: "assistant",
        status: "completed",
        content:
          "## 검토 결과\n\n" +
          Array.from(
            { length: 30 },
            (_, i) =>
              `${i + 1}. 원본을 유지하고 제목과 본문의 관계를 확인했습니다.`,
          ).join("\n"),
      },
    ];
    let submitted = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/conversation"))
        return route.fulfill({ json: { messages } });
      if (url.pathname.endsWith("/edits")) {
        submitted++;
        return route.fulfill({ json: {} });
      }
      if (url.pathname === `/api/documents/${documentId}`)
        return route.fulfill({ json: state });
      if (url.pathname === "/api/assets")
        return route.fulfill({
          contentType: "image/svg+xml",
          body: slideSvg("분기 실적 보고서"),
        });
      return route.fulfill({ status: 404, body: "{}" });
    });
    await page.goto(`/documents/${documentId}`);
    const timeline = page.getByRole("region", { name: "대화 이력" });
    await expect(
      timeline.getByRole("heading", { name: "검토 결과" }),
    ).toBeAttached();
    await expect(
      page.getByText("슬라이드 화면 확인", { exact: true }),
    ).toBeHidden();
    await timeline.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.locator(".tool-activity summary")).toContainText(
      "작업 기록 2개",
    );
    await page.locator(".tool-activity summary").click();
    await expect(
      page.getByText("슬라이드 화면 확인", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "최신 메시지" }),
    ).toBeVisible();
    messages.push({
      id: "answer-2",
      editRequestId: editId,
      role: "assistant",
      status: "completed",
      content: "추가 검토가 완료됐습니다.",
    });
    await expect(timeline.getByText("추가 검토가 완료됐습니다.")).toBeAttached({
      timeout: 7000,
    });
    expect(await timeline.evaluate((el) => el.scrollTop)).toBeLessThan(100);
    await page.getByRole("button", { name: "최신 메시지" }).click();
    await expect(timeline.getByText("추가 검토가 완료됐습니다.")).toBeVisible();
    await timeline
      .getByRole("button", { name: "답변 복사", exact: true })
      .last()
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("추가 검토가 완료됐습니다.");
    const input = page.getByRole("textbox", {
      name: "질문하거나 수정을 요청하세요",
    });
    await input.fill("한글 입력 중");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    expect(submitted).toBe(0);
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("한글 입력 중\n");
    await input.fill(Array(12).fill("긴 수정 요청입니다.").join("\n"));
    expect((await input.boundingBox())!.height).toBeGreaterThan(100);
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(180);
    await expect(
      timeline.getByText("추가 검토가 완료됐습니다."),
    ).toBeInViewport();
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "chat-redesign-long-conversation.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await input.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: path.join(screenshotDir, "chat-redesign-mobile-input.png"),
      fullPage: true,
    });
  },
);

legacyTest(
  "업로드부터 선택, AI 수정, 비교, 승인, 다운로드와 되돌리기까지 이어진다",
  async ({ page }) => {
    await fs.mkdir(screenshotDir, { recursive: true });

    let state = readyDocument();
    let editRequests = 0;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();

      if (url.pathname === "/api/ai/account/status" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            account: {
              account: {
                type: "chatgpt",
                email: "owner@example.test",
                planType: "pro",
              },
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/documents" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ documents: [] }),
        });
        return;
      }

      if (url.pathname === "/api/documents" && method === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: documentId }),
        });
        return;
      }

      if (url.pathname === `/api/documents/${documentId}` && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state),
        });
        return;
      }

      if (
        url.pathname === `/api/documents/${documentId}/edits` &&
        method === "POST"
      ) {
        const body = request.postDataJSON();
        if (++editRequests === 2) expect(body.baseCandidateEditId).toBe(editId);
        state = candidateDocument();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ id: editId, status: "editing" }),
        });
        return;
      }

      if (
        url.pathname ===
          `/api/documents/${documentId}/edits/${editId}/approve` &&
        method === "POST"
      ) {
        state = approvedDocument();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      if (
        url.pathname === `/api/documents/${documentId}/undo` &&
        method === "POST"
      ) {
        state = readyDocument();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      if (
        url.pathname === `/api/documents/${documentId}/download` &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="e2e-approved.pptx"',
            "content-type":
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
          body: Buffer.from("e2e-pptx-download"),
        });
        return;
      }

      if (url.pathname === "/api/assets" && method === "GET") {
        const candidate = url.searchParams.get("object")?.includes("candidate");
        await route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: slideSvg(candidate ? "2026년 3분기 실적" : "분기 실적 보고서"),
        });
        return;
      }

      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "unexpected_e2e_route" }),
      });
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "보이는 그대로 열고, 필요한 것만 고칩니다.",
      }),
    ).toBeVisible();
    await expect(page.getByText("연결됨", { exact: true })).toBeVisible();
    await expect(page.getByText("플랜: pro", { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, "browser-e2e-dashboard.png"),
      fullPage: true,
    });

    await page.locator('input[type="file"]').setInputFiles({
      name: "quarterly-report.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("e2e-pptx-upload"),
    });
    await page.waitForURL(`**/documents/${documentId}`);

    await expect(
      page.getByText("quarterly-report.pptx", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("지원 등급 A", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "제목", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, "browser-e2e-editor.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "제목", exact: true }).click();
    await expect(
      page.getByText("분기 실적 보고서", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "질문하거나 수정을 요청하세요" })
      .fill("제목을 2026년 3분기 실적으로 바꿔줘");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(page.getByRole("textbox")).toBeEnabled();
    await page
      .getByRole("button", { name: "수정 전후 비교", exact: true })
      .click();

    await expect(page.getByText("수정 전", { exact: true })).toBeVisible();
    await expect(
      page.getByText("자체 검증 통과 후", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "이 결과 승인" }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, "browser-e2e-before-after.png"),
      fullPage: true,
    });

    await page
      .getByRole("button", { name: "작업 화면으로", exact: true })
      .click();
    await expect(
      page.getByText("2026년 3분기 실적", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "질문하거나 수정을 요청하세요" })
      .fill("이 후보의 제목을 조금 더 간결하게 해줘");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "이 결과 승인" }),
    ).toBeVisible();
    expect(editRequests).toBe(2);

    await page.getByRole("button", { name: "이 결과 승인" }).click();
    await page.getByText("파일 정보 및 작업 이력", { exact: true }).click();
    await page.getByText("작업 이력", { exact: true }).click();
    await expect(
      page.getByText("승인됨 · 서버 기본 모델 · 시도 1회", { exact: true }),
    ).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "PPTX 다운로드" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("e2e-approved.pptx");

    await expect(page.getByRole("button", { name: "되돌리기" })).toBeEnabled();
    await page.getByRole("button", { name: "되돌리기" }).click();
    await expect(page.getByRole("button", { name: "되돌리기" })).toBeDisabled();
    await expect(
      page.getByText("분기 실적 보고서", { exact: true }),
    ).toBeVisible();
  },
);

function graph(previewObject: string, title: string) {
  return {
    contractVersion: "1.0",
    documentSha256:
      title === "분기 실적 보고서" ? "original-sha" : "candidate-sha",
    slideWidthEmu: 12_192_000,
    slideHeightEmu: 6_858_000,
    fontInventoryAvailable: true,
    declaredFonts: ["Noto Sans CJK KR"],
    missingFonts: [],
    fontSubstitutions: [],
    rendererName: "LibreOffice",
    rendererVersion: "e2e-isolated",
    slides: [
      {
        slideIndex: 0,
        partUri: "/ppt/slides/slide1.xml",
        previewObject,
        supportGrade: "A",
        elements: [
          {
            elementId: "slide-1-title",
            shapeId: 2,
            kind: "shape",
            name: "제목",
            text: title,
            x: 1_000_000,
            y: 900_000,
            width: 7_500_000,
            height: 900_000,
            rotation: 0,
            zIndex: 1,
            editable: true,
            unsupportedReason: null,
            sourceHash:
              title === "분기 실적 보고서" ? "title-before" : "title-after",
          },
        ],
        warnings: [],
      },
    ],
    warnings: [],
  };
}

function edit(status: string) {
  return {
    id: editId,
    requestText: "제목을 2026년 3분기 실적으로 바꿔줘",
    status,
    candidateVersionId,
    aiAttempts: 1,
    resultSummary: "제목만 요청한 문구로 교체했고 재렌더 검증을 통과했습니다.",
    lastError: null,
  };
}

function readyDocument() {
  return {
    id: documentId,
    fileName: "quarterly-report.pptx",
    status: "ready",
    lastError: null,
    currentVersionId: originalVersionId,
    graph: originalGraph,
    candidateGraph: null,
    latestEdit: null,
    history: [],
    versions: [
      { id: originalVersionId, parentVersionId: null, kind: "original" },
    ],
  };
}

function candidateDocument() {
  return {
    ...readyDocument(),
    status: "candidate_ready",
    candidateGraph,
    latestEdit: edit("candidate_ready"),
    history: [edit("candidate_ready")],
    versions: [
      { id: originalVersionId, parentVersionId: null, kind: "original" },
      {
        id: candidateVersionId,
        parentVersionId: originalVersionId,
        kind: "candidate",
      },
    ],
  };
}

function approvedDocument() {
  return {
    ...candidateDocument(),
    status: "ready",
    currentVersionId: candidateVersionId,
    graph: candidateGraph,
    candidateGraph: null,
    latestEdit: edit("approved"),
    history: [edit("approved")],
  };
}

function slideSvg(title: string) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1440" height="810" viewBox="0 0 1440 810">
      <rect width="1440" height="810" fill="#fffdf7"/>
      <rect x="110" y="106" width="1220" height="12" fill="#d9ff43"/>
      <text x="118" y="245" font-family="sans-serif" font-size="72" font-weight="700" fill="#171813">${title}</text>
      <text x="118" y="325" font-family="sans-serif" font-size="28" fill="#6d7065">원본 요소를 유지한 국소 편집 검증</text>
    </svg>
  `;
}

for (const [width, height] of [
  [1600, 900],
  [1200, 900],
  [900, 1200],
  [1370, 910],
]) {
  legacyTest(
    `슬라이드 ${width}:${height}에서 그림과 선택 좌표가 일치한다`,
    async ({ page }) => {
      const state = readyDocument();
      state.graph = structuredClone(originalGraph);
      state.graph.slideWidthEmu = width * 1000;
      state.graph.slideHeightEmu = height * 1000;
      Object.assign(state.graph.slides[0].elements[0], {
        x: width * 200,
        y: height * 300,
        width: width * 400,
        height: height * 100,
      });
      await page.route(`**/api/documents/${documentId}`, (route) =>
        route.fulfill({ json: state }),
      );
      await page.route("**/api/assets?**", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><rect x="${width * 0.2}" y="${height * 0.3}" width="${width * 0.4}" height="${height * 0.1}" fill="#d9ff43"/></svg>`,
        }),
      );
      await page.goto(`/documents/${documentId}`);
      const canvas = page.locator(".slide-canvas");
      const target = page.getByRole("button", { name: "제목", exact: true });
      await expect(target).toBeVisible();
      const bounds = (await canvas.boundingBox())!;
      const box = (await target.boundingBox())!;
      expect(bounds.width / bounds.height).toBeCloseTo(width / height, 2);
      expect((box.x - bounds.x) / bounds.width).toBeCloseTo(0.2, 2);
      expect((box.y - bounds.y) / bounds.height).toBeCloseTo(0.3, 2);
      await target.click();
      await expect(target).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({
        path: path.join(screenshotDir, `beta-selection-${width}-${height}.png`),
        fullPage: true,
      });
    },
  );
}

legacyTest(
  "초기 통신 오류는 무한 로딩 대신 다시 불러오기를 제공한다",
  async ({ page }) => {
    await page.route(`**/api/documents/${documentId}`, (route) =>
      route.abort("failed"),
    );
    await page.goto(`/documents/${documentId}`);
    await expect(
      page.getByRole("button", { name: "다시 불러오기" }),
    ).toBeVisible();
    await expect(page.locator(".spinner")).toHaveCount(0);
  },
);

legacyTest(
  "후보 위에서 질문하고 새로고침해도 대화와 후보가 유지된다",
  async ({ page }) => {
    let answered = false;
    const answer =
      "현재 제목은 2026년 3분기 실적입니다. 파일은 바꾸지 않았습니다.";
    await page.route(`**/api/documents/${documentId}`, (route) => {
      const state = candidateDocument();
      if (answered)
        state.history.unshift({
          ...edit("answered"),
          id: "question",
          requestText: "현재 제목이 뭐야?",
          resultSummary: answer,
        });
      return route.fulfill({ json: state });
    });
    await page.route(`**/api/documents/${documentId}/edits`, (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        requestText: "현재 제목이 뭐야?",
        selectedElementIds: [],
        selectedSlideIndexes: [0],
        baseCandidateEditId: editId,
      });
      answered = true;
      return route.fulfill({
        status: 202,
        json: { editRequestId: "question" },
      });
    });
    await page.route("**/api/assets?**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: slideSvg("2026년 3분기 실적"),
      }),
    );
    await page.goto(`/documents/${documentId}`);
    await page.getByRole("textbox").fill("현재 제목이 뭐야?");
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(page.getByRole("region", { name: "대화 이력" })).toContainText(
      answer,
    );
    await expect(
      page.getByRole("button", { name: "이 결과 승인" }),
    ).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "대화 이력" })).toContainText(
      answer,
    );
    await expect(page.getByRole("textbox")).toBeEnabled();
    await page.screenshot({
      path: path.join(screenshotDir, "beta-conversation.png"),
      fullPage: true,
    });
  },
);
