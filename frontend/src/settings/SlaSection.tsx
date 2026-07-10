import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { Workspace } from "../lib/types";

export function SlaSection({ ws }: { ws: Workspace }) {
  const { refetchMe } = useAuth();
  const { showError } = useToast();
  const [fr, setFr] = useState(ws.slaFirstResponseMin?.toString() ?? "");
  const [res, setRes] = useState(ws.slaResolutionMin?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/ws/${ws.id}`, {
        method: "PATCH",
        body: {
          slaFirstResponseMin: fr.trim() ? Number(fr) : null,
          slaResolutionMin: res.trim() ? Number(res) : null,
        },
      });
      await refetchMe();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-slate-900">SLA targets</h2>
      <p className="mb-3 text-xs text-slate-400">
        Time targets in minutes — the inbox shows countdowns and breach flags. Leave blank to turn a target off.
      </p>
      <form onSubmit={handleSave} className="flex items-end gap-3">
        <label className="text-xs text-slate-500">
          First response (min)
          <input
            type="number" min={1} max={10080} value={fr} onChange={(e) => setFr(e.target.value)}
            placeholder="off" className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          Resolution (min)
          <input
            type="number" min={1} max={10080} value={res} onChange={(e) => setRes(e.target.value)}
            placeholder="off" className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit" disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saved ? "Saved!" : "Save"}
        </button>
      </form>
    </section>
  );
}
