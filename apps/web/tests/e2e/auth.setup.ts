import { expect, test as setup } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const authState = path.join(process.cwd(), ".tmp-e2e", "auth.json");

setup("authenticate the self-hosted owner", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("이메일").fill("owner@example.test");
  await page.getByLabel("비밀번호").fill("spellbook-test-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL("/");
  await fs.mkdir(path.dirname(authState), { recursive: true });
  await page.context().storageState({ path: authState });
});
