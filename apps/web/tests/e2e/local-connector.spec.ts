import { expect, test } from "@playwright/test";

// Run with SPELLBOOK_AI_CONNECTOR_MODE=local. No real subscription is used.
test.skip(
  process.env.SPELLBOOK_AI_CONNECTOR_MODE !== "local",
  "Requires the local connector configuration",
);

for (const provider of ["Codex", "Claude"] as const) {
  test(`${provider} disconnect clears browser access when the connector is unreachable`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const key = "spellbook.local-ai-session.v1";
    await page.addInitScript(
      ({ key }) => {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            token: "test-only-local-token-0000000000000000",
            challenge: "test-only-challenge",
            expiresAt: Date.now() + 60_000,
          }),
        );
        localStorage.setItem(
          "spellbook.ai-keys.v1:local-test",
          JSON.stringify({
            active: "claude_code",
            keys: { anthropic_api: "test-only-api-key" },
          }),
        );
      },
      { key },
    );
    await page.route("**/api/ai/account/status", (route) =>
      route.fulfill({ json: { keyScope: "local-test" } }),
    );
    await page.route("http://127.0.0.1:43127/**", (route) => {
      if (new URL(route.request().url()).pathname === "/v1/pairings/revoke")
        return route.abort("connectionrefused");
      return route.fulfill({
        headers: {
          "access-control-allow-origin": "http://localhost:3112",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
        json: {
          account: {
            account: {
              type: "chatgpt",
              email: "codex@example.test",
              planType: "plus",
            },
          },
          claude: {
            account: {
              type: "claude",
              email: "claude@example.test",
              planType: "max",
            },
          },
        },
      });
    });
    await page.goto("/settings");
    const card = page
      .locator(".conn-card")
      .filter({
        hasText: provider === "Codex" ? "ChatGPT 구독" : "Claude 구독",
      });
    await expect(
      card.getByRole("button", { name: "이 브라우저 연결 해제" }),
    ).toBeVisible();
    await card.getByRole("button", { name: "이 브라우저 연결 해제" }).click();
    await expect(
      page.getByRole("button", { name: "이 브라우저 연결 해제" }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "이 브라우저 연결은 해제했어요. 연결 앱의 승인 취소는 확인하지 못했어요.",
      ),
    ).toBeVisible();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), key),
    ).toBeNull();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("spellbook.ai-keys.v1:local-test")!)
            .keys.anthropic_api,
      ),
    ).toBe("test-only-api-key");
    await expect(
      page.getByText("다음 요청에 사용할 AI를 선택해 주세요.", {
        exact: false,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Claude Code 연결 확인" }),
    ).toBeVisible();
    await page.screenshot({
      path: `../../.tmp-runtime-validation/redesign/local-${provider.toLowerCase()}-disconnect-phone.png`,
      fullPage: true,
    });
  });
}

test("local mode blocks server subscription login and credential forwarding", async ({
  request,
}) => {
  for (const path of ["login", "login/complete", "logout"]) {
    const response = await request.post(`/api/ai/account/${path}`, {
      data: { provider: "claude_code", code: "test-only-code" },
    });
    expect(response.status()).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "local_connector_required",
    });
  }
  const response = await request.get("/api/ai/account/status");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ account: null, claude: null });
});
