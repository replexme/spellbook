// Browser Office hides its development toolbar in the product workspace.
// Native conformance saves through the same probe transaction without relying
// on a control that is intentionally invisible to users. The server editor
// still exercises its visible Save button.
export async function requestNativeProbeSave(page) {
  if (new URL(page.url()).searchParams.get("browserProbe") === "1") {
    await page.waitForFunction(
      () =>
        document.body.dataset.browserProbe === "ready" &&
        typeof globalThis.spellbookBrowserOffice?.saveProbe === "function",
      null,
      { timeout: 20_000 },
    );
    await page.evaluate(() => globalThis.spellbookBrowserOffice.saveProbe());
    return;
  }
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "저장 확인 중…" }).waitFor({
    timeout: 20_000,
  });
}
