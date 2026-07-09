import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("magic-link login renders the dashboard shell, and logout returns to /login", async ({ page, request, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `auth-spec-${Date.now()}@example.com`;
  const magicLinkRes = await request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const magicLinkBody = await magicLinkRes.json();
  expect(magicLinkBody.code).toBe("OK");
  const debugToken = magicLinkBody.data.debugToken as string;

  await page.goto(`/auth/verify?token=${debugToken}`);

  // Fresh user has no workspace yet — lands on the create-workspace prompt.
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("Acme Corp").fill(`Auth Spec Co ${Date.now()}`);
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Dashboard shell renders with the workspace name in the sidebar switcher.
  await expect(page.locator("aside")).toContainText("Auth Spec Co");
  await expect(page.getByRole("link", { name: "Inbox" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
