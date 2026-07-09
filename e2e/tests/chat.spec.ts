import { test, expect, type Browser } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

async function loginAgent(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const request = context.request;

  const magicLinkRes = await request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });

  const wsName = `Chat Spec ${Date.now()}`;
  await page.getByPlaceholder("Acme Corp").fill(wsName);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as { workspace: { id: string; widgetKey: string } };
  await expect(page.locator("aside")).toContainText(wsName, { timeout: 10_000 });

  return { context, page, wsId: workspace.id, widgetKey: workspace.widgetKey };
}

test("widget <-> dashboard: live messages, typing, assign/resolve, reopen", async ({ browser, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const agentB = await loginAgent(browser, baseURL!, `chat-spec-b-${Date.now()}@example.com`);

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto(`/demo.html?key=${agentB.widgetKey}`);

  const widgetFrame = pageA.frameLocator("iframe");
  await pageA.locator('button[aria-label="Open chat"]').click();
  await widgetFrame.getByText("+ New conversation").click();
  await widgetFrame.getByPlaceholder("How can we help?").fill("My order is broken");
  await widgetFrame.getByRole("button", { name: "Send" }).click();
  await expect(widgetFrame.getByText("My order is broken")).toBeVisible({ timeout: 10_000 });

  // B sees the new conversation and replies.
  await agentB.page.reload();
  await agentB.page.getByText("My order is broken").first().click();
  await agentB.page.getByPlaceholder("Reply…").fill("Sorry about that — looking into it now.");
  await agentB.page.getByRole("button", { name: "Send" }).click();

  // A receives it live, no reload.
  await expect(widgetFrame.getByText("Sorry about that — looking into it now.")).toBeVisible({ timeout: 5_000 });

  // A types -> B sees a typing indicator.
  await widgetFrame.getByPlaceholder("Reply…").fill("typing this out...");
  await expect(agentB.page.getByText("typing…")).toBeVisible({ timeout: 5_000 });
  await widgetFrame.getByPlaceholder("Reply…").fill("");

  // B assigns to self and resolves.
  await agentB.page.getByLabel("Assignee").selectOption({ label: "Me" });
  await agentB.page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(agentB.page.getByRole("button", { name: "Reopen" })).toBeVisible({ timeout: 5_000 });

  // A's ticket reflects Resolved via the SYSTEM message.
  await expect(widgetFrame.getByText("Resolved")).toBeVisible({ timeout: 5_000 });

  // A sends again -> conversation auto-reopens; B's Open list shows it again.
  await widgetFrame.getByPlaceholder("Reply…").fill("Actually still broken, one more thing");
  await widgetFrame.getByRole("button", { name: "Send" }).click();
  await expect(widgetFrame.getByText("Conversation reopened")).toBeVisible({ timeout: 5_000 });
  await agentB.page.getByRole("button", { name: "Open" }).click();
  await expect(agentB.page.getByText("Actually still broken, one more thing")).toBeVisible({ timeout: 5_000 });

  await contextA.close();
  await agentB.context.close();
});
