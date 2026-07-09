import { useEffect, useState } from "react";
import { widgetApi } from "./widgetApi";
import type { ConversationSnapshot, KbSearchHit } from "../lib/types";

function relativeTime(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function TicketList({
  workspaceName,
  widgetColor,
  wsSlug,
  conversations,
  onSelect,
  onNewConversation,
}: {
  workspaceName: string;
  widgetColor: string;
  wsSlug: string;
  conversations: ConversationSnapshot[];
  onSelect: (id: string) => void;
  onNewConversation: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<KbSearchHit[]>([]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await widgetApi<{ results: KbSearchHit[] }>(`/api/v1/widget/suggest?q=${encodeURIComponent(q)}`);
        setResults(data.results);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="flex h-screen flex-col bg-white">
      <div className="px-4 pb-6 pt-5" style={{ backgroundColor: widgetColor }}>
        <div className="text-sm font-medium text-white/80">{workspaceName}</div>
        <div className="mt-1 text-lg font-semibold text-white">How can we help?</div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search help articles…"
          className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        {results.length > 0 && (
          <ul className="mb-3 space-y-1">
            {results.map((r) => (
              <li key={r.id}>
                <a
                  href={`/kb/${wsSlug}/a/${r.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-slate-100 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                >
                  📄 {r.title}
                </a>
              </li>
            ))}
          </ul>
        )}

        <button
          onClick={onNewConversation}
          className="mb-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50"
        >
          + New conversation
        </button>

        {conversations.length === 0 ? (
          <div className="mt-8 text-center text-xs text-slate-400">
            No conversations yet — start one above.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className="block w-full rounded-lg border border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">
                      {c.subject || "Conversation"}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">{relativeTime(c.lastMessageAt)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">{c.lastMessagePreview}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
