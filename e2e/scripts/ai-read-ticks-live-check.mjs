// One-shot prod verification for blue ticks on AI replies. Creates a THROWAWAY workspace,
// delegates a conversation to the AI, waits for its reply, then re-boots the widget and expects
// the conversation snapshot's agentLastReadAt to cover the customer's message (=> blue ticks).
//   BASE_URL=https://sp.hyugorix.com DEBUG_AUTH_SECRET=... node scripts/ai-read-ticks-live-check.mjs
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
  body: { email: `ai-ticks-${suffix}@example.com` },
});
const { accessToken } = await api("/api/v1/auth/verify", { method: "POST", body: { token: debugToken } });
const me = await api("/api/v1/auth/me", { token: accessToken });
const { workspace } = await api("/api/v1/workspaces", {
  method: "POST",
  body: { slug: `ai-ticks-${suffix}` },
  token: accessToken,
});
console.log("workspace:", workspace.slug);

const boot = await api("/api/v1/widget/boot", { method: "POST", body: { widgetKey: workspace.widgetKey } });
const wtoken = boot.token;
const uid = boot.userId;
const { conversation, message } = await api("/api/v1/widget/conversations", {
  method: "POST",
  body: { body: "How do I reset my password?" },
  token: wtoken,
});
const convId = conversation.id;
if (conversation.agentLastReadAt != null) throw new Error("agentLastReadAt set before anyone replied");

await api(`/api/v1/ws/${workspace.id}/conversations/${convId}`, {
  method: "PATCH",
  body: { assigneeId: me.user.id },
  token: accessToken,
});
await api(`/api/v1/ws/${workspace.id}/conversations/${convId}/ai/delegate`, { method: "POST", token: accessToken });
console.log("delegated to AI, customer sends a follow-up…");
const followUp = await api(`/api/v1/widget/conversations/${convId}/messages`, {
  method: "POST",
  body: { body: "Also, where do I find my invoices?" },
  token: wtoken,
});

// Wait for the AI turn, then re-boot the widget (what a page reload does) and check the snapshot.
let snap = null;
for (let i = 0; i < 12; i++) {
  await sleep(2500);
  const reboot = await api("/api/v1/widget/boot", { method: "POST", body: { widgetKey: workspace.widgetKey, userId: uid } });
  snap = reboot.conversations.find((c) => c.id === convId);
  if (snap?.agentLastReadAt != null) break;
}

if (snap?.agentLastReadAt == null) throw new Error("AI replied (or should have) but agentLastReadAt is still null");
if (snap.agentLastReadAt < followUp.message.createdAt)
  throw new Error(`watermark ${snap.agentLastReadAt} doesn't cover customer message ${followUp.message.createdAt}`);
console.log(
  `ALL CHECKS PASSED — agentLastReadAt=${snap.agentLastReadAt} covers customer msg at ${followUp.message.createdAt} (and first msg at ${message.createdAt}) => blue ticks · workspace ${workspace.slug} (throwaway)`,
);
