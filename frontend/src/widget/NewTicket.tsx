import { useState, type FormEvent } from "react";
import type { Contact } from "../lib/types";

export function NewTicket({
  contact,
  widgetColor,
  onBack,
  onCreate,
}: {
  contact: Contact | null;
  widgetColor: string;
  onBack: () => void;
  onCreate: (body: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const needsProfile = !contact?.name && !contact?.email;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await onCreate(message.trim());
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
          <p className="text-xs text-slate-500">
            Optional: share your name or email so we can follow up if you leave.
          </p>
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
