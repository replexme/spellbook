#!/usr/bin/env node
// End-to-end check against a running Spellbook web app whose document view
// is this site (SPELLBOOK_BROWSER_OFFICE_URL). Headless Chrome:
// sign in, upload a deck, open it, make an edit through the editor
// channel (the same requests the AI's tools send), save with the web app's
// save button (upload, document-worker validation, new version), download,
// and check the downloaded file.
//   node apps/office/e2e-local.mjs <playwright-core dir> <web origin> <email> <password-file> <deck.pptx | new:pptx | new:idml> <out-dir>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const [pwDir, origin, email, passwordFile, deck, out] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)(pwDir);
const password = /password:\s*(\S+)/.exec(fs.readFileSync(passwordFile, "utf8"))?.[1] ?? fs.readFileSync(passwordFile, "utf8").trim();
fs.mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const report = { steps: [] };
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const value = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t, ...(value ?? {}) });
    return value;
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - t, error: String(e.message ?? e).slice(0, 400) });
    throw e;
  }
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await context.newPage();
  const log = [];
  page.on("console", (m) => m.type() !== "log" && log.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`.slice(0, 300)));
  await page.addInitScript(() => {
    const Native = window.MessageChannel;
    const channels = [];
    Object.defineProperty(window, "__observedChannels", { value: channels });
    Object.defineProperty(window, "MessageChannel", { configurable: true, value: function Observed() { const c = new Native(); channels.push(c); return c; } });
  });
  await page.route("**/native/result", async (route) => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch {}
    if (typeof body?.id === "string" && body.id.startsWith("e2e-")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return route.continue();
  });
  const bridge = (request) =>
    page.evaluate((nativeRequest) => new Promise((resolve, reject) => {
      const channel = window.__observedChannels.at(-1);
      if (!channel) return reject(new Error("editor_channel_not_found"));
      const id = `e2e-${nativeRequest.operation}-${Date.now()}`;
      const timer = setTimeout(() => reject(new Error(`${nativeRequest.operation}_timeout`)), 60000);
      const on = (event) => {
        if (event.data?.id !== id) return;
        clearTimeout(timer);
        channel.port1.removeEventListener("message", on);
        event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.value);
      };
      channel.port1.addEventListener("message", on);
      channel.port1.postMessage({ id, request: nativeRequest });
    }), request);

  await step("sign_in", async () => {
    await page.goto(`${origin}/login`);
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.locator('form.signin-form button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  });
  // "new:pptx" or "new:idml" makes a new document with the home screen's buttons instead.
  const create = /^new:(pptx|idml)$/.exec(deck)?.[1];
  const documentId = await step(create ? "create" : "upload", async () => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => /\/api\/documents(\/uploads\/complete|\/new)?$/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 120000 }),
      create
        ? page.getByRole("button", { name: create === "pptx" ? "새 프레젠테이션" : "새 InDesign 문서" }).first().click()
        : page.locator('input[type="file"]').first().setInputFiles(deck),
    ]);
    if (create) {
      // The page goes to the new document at once, so its id comes from the address.
      if (response.status() !== 201) throw new Error(`create ${response.status()}`);
      await page.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 60000, waitUntil: "commit" });
      return { documentId: /documents\/([0-9a-f-]{36})/.exec(page.url())[1] };
    }
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 300) throw new Error(`upload ${response.status()}: ${JSON.stringify(body).slice(0, 300)}`);
    const id = body.id ?? body.document?.id ?? body.documentId ?? null;
    return id ? { documentId: id } : { response: JSON.stringify(body).slice(0, 300) };
  });
  const id = documentId?.documentId;
  if (!id) throw new Error("upload did not return a document id");
  await step("open", async () => {
    await page.goto(`${origin}/documents/${id}`);
    await page.waitForURL(/browser-documents/, { timeout: 120000 });
    await page.getByTitle("PPT 편집기").waitFor({ timeout: 120000 });
    await page.locator(".ws-save").filter({ hasText: /^저장됨/ }).waitFor({ timeout: 180000 });
    const frame = page.frameLocator('iframe[title="PPT 편집기"]');
    await frame.locator("figure img[src]").first().waitFor({ timeout: 60000 });
    const slides = await frame.locator("figure").count();
    await page.screenshot({ path: path.join(out, "opened.png") });
    return { slides };
  });
  const replacement = `AI 편집 검증 ${Date.now()}`;
  await step("ai_edit_through_editor_channel", async () => {
    const before = await bridge({ operation: "observe", detailSlideIndex: null });
    const target = before.slides.flatMap((s) => s.elements).find((e) => e.text && e.text.trim() && !e.elements);
    // A new document has no text yet: the AI adds a text box.
    const command = target
      ? { op: "replace_text", elementId: target.elementId, text: replacement }
      : { op: "add_text_box", slideIndex: 0, x: 2000, y: 2000, width: 15000, height: 3000, text: replacement, name: null };
    const after = await bridge({
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      permission: { mode: "document", elementIds: [], slideIndexes: [] },
      command,
    });
    return { target: target?.elementId ?? "new text box", changed: after.changedSlideIndexes, images: after.images.length };
  });
  await step("save_with_web_button", async () => {
    await page.locator(".ws-save").filter({ hasText: /저장 안 됨/ }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /저장 안 됨/ }).click();
    await page.locator(".ws-save").filter({ hasText: /^저장됨/ }).waitFor({ timeout: 180000 });
    await page.screenshot({ path: path.join(out, "saved.png") });
  });
  await step("download_and_check", async () => {
    const response = await page.request.get(`${origin}/api/documents/${id}/download?source=current`);
    if (!response.ok()) throw new Error(`download ${response.status()}`);
    const file = path.join(out, "downloaded.pptx");
    fs.writeFileSync(file, Buffer.from(await response.body()));
    const original = path.join(out, "original.pptx");
    if (create) {
      const first = await page.request.get(`${origin}/api/documents/${id}/download?source=original`);
      if (!first.ok()) throw new Error(`download original ${first.status()}`);
      fs.writeFileSync(original, Buffer.from(await first.body()));
    } else fs.copyFileSync(deck, original);
    const compare = execFileSync("python3", ["-c", `
import json,sys,zipfile
a,b,needle=zipfile.ZipFile(sys.argv[1]),zipfile.ZipFile(sys.argv[2]),sys.argv[3]
names=sorted(set(a.namelist())|set(b.namelist()))
read=lambda z,n: z.read(n) if n in z.namelist() else None
changed=[n for n in names if read(a,n)!=read(b,n)]
print(json.dumps({"changed":changed,"contains":any(needle in (read(b,n) or b"").decode("utf8","ignore") for n in changed)}))
`, original, file, replacement], { encoding: "utf8" });
    const { changed, contains } = JSON.parse(compare);
    return { bytes: fs.statSync(file).size, changedParts: changed, containsEdit: contains };
  });
} catch {
  // reported per step
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 1));
