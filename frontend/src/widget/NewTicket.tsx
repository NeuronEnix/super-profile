import { useEffect, useState, type FormEvent } from "react";
import { widgetApi } from "./widgetApi";
import type { Contact, KbSearchHit } from "../lib/types";

export function NewTicket({
  contact,
  widgetColor,
  kbBase,
  onBack,
  onCreate,
}: {
  contact: Contact | null;
  widgetColor: string;
  kbBase: string;
  onBack: () => void;
  onCreate: (body: string, profile?: { name?: string; email?: string }) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<KbSearchHit[]>([]);
  const needsProfile = !contact?.name && !contact?.email;

  useEffect(() => {
    if (!message.trim() || message.trim().length < 4) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await widgetApi<{ results: KbSearchHit[] }>(
          `/api/v1/widget/suggest?q=${encodeURIComponent(message.trim())}`,
        );
        setSuggestions(data.results);
      } catch {
        setSuggestions([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [message]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      const profile = needsProfile
        ? { name: name.trim() || undefined, email: email.trim() || undefined }
        : undefined;
      await onCreate(message.trim(), profile);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      <div className="flex items-center gap-2 px-4 py-3" style={{ backgroundColor: widgetColor }}>
        <button onClick={onBack} className="text-white/90 hover:text-white" aria-label="Back">
          ←
        </button>
        <span className="text-sm font-medium text-white">New conversation</span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {needsProfile && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Optional: share your name or email so we can follow up if you leave.
            </p>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                aria-label="Your name"
                className="w-1/2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Your email"
                className="w-1/2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}
        <textarea
          autoFocus
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help?"
          rows={5}
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />

        {suggestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500">You might find these helpful:</p>
            {suggestions.map((s) => (
              <a
                key={s.id}
                href={`${kbBase}/a/${s.slug}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="block rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              >
                📄 {s.title}
              </a>
            ))}
          </div>
        )}

        <button
          type="submit"
          disabled={sending || !message.trim()}
          className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: widgetColor }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
