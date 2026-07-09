// Verifies WorkspaceHub realtime routing: MESSAGE_CREATED delivery, typing relay,
// contact isolation, and read receipts. Run against `wrangler dev` (or prod with
// DEBUG_AUTH_SECRET set) via: BASE_URL=http://localhost:8787 node scripts/ws-check.mjs
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8787";
const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET;
const WS_BASE = BASE_URL.replace(/^http/, "ws");

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  const body = await res.json();
  if (body.code !== "OK") throw new Error(`${path} -> ${body.code}: ${body.msg}`);
  return body.data;
}

async function loginAgent(email) {
  const { debugToken } = await api("/api/v1/auth/magic-link", {
    method: "POST",
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    body: JSON.stringify({ email }),
  });
  return api("/api/v1/auth/verify", { method: "POST", body: JSON.stringify({ token: debugToken }) });
}

function waitForEvent(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for event: ${predicate}`));
    }, timeoutMs);
    function onMessage(ev) {
      const data = JSON.parse(ev.data);
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    }
    ws.addEventListener("message", onMessage);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

async function main() {
  if (!DEBUG_SECRET) throw new Error("DEBUG_AUTH_SECRET env var required");

  const suffix = Date.now().toString(36);
  const agent = await loginAgent(`ws-check-${suffix}@example.com`);
  const accessToken = agent.accessToken;

  const ws1 = await api("/api/v1/workspaces", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: `WS Check ${suffix}` }),
  });
  const workspaceId = ws1.workspace.id;
  const widgetKey = ws1.workspace.widgetKey;

  const boot1 = await api("/api/v1/widget/boot", {
    method: "POST",
    body: JSON.stringify({ widgetKey, name: "Contact One" }),
  });
  const boot2 = await api("/api/v1/widget/boot", {
    method: "POST",
    body: JSON.stringify({ widgetKey, name: "Contact Two" }),
  });

  const created = await api("/api/v1/widget/conversations", {
    method: "POST",
    headers: { Authorization: `Bearer ${boot1.token}` },
    body: JSON.stringify({ body: "Hello from contact one" }),
  });
  const conversationId = created.conversation.id;

  const agentWs = await connect(`${WS_BASE}/api/v1/ws-connect/dashboard?wsId=${workspaceId}&token=${accessToken}`);
  const widget1Ws = await connect(`${WS_BASE}/api/v1/ws-connect/widget?token=${boot1.token}`);
  const widget2Ws = await connect(`${WS_BASE}/api/v1/ws-connect/widget?token=${boot2.token}`);

  await new Promise((r) => setTimeout(r, 300)); // let PRESENCE settle

  // --- MESSAGE_CREATED delivery ---
  const agentMsgP = waitForEvent(agentWs, (d) => d.type === "MESSAGE_CREATED" && d.message.bodyText === "Reply from agent");
  const widget1MsgP = waitForEvent(widget1Ws, (d) => d.type === "MESSAGE_CREATED" && d.message.bodyText === "Reply from agent");
  let widget2GotIt = false;
  widget2Ws.addEventListener("message", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "MESSAGE_CREATED" && d.message.bodyText === "Reply from agent") widget2GotIt = true;
  });

  await api(`/api/v1/ws/${workspaceId}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ body: "Reply from agent" }),
  });

  const [agentMsg, widget1Msg] = await Promise.all([agentMsgP, widget1MsgP]);
  assert(agentMsg.conversation.id === conversationId, "agent socket received MESSAGE_CREATED");
  assert(widget1Msg.conversation.id === conversationId, "widget1 (owning contact) received MESSAGE_CREATED");
  await new Promise((r) => setTimeout(r, 300));
  assert(!widget2GotIt, "widget2 (different contact) did NOT receive widget1's MESSAGE_CREATED — isolation holds");

  // --- typing relay: agent -> widget1 only ---
  const widget1TypingP = waitForEvent(widget1Ws, (d) => d.type === "TYPING" && d.from === "AGENT");
  let widget2GotTyping = false;
  widget2Ws.addEventListener("message", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "TYPING" && d.from === "AGENT") widget2GotTyping = true;
  });
  agentWs.send(JSON.stringify({ type: "TYPING", conversationId, state: "START" }));
  await widget1TypingP;
  assert(true, "widget1 received AGENT typing event");
  await new Promise((r) => setTimeout(r, 300));
  assert(!widget2GotTyping, "widget2 did NOT receive the typing event for another contact's conversation");

  // --- typing relay: contact -> agents only ---
  const agentTypingP = waitForEvent(agentWs, (d) => d.type === "TYPING" && d.from === "CONTACT");
  widget1Ws.send(JSON.stringify({ type: "TYPING", conversationId, state: "START" }));
  await agentTypingP;
  assert(true, "agent received CONTACT typing event");

  // --- read receipt ---
  const widget1ReadP = waitForEvent(widget1Ws, (d) => d.type === "READ_RECEIPT" && d.by === "AGENT");
  agentWs.send(JSON.stringify({ type: "READ", conversationId }));
  await widget1ReadP;
  assert(true, "widget1 received READ_RECEIPT after agent read");

  // --- PING/PONG ---
  const pongP = waitForEvent(agentWs, (d) => d.type === "PONG");
  agentWs.send(JSON.stringify({ type: "PING" }));
  await pongP;
  assert(true, "agent received PONG for PING");

  agentWs.close();
  widget1Ws.close();
  widget2Ws.close();

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
