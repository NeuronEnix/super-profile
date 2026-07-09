import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Summary } from "../lib/types";

const MIN_MESSAGES_FOR_AUTO_SUMMARY = 6;

function parseLines(summary: string): { label: string; text: string }[] {
  const lines = summary
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = lines
    .map((line) => {
      const match = line.match(/^(WANTS|TRIED|STATUS):\s*(.*)$/);
      return match ? { label: match[1], text: match[2] } : null;
    })
    .filter((l): l is { label: string; text: string } => l !== null);
  return parsed.length > 0 ? parsed : [{ label: "SUMMARY", text: summary }];
}

export function SummaryPanel({ wsId, conversationId, messageCount }: { wsId: string; conversationId: string; messageCount: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSummary = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<Summary>(
          `/api/v1/ws/${wsId}/conversations/${conversationId}/summary${force ? "?force=1" : ""}`,
        );
        setSummary(data);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      } finally {
        setLoading(false);
      }
    },
    [wsId, conversationId],
  );

  useEffect(() => {
    setSummary(null);
    setError(null);
    if (messageCount >= MIN_MESSAGES_FOR_AUTO_SUMMARY) {
      fetchSummary(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, conversationId, messageCount]);

  if (messageCount < MIN_MESSAGES_FOR_AUTO_SUMMARY && !summary) {
    return null;
  }

  return (
    <div className="border-b border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">AI Summary</h3>
        {summary && !loading && (
          <button
            onClick={() => fetchSummary(true)}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800"
          >
            Regenerate
          </button>
        )}
      </div>

      {loading && <div className="mt-2 text-xs text-slate-400">Summarizing…</div>}

      {!loading && error && (
        <div className="mt-2">
          <div className="text-xs text-rose-500">{error}</div>
          <button
            onClick={() => fetchSummary(false)}
            className="mt-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-800"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="mt-2 space-y-1.5">
          {parseLines(summary.summary).map((line) => (
            <div key={line.label} className="text-xs">
              <span className="font-semibold text-slate-500">{line.label}: </span>
              <span className="text-slate-700">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
