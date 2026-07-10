import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("timeline: widget pageviews and last-seen appear on the contact panel", async ({ page, context, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `timeline-spec-${Date.now()}@example.com`;
  const magicLinkRes = await page.request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("acme").fill(`timeline-spec-${Date.now().toString(36)}`);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as { workspace: { id: string; widgetKey: string } };

  // Visitor browses the demo store (eager iframe reports pageviews) and opens a ticket.
  const visitor = await context.newPage();
  await visitor.goto(`/demo.html?key=${workspace.widgetKey}`);
  // Let the eager iframe boot and report the initial pageview before navigating further.
  await visitor.waitForTimeout(500);
  await visitor.getByRole("link", { name: "Pricing" }).click();
  await visitor.waitForTimeout(300);
  await visitor.getByRole("link", { name: "Features" }).click();
  await visitor.waitForTimeout(300);
  await visitor.locator('button[aria-label="Open chat"]').click();
  const frame = visitor.frameLocator("iframe");
  await frame.getByText("+ New conversation").click();
  await frame.getByPlaceholder("How can we help?").fill("Hi, question about pricing");
  await frame.getByRole("button", { name: /Send|Start/ }).click();

  // Agent opens the conversation — the panel shows the browsing trail.
  await page.goto(`/w/${workspace.id}`);
  await page.getByText("Hi, question about pricing").first().click();
  await expect(page.getByText("Recent activity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Pricing — Acme Corp/)).toBeVisible();
  await expect(page.getByText(/Last seen/)).toBeVisible();
});
