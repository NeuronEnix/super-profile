import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { KbSyncSource } from "../lib/types";

function remainingText(lastSyncedAt: number | null, cooldownMin: number): string | null {
  if (!lastSyncedAt) return null;
  const ms = lastSyncedAt + cooldownMin * 60_000 - Date.now();
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const CHIP: Record<KbSyncSource["status"], { label: string; className: string }> = {
  RUNNING: { label: "Syncing…", className: "bg-indigo-100 text-indigo-700" },
  DONE: { label: "Synced", className: "bg-emerald-100 text-emerald-700" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-700" },
};

/** Imports an existing public docs site into this KB: paste a URL, hit Sync, watch it fill.
 * Progress comes from polling the D1-backed status row (the DO write-throughs). */
export function KbSyncPanel({ wsId }: { wsId: string }) {
  const { showError } = useToast();
  const [source, setSource] = useState<KbSyncSource | null>(null);
  const [cooldownMin, setCooldownMin] = useState(1440);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ source: KbSyncSource | null; cooldownMin: number }>(`/api/v1/ws/${wsId}/kb/sync`);
      setSource(data.source);
      setCooldownMin(data.cooldownMin);
      setLoaded(true);
      return data.source;
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
      return null;
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 2s while a sync runs so the counters tick live.
  useEffect(() => {
    if (source?.status !== "RUNNING") return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [source?.status, load]);

  async function handleSync() {
    const value = (url || source?.url || "").trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      const data = await api<{ source: KbSyncSource }>(`/api/v1/ws/${wsId}/kb/sync`, {
        method: "POST",
        body: { url: value },
      });
      setSource(data.source);
      setUrl("");
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;
  const cooldown = source?.status === "DONE" ? remainingText(source.lastSyncedAt, cooldownMin) : null;
  const running = source?.status === "RUNNING";

  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-slate-400">📥</span>
        <span className="font-medium text-slate-700">Docs import</span>
        {source ? (
          <span className="flex items-center gap-1.5">
            <span className="max-w-[220px] truncate font-mono text-slate-600">{source.url}</span>
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${CHIP[source.status].className}`}>
              {running ? `Syncing… ${source.pagesImported} imported` : CHIP[source.status].label}
            </span>
            {source.status === "DONE" && (
              <span className="text-slate-400">
                {source.pagesImported} article{source.pagesImported === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-400">not set up — import your existing docs site</span>
        )}
        <span className="ml-auto text-slate-400">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 px-3 py-3">
          {running && (
            <p className="mb-2 text-[11px] text-indigo-700">
              Crawling… found {source!.pagesFound} · imported {source!.pagesImported} · failed {source!.pagesFailed}
            </p>
          )}
          {source?.status === "FAILED" && source.error && (
            <p className="mb-2 text-[11px] text-red-600">{source.error}</p>
          )}
          {source?.status === "DONE" && (
            <p className="mb-2 text-[11px] text-slate-500">
              Imported {source.pagesImported} of {source.pagesFound} pages
              {source.pagesFailed > 0 ? ` (${source.pagesFailed} failed)` : ""} ·{" "}
              {source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : ""}
            </p>
          )}
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSync()}
              placeholder={source?.url ?? "https://docs.yourcompany.com"}
              className="flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
            <button
              onClick={handleSync}
              disabled={saving || running || !!cooldown || (!url.trim() && !source?.url)}
              title={cooldown ? `Next sync available in ${cooldown}` : undefined}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Starting…" : running ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            {cooldown
              ? `Next sync available in ${cooldown}.`
              : "We crawl up to 10 pages of your public docs and import them as published articles. "}
            {!cooldown && "Re-syncing updates previously imported articles; articles you wrote here are never touched."}
          </p>
        </div>
      )}
    </div>
  );
}
