import type { Channel, Conversation, ConversationStatus, Member } from "../lib/types";

export type Filters = { channel?: Channel; status: ConversationStatus; assigneeId?: string };

const STATUS_TABS: { label: string; value: ConversationStatus }[] = [
  { label: "Open", value: "OPEN" },
  { label: "Snoozed", value: "SNOOZED" },
  { label: "Resolved", value: "RESOLVED" },
];

function relativeTime(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function ConversationList({
  conversations,
  filters,
  onFiltersChange,
  members,
  selectedId,
  onSelect,
  currentUserId,
}: {
  conversations: Conversation[];
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  members: Member[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentUserId: string | undefined;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex gap-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => onFiltersChange({ ...filters, status: tab.value })}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                filters.status === tab.value
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <select
            value={filters.channel ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, channel: (e.target.value as Channel) || undefined })}
            className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
          >
            <option value="">All channels</option>
            <option value="CHAT">Chat</option>
            <option value="EMAIL">Email</option>
          </select>
          <select
            value={filters.assigneeId ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, assigneeId: e.target.value || undefined })}
            className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
          >
            <option value="">Everyone</option>
            {currentUserId && <option value={currentUserId}>Me</option>}
            <option value="unassigned">Unassigned</option>
            {members
              .filter((m) => m.userId !== currentUserId)
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email ?? m.userId}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="p-6 text-center text-xs text-slate-400">No conversations here.</div>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`block w-full border-b border-slate-100 px-3 py-2.5 text-left transition ${
              selectedId === c.id ? "bg-indigo-50" : "hover:bg-slate-50"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-slate-900">
                {c.contact.name ?? c.contact.email ?? "Anonymous visitor"}
              </span>
              <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(c.lastMessageAt)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className={`shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide ${
                  c.channel === "EMAIL" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"
                }`}
              >
                {c.channel}
              </span>
              <span className="truncate text-xs text-slate-500">{c.subject || c.lastMessagePreview}</span>
              {c.unread && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600" />}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
