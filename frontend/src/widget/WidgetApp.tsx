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
  const [workspace, setWorkspace] = useState<{ id: string; name: string; widgetColor: string } | null>(null);
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const listenersRef = useRef<Set<(event: WsEvent) => void>>(new Set());

  useEffect(() => {
    if (!widgetKey) {
      setError("This widget is missing its key.");
      return;
    }
    const storedUid = localStorage.getItem(UID_KEY) ?? undefined;
    (async () => {
      try {
        const data = await widgetApi<{
          userId: string;
          token: string;
          contact: Contact;
          workspace: { id: string; name: string; widgetColor: string };
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
    })();
  }, [widgetKey]);

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

  const { send } = useReconnectingSocket(socketUrl, { onMessage: handleSocketMessage });

  const subscribe = useCallback((fn: (event: WsEvent) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const handleConversationChanged = useCallback((c: ConversationSnapshot) => {
    setConversations((prev) => mergeSnapshot(prev, c));
  }, []);

  const totalUnread = conversations.filter(
    (c) => c.agentLastReadAt === null || c.contactLastReadAt === null || c.contactLastReadAt < c.lastMessageAt,
  ).length;

  useEffect(() => {
    window.parent.postMessage({ type: "sp:unread", count: totalUnread }, "*");
  }, [totalUnread]);

  const handleCreateConversation = useCallback(async (body: string) => {
    const data = await widgetApi<{ conversation: ConversationSnapshot }>("/api/v1/widget/conversations", {
      method: "POST",
      body: { body },
    });
    setConversations((prev) => mergeSnapshot(prev, data.conversation));
    setView({ mode: "ticket", id: data.conversation.id });
  }, []);

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
        onBack={() => setView({ mode: "list" })}
        onCreate={handleCreateConversation}
      />
    );
  }
  if (view.mode === "ticket") {
    return (
      <TicketView
        conversationId={view.id}
        widgetColor={workspace.widgetColor}
        send={send}
        subscribe={subscribe}
        onBack={() => setView({ mode: "list" })}
        onConversationChanged={handleConversationChanged}
      />
    );
  }
  return (
    <TicketList
      workspaceName={workspace.name}
      widgetColor={workspace.widgetColor}
      conversations={conversations}
      onSelect={(id) => setView({ mode: "ticket", id })}
      onNewConversation={() => setView({ mode: "new" })}
    />
  );
}
