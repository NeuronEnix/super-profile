import { useCallback, useEffect, useRef, useState } from "react";
import { widgetApi } from "./widgetApi";
import { Composer } from "../inbox/Composer";
import { Ticks, TypingDots, type TickState } from "../components/MessageStatus";
import { Linkified } from "../lib/linkify";
import type { ConversationSnapshot, Message, WsEvent } from "../lib/types";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TicketView({
  conversationId,
  initial,
  widgetColor,
  send,
  subscribe,
  reconnectNonce,
  agentsOnline,
  onBack,
  onConversationChanged,
}: {
  conversationId: string;
  initial: ConversationSnapshot | null;
  widgetColor: string;
  send: (data: unknown) => void;
  subscribe: (fn: (event: WsEvent) => void) => () => void;
  reconnectNonce: number;
  agentsOnline: number;
  onBack: () => void;
  onConversationChanged: (c: ConversationSnapshot) => void;
}) {
  const [conversation, setConversation] = useState<ConversationSnapshot | null>(initial);
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  // Monotonic "delivered" watermark — latches once an agent is online, never flickers back.
  const [deliveredAt, setDeliveredAt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await widgetApi<{ messages: Message[] }>(
        `/api/v1/widget/conversations/${conversationId}/messages`,
      );
      if (cancelled) return;
      setMessages(data.messages);
      widgetApi(`/api/v1/widget/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // After a WS reconnect, fill any gap the socket missed while disconnected.
  useEffect(() => {
    if (reconnectNonce === 0) return;
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (!last) return;
    widgetApi<{ messages: Message[] }>(`/api/v1/widget/conversations/${conversationId}/messages?afterId=${last.id}`)
      .then((data) => {
        if (data.messages.length === 0) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...data.messages.filter((m) => !seen.has(m.id))];
        });
      })
      .catch(() => {});
  }, [reconnectNonce, conversationId]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "MESSAGE_CREATED" && event.conversation.id === conversationId) {
        setConversation(event.conversation);
        onConversationChanged(event.conversation);
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
        if (event.message.senderType === "AGENT" || event.message.senderType === "AI") {
          setAgentTyping(false); // they sent — no longer typing
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
          widgetApi(`/api/v1/widget/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
        }
      } else if (event.type === "CONVERSATION_UPDATED" && event.conversation.id === conversationId) {
        setConversation(event.conversation);
        onConversationChanged(event.conversation);
      } else if (event.type === "READ_RECEIPT" && event.conversationId === conversationId && event.by === "AGENT") {
        // Agent-side read (human opening the inbox, or the AI replying) — turn the ticks blue.
        setConversation((prev) => (prev ? { ...prev, agentLastReadAt: event.at } : prev));
      } else if (event.type === "TYPING" && event.conversationId === conversationId && event.from === "AGENT") {
        // Each ping shows the dots for 3s; a new ping resets the window from now.
        setAgentTyping(true);
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setAgentTyping(false), 3000);
      }
    });
  }, [subscribe, conversationId, onConversationChanged]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, agentTyping]);

  // Latch "delivered" whenever an agent is connected to receive the message.
  useEffect(() => {
    if (agentsOnline > 0) setDeliveredAt((prev) => Math.max(prev, Date.now()));
  }, [agentsOnline, messages]);

  const handleSend = useCallback(
    async (body: string) => {
      const { conversation: updated, message } = await widgetApi<{
        conversation: ConversationSnapshot;
        message: Message;
      }>(`/api/v1/widget/conversations/${conversationId}/messages`, { method: "POST", body: { body } });
      setConversation(updated);
      onConversationChanged(updated);
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    },
    [conversationId, onConversationChanged],
  );

  const handleTyping = useCallback(() => {
    send({ type: "TYPING", conversationId, state: "START" });
  }, [send, conversationId]);

  const tickState = (m: Message): TickState => {
    if (conversation?.agentLastReadAt != null && conversation.agentLastReadAt >= m.createdAt) return "read";
    if (deliveredAt >= m.createdAt) return "delivered";
    return "sent";
  };

  return (
    <div className="flex h-screen flex-col bg-white">
      <div className="flex items-center gap-2 px-4 py-3" style={{ backgroundColor: widgetColor }}>
        <button onClick={onBack} className="text-white/90 hover:text-white" aria-label="Back">
          ←
        </button>
        <span className="truncate text-sm font-medium text-white">
          {conversation?.subject || "Conversation"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.map((m) => (
          <div key={m.id}>
            {m.senderType === "SYSTEM" ? (
              <div className="text-center text-[11px] text-slate-400">{m.bodyText}</div>
            ) : (
              <div className={`flex ${m.senderType === "CONTACT" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                    m.senderType === "CONTACT" ? "text-white" : "bg-slate-100 text-slate-900"
                  }`}
                  style={m.senderType === "CONTACT" ? { backgroundColor: widgetColor } : undefined}
                >
                  <div className="whitespace-pre-wrap break-words">
                    <Linkified text={m.bodyText} />
                  </div>
                  <div
                    className={`mt-0.5 flex items-center gap-1 text-[9px] ${
                      m.senderType === "CONTACT" ? "justify-end text-white/70" : "text-slate-400"
                    }`}
                  >
                    <span>{formatTime(m.createdAt)}</span>
                    {m.senderType === "CONTACT" && <Ticks state={tickState(m)} onColor />}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        {agentTyping && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-3 py-1.5">
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      <Composer onSend={handleSend} onTyping={handleTyping} placeholder="Reply…" />
    </div>
  );
}
