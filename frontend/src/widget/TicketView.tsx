import { useCallback, useEffect, useRef, useState } from "react";
import { widgetApi } from "./widgetApi";
import { Composer } from "../inbox/Composer";
import type { ConversationSnapshot, Message, WsEvent } from "../lib/types";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TicketView({
  conversationId,
  widgetColor,
  send,
  subscribe,
  onBack,
  onConversationChanged,
}: {
  conversationId: string;
  widgetColor: string;
  send: (data: unknown) => void;
  subscribe: (fn: (event: WsEvent) => void) => () => void;
  onBack: () => void;
  onConversationChanged: (c: ConversationSnapshot) => void;
}) {
  const [conversation, setConversation] = useState<ConversationSnapshot | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "MESSAGE_CREATED" && event.conversation.id === conversationId) {
        setConversation(event.conversation);
        onConversationChanged(event.conversation);
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
        if (event.message.senderType === "AGENT") {
          widgetApi(`/api/v1/widget/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
        }
      } else if (event.type === "CONVERSATION_UPDATED" && event.conversation.id === conversationId) {
        setConversation(event.conversation);
        onConversationChanged(event.conversation);
      } else if (event.type === "TYPING" && event.conversationId === conversationId && event.from === "AGENT") {
        setAgentTyping(event.state === "START");
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        if (event.state === "START") typingTimerRef.current = setTimeout(() => setAgentTyping(false), 5000);
      }
    });
  }, [subscribe, conversationId, onConversationChanged]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, agentTyping]);

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

  const handleTyping = useCallback(
    (state: "START" | "STOP") => {
      send({ type: "TYPING", conversationId, state });
    },
    [send, conversationId],
  );

  const lastOwnMessage = [...messages].reverse().find((m) => m.senderType === "CONTACT");
  const seen = !!(
    lastOwnMessage &&
    conversation?.agentLastReadAt &&
    conversation.agentLastReadAt >= lastOwnMessage.createdAt
  );

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
                  <div className="whitespace-pre-wrap break-words">{m.bodyText}</div>
                  <div className={`mt-0.5 text-[9px] ${m.senderType === "CONTACT" ? "text-white/70" : "text-slate-400"}`}>
                    {formatTime(m.createdAt)}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        {agentTyping && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-3 py-1.5 text-xs italic text-slate-400">typing…</div>
          </div>
        )}
        {seen && <div className="text-right text-[9px] text-slate-400">Seen</div>}
      </div>

      <Composer onSend={handleSend} onTyping={handleTyping} placeholder="Reply…" />
    </div>
  );
}
