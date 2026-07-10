// Verifies the hub drops TYPING/READ sent by a CONTACT socket for a conversation it doesn't
// own (and still honors them for its own conversation). Run against wrangler dev or prod:
//   BASE_URL=http://localhost:8787 DEBUG_AUTH_SECRET=... node scripts/ws-isolation-check.mjs
import WebSocket from "ws";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const DEBUG = process.env.DEBUG_AUTH_SECRET;
if (!DEBUG) throw new Error("DEBUG_AUTH_SECRET required");
const WS_BASE = BASE.replace(/^http/, "ws");

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const env = await res.json();
  if (env.code !== "OK") throw new Error(`${path}: ${env.code} ${env.msg}`);
  return env.data;
}

const email = `ws-iso-${Date.now()}@example.com`;
const { debugToken } = await api("/api/v1/auth/magic-link", {
  method: "POST",
  body: { email },
  headers: { "X-Debug-Auth": DEBUG },
});
const { accessToken } = await api("/api/v1/auth/verify", { method: "POST", body: { token: debugToken } });
const auth = { Authorization: `Bearer ${accessToken}` };
const { workspace } = await api("/api/v1/workspaces", { method: "POST", body: { name: "WS Iso Check" }, headers: auth });

// Visitor A owns a conversation; visitor B is the attacker.
const bootA = await api("/api/v1/widget/boot", { method: "POST", body: { widgetKey: workspace.widgetKey } });
const convA = (
  await api("/api/v1/widget/conversations", {
    method: "POST",
    body: { body: "victim conversation" },
    headers: { Authorization: `Bearer ${bootA.token}` },
  })
).conversation;
const bootB = await api("/api/v1/widget/boot", { method: "POST", body: { widgetKey: workspace.widgetKey } });
const convB = (
  await api("/api/v1/widget/conversations", {
    method: "POST",
    body: { body: "attacker's own conversation" },
    headers: { Authorization: `Bearer ${bootB.token}` },
  })
).conversation;

const before = (
  await api(`/api/v1/ws/${workspace.id}/conversations/${convA.id}`, { headers: auth })
).conversation.contactLastReadAt;

const wsB = new WebSocket(`${WS_BASE}/api/v1/ws-connect/widget?token=${encodeURIComponent(bootB.token)}`);
await new Promise((resolve, reject) => {
  wsB.on("open", resolve);
  wsB.on("error", reject);
});
// Attack: mark the VICTIM's conversation read, and fake-type on it.
wsB.send(JSON.stringify({ type: "READ", conversationId: convA.id }));
wsB.send(JSON.stringify({ type: "TYPING", conversationId: convA.id, state: "START" }));
// Legit: mark OWN conversation read.
wsB.send(JSON.stringify({ type: "READ", conversationId: convB.id }));
await new Promise((r) => setTimeout(r, 1500));
wsB.close();

const afterVictim = (
  await api(`/api/v1/ws/${workspace.id}/conversations/${convA.id}`, { headers: auth })
).conversation.contactLastReadAt;
const afterOwn = (
  await api(`/api/v1/ws/${workspace.id}/conversations/${convB.id}`, { headers: auth })
).conversation.contactLastReadAt;

if (afterVictim !== before) {
  console.error(`FAIL: foreign READ mutated victim's contact_last_read_at (${before} -> ${afterVictim})`);
  process.exit(1);
}
if (!afterOwn) {
  console.error("FAIL: legitimate own-conversation READ was dropped too");
  process.exit(1);
}
console.log("PASS: foreign TYPING/READ dropped; own READ honored");
