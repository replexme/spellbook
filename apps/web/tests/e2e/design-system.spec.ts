import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/*
 * The redesigned product screens, driven by mocked APIs. The workspace test
 * uses a stand-in editor page that speaks the real bridge handshake
 * (document loaded → extension ready → port) so the AI panel receives the
 * same events it would from Collabora.
 */

const screenshotDir = path.resolve(
  process.cwd(),
  "../../.tmp-runtime-validation/redesign",
);
const viewports = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;

const connectedAi = {
  account: {
    account: { type: "chatgpt", email: "owner@example.test", planType: "plus" },
  },
  runtime: {
    provider: "codex",
    displayName: "Codex",
    runtime: "codex",
    version: "e2e",
  },
  connectedAt: "2026-09-14T03:00:00.000Z",
};

const models = {
  models: [
    {
      provider: "codex",
      model: "gpt-e2e",
      displayName: "GPT E2E",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
      isDefault: true,
    },
  ],
};

const now = new Date("2026-09-18T01:30:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

const library = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "2026 하반기 사업계획.pptx",
    formatId: "pptx",
    status: "ready",
    lastError: null,
    createdAt: minutesAgo(3000),
    updatedAt: minutesAgo(1),
    slideCount: 12,
    coverUrl: "/e2e/cover-0.png",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    fileName: "3분기 영업 실적 보고.pptx",
    formatId: "pptx",
    status: "ready",
    lastError: null,
    createdAt: minutesAgo(5000),
    updatedAt: minutesAgo(130),
    slideCount: 18,
    coverUrl: "/e2e/cover-1.png",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    fileName: "고객 인터뷰 요약.pptx",
    formatId: "pptx",
    status: "processing",
    lastError: null,
    createdAt: minutesAgo(0),
    updatedAt: minutesAgo(0),
    slideCount: null,
    coverUrl: null,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    fileName: "교육 운영 계획.pptx",
    formatId: "pptx",
    status: "failed",
    lastError: "scan_failed",
    failureCode: "encrypted_or_legacy_file",
    createdAt: minutesAgo(9000),
    updatedAt: minutesAgo(9000),
    slideCount: null,
    coverUrl: null,
  },
];

async function shot(page: Page, name: string, fullPage = false) {
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
    fullPage,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

/** A rendered slide image for evidence and previews, drawn by the browser. */
async function slidePng(page: Page, title: string, bold: boolean) {
  const drawer = await page.context().newPage();
  await drawer.setViewportSize({ width: 640, height: 360 });
  await drawer.setContent(
    `<body style="margin:0;width:640px;height:360px;background:#fff;font-family:sans-serif;position:relative">
      <h1 style="position:absolute;left:42px;top:40px;margin:0;font-size:${bold ? 34 : 26}px;font-weight:${bold ? 800 : 500}">${title}</h1>
      <ul style="position:absolute;left:30px;top:140px;font-size:17px;line-height:2;color:#444">
        <li>국내 시장 규모 4.2조 원</li><li>상위 3사 점유율 61%</li><li>중소 고객 비중 확대</li></ul>
      <div style="position:absolute;right:48px;bottom:48px;display:flex;gap:14px;align-items:flex-end;height:180px">
        ${[38, 52, 60, 74, 92].map((h) => `<i style="display:block;width:30px;height:${h}%;background:#9aa6b2"></i>`).join("")}
      </div></body>`,
  );
  const png = await drawer.screenshot();
  await drawer.close();
  return png;
}

const editorPage = `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#e5e9ec;font-family:sans-serif">
  <div style="width:min(760px,80%);aspect-ratio:16/9;background:#fff;box-shadow:0 8px 24px rgb(0 0 0 / 12%);padding:40px;box-sizing:border-box">
    <h1 style="margin:0;font-size:32px">하반기 시장 현황</h1><p style="color:#555">편집기 자리</p>
  </div>
  <script>
    const send = (value) => parent.postMessage(value, "*");
    // What the page asked the editor to do, for the test to read.
    const calls = (window.calls = []);
    send(JSON.stringify({ MessageId: "App_LoadingStatus", Values: { Status: "Document_Loaded" } }));
    addEventListener("message", (event) => {
      let data = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      if (data && data.MessageId) calls.push(data.MessageId + (data.Values && data.Values.Command ? " " + data.Values.Command : ""));
      if (data && data.type === "spellbook.open-extension")
        send({ type: "spellbook.extension-ready", bridgeSessionId: "e2e-bridge" });
      if (data && data.type === "spellbook.ensure-edit") {
        calls.push("ensure-edit");
        send({ type: "spellbook.edit-mode", edit: true });
      }
      if (data && data.type === "spellbook.connect" && event.ports[0]) {
        const port = event.ports[0];
        port.onmessage = (message) => {
          const request = message.data && message.data.request;
          if (!request || typeof message.data.id !== "string") return;
          calls.push(request.operation);
          if (request.operation === "undo_turn")
            port.postMessage(window.failUndo
              ? { id: message.data.id, error: "document_changed_since_turn" }
              : { id: message.data.id, value: { undone: request.steps } });
          else port.postMessage({ id: message.data.id, value: { activeSlide: request.slideIndex ?? 0, revealed: request.elementId ?? null } });
        };
        port.postMessage({ type: "ready" });
        port.postMessage({ type: "selection", value: {
          activeSlide: 2, slideCount: 12, selectionCount: 1,
          selected: [{ elementId: "2/0", name: "Title 1", kind: "com.sun.star.presentation.TitleTextShape", text: "하반기 시장 현황" }],
          editableOperations: ["replace_text"],
        } });
      }
    });
  </script>
</body></html>`;

test.describe("file home", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(now);
    const covers = [
      await slidePng(page, "2026 하반기 사업계획", true),
      await slidePng(page, "3분기 영업 실적", false),
    ];
    await page.route("**/e2e/cover-*.png", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: covers[route.request().url().endsWith("cover-1.png") ? 1 : 0]!,
      }),
    );
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/documents")
        return route.fulfill({ json: { documents: library } });
      if (url.pathname === "/api/ai/account/status")
        return route.fulfill({ json: connectedAi });
      if (url.pathname === "/api/office/warm")
        return route.fulfill({ status: 204 });
      return route.fulfill({ status: 404, json: {} });
    });
  });

  test("files are found by their look, and status appears only when a file needs attention", async ({
    page,
  }) => {
    await page.setViewportSize(viewports.desktop);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "파일" })).toBeVisible();
    await expect(page.getByText("4개")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /AI 연결됨 · Codex/ }),
    ).toHaveAttribute("href", "/settings");
    await expect(page.getByText("확인 중…")).toBeVisible();
    await expect(page.getByText("열 수 없음")).toBeVisible();
    await expect(
      page.getByText("암호가 걸렸거나 옛 형식인 파일이에요"),
    ).toBeVisible();
    await expect(page.getByText("준비됨")).toHaveCount(0);
    await expect(page.getByText("1분 전 · 12장")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "home-desktop");

    await page
      .getByRole("searchbox", { name: "파일 이름으로 찾기" })
      .fill("영업");
    await expect(page.getByText("3분기 영업 실적 보고.pptx")).toBeVisible();
    await expect(page.getByText("2026 하반기 사업계획.pptx")).toHaveCount(0);
    await page
      .getByRole("searchbox", { name: "파일 이름으로 찾기" })
      .fill("없는 이름");
    await expect(
      page.getByRole("heading", { name: "찾는 파일이 없어요" }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "파일 이름으로 찾기" }).fill("");

    await page.getByRole("button", { name: "최근 수정 순" }).click();
    await page.getByRole("menuitemradio", { name: "이름 순" }).click();
    await expect(page.getByRole("button", { name: "이름 순" })).toBeVisible();
    await page.getByRole("radio", { name: "목록으로 보기" }).click();
    await expect(page.locator(".file-list")).toBeVisible();
    await shot(page, "home-list-desktop");

    await page
      .getByRole("button", { name: "2026 하반기 사업계획.pptx 메뉴" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "이름 바꾸기" }),
    ).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "삭제" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "삭제" })).toHaveCount(0);

    for (const [name, size] of [
      ["tablet", viewports.tablet],
      ["phone", viewports.phone],
    ] as const) {
      await page.setViewportSize(size);
      await expectNoHorizontalOverflow(page);
      await shot(page, `home-list-${name}`, true);
    }
    await page.getByRole("radio", { name: "격자로 보기" }).click();
    await expectNoHorizontalOverflow(page);
    await shot(page, "home-phone", true);
  });

  test("a first visit explains the three steps and where to connect AI", async ({
    page,
  }) => {
    await page.route("**/api/documents", (route) =>
      route.fulfill({ json: { documents: [] } }),
    );
    await page.route("**/api/ai/account/status", (route) =>
      route.fulfill({ json: { account: { account: null } } }),
    );
    await page.goto("/");
    await expect(
      page.getByText("PowerPoint 파일을 끌어 놓거나 선택하세요"),
    ).toBeVisible();
    await expect(
      page.getByText(".pptx · 50MB까지", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "쓰는 순서" }).getByRole("listitem"),
    ).toHaveCount(3);
    await expect(page.getByRole("link", { name: "연결하기" })).toHaveAttribute(
      "href",
      "/settings",
    );
    await expect(
      page.getByRole("link", { name: /AI 연결 필요/ }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "home-first-desktop");
    await page.setViewportSize(viewports.phone);
    await expectNoHorizontalOverflow(page);
    await shot(page, "home-first-phone", true);
  });

  test("import uploads, checks, summarises, then opens", async ({ page }) => {
    const id = "55555555-5555-4555-8555-555555555555";
    const preview = await slidePng(page, "2026 하반기 사업계획", true);
    let checks = 0;
    await page.route("**/api/documents", async (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({ status: 201, json: { id } });
      return route.fulfill({ json: { documents: library } });
    });
    await page.route(`**/api/documents/${id}/summary`, (route) => {
      checks += 1;
      return route.fulfill({
        json: {
          id,
          fileName: "2026 하반기 사업계획.pptx",
          status: checks < 2 ? "processing" : "ready",
          lastError: null,
          version:
            checks < 2
              ? null
              : {
                  id: "v1",
                  createdAt: now.toISOString(),
                  slideCount: 12,
                  rendered: true,
                  origin: null,
                  changeCheck: null,
                },
          previews:
            checks < 2
              ? []
              : Array.from({ length: 12 }, () => "/e2e/preview.png"),
          fonts: {
            inventoryAvailable: true,
            missing: ["나눔스퀘어", "에스코어 드림"],
            substitutions: [],
          },
          aiLimits: [{ kind: "diagram", count: 1, slides: [5] }],
          aiEngineKnown: true,
        },
      });
    });
    await page.route("**/e2e/preview.png", (route) =>
      route.fulfill({ contentType: "image/png", body: preview }),
    );
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({
      name: "2026 하반기 사업계획.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("PK e2e"),
    });
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "가져왔어요" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText(/^12장 · /)).toBeVisible();
    await expect(
      dialog.getByText("서버에서 파일을 다시 열어 12장을 모두 그려 봤어요"),
    ).toBeVisible();
    await expect(
      dialog.getByText("서버에 없어 비슷한 글꼴로 그린 글꼴 2개", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "글자 문구와 도형의 위치·크기·색은 편집기에서 직접, 또는 AI로 고칠 수 있어요",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText("6번 슬라이드의 SmartArt 1개는 AI가 고치지 못해요"),
    ).toBeVisible();
    await expect(dialog.getByRole("link", { name: "열기" })).toHaveAttribute(
      "href",
      `/documents/${id}`,
    );
    await shot(page, "import-summary");
    await dialog.getByRole("button", { name: "파일 목록" }).click();

    await page.locator('input[type="file"]').setInputFiles({
      name: "사업계획_2019.ppt",
      mimeType: "application/vnd.ms-powerpoint",
      buffer: Buffer.from("legacy"),
    });
    await expect(
      dialog.getByRole("heading", { name: "가져오지 못했어요" }),
    ).toBeVisible();
    await expect(
      dialog.getByText("옛 PowerPoint 형식(.ppt)이에요."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "다른 파일 선택" }),
    ).toBeVisible();
    await shot(page, "import-failed");
  });
});

test.describe("workspace", () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const turnId = "77777777-7777-4777-8777-777777777777";
  const taskBefore = "88888888-8888-4888-8888-888888888888";
  const taskAfter = "99999999-9999-4999-8999-999999999999";
  const summary = {
    version: 1,
    outcome: "changed",
    changedSlides: [2],
    slideCount: { before: 12, after: 12 },
    changes: [
      {
        slideIndex: 2,
        target: "제목",
        kind: "modified",
        details: ["굵게", "글자 크기 26 → 34"],
        box: { x: 0.055, y: 0.09, width: 0.52, height: 0.16 },
      },
    ],
    omittedChanges: 0,
    reviewed: true,
    introducedIssues: { overlap: 0, outOfBounds: 0, invalidSize: 0 },
    scopeEnforced: true,
    scopeRejected: false,
    evidence: [
      { slideIndex: 2, before: `${taskBefore}:0`, after: `${taskAfter}:0` },
    ],
    failure: null,
    unchangedSlides: 11,
  };
  /** A summary stored with the editor's undo data: the card can undo in the editor. */
  const undoable = {
    ...summary,
    undoSteps: 1,
    revisions: { before: "r-before", after: "r-after" },
  };
  const events = [
    {
      id: 1,
      type: "start",
      text: "3번 슬라이드 제목을 더 눈에 띄게 해 줘",
      permission: "slides",
      turnId,
      at: minutesAgo(3),
    },
    { id: 2, type: "tool", label: "슬라이드 보기", turnId, at: minutesAgo(3) },
    {
      id: 3,
      type: "done",
      text: "제목을 굵게 하고 글자 크기를 34로 키웠어요.",
      changed: true,
      reviewed: true,
      status: "completed",
      turnId,
      summary,
      at: minutesAgo(2),
    },
  ];

  async function mockWorkspace(
    page: Page,
    options: {
      restored?: () => boolean;
      summary?: typeof summary | typeof undoable;
    } = {},
  ) {
    const before = await slidePng(page, "하반기 시장 현황", false);
    const after = await slidePng(page, "하반기 시장 현황", true);
    const restoreCalls: string[] = [];
    const undoCalls: string[] = [];
    const chatCalls: Array<{ body: unknown; savesBefore: number }> = [];
    const turnSummary = options.summary ?? summary;
    // Every save the page asks for completes by the next poll.
    let saveRevision = 0;
    await page.route("**/api/**", async (route: Route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      const base = `/api/documents/${id}`;
      if (pathname === "/api/ai/account/status")
        return route.fulfill({ json: connectedAi });
      if (pathname === `${base}/native/launch`)
        return route.fulfill({
          json: {
            documentId: id,
            fileName: "2026 하반기 사업계획.pptx",
            editorKind: "wopi",
            editorUrl: "http://localhost:3112/mock-office",
            accessToken: "e2e-token",
            expiresAt: Date.now() + 600_000,
            apiBase: `http://localhost:3112${base}/native`,
            aiConnector: { mode: "internal" },
          },
        });
      if (pathname === `${base}/summary`)
        return route.fulfill({
          json: {
            id,
            fileName: "2026 하반기 사업계획.pptx",
            status: "ready",
            lastError: null,
            version: {
              id: "v-after",
              createdAt: minutesAgo(2),
              slideCount: 12,
              rendered: true,
              origin: "ai",
              changeCheck: true,
              bytes: 16_987_000,
            },
            previews: Array.from({ length: 12 }, (_, index) =>
              index === 0 ? "/e2e/after.png" : null,
            ),
            fonts: { inventoryAvailable: true, missing: [], substitutions: [] },
          },
        });
      if (pathname === `${base}/native/poll`) {
        const first = url.searchParams.get("after") === "0";
        const restoredEvent = options.restored?.()
          ? [
              {
                id: 4,
                type: "restored",
                versionId: "v-restored",
                restoredFrom: "v-before",
                at: now.toISOString(),
              },
            ]
          : [];
        return route.fulfill({
          json: {
            task: null,
            localJob: null,
            events: first
              ? [
                  ...events.map((event) =>
                    event.type === "done"
                      ? { ...event, summary: turnSummary }
                      : event,
                  ),
                  ...restoredEvent,
                ]
              : [],
            session: {
              status: "active",
              saveRevision: ++saveRevision,
              error: null,
              workingVersionId: "v-after",
              editorLocked: false,
            },
          },
        });
      }
      if (pathname === `${base}/native/turns`)
        return route.fulfill({
          json: {
            turns: [
              {
                id: turnId,
                requestText: events[0]!.text,
                permissionMode: "slides",
                status: "completed",
                assistantText: events[2]!.text,
                createdAt: minutesAgo(3),
                updatedAt: minutesAgo(2),
                summary: turnSummary,
                beforeVersionId: "v-before",
                afterVersionId: "v-after",
                savedPreviews: [
                  {
                    slideIndex: 2,
                    before: "/e2e/before.png",
                    after: "/e2e/after.png",
                  },
                ],
                undoneAt: null,
              },
            ],
          },
        });
      if (pathname === `${base}/native/chat`) {
        chatCalls.push({
          body: route.request().postDataJSON(),
          savesBefore: (await editorCalls(page)).filter(
            (call) => call === "Action_Save",
          ).length,
        });
        return route.fulfill({
          json: { accepted: true, turnId: "e2e-new-turn" },
        });
      }
      if (pathname === `${base}/native/undo`) {
        const body = route.request().postDataJSON() as { turnId: string };
        undoCalls.push(body.turnId);
        return route.fulfill({
          json: { turnId: body.turnId, undoneAt: now.toISOString() },
        });
      }
      if (pathname === `${base}/native/models`)
        return route.fulfill({ json: models });
      if (pathname === `${base}/native/state`)
        return route.fulfill({
          json: {
            status: "active",
            saveRevision: 1,
            workingVersionId: "v-after",
            editorLocked: false,
          },
        });
      if (pathname === `${base}/versions`)
        return route.fulfill({
          json: {
            currentVersionId: "v-after",
            versions: [
              {
                id: "v-after",
                parentVersionId: "v-before",
                origin: "ai",
                createdAt: minutesAgo(2),
                slideCount: 12,
                current: true,
                turn: { id: turnId, requestText: events[0]!.text },
                restoredFrom: null,
                previews: ["/e2e/after.png", null, "/e2e/after.png"],
                bytes: 1_234_567,
              },
              {
                id: "v-before",
                parentVersionId: "v-original",
                origin: "manual",
                createdAt: minutesAgo(40),
                slideCount: 12,
                current: false,
                turn: null,
                restoredFrom: null,
                previews: ["/e2e/before.png", null, "/e2e/before.png"],
                bytes: 1_200_000,
              },
              {
                id: "v-original",
                parentVersionId: null,
                origin: "original",
                createdAt: minutesAgo(3000),
                slideCount: 12,
                current: false,
                turn: null,
                restoredFrom: null,
                previews: ["/e2e/before.png", null, "/e2e/before.png"],
                bytes: 1_200_000,
              },
            ],
          },
        });
      const restore = pathname.match(
        new RegExp(`^${base}/versions/([^/]+)/restore$`),
      );
      if (restore) {
        restoreCalls.push(restore[1]!);
        return route.fulfill({
          json: { versionId: "v-restored", restoredFrom: restore[1] },
        });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.route("**/mock-office", (route) =>
      route.fulfill({ contentType: "text/html", body: editorPage }),
    );
    await page.route("**/e2e/before.png", (route) =>
      route.fulfill({ contentType: "image/png", body: before }),
    );
    await page.route("**/e2e/after.png", (route) =>
      route.fulfill({ contentType: "image/png", body: after }),
    );
    return { restoreCalls, undoCalls, chatCalls };
  }

  const editorCalls = (page: Page) =>
    page
      .frame({ name: "spellbook-office" })!
      .evaluate(() => (window as unknown as { calls: string[] }).calls);

  test("an AI request leaves one card: what changed, what was checked, and a way back", async ({
    page,
  }) => {
    let restored = false;
    const { restoreCalls } = await mockWorkspace(page, {
      restored: () => restored,
    });
    await page.setViewportSize(viewports.desktop);
    await page.goto(`/documents/${id}`);

    await expect(
      page.getByRole("status").filter({ hasText: "저장됨" }),
    ).toBeVisible({ timeout: 20_000 });
    const panel = page.getByRole("complementary", { name: "AI와 버전 기록" });
    const card = panel.locator("article.rc");
    await expect(card.getByText("바뀜 · 3번 슬라이드")).toBeVisible();
    await expect(
      card.getByText("글자 크기 26 → 34", { exact: false }),
    ).toBeVisible();
    await expect(
      card.getByText("바뀐 화면을 AI가 다시 보고 검토함"),
    ).toBeVisible();
    await expect(card.getByText("새로 생긴 겹침 없음")).toBeVisible();
    await expect(
      card.getByText("슬라이드 밖으로 나간 요소 없음"),
    ).toBeVisible();
    await expect(card.getByText("다른 슬라이드는 바뀌지 않음")).toBeVisible();
    await expect(
      card.getByRole("img", { name: "3번 슬라이드 수정 후" }),
    ).toBeVisible();
    // After a reload the AI's own screenshots are gone; saved previews stand in.
    await expect(card.getByText("후 · 저장본 미리보기")).toBeVisible();
    await expect(panel.getByText("범위 · 이 슬라이드").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "AI 모델: Codex · 보통" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "workspace-result-desktop");

    await card.getByRole("button", { name: "비교" }).click();
    const compare = page.getByRole("dialog", { name: "무엇이 바뀌었나" });
    await expect(
      compare.getByRole("img", { name: "3번 슬라이드 수정 전" }),
    ).toBeVisible();
    await expect(
      compare.getByText("그림: 서버에서 그린 저장본 미리보기"),
    ).toBeVisible();
    await shot(page, "workspace-compare-side");
    await compare.getByRole("radio", { name: "겹쳐 보기" }).click();
    await expect(compare.getByRole("radio", { name: "후" })).toBeVisible();
    await shot(page, "workspace-compare-overlay");
    await page.keyboard.press("Escape");
    await expect(compare).toHaveCount(0);

    await page.getByRole("tab", { name: "버전 기록" }).click();
    await expect(
      panel.getByText("가져온 원본", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      panel.getByText(events[0]!.text, { exact: false }).first(),
    ).toBeVisible();
    await shot(page, "workspace-versions-desktop");
    await page.getByRole("tab", { name: "AI" }).click();

    await page.getByRole("button", { name: "PPTX 내려받기" }).click();
    const download = page.getByRole("dialog", { name: "내려받기" });
    await expect(
      download.getByText(
        "AI가 허용한 범위 밖을 바꾸지 않았는지 저장 파일에서 다시 검사했어요",
      ),
    ).toBeVisible();
    await expect(
      download.getByText(
        "PowerPoint에서 직접 열어 보는 확인은 아직 하지 않아요",
      ),
    ).toBeVisible();
    await expect(download.getByText("SmartArt", { exact: false })).toHaveCount(
      0,
    );
    await expect(
      download.getByRole("button", { name: "PPTX 내려받기 · 16.2MB" }),
    ).toBeVisible();
    await shot(page, "workspace-download");
    await download.getByRole("button", { name: "취소" }).click();

    for (const [name, size] of [
      ["laptop", viewports.laptop],
      ["tablet", viewports.tablet],
    ] as const) {
      await page.setViewportSize(size);
      await expectNoHorizontalOverflow(page);
      await shot(page, `workspace-result-${name}`);
    }

    restored = true;
    await page.setViewportSize(viewports.desktop);
    // Without the editor's undo data the card goes back to the saved version,
    // after saying what else goes back with it.
    await card.getByRole("button", { name: "이 요청 전으로 돌아가기" }).click();
    const confirm = page.getByRole("dialog", { name: /상태로 돌아갈까요\?/ });
    await expect(
      confirm.getByText(
        "“3번 슬라이드 제목을 더 눈에 띄게 해 줘” 요청 전 상태로 돌아가요.",
      ),
    ).toBeVisible();
    await expect(
      confirm.getByText(
        "지금 파일은 버전 기록에 남아서 다시 돌아올 수 있어요.",
      ),
    ).toBeVisible();
    await shot(page, "workspace-restore-confirm");
    await confirm.getByRole("button", { name: "돌아가기" }).click();
    await expect.poll(() => restoreCalls).toEqual(["v-before"]);
    await expect(
      page.getByText("이전 버전으로 돌아갔어요", { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
    await shot(page, "workspace-restored");
  });

  test("the latest request is undone in the editor itself when nothing came after it", async ({
    page,
  }) => {
    const { undoCalls } = await mockWorkspace(page, { summary: undoable });
    await page.setViewportSize(viewports.desktop);
    await page.goto(`/documents/${id}`);
    const card = page
      .getByRole("complementary", { name: "AI와 버전 기록" })
      .locator("article.rc");
    await card.getByRole("button", { name: "되돌리기", exact: true }).click();
    await expect.poll(() => editorCalls(page)).toContain("undo_turn");
    await expect.poll(() => undoCalls).toEqual([turnId]);
    await expect(card.getByText("되돌렸어요", { exact: false })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "되돌리기", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => editorCalls(page)).toContain("Action_Save");
    await shot(page, "workspace-undone");
  });

  test("when the editor cannot undo exactly, going back asks first", async ({
    page,
  }) => {
    const { restoreCalls } = await mockWorkspace(page, { summary: undoable });
    await page.goto(`/documents/${id}`);
    const card = page
      .getByRole("complementary", { name: "AI와 버전 기록" })
      .locator("article.rc");
    await expect(
      card.getByRole("button", { name: "되돌리기", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await page.frame({ name: "spellbook-office" })!.evaluate(() => {
      (window as unknown as { failUndo: boolean }).failUndo = true;
    });
    await card.getByRole("button", { name: "되돌리기", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: /상태로 돌아갈까요\?/ });
    await expect(
      confirm.getByText(
        "편집기에서 바로 되돌릴 수 없어서, 요청 전에 저장해 둔 버전으로 돌아가요.",
      ),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "취소" }).click();
    await expect(confirm).toHaveCount(0);
    expect(restoreCalls).toEqual([]);
  });

  test("the request box names what is selected, and a card shows its change in the editor", async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.goto(`/documents/${id}`);
    await expect(
      page.getByRole("button", {
        name: "AI가 바꿀 수 있는 범위: 선택 · 제목 (3번)",
      }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole("button", {
        name: "AI가 바꿀 수 있는 범위: 선택 · 제목 (3번)",
      })
      .click();
    await expect(
      page.getByRole("menuitemradio", {
        name: /지금 선택한 제목 1개만 바꿔요/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: /3번 슬라이드 안에서만 바꿔요/ }),
    ).toBeVisible();
    await shot(page, "workspace-scope-selection");
    await page.keyboard.press("Escape");
    const card = page
      .getByRole("complementary", { name: "AI와 버전 기록" })
      .locator("article.rc");
    await card.getByRole("button", { name: "슬라이드에서 보기" }).click();
    await expect.poll(() => editorCalls(page)).toContain("reveal");
  });

  test("the first request of an editor load saves before the AI starts", async ({
    page,
  }) => {
    const { chatCalls } = await mockWorkspace(page);
    await page.goto(`/documents/${id}`);
    const box = page.getByRole("textbox", { name: "AI에게 요청" });
    await expect(
      page.getByRole("button", {
        name: /^AI가 바꿀 수 있는 범위: 선택 · 제목/,
      }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await box.fill("제목을 한 줄로 줄여 줘");
    await box.press("Enter");
    await expect.poll(() => chatCalls.length).toBe(1);
    // The save the AI's edits are checked against happened first, in this editor load.
    expect(chatCalls[0]!.savesBefore).toBe(1);
    expect(chatCalls[0]!.body).toMatchObject({
      text: "제목을 한 줄로 줄여 줘",
      permission: "selection",
    });
  });

  test("⌘S saves and ⌘Z undoes from anywhere outside a text field", async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.goto(`/documents/${id}`);
    await expect(
      page.getByRole("status").filter({ hasText: "저장됨" }),
    ).toBeVisible({ timeout: 20_000 });
    const saves = async () =>
      (await editorCalls(page)).filter((call) => call === "Action_Save").length;
    // Opening the editor does not save by itself; the first AI request of a load does.
    await page.waitForTimeout(1_000);
    expect(await saves()).toBe(0);
    await page.locator(".ws-topbar").click({ position: { x: 400, y: 10 } });
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(saves).toBe(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => editorCalls(page))
      .toContain("Send_UNO_Command .uno:Undo");
    // In the request box the keys stay with the text.
    const calls = (await editorCalls(page)).length;
    await page.getByRole("textbox", { name: "AI에게 요청" }).click();
    await page.keyboard.press("ControlOrMeta+z");
    expect((await editorCalls(page)).length).toBe(calls);
  });

  test("a phone shows saved slides and the AI panel; editing stays on large screens", async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.setViewportSize(viewports.phone);
    await page.goto(`/documents/${id}`);
    const slides = page.getByRole("region", { name: "슬라이드 미리보기" });
    await expect(
      slides.getByText("보기만 가능 · 직접 편집은 큰 화면에서", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(slides.getByText("1 / 12")).toBeVisible();
    const panel = page.getByRole("complementary", { name: "AI와 버전 기록" });
    await expect(
      panel.locator("article.rc").getByText("바뀜 · 3번 슬라이드"),
    ).toBeVisible();
    await expect(
      panel.getByRole("textbox", { name: "AI에게 요청" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "PPTX 내려받기" }),
    ).toBeVisible();
    // The editor keeps running out of sight and is asked into edit mode.
    await expect(page.getByTitle("PPT 편집기")).toBeAttached();
    await expect.poll(() => editorCalls(page)).toContain("ensure-edit");
    await panel
      .locator("article.rc")
      .getByRole("button", { name: "슬라이드에서 보기" })
      .click();
    await expect(slides.getByText("3 / 12")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "workspace-phone", true);
  });

  test("before AI is connected, the panel shows numbered steps and editing stays open", async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.route("**/api/ai/account/status", (route) =>
      route.fulfill({ json: { account: { account: null } } }),
    );
    await page.route("**/api/ai/account/login", (route) =>
      route.fulfill({
        json: {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "PRES-ENT1",
        },
      }),
    );
    await page.goto(`/documents/${id}`);
    const panel = page.getByRole("complementary", { name: "AI와 버전 기록" });
    await expect(
      panel.getByRole("heading", { name: "AI를 연결해 주세요" }),
    ).toBeVisible();
    await expect(panel.getByLabel("AI에게 요청")).toHaveCount(0);
    await expect(
      panel.getByText("AI 연결 전에도 편집기에서 직접 고칠 수 있어요."),
    ).toBeVisible();
    await panel.getByRole("button", { name: "연결 코드 받기" }).click();
    await expect(panel.getByText("PRES-ENT1")).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "OpenAI 코드 입력 화면 열기" }),
    ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    await shot(page, "workspace-connect");
  });
});

test.describe("settings", () => {
  test("AI connection lives in one place with numbered steps", async ({
    page,
  }) => {
    let attempts = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/ai/account/status")
        return route.fulfill({
          json: { account: { account: null, requiresOpenaiAuth: true } },
        });
      if (url.pathname === "/api/ai/account/login") {
        attempts += 1;
        if (attempts === 1)
          return route.fulfill({
            status: 409,
            json: { error: "device_code_auth_disabled" },
          });
        return route.fulfill({
          json: {
            type: "chatgptDeviceCode",
            loginId: `login-${attempts}`,
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: attempts === 2 ? "ABCD-1234" : "WXYZ-9876",
          },
        });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "AI 연결" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "보안 설정 열기" }),
    ).toHaveAttribute("href", "https://chatgpt.com/#settings/Security");
    await page.getByRole("button", { name: "연결 코드 받기" }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "‘Codex용 장치 코드 인증’을 켠 뒤 다시 시도해 주세요",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "연결 코드 받기" }).click();
    await expect(page.getByText("ABCD-1234")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "OpenAI 코드 입력 화면 열기" }),
    ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    await expectNoHorizontalOverflow(page);
    await shot(page, "settings-connect");
    await page.getByRole("button", { name: "새 코드 받기" }).click();
    await expect(page.getByText("WXYZ-9876")).toBeVisible();
    await page.setViewportSize(viewports.phone);
    await expectNoHorizontalOverflow(page);
    await shot(page, "settings-connect-phone", true);
  });

  test("a connected subscription shows the account and a way to disconnect", async ({
    page,
  }) => {
    await page.route("**/api/ai/account/status", (route) =>
      route.fulfill({ json: connectedAi }),
    );
    await page.goto("/settings");
    await expect(
      page.getByText("owner@example.test · Plus 플랜 · 9월 14일 연결"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "연결 해제" })).toBeVisible();
    await shot(page, "settings-connected");
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-in makes one checkable promise beside a real result card", async ({
    page,
  }) => {
    await page.setViewportSize(viewports.desktop);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /AI가 화면을 보고 고치고/ }),
    ).toBeVisible();
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(page.locator(".signin-visual article.rc")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "signin-desktop");
    await page.setViewportSize(viewports.phone);
    await expectNoHorizontalOverflow(page);
    await shot(page, "signin-phone", true);
  });

  test("a wrong password says so in the form", async ({ page }) => {
    await page.goto("/login?error=invalid_credentials");
    await expect(page.locator(".ds-banner")).toHaveText(
      "이메일 또는 비밀번호가 올바르지 않습니다.",
    );
    await expect(page.locator(".ds-banner")).toHaveAttribute("role", "alert");
  });
});

test("the gallery shows every result card state from the system", async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  await page.goto("/design-system");
  await expect(
    page.getByRole("heading", { name: "디자인 시스템" }),
  ).toBeVisible();
  for (const title of [
    "바뀜 · AI가 다시 보고 검토함",
    "바뀜 · 여러 슬라이드",
    "바뀜 · 다시 확인하지 못함",
    "새로고침 뒤 · 저장본 미리보기",
    "되돌림",
    "고치지 못함 · 범위 밖",
    "바뀐 것 없음",
    "답만 함",
    "고치지 못함",
    "중단됨",
  ])
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, "gallery", true);
  await page.setViewportSize(viewports.phone);
  await expectNoHorizontalOverflow(page);
});
