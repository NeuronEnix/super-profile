import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { ContactPanel } from "./ContactPanel";
import { SummaryPanel } from "./SummaryPanel";
import { Composer } from "./Composer";
import type { Conversation, ConversationSnapshot, Member, Message, WsEvent } from "../lib/types";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function snoozeOptions(): { label: string; until: number }[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const tomorrow9am = new Date();
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);
  return [
    { label: "1 hour", until: now + 60 * 60 * 1000 },
    { label: "Tomorrow", until: tomorrow9am.getTime() },
    { label: "Next week", until: now + 7 * day },
  ];
}

export function ConversationView({
  conversationId,
  wsId,
  send,
  subscribe,
  reconnectNonce,
  members,
  currentUserId,
  presenceOnline,
  onConversationChanged,
}: {
  conversationId: string;
  wsId: string;
  send: (data: unknown) => void;
  subscribe: (fn: (event: WsEvent) => void) => () => void;
  reconnectNonce: number;
  members: Member[];
  currentUserId: string | undefined;
  presenceOnline: number;
  onConversationChanged: (c: Conversation) => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contactTyping, setContactTyping] = useState(false);
  const { showError } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /** The DO's write-path responses (POST .../messages) return a bare ConversationSnapshot —
   * no `contact` object. Merge onto whatever `contact` we already have rather than trusting
   * the response's shape, or the UI crashes reading `.contact.name` on the next render. */
  function mergeContactOnto(snapshot: ConversationSnapshot): Conversation | null {
    const prev = conversationRef.current;
    if (!prev) return null;
    return { ...snapshot, contact: prev.contact, unread: prev.unread };
  }

  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    setMessages([]);
    (async () => {
      try {
        const [convData, msgData] = await Promise.all([
          api<{ conversation: Conversation }>(`/api/v1/ws/${wsId}/conversations/${conversationId}`),
          api<{ messages: Message[] }>(`/api/v1/ws/${wsId}/conversations/${conversationId}/messages`),
        ]);
        if (cancelled) return;
        setConversation(convData.conversation);
        setMessages(msgData.messages);
        api(`/api/v1/ws/${wsId}/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      } catch (err) {
        showError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, conversationId, showError]);

  // After a WS reconnect, refetch the conversation (status/assignee may have changed while
  // offline) and fill the message gap via ?afterId= instead of trusting the socket alone.
  useEffect(() => {
    if (reconnectNonce === 0) return;
    const last = messagesRef.current[messagesRef.current.length - 1];
    (async () => {
      try {
        const [convData, msgData] = await Promise.all([
          api<{ conversation: Conversation }>(`/api/v1/ws/${wsId}/conversations/${conversationId}`),
          api<{ messages: Message[] }>(
            `/api/v1/ws/${wsId}/conversations/${conversationId}/messages${last ? `?afterId=${last.id}` : ""}`,
          ),
        ]);
        setConversation(convData.conversation);
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...msgData.messages.filter((m) => !seen.has(m.id))];
        });
      } catch {
        // Reconnect catch-up is best-effort; the next event or a reload resyncs anyway.
      }
    })();
  }, [reconnectNonce, wsId, conversationId]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "MESSAGE_CREATED" && event.conversation.id === conversationId) {
        setConversation((prev) => (prev ? { ...event.conversation, contact: prev.contact, unread: prev.unread } : prev));
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
        if (event.message.senderType === "CONTACT") {
          api(`/api/v1/ws/${wsId}/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
        }
      } else if (event.type === "CONVERSATION_UPDATED" && event.conversation.id === conversationId) {
        setConversation((prev) => (prev ? { ...event.conversation, contact: prev.contact, unread: prev.unread } : prev));
      } else if (event.type === "TYPING" && event.conversationId === conversationId && event.from === "CONTACT") {
        setContactTyping(event.state === "START");
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        if (event.state === "START") {
          typingTimerRef.current = setTimeout(() => setContactTyping(false), 5000);
        }
      } else if (event.type === "READ_RECEIPT" && event.conversationId === conversationId && event.by === "CONTACT") {
        setConversation((prev) => (prev ? { ...prev, contactLastReadAt: event.at } : prev));
      }
    });
  }, [subscribe, conversationId, wsId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, contactTyping]);

  const patchConversation = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        const { conversation: updated } = await api<{ conversation: Conversation }>(
          `/api/v1/ws/${wsId}/conversations/${conversationId}`,
          { method: "PATCH", body: patch },
        );
        setConversation(updated);
        onConversationChanged(updated);
      } catch (err) {
        showError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    },
    [wsId, conversationId, onConversationChanged, showError],
  );

  const handleSend = useCallback(
    async (body: string) => {
      const { conversation: snapshot, message } = await api<{ conversation: ConversationSnapshot; message: Message }>(
        `/api/v1/ws/${wsId}/conversations/${conversationId}/messages`,
        { method: "POST", body: { body } },
      );
      const merged = mergeContactOnto(snapshot);
      setConversation(merged);
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      if (merged) onConversationChanged(merged);
    },
    [wsId, conversationId, onConversationChanged],
  );

  const handleTyping = useCallback(
    (state: "START" | "STOP") => {
      send({ type: "TYPING", conversationId, state });
    },
    [send, conversationId],
  );

  if (!conversation) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  const lastAgentMessage = [...messages].reverse().find((m) => m.senderType === "AGENT");
  const seen = !!(
    lastAgentMessage &&
    conversation.contactLastReadAt &&
    conversation.contactLastReadAt >= lastAgentMessage.createdAt
  );

  return (
    <div className="flex flex-1 min-w-0">
      <div className="flex flex-1 min-w-0 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-slate-900">
                {conversation.contact.name ?? conversation.contact.email ?? "Anonymous visitor"}
              </span>
              {presenceOnline > 0 && (
                <span title={`${presenceOnline} agent(s) online`} className="h-2 w-2 rounded-full bg-emerald-500" />
              )}
            </div>
            <div className="text-xs text-slate-500">{conversation.subject || conversation.channel}</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Assignee"
              value={conversation.assigneeId ?? ""}
              onChange={(e) => patchConversation({ assigneeId: e.target.value || null })}
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.userId === currentUserId ? "Me" : (m.name ?? m.email ?? m.userId)}
                </option>
              ))}
            </select>
            {conversation.status !== "RESOLVED" && (
              <div className="group relative">
                <button className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                  Snooze
                </button>
                <div className="absolute right-0 z-10 hidden w-32 rounded-md border border-slate-200 bg-white py-1 shadow-lg group-hover:block">
                  {snoozeOptions().map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => patchConversation({ status: "SNOOZED", snoozedUntil: opt.until })}
                      className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {conversation.status === "RESOLVED" ? (
              <button
                onClick={() => patchConversation({ status: "OPEN" })}
                className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Reopen
              </button>
            ) : (
              <button
                onClick={() => patchConversation({ status: "RESOLVED" })}
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Resolve
              </button>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m) => (
            <div key={m.id}>
              {m.senderType === "SYSTEM" ? (
                <div className="text-center text-xs text-slate-400">{m.bodyText}</div>
              ) : (
                <div className={`flex ${m.senderType === "AGENT" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                      m.senderType === "AGENT" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-900"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">{m.bodyText}</div>
                    <div
                      className={`mt-1 text-[10px] ${m.senderType === "AGENT" ? "text-indigo-200" : "text-slate-400"}`}
                    >
                      {formatTime(m.createdAt)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {contactTyping && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-slate-100 px-3.5 py-2 text-xs italic text-slate-400">typing…</div>
            </div>
          )}
          {seen && (
            <div className="text-right text-[10px] text-slate-400">Seen</div>
          )}
        </div>

        <Composer onSend={handleSend} onTyping={handleTyping} />
      </div>

      <div className="w-64 shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
        <ContactPanel contact={conversation.contact} />
        <SummaryPanel wsId={wsId} conversationId={conversationId} messageCount={conversation.messageCount} />
      </div>
    </div>
  );
}
