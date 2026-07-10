import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { matchCanned } from "../lib/canned";
import type { CannedResponse } from "../lib/types";

export type DraftSuggestion = { draft: string; sources: { id: string; title: string; slug: string }[] };

export function Composer({
  onSend,
  onTyping,
  onSuggest,
  onFixGrammar,
  disabled,
  placeholder = "Reply…",
  canned,
}: {
  onSend: (text: string) => Promise<void> | void;
  onTyping?: () => void;
  onSuggest?: () => Promise<DraftSuggestion>;
  onFixGrammar?: (text: string) => Promise<string>;
  disabled?: boolean;
  placeholder?: string;
  canned?: CannedResponse[];
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [cannedIdx, setCannedIdx] = useState(0);
  const [autoFix, setAutoFix] = useState(() => localStorage.getItem("sp_composer_autofix") === "1");

  function toggleAutoFix() {
    setAutoFix((prev) => {
      localStorage.setItem("sp_composer_autofix", prev ? "0" : "1");
      return !prev;
    });
  }
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
    let trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      if (autoFix && onFixGrammar) {
        try {
          trimmed = await onFixGrammar(trimmed);
          setText(trimmed); // show what's actually being sent
        } catch {
          // AI down must never block sending — fall back to the original text.
        }
      }
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

  const cannedOpen = !!canned && canned.length > 0 && text.startsWith("/");
  const cannedMatches = cannedOpen ? matchCanned(canned!, text.slice(1)) : [];

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (cannedOpen && cannedMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCannedIdx((i) => (i + 1) % cannedMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCannedIdx((i) => (i - 1 + cannedMatches.length) % cannedMatches.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        setText(cannedMatches[Math.min(cannedIdx, cannedMatches.length - 1)].body);
        setCannedIdx(0);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        setCannedIdx(0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="relative">
        {cannedOpen && cannedMatches.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-100 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
              Canned responses — ↑↓ then Enter
            </div>
            {cannedMatches.map((r, i) => (
              <button
                key={r.id}
                onMouseEnter={() => setCannedIdx(i)}
                onClick={() => {
                  setText(r.body);
                  setCannedIdx(0);
                }}
                className={`block w-full px-3 py-2 text-left ${
                  i === Math.min(cannedIdx, cannedMatches.length - 1) ? "bg-indigo-50" : ""
                }`}
              >
                <div className="text-xs font-medium text-slate-800">{r.title}</div>
                <div className="truncate text-[11px] text-slate-500">{r.body}</div>
              </button>
            ))}
          </div>
        )}
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
      </div>
      {sources && (
        <p className="mt-1 text-[11px] text-violet-600">
          ✨ AI draft{sources.length > 0 && <> · based on: {sources.map((s) => s.title).join(", ")}</>} — review
          before sending
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          {canned ? "Enter to send · Shift+Enter new line · / canned replies" : "Enter to send, Shift+Enter for a new line"}
        </span>
        <div className="flex items-center gap-2">
          {canned && canned.length > 0 && (
            <button
              onClick={() => setText("/")}
              disabled={disabled}
              title="Insert a canned response (or just type / in the reply box)"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              ⚡ Canned
            </button>
          )}
          {onFixGrammar && (
            <button
              onClick={toggleAutoFix}
              disabled={disabled}
              title="Automatically correct grammar every time you send"
              aria-pressed={autoFix}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                autoFix
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${autoFix ? "bg-emerald-500" : "bg-slate-300"}`} />
              Auto-fix on send
            </button>
          )}
          {onFixGrammar && (
            <button
              onClick={handleFixGrammar}
              disabled={disabled || sending || fixing || !text.trim()}
              title="Fix grammar, spelling, punctuation and capitalization without changing your wording"
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
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
