// One-shot prod verification for AI ticket resolution. Creates a THROWAWAY workspace,
// delegates a conversation to the AI, has the "customer" confirm they're done, and expects
// the AI to close the ticket (status RESOLVED, ai_handling off, "Resolved by AI" note).
//   BASE_URL=https://sp.hyugorix.com DEBUG_AUTH_SECRET=... node scripts/ai-resolve-live-check.mjs
const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const DEBUG = process.env.DEBUG_AUTH_SECRET;
if (!DEBUG) throw new Error("DEBUG_AUTH_SECRET required");

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(path.includes("magic-link") ? { "X-Debug-Auth": DEBUG } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const env = await res.json();
  if (env.code !== "OK") throw new Error(`${path} -> ${env.code}: ${env.msg}`);
  return env.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const suffix = Date.now().toString(36);
const { debugToken } = await api("/api/v1/auth/magic-link", {
  method: "POST",
  body: { email: `ai-resolve-${suffix}@example.com` },
});
const { accessToken } = await api("/api/v1/auth/verify", { method: "POST", body: { token: debugToken } });
const me = await api("/api/v1/auth/me", { token: accessToken });
const myId = me.user.id;
const { workspace } = await api("/api/v1/workspaces", {
  method: "POST",
  body: { slug: `ai-resolve-${suffix}` },
  token: accessToken,
});
console.log("workspace:", workspace.slug);

// Customer opens a ticket that's basically already handled.
const boot = await api("/api/v1/widget/boot", { method: "POST", body: { widgetKey: workspace.widgetKey } });
const wtoken = boot.token;
const { conversation } = await api("/api/v1/widget/conversations", {
  method: "POST",
  body: { body: "Hey, I was double charged but my bank already reversed it. All good now, just letting you know." },
  token: wtoken,
});
const convId = conversation.id;

// Agent claims it and delegates to AI.
await api(`/api/v1/ws/${workspace.id}/conversations/${convId}`, {
  method: "PATCH",
  body: { assigneeId: myId },
  token: accessToken,
});
await api(`/api/v1/ws/${workspace.id}/conversations/${convId}/ai/delegate`, { method: "POST", token: accessToken });
console.log("delegated to AI, waiting for its first turn…");
await sleep(9000);

async function status() {
  const { conversation: c } = await api(`/api/v1/ws/${workspace.id}/conversations/${convId}`, {
    token: accessToken,
  });
  return c;
}

// Customer confirms they're done — up to two confirmations in case the AI asks first.
const confirmations = [
  "No, that's all I needed. You can close the ticket, thanks!",
  "Yes, please close it. Thanks!",
];
let final = null;
for (const text of confirmations) {
  await api(`/api/v1/widget/conversations/${convId}/messages`, {
    method: "POST",
    body: { body: text },
    token: wtoken,
  });
  console.log(`customer: "${text}"`);
  for (let i = 0; i < 10; i++) {
    await sleep(2500);
    final = await status();
    if (final.status === "RESOLVED") break;
  }
  if (final.status === "RESOLVED") break;
  console.log("  not resolved yet (status:", final.status, "aiHandling:", final.aiHandling, ") — confirming again");
  if (!final.aiHandling) throw new Error("AI stopped handling without resolving (escalated?) — check transcript");
}

if (final.status !== "RESOLVED") throw new Error(`expected RESOLVED, got ${final.status}`);
if (final.aiHandling) throw new Error("resolved but ai_handling still on");
if (final.resolvedAt == null) throw new Error("resolved but resolved_at not stamped");

const { messages } = await api(`/api/v1/ws/${workspace.id}/conversations/${convId}/messages`, {
  token: accessToken,
});
const note = messages.find((m) => m.senderType === "SYSTEM" && m.bodyText === "Resolved by AI");
const farewell = [...messages].reverse().find((m) => m.senderType === "AI");
if (!note) throw new Error('missing "Resolved by AI" system note');
console.log("\ntranscript tail:");
for (const m of messages.slice(-6)) console.log(`  [${m.senderType}] ${m.bodyText.slice(0, 90)}`);
console.log(`\nALL CHECKS PASSED — AI farewell: "${farewell.bodyText.slice(0, 80)}" · resolvedAt stamped · workspace ${workspace.slug} (throwaway)`);
