import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("KB: create collection + article, publish, public page renders markdown, search finds it, widget suggests it", async ({
  page,
  baseURL,
}) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `kb-spec-${Date.now()}@example.com`;
  const magicLinkRes = await page.request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });

  const wsName = `KB Spec ${Date.now()}`;
  await page.getByPlaceholder("Acme Corp").fill(wsName);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as {
    workspace: { id: string; slug: string; widgetKey: string };
  };
  await expect(page.locator("aside")).toContainText(wsName, { timeout: 10_000 });

  await page.goto(`/w/${workspace.id}/kb`);
  await page.getByRole("button", { name: "+ New collection" }).click();
  await page.getByPlaceholder("Getting started").fill("Orders");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Orders", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+ New article" }).click();
  await page.getByPlaceholder("Article title").fill("How to reset your password");
  await page.getByLabel("Collection").selectOption({ label: "Orders" });
  await page
    .locator("textarea")
    .fill("## Resetting your password\n\nClick the reset link we email you and follow the instructions.");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("button", { name: "Publishing…" })).toHaveCount(0, { timeout: 10_000 });

  // Public page renders markdown (assert an <h2> from the source md).
  await page.goto(`/kb/${workspace.slug}`);
  await expect(page.getByRole("link", { name: "How to reset your password" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("link", { name: "How to reset your password" }).click();
  await expect(page.locator("h2", { hasText: "Resetting your password" })).toBeVisible({ timeout: 10_000 });

  // Public search finds it.
  await page.goto(`/kb/${workspace.slug}`);
  await page.getByPlaceholder("Search articles…").fill("reset");
  await expect(page.getByRole("link", { name: "How to reset your password" })).toBeVisible({ timeout: 10_000 });

  // Widget NewTicket suggests it while typing.
  await page.goto(`/demo.html?key=${workspace.widgetKey}`);
  await page.locator('button[aria-label="Open chat"]').click();
  const widgetFrame = page.frameLocator("iframe");
  await widgetFrame.getByText("+ New conversation").click();
  await widgetFrame.getByPlaceholder("How can we help?").fill("how do I reset my password please");
  await expect(widgetFrame.getByText("How to reset your password")).toBeVisible({ timeout: 10_000 });
});
