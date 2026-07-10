import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { ContactPanel } from "./ContactPanel";
import { SummaryPanel } from "./SummaryPanel";
import { Composer, type DraftSuggestion } from "./Composer";
import { Ticks, TypingDots, type TickState } from "../components/MessageStatus";
import { Linkified } from "../lib/linkify";
import { computeSla, type SlaTargets } from "../lib/sla";
import type { CannedResponse, Conversation, ConversationSnapshot, Member, Message, WsEvent } from "../lib/types";

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
  canned,
  currentUserId,
  presenceOnline,
  onlineContactIds,
  onConversationChanged,
  slaTargets,
}: {
  conversationId: string;
  wsId: string;
  send: (data: unknown) => void;
  subscribe: (fn: (event: WsEvent) => void) => () => void;
  reconnectNonce: number;
  members: Member[];
  canned: CannedResponse[];
  currentUserId: string | undefined;
  presenceOnline: number;
  onlineContactIds: string[];
  onConversationChanged: (c: Conversation) => void;
  slaTargets: SlaTargets;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contactTyping, setContactTyping] = useState(false);
  // Monotonic "delivered" watermark: once the contact is seen online, every message up to now is
  // delivered and stays delivered even if they later disconnect (so the tick never flickers back).
  const [deliveredAt, setDeliveredAt] = useState(0);
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
          setContactTyping(false); // they sent — no longer typing
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
          api(`/api/v1/ws/${wsId}/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
        }
      } else if (event.type === "CONVERSATION_UPDATED" && event.conversation.id === conversationId) {
        setConversation((prev) => (prev ? { ...event.conversation, contact: prev.contact, unread: prev.unread } : prev));
      } else if (event.type === "TYPING" && event.conversationId === conversationId && event.from === "CONTACT") {
        // Each ping shows the dots for 3s; a new ping resets the window from now.
        setContactTyping(true);
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setContactTyping(false), 3000);
      } else if (event.type === "READ_RECEIPT" && event.conversationId === conversationId && event.by === "CONTACT") {
        setConversation((prev) => (prev ? { ...prev, contactLastReadAt: event.at } : prev));
      }
    });
  }, [subscribe, conversationId, wsId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, contactTyping]);

  // Latch "delivered" whenever this conversation's contact is currently connected.
  useEffect(() => {
    const contactUserId = messages.find((m) => m.senderType === "CONTACT")?.senderId ?? null;
    if (contactUserId && onlineContactIds.includes(contactUserId)) {
      setDeliveredAt((prev) => Math.max(prev, Date.now()));
    }
  }, [onlineContactIds, messages]);

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
      try {
        const { conversation: snapshot, message } = await api<{ conversation: ConversationSnapshot; message: Message }>(
          `/api/v1/ws/${wsId}/conversations/${conversationId}/messages`,
          { method: "POST", body: { body } },
        );
        const merged = mergeContactOnto(snapshot);
        setConversation(merged);
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        if (merged) onConversationChanged(merged);
      } catch (err) {
        showError(err instanceof ApiError ? err.message : "Something went wrong");
        throw err; // let the composer keep the unsent text
      }
    },
    [wsId, conversationId, onConversationChanged, showError],
  );

  const handleTyping = useCallback(() => {
    send({ type: "TYPING", conversationId, state: "START" });
  }, [send, conversationId]);

  const handleSuggest = useCallback(async (): Promise<DraftSuggestion> => {
    try {
      return await api<DraftSuggestion>(`/api/v1/ws/${wsId}/conversations/${conversationId}/suggest-reply`, {
        method: "POST",
      });
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
      throw err; // the composer just clears its "Thinking…" state
    }
  }, [wsId, conversationId, showError]);

  const handleAiAction = useCallback(
    async (action: "delegate" | "takeover") => {
      try {
        const { conversation: updated } = await api<{ conversation: Conversation }>(
          `/api/v1/ws/${wsId}/conversations/${conversationId}/ai/${action}`,
          { method: "POST" },
        );
        setConversation(updated);
        onConversationChanged(updated);
      } catch (err) {
        showError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    },
    [wsId, conversationId, onConversationChanged, showError],
  );

  const handleFixGrammar = useCallback(
    async (text: string): Promise<string> => {
      try {
        const { text: corrected } = await api<{ text: string }>(`/api/v1/ws/${wsId}/ai/grammar`, {
          method: "POST",
          body: { text },
        });
        return corrected;
      } catch (err) {
        showError(err instanceof ApiError ? err.message : "Something went wrong");
        throw err; // the composer keeps the original text
      }
    },
    [wsId, showError],
  );

  if (!conversation) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  const isChat = conversation.channel === "CHAT";
  const lastAgentMessage = [...messages].reverse().find((m) => m.senderType === "AGENT");
  const seen = !!(
    lastAgentMessage &&
    conversation.contactLastReadAt &&
    conversation.contactLastReadAt >= lastAgentMessage.createdAt
  );
  const tickState = (m: Message): TickState => {
    if (conversation.contactLastReadAt != null && conversation.contactLastReadAt >= m.createdAt) return "read";
    if (deliveredAt >= m.createdAt) return "delivered";
    return "sent";
  };

  // Assignment lock: while a conversation is assigned to another agent and not yet resolved, only
  // that agent may reply. Unassigned or resolved conversations are open to everyone (whoever replies
  // to an unassigned one claims it — see the backend auto-assign). The assignee dropdown stays live
  // so anyone can reassign it to themselves and unlock their own composer.
  const lockedToOther =
    conversation.status !== "RESOLVED" &&
    conversation.assigneeId != null &&
    conversation.assigneeId !== currentUserId;
  const lockOwner = members.find((m) => m.userId === conversation.assigneeId);
  const lockOwnerName = lockOwner?.name ?? lockOwner?.email ?? "another agent";
  const aiHandling = !!conversation.aiHandling;
  const isAssignee = conversation.assigneeId === currentUserId;

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
            {(() => {
              const sla = computeSla(conversation, slaTargets, Date.now());
              if (!sla.firstResponse && !sla.resolution) return null;
              const fmt = (s: NonNullable<typeof sla.firstResponse>, name: string) =>
                s.state === "MET"
                  ? `${name} ${s.tookMin}m ✓`
                  : s.state === "BREACHED"
                    ? `${name} breached${s.tookMin != null ? ` (${s.tookMin}m)` : ""}`
                    : `${name} due in ${Math.max(0, Math.ceil((s.dueAt - Date.now()) / 60_000))}m`;
              return (
                <div className="mt-0.5 flex gap-2 text-[10px]">
                  {sla.firstResponse && (
                    <span className={sla.firstResponse.state === "BREACHED" ? "text-red-600" : sla.firstResponse.state === "MET" ? "text-emerald-600" : "text-amber-600"}>
                      {fmt(sla.firstResponse, "First response")}
                    </span>
                  )}
                  {sla.resolution && (
                    <span className={sla.resolution.state === "BREACHED" ? "text-red-600" : sla.resolution.state === "MET" ? "text-emerald-600" : "text-amber-600"}>
                      {fmt(sla.resolution, "Resolution")}
                    </span>
                  )}
                </div>
              );
            })()}
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
            {conversation.status !== "RESOLVED" &&
              (aiHandling ? (
                <button
                  onClick={() => handleAiAction("takeover")}
                  disabled={!isAssignee}
                  title={isAssignee ? "Stop the AI and reply yourself" : "Only the assignee can take over"}
                  className="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  Take over from AI
                </button>
              ) : (
                <button
                  onClick={() => handleAiAction("delegate")}
                  disabled={!isAssignee}
                  title={
                    isAssignee
                      ? "Let AI reply to the customer using your knowledge base; it escalates back to you when stuck"
                      : "Assign the conversation to yourself first"
                  }
                  className="rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                >
                  ✨ Delegate to AI
                </button>
              ))}
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
                <div
                  className={`flex ${m.senderType === "AGENT" || m.senderType === "AI" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                      m.senderType === "AGENT"
                        ? "bg-indigo-600 text-white"
                        : m.senderType === "AI"
                          ? "bg-violet-600 text-white"
                          : "bg-slate-100 text-slate-900"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">
                      <Linkified text={m.bodyText} />
                    </div>
                    <div
                      className={`mt-1 flex items-center gap-1 text-[10px] ${
                        m.senderType === "AGENT"
                          ? "justify-end text-indigo-200"
                          : m.senderType === "AI"
                            ? "justify-end text-violet-200"
                            : "text-slate-400"
                      }`}
                    >
                      {m.senderType === "AI" && <span className="font-medium">✨ AI</span>}
                      <span>{formatTime(m.createdAt)}</span>
                      {isChat && (m.senderType === "AGENT" || m.senderType === "AI") && (
                        <Ticks state={tickState(m)} onColor />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {isChat && contactTyping && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-slate-100 px-3.5 py-2">
                <TypingDots />
              </div>
            </div>
          )}
          {!isChat && seen && <div className="text-right text-[10px] text-slate-400">Seen</div>}
        </div>

        {lockedToOther && !aiHandling && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            Assigned to <span className="font-medium">{lockOwnerName}</span>. Reassign it to yourself to reply.
          </div>
        )}
        {aiHandling && (
          <div className="border-t border-violet-200 bg-violet-50 px-4 py-2 text-xs text-violet-800">
            ✨ <span className="font-medium">AI is handling this conversation</span> — it replies to the customer
            automatically and escalates back to {isAssignee ? "you" : lockOwnerName} when stuck.
            {isAssignee && ' Click "Take over from AI" to reply yourself.'}
          </div>
        )}
        <Composer
          onSend={handleSend}
          onTyping={isChat && !lockedToOther && !aiHandling ? handleTyping : undefined}
          onSuggest={handleSuggest}
          onFixGrammar={handleFixGrammar}
          canned={canned}
          disabled={lockedToOther || aiHandling}
          placeholder={
            aiHandling
              ? "AI is handling — take over to reply…"
              : lockedToOther
                ? "Reassign to yourself to reply…"
                : "Reply…"
          }
        />
      </div>

      <div className="w-64 shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
        <ContactPanel contact={conversation.contact} />
        <SummaryPanel wsId={wsId} conversationId={conversationId} messageCount={conversation.messageCount} />
      </div>
    </div>
  );
}
