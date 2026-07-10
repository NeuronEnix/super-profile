import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function Composer({
  onSend,
  onTyping,
  disabled,
  placeholder = "Reply…",
}: {
  onSend: (text: string) => Promise<void> | void;
  onTyping?: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const dirtyRef = useRef(false);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Typing signal: ping the other side right away, then a self-rescheduling setTimeout loop
  // (never setInterval) re-pings every 2s ONLY if new characters were typed since the last ping.
  // The first tick that finds nothing new stops the loop. The receiver shows the dots for 3s
  // per ping, so continuous typing keeps re-extending that window.
  function pingLoop() {
    loopRef.current = null;
    if (!dirtyRef.current) return; // nothing typed in the last 2s → stop
    dirtyRef.current = false;
    onTyping?.();
    loopRef.current = setTimeout(pingLoop, 2000);
  }

  function notifyTyping() {
    if (!onTyping) return;
    dirtyRef.current = true;
    if (!loopRef.current) {
      dirtyRef.current = false;
      onTyping();
      loopRef.current = setTimeout(pingLoop, 2000);
    }
  }

  function stopTypingLoop() {
    if (loopRef.current) clearTimeout(loopRef.current);
    loopRef.current = null;
    dirtyRef.current = false;
  }

  useEffect(() => () => stopTypingLoop(), []);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
      stopTypingLoop();
    } catch {
      // Send failed (e.g. the conversation got claimed by someone else) — keep the text so the
      // user can retry or copy it; the parent surfaces the actual error message.
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
