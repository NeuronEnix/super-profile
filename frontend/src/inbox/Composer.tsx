import { useRef, useState, type KeyboardEvent } from "react";

export function Composer({
  onSend,
  onTyping,
  disabled,
  placeholder = "Reply…",
}: {
  onSend: (text: string) => Promise<void> | void;
  onTyping?: (state: "START" | "STOP") => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const typingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function notifyTyping() {
    if (!onTyping) return;
    if (!typingRef.current) {
      typingRef.current = true;
      onTyping("START");
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      typingRef.current = false;
      onTyping("STOP");
    }, 2000);
  }

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
      if (typingRef.current) {
        typingRef.current = false;
        onTyping?.("STOP");
      }
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          notifyTyping();
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">Enter to send, Shift+Enter for a new line</span>
        <button
          onClick={handleSend}
          disabled={disabled || sending || !text.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
