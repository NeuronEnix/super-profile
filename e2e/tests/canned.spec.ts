import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("canned responses: create in settings, insert via / in composer, send", async ({ page, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `canned-spec-${Date.now()}@example.com`;
  const magicLinkRes = await page.request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("acme").fill(`canned-spec-${Date.now().toString(36)}`);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as { workspace: { id: string; widgetKey: string } };

  // Create the canned response in settings.
  await page.goto(`/w/${workspace.id}/settings`);
  await page.getByRole("button", { name: "+ New response" }).click();
  await page.getByPlaceholder("Title (e.g. Refund policy)").fill("Refund policy");
  await page.getByPlaceholder("The reply text that gets inserted…").fill("Refunds take 5-7 business days.");
  // Scope to the canned editor card — the profile section also has a "Save" button.
  await page
    .locator("div.rounded-lg.border", { has: page.getByPlaceholder("Title (e.g. Refund policy)") })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Refunds take 5-7 business days.")).toBeVisible();

  // Seed a conversation via the widget API.
  const boot = await page.request.post(`${baseURL}/api/v1/widget/boot`, { data: { widgetKey: workspace.widgetKey } });
  const token = (await boot.json()).data.token as string;
  await page.request.post(`${baseURL}/api/v1/widget/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { body: "I want a refund please" },
  });

  // Insert it in the inbox composer via "/".
  await page.goto(`/w/${workspace.id}`);
  await page.getByText("I want a refund please").first().click();
  const composer = page.locator("textarea");
  await composer.fill("/ref");
  await expect(page.getByText("Canned responses — ↑↓ then Enter")).toBeVisible();
  await page.getByRole("button", { name: /Refund policy/ }).click();
  await expect(composer).toHaveValue("Refunds take 5-7 business days.");
  await composer.press("Enter");
  await expect(page.locator(".bg-indigo-600", { hasText: "Refunds take 5-7 business days." })).toBeVisible({ timeout: 10_000 });
});
