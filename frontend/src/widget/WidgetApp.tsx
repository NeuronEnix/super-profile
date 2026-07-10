import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiError } from "../lib/api";
import { useReconnectingSocket, wsUrl } from "../lib/ws";
import { widgetApi, setWidgetToken, getWidgetToken } from "./widgetApi";
import { TicketList } from "./TicketList";
import { TicketView } from "./TicketView";
import { NewTicket } from "./NewTicket";
import type { Contact, ConversationSnapshot, WsEvent } from "../lib/types";

const UID_KEY = "sp_uid";

type View = { mode: "list" } | { mode: "new" } | { mode: "ticket"; id: string };

function mergeSnapshot(list: ConversationSnapshot[], snapshot: ConversationSnapshot): ConversationSnapshot[] {
  const withoutOld = list.filter((c) => c.id !== snapshot.id);
  return [snapshot, ...withoutOld].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export default function WidgetApp() {
  const [params] = useSearchParams();
  const widgetKey = params.get("key");
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [contact, setContact] = useState<Contact | null>(null);
  const [workspace, setWorkspace] = useState<{ id: string; name: string; slug: string; widgetColor: string } | null>(null);
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const listenersRef = useRef<Set<(event: WsEvent) => void>>(new Set());
  const firstOpenRef = useRef(true);

  const doBoot = useCallback(async () => {
    if (!widgetKey) return;
    const storedUid = localStorage.getItem(UID_KEY) ?? undefined;
    try {
      const data = await widgetApi<{
        userId: string;
        token: string;
        contact: Contact;
        workspace: { id: string; name: string; slug: string; widgetColor: string };
        conversations: ConversationSnapshot[];
      }>("/api/v1/widget/boot", { method: "POST", body: { widgetKey, userId: storedUid } });
      localStorage.setItem(UID_KEY, data.userId);
      setWidgetToken(data.token);
      setContact(data.contact);
      setWorkspace(data.workspace);
      setConversations(data.conversations);
      setBooted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't connect. Please try again later.");
    }
  }, [widgetKey]);

  useEffect(() => {
    if (!widgetKey) {
      setError("This widget is missing its key.");
      return;
    }
    doBoot();
  }, [widgetKey, doBoot]);

  const socketUrl = useMemo(() => {
    if (!booted) return null;
    const token = getWidgetToken();
    if (!token) return null;
    return wsUrl(`/api/v1/ws-connect/widget?token=${encodeURIComponent(token)}`);
  }, [booted]);

  const handleSocketMessage = useCallback((event: WsEvent) => {
    if (event.type === "MESSAGE_CREATED" || event.type === "CONVERSATION_UPDATED") {
      setConversations((prev) => mergeSnapshot(prev, event.conversation));
    }
    for (const fn of listenersRef.current) fn(event);
  }, []);

  // On RE-connect (not the initial open), the socket may have missed events — re-boot to
  // resync the conversation list, and bump the nonce so an open ticket catches up via afterId.
  const handleSocketOpen = useCallback(() => {
    if (firstOpenRef.current) {
      firstOpenRef.current = false;
      return;
    }
    doBoot();
    setReconnectNonce((n) => n + 1);
  }, [doBoot]);

  const { send } = useReconnectingSocket(socketUrl, { onMessage: handleSocketMessage, onOpen: handleSocketOpen });

  const subscribe = useCallback((fn: (event: WsEvent) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const handleConversationChanged = useCallback((c: ConversationSnapshot) => {
    setConversations((prev) => mergeSnapshot(prev, c));
  }, []);

  // Unread FOR THE VISITOR: only their own read watermark matters here — the agent's watermark
  // is about the other side (using it counted the visitor's own fresh ticket as unread).
  const totalUnread = conversations.filter(
    (c) => c.contactLastReadAt === null || c.contactLastReadAt < c.lastMessageAt,
  ).length;

  useEffect(() => {
    window.parent.postMessage({ type: "sp:unread", count: totalUnread }, "*");
  }, [totalUnread]);

  const handleCreateConversation = useCallback(
    async (body: string, profile?: { name?: string; email?: string }) => {
      const data = await widgetApi<{ conversation: ConversationSnapshot }>("/api/v1/widget/conversations", {
        method: "POST",
        body: { body, ...profile },
      });
      if (profile?.name || profile?.email) {
        setContact((prev) =>
          prev ? { ...prev, name: prev.name ?? profile.name ?? null, email: prev.email ?? profile.email ?? null } : prev,
        );
      }
      setConversations((prev) => mergeSnapshot(prev, data.conversation));
      setView({ mode: "ticket", id: data.conversation.id });
    },
    [],
  );

  if (error) {
    return <div className="flex h-screen items-center justify-center p-6 text-center text-sm text-slate-500">{error}</div>;
  }
  if (!booted || !workspace) {
    return <div className="flex h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  if (view.mode === "new") {
    return (
      <NewTicket
        contact={contact}
        widgetColor={workspace.widgetColor}
        wsSlug={workspace.slug}
        onBack={() => setView({ mode: "list" })}
        onCreate={handleCreateConversation}
      />
    );
  }
  if (view.mode === "ticket") {
    return (
      <TicketView
        key={view.id}
        conversationId={view.id}
        initial={conversations.find((c) => c.id === view.id) ?? null}
        widgetColor={workspace.widgetColor}
        send={send}
        subscribe={subscribe}
        reconnectNonce={reconnectNonce}
        onBack={() => setView({ mode: "list" })}
        onConversationChanged={handleConversationChanged}
      />
    );
  }
  return (
    <TicketList
      workspaceName={workspace.name}
      widgetColor={workspace.widgetColor}
      wsSlug={workspace.slug}
      conversations={conversations}
      onSelect={(id) => setView({ mode: "ticket", id })}
      onNewConversation={() => setView({ mode: "new" })}
    />
  );
}
