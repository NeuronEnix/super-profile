import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/time";
import type { Contact, ContactTimeline } from "../lib/types";

function pageLabel(url: string, title: string | null): string {
  if (title) return title;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash}` || u.hostname;
  } catch {
    return url;
  }
}

/** The contact's "super profile": identity, presence, browsing trail and full history. */
export function ContactPanel({
  wsId,
  contact,
  currentConversationId,
  onSelectConversation,
}: {
  wsId: string;
  contact: Contact;
  currentConversationId: string;
  onSelectConversation: (id: string) => void;
}) {
  const [timeline, setTimeline] = useState<ContactTimeline | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ContactTimeline>(`/api/v1/ws/${wsId}/contacts/${contact.id}/timeline`)
      .then((data) => {
        if (!cancelled) setTimeline(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wsId, contact.id, currentConversationId]);

  const lastSeen = timeline?.contact.lastSeenAt;

  return (
    <div className="border-b border-slate-200 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contact</h3>
      <div className="mt-2 text-sm font-medium text-slate-900">{contact.name ?? "Anonymous visitor"}</div>
      {contact.email && <div className="mt-0.5 text-xs text-slate-500">{contact.email}</div>}
      {lastSeen != null && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${Date.now() - lastSeen < 2 * 60_000 ? "bg-emerald-500" : "bg-slate-300"}`}
          />
          Last seen {relativeTime(lastSeen)}
        </div>
      )}

      {timeline && timeline.events.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Recent activity</h4>
          <ul className="mt-1.5 space-y-1">
            {timeline.events.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate text-slate-600" title={e.url}>
                  👁 {pageLabel(e.url, e.title)}
                </span>
                <span className="shrink-0 text-slate-400">{relativeTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {timeline && timeline.conversations.length > 1 && (
        <div className="mt-4">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Conversations ({timeline.conversations.length})
          </h4>
          <ul className="mt-1.5 space-y-1">
            {timeline.conversations.slice(0, 8).map((tc) => (
              <li key={tc.id}>
                <button
                  onClick={() => tc.id !== currentConversationId && onSelectConversation(tc.id)}
                  className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] ${
                    tc.id === currentConversationId
                      ? "bg-indigo-50 font-medium text-indigo-700"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="mr-1">{tc.channel === "EMAIL" ? "✉️" : "💬"}</span>
                  {tc.subject || tc.lastMessagePreview || "Conversation"}
                  <span className="ml-1 text-slate-400">· {relativeTime(tc.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
