import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("AI summary: seeded conversation gets a WANTS/TRIED/STATUS summary, shown in the inbox", async ({
  page,
  baseURL,
}) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");
  const request = page.request;

  const email = `summary-spec-${Date.now()}@example.com`;
  const magicLinkRes = await request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });

  const wsName = `summary-spec-${Date.now().toString(36)}`;
  await page.getByPlaceholder("acme").fill(wsName);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as {
    workspace: { id: string; widgetKey: string };
  };
  await expect(page.locator("aside")).toContainText(wsName, { timeout: 10_000 });

  // The dashboard SPA keeps the access token in memory only (not in a cookie/localStorage the
  // test could read), so re-derive one from the refresh cookie the login flow already set.
  const refreshed = await (await request.post(`${baseURL}/api/v1/auth/refresh`)).json();
  const auth = refreshed.data.accessToken as string;

  const boot = await (
    await request.post(`${baseURL}/api/v1/widget/boot`, {
      data: { widgetKey: workspace.widgetKey, email: "visitor@example.com", name: "Visitor Vic" },
    })
  ).json();
  const widgetToken = boot.data.token as string;

  const seed = await (
    await request.post(`${baseURL}/api/v1/widget/conversations`, {
      headers: { Authorization: `Bearer ${widgetToken}` },
      data: { body: "Hi, my order #4521 never arrived and it's been two weeks." },
    })
  ).json();
  const conversationId = seed.data.conversation.id as string;

  const agentTurns = [
    "Sorry to hear that! Can you confirm the shipping address on file?",
    "Thanks, I see the package shows delivered but you say it never arrived — filing a carrier trace now.",
    "Usually 2-3 business days. I'll also send a replacement in parallel so you're not stuck waiting.",
    "Replacement order #4599 has been created and will ship today.",
  ];
  const contactTurns = [
    "Yes, 123 Main St, Springfield.",
    "OK thank you, how long will that take?",
    "That would be great, appreciate it!",
  ];
  for (let i = 0; i < contactTurns.length; i++) {
    await request.post(`${baseURL}/api/v1/ws/${workspace.id}/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${auth}` },
      data: { body: agentTurns[i] },
    });
    await request.post(`${baseURL}/api/v1/widget/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${widgetToken}` },
      data: { body: contactTurns[i] },
    });
  }
  await request.post(`${baseURL}/api/v1/ws/${workspace.id}/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${auth}` },
    data: { body: agentTurns[3] },
  });

  const summaryRes = await request.get(`${baseURL}/api/v1/ws/${workspace.id}/conversations/${conversationId}/summary`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  const summaryBody = await summaryRes.json();
  if (summaryBody.code === "AI_UNAVAILABLE") {
    test.info().annotations.push({ type: "soft-skip", description: "AI backend unavailable during this run" });
    return;
  }
  expect(summaryBody.code).toBe("OK");
  expect(summaryBody.data.summary).toMatch(/WANTS:/);
  expect(summaryBody.data.summary).toMatch(/TRIED:/);
  expect(summaryBody.data.summary).toMatch(/STATUS:/);

  await page.reload();
  await page.getByText("Hi, my order #4521").first().click();
  await expect(page.getByText("AI Summary")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/WANTS:/)).toBeVisible({ timeout: 15_000 });
});
