import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

import { createSessionToken, localAccountId } from "../../src/lib/auth";

const documentId = process.env.SPELLBOOK_SELFHOST_DOCUMENT_ID;
const cookieFile = path.resolve(
  process.cwd(),
  process.env.SPELLBOOK_SELFHOST_COOKIE_FILE ??
    "../../.tmp-runtime/cookies.txt",
);
const evidenceDir = path.resolve(process.cwd(), "../../.tmp-runtime/evidence");

test.beforeEach(async ({ context }) => {
  const stored = await storedSessionCookie();
  await context.addCookies([stored ?? localSelfhostSessionCookie()]);
});

async function storedSessionCookie() {
  const lines = await fs
    .readFile(cookieFile, "utf8")
    .then((value) => value.split("\n"))
    .catch(() => []);
  const line = lines.find(
    (candidate) =>
      candidate.includes("\tspellbook_session\t") &&
      candidate.split("\t").length >= 7,
  );
  if (!line) return null;
  const [rawDomain, , cookiePath, secure, expires, name, value] =
    line.split("\t");
  if (Number(expires) <= Date.now() / 1000) return null;
  return {
    name,
    value,
    domain: rawDomain.replace(/^#HttpOnly_/, ""),
    path: cookiePath,
    httpOnly: rawDomain.startsWith("#HttpOnly_"),
    secure: secure === "TRUE",
    expires: Number(expires),
    sameSite: "Lax" as const,
  };
}

function localSelfhostSessionCookie() {
  const base = new URL(
    process.env.SPELLBOOK_SELFHOST_URL ?? "http://localhost:3000",
  );
  if (!["localhost", "127.0.0.1", "::1"].includes(base.hostname))
    throw new Error(
      `No unexpired spellbook_session cookie in ${cookieFile}; automatic sessions are local-only.`,
    );
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
  const email = process.env.SPELLBOOK_LOCAL_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("SPELLBOOK_LOCAL_EMAIL is required.");
  const value = createSessionToken({
    accountId: localAccountId(email),
    email,
    admin: true,
    token: "",
  });
  return {
    name: "spellbook_session",
    value,
    domain: base.hostname,
    path: "/",
    httpOnly: true,
    secure: base.protocol === "https:",
    expires: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sameSite: "Lax" as const,
  };
}

test("a PPTX reaches the live canvas, edits, saves and downloads", async ({
  page,
}) => {
  test.skip(!documentId, "SPELLBOOK_SELFHOST_DOCUMENT_ID is required");

  const baselineResponse = await page.request.get(
    `/api/documents/${documentId}/download?source=current`,
  );
  expect(baselineResponse.ok()).toBe(true);
  const baselineBytes = new Uint8Array(await baselineResponse.body());

  await page.addInitScript(() => {
    const NativeMessageChannel = window.MessageChannel;
    const channels: MessageChannel[] = [];
    Object.defineProperty(window, "__spellbookObservedMessageChannels", {
      value: channels,
    });
    Object.defineProperty(window, "MessageChannel", {
      configurable: true,
      value: function ObservedMessageChannel() {
        const channel = new NativeMessageChannel();
        channels.push(channel);
        return channel;
      },
    });
  });
  await page.route(
    `**/api/documents/${documentId}/native/result`,
    async (route) => {
      let body: any = null;
      try {
        body = route.request().postDataJSON();
      } catch {}
      if (typeof body?.id === "string" && body.id.startsWith("selfhost-e2e-")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
        return;
      }
      await route.continue();
    },
  );

  await page.goto(`/documents/${documentId}`);
  await expect(page).toHaveURL(
    new RegExp(`/(?:browser-)?documents/${documentId}$`),
  );
  const browserEditor = page.url().includes("/browser-documents/");
  await expect(page.getByTitle("PPT 편집기")).toBeVisible();
  await expect(page.locator(".ws-save")).toHaveText(/^저장됨/, {
    timeout: 60_000,
  });

  const editor = page.frameLocator('iframe[title="PPT 편집기"]');
  await expect(editor.locator("body")).toBeVisible();
  if (browserEditor)
    await expect(editor.locator("body")).toHaveAttribute(
      "data-default-sidebar",
      "closed",
    );
  await expect(editor.getByText("Explore The New")).toHaveCount(0);
  const panel = page.getByRole("complementary", { name: "AI와 버전 기록" });
  await expect(panel).toBeVisible();
  // Without an AI connection the panel explains that direct editing works.
  if (
    await panel.getByRole("heading", { name: "AI를 연결해 주세요" }).isVisible()
  )
    await expect(
      panel.getByText("AI 연결 전에도 편집기에서 직접 고칠 수 있어요."),
    ).toBeVisible();

  const replacement = `Spellbook round trip ${Date.now()}`;
  const changed = browserEditor
    ? await editThroughBrowserBridge(page, replacement)
    : await editThroughCollaboraBridge(page, replacement);
  expect(changed).toBe(true);

  // The save state in the top bar is also the save button while unsaved.
  await page.getByRole("button", { name: /저장 안 됨/ }).click();
  await expect(page.locator(".ws-save")).toHaveText(/^저장됨/, {
    timeout: 60_000,
  });

  const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "PPTX 내려받기" }).click();
  await page
    .getByRole("dialog", { name: "내려받기" })
    .getByRole("button", { name: "PPTX 내려받기" })
    .click();
  const download = await downloadEvent;

  await fs.mkdir(evidenceDir, { recursive: true });
  const downloadedFile = path.join(evidenceDir, "round-trip.pptx");
  await download.saveAs(downloadedFile);
  const downloadedBytes = new Uint8Array(await fs.readFile(downloadedFile));
  const archiveCheck = spawnSync("unzip", ["-t", downloadedFile], {
    encoding: "utf8",
  });
  expect(archiveCheck.status, archiveCheck.stderr).toBe(0);
  const slide = spawnSync(
    "unzip",
    ["-p", downloadedFile, "ppt/slides/slide1.xml"],
    { encoding: "utf8" },
  );
  expect(slide.status, slide.stderr).toBe(0);
  expect(slide.stdout).toContain(replacement);
  if (browserEditor) {
    const changedParts = changedLogicalParts(
      unzipSync(baselineBytes),
      unzipSync(downloadedBytes),
    );
    expect(changedParts).toEqual(["ppt/slides/slide1.xml"]);
    await fs.writeFile(
      path.join(evidenceDir, "round-trip-changed-parts.json"),
      `${JSON.stringify({ changedParts }, null, 2)}\n`,
    );
  }
  await page.screenshot({
    path: path.join(evidenceDir, "live-pptx-editor.png"),
    fullPage: true,
  });
});

test("a phone shows saved slides and the AI panel while the editor keeps running", async ({
  page,
}) => {
  test.skip(!documentId, "SPELLBOOK_SELFHOST_DOCUMENT_ID is required");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/documents/${documentId}`);
  // The editor stays mounted out of sight so AI requests still reach it.
  await expect(page.getByTitle("PPT 편집기")).toBeAttached();
  await expect(page.locator(".ws-opening")).toHaveCount(0, {
    timeout: 60_000,
  });
  const slides = page.getByRole("region", { name: "슬라이드 미리보기" });
  await expect(
    slides.getByText("보기만 가능 · 직접 편집은 큰 화면에서", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "AI와 버전 기록" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PPTX 내려받기" }),
  ).toBeVisible();
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).resolves.toBe(true);
  await fs.mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, "mobile-editor.png") });
  // A large screen gets the editor itself back.
  await page.setViewportSize({ width: 1200, height: 844 });
  await expect(page.getByTitle("PPT 편집기")).toBeVisible();
  await expect(slides).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(slides).toBeVisible();
});

async function editThroughBrowserBridge(page: Page, replacement: string) {
  const before = await browserBridgeRequest(page, "observe", {
    operation: "observe",
    captureSlideIndexes: [],
  });
  const target = before.slides
    .flatMap((slide: { elements: Array<{ text?: string }> }) => slide.elements)
    .find((element: { text?: string }) => element.text);
  if (!target) throw new Error("browser_editor_text_target_not_found");
  const after = await browserBridgeRequest(page, "edit", {
    operation: "edit",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    permission: { mode: "document", elementIds: [], slideIndexes: [] },
    command: {
      op: "replace_text",
      elementId: target.elementId,
      text: replacement,
    },
    suppressCapture: true,
  });
  return after.slides.some((slide: { elements: Array<{ text?: string }> }) =>
    slide.elements.some(
      (element: { text?: string }) => element.text === replacement,
    ),
  );
}

async function browserBridgeRequest(
  page: Page,
  operation: string,
  request: unknown,
) {
  return page.evaluate(
    ({ id, nativeRequest }) =>
      new Promise<any>((resolve, reject) => {
        const channels = (
          window as typeof window & {
            __spellbookObservedMessageChannels?: MessageChannel[];
          }
        ).__spellbookObservedMessageChannels;
        const channel = channels?.at(-1);
        if (!channel) {
          reject(new Error("browser_editor_message_channel_not_found"));
          return;
        }
        const timeout = window.setTimeout(() => {
          channel.port1.removeEventListener("message", onMessage);
          reject(new Error(`browser_editor_${operation}_timeout`));
        }, 30_000);
        const onMessage = (event: MessageEvent) => {
          if (event.data?.id !== id) return;
          window.clearTimeout(timeout);
          channel.port1.removeEventListener("message", onMessage);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.value);
        };
        channel.port1.addEventListener("message", onMessage);
        channel.port1.start();
        channel.port1.postMessage({ id, request: nativeRequest });
      }),
    {
      id: `selfhost-e2e-${operation}-${Date.now()}`,
      nativeRequest: request,
    },
  );
}

async function editThroughCollaboraBridge(page: Page, replacement: string) {
  await expect
    .poll(() =>
      page
        .frames()
        .find((frame) =>
          frame.url().includes("/extensions/org.spellbook.editor/index.html"),
        ),
    )
    .not.toBeUndefined();
  const editorBridge = page
    .frames()
    .find((frame) =>
      frame.url().includes("/extensions/org.spellbook.editor/index.html"),
    );
  expect(editorBridge).toBeDefined();
  return editorBridge!.evaluate(async (nextText) => {
    const native = (
      window as typeof window & {
        presentNative: {
          observe(): Promise<any>;
          edit(request: unknown): Promise<any>;
        };
      }
    ).presentNative;
    const before = await native.observe();
    const target = before.slides[0].elements.find(
      (element: { text?: string }) =>
        element.text === "Typical Presentation" ||
        element.text?.startsWith("Spellbook round trip "),
    );
    if (!target) throw new Error("first_slide_title_not_found");
    const after = await native.edit({
      operation: "edit",
      expectedSlides: JSON.stringify(before.slides),
      permission: { mode: "document" },
      command: {
        op: "replace_text",
        elementId: target.elementId,
        text: nextText,
      },
    });
    return after.slides[0].elements.some(
      (element: { text?: string }) => element.text === nextText,
    );
  }, replacement);
}

function changedLogicalParts(
  before: Record<string, Uint8Array>,
  after: Record<string, Uint8Array>,
) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => !equalBytes(before[name], after[name]))
    .sort();
}

function equalBytes(left?: Uint8Array, right?: Uint8Array) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
