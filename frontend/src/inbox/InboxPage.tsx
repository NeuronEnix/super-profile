import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError, getAccessToken } from "../lib/api";
import { useReconnectingSocket, wsUrl } from "../lib/ws";
import { useToast } from "../components/Toast";
import { ConversationList, type Filters } from "./ConversationList";
import { ConversationView } from "./ConversationView";
import type { Conversation, ConversationSnapshot, Member, WsEvent } from "../lib/types";
import { useAuth } from "../auth/AuthContext";

function upsertConversation(list: Conversation[], updated: Conversation): Conversation[] {
  const withoutOld = list.filter((c) => c.id !== updated.id);
  return [updated, ...withoutOld].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/** WS snapshots lack `contact`/`unread` — merge onto whatever we already know, if anything. */
function mergeSnapshot(list: Conversation[], snapshot: ConversationSnapshot): Conversation[] {
  const existing = list.find((c) => c.id === snapshot.id);
  const merged: Conversation = {
    ...snapshot,
    contact: existing?.contact ?? { id: snapshot.contactId, name: null, email: null },
    unread: snapshot.agentLastReadAt === null || snapshot.agentLastReadAt < snapshot.lastMessageAt,
  };
  return upsertConversation(list, merged);
}

export default function InboxPage() {
  const { wsId } = useParams();
  const { user } = useAuth();
  const { showError } = useToast();
  const [filters, setFilters] = useState<Filters>({ status: "OPEN" });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presenceOnline, setPresenceOnline] = useState(0);
  const listenersRef = useRef<Set<(event: WsEvent) => void>>(new Set());

  const loadConversations = useCallback(async () => {
    if (!wsId) return;
    const qs = new URLSearchParams();
    if (filters.channel) qs.set("channel", filters.channel);
    if (filters.status) qs.set("status", filters.status);
    if (filters.assigneeId) qs.set("assigneeId", filters.assigneeId);
    setConversationsLoading(true);
    try {
      const data = await api<{ conversations: Conversation[] }>(`/api/v1/ws/${wsId}/conversations?${qs}`);
      setConversations(data.conversations);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setConversationsLoading(false);
    }
  }, [wsId, filters, showError]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!wsId) return;
    api<{ members: Member[] }>(`/api/v1/ws/${wsId}/members`)
      .then((d) => setMembers(d.members))
      .catch(() => {});
  }, [wsId]);

  const socketUrl = useMemo(() => {
    if (!wsId) return null;
    const token = getAccessToken();
    if (!token) return null;
    return wsUrl(`/api/v1/ws-connect/dashboard?wsId=${wsId}&token=${encodeURIComponent(token)}`);
  }, [wsId]);

  const handleSocketMessage = useCallback(
    (event: WsEvent) => {
      if (event.type === "MESSAGE_CREATED" || event.type === "CONVERSATION_UPDATED") {
        setConversations((prev) => mergeSnapshot(prev, event.conversation));
      } else if (event.type === "PRESENCE") {
        setPresenceOnline(event.agentsOnline);
      }
      for (const fn of listenersRef.current) fn(event);
    },
    [],
  );

  const { send } = useReconnectingSocket(socketUrl, {
    onMessage: handleSocketMessage,
    onOpen: loadConversations,
  });

  const subscribe = useCallback((fn: (event: WsEvent) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const handleConversationChanged = useCallback((c: Conversation) => {
    setConversations((prev) => upsertConversation(prev, c));
  }, []);

  if (!wsId) return null;

  return (
    <div className="flex h-screen">
      <ConversationList
        conversations={conversations}
        loading={conversationsLoading}
        filters={filters}
        onFiltersChange={setFilters}
        members={members}
        selectedId={selectedId}
        onSelect={setSelectedId}
        currentUserId={user?.id}
      />
      {selectedId ? (
        <ConversationView
          key={selectedId}
          conversationId={selectedId}
          wsId={wsId}
          send={send}
          subscribe={subscribe}
          members={members}
          currentUserId={user?.id}
          presenceOnline={presenceOnline}
          onConversationChanged={handleConversationChanged}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          Select a conversation
        </div>
      )}
    </div>
  );
}
