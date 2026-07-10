import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type DraftSuggestion = { draft: string; sources: { id: string; title: string; slug: string }[] };

export function Composer({
  onSend,
  onTyping,
  onSuggest,
  onFixGrammar,
  disabled,
  placeholder = "Reply…",
}: {
  onSend: (text: string) => Promise<void> | void;
  onTyping?: () => void;
  onSuggest?: () => Promise<DraftSuggestion>;
  onFixGrammar?: (text: string) => Promise<string>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [sources, setSources] = useState<DraftSuggestion["sources"] | null>(null);
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

  async function handleSuggest() {
    if (!onSuggest || suggesting || sending) return;
    setSuggesting(true);
    try {
      const { draft, sources: used } = await onSuggest();
      setText(draft);
      setSources(used);
    } catch {
      // The parent surfaces the error toast; nothing to roll back here.
    } finally {
      setSuggesting(false);
    }
  }

  async function handleFixGrammar() {
    const trimmed = text.trim();
    if (!onFixGrammar || !trimmed || fixing || sending) return;
    setFixing(true);
    try {
      const corrected = await onFixGrammar(trimmed);
      setText(corrected);
    } catch {
      // The parent surfaces the error toast; the original text stays untouched.
    } finally {
      setFixing(false);
    }
  }

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
      setSources(null);
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
      {sources && (
        <p className="mt-1 text-[11px] text-violet-600">
          ✨ AI draft{sources.length > 0 && <> · based on: {sources.map((s) => s.title).join(", ")}</>} — review
          before sending
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">Enter to send, Shift+Enter for a new line</span>
        <div className="flex items-center gap-2">
          {onFixGrammar && (
            <button
              onClick={handleFixGrammar}
              disabled={disabled || sending || fixing || !text.trim()}
              title="Fix grammar, spelling and punctuation without changing your wording"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {fixing ? "Fixing…" : "Correct grammar"}
            </button>
          )}
          {onSuggest && (
            <button
              onClick={handleSuggest}
              disabled={disabled || sending || suggesting}
              title="Draft a reply from the conversation and your knowledge base"
              className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 transition hover:bg-violet-100 disabled:opacity-50"
            >
              {suggesting ? "Thinking…" : "✨ Suggest reply"}
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={disabled || sending || !text.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
