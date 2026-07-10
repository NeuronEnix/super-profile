import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { CannedResponse } from "../lib/types";

export function CannedSection({ wsId }: { wsId: string }) {
  const { showError } = useToast();
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [editing, setEditing] = useState<CannedResponse | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ canned: CannedResponse[] }>(`/api/v1/ws/${wsId}/canned`);
      setItems(data.canned);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(item: CannedResponse | "new") {
    setEditing(item);
    setTitle(item === "new" ? "" : item.title);
    setBody(item === "new" ? "" : item.body);
    setTags(item === "new" ? "" : item.tags);
  }

  async function handleSave() {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    try {
      if (editing && editing !== "new") {
        await api(`/api/v1/ws/${wsId}/canned/${editing.id}`, { method: "PATCH", body: { title, body, tags } });
      } else {
        await api(`/api/v1/ws/${wsId}/canned`, { method: "POST", body: { title, body, tags } });
      }
      setEditing(null);
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Two-click confirm — no native dialogs (they block browser automation).
  async function handleDelete(id: string) {
    if (confirmingDeleteId !== id) {
      setConfirmingDeleteId(id);
      setTimeout(() => setConfirmingDeleteId((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    setConfirmingDeleteId(null);
    try {
      await api(`/api/v1/ws/${wsId}/canned/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Canned responses</h2>
          <p className="text-xs text-slate-400">Saved replies your team inserts with “/” in the composer.</p>
        </div>
        <button
          onClick={() => startEdit("new")}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
        >
          + New response
        </button>
      </div>

      {editing && (
        <div className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Refund policy)"
            maxLength={120}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="The reply text that gets inserted…"
            rows={3}
            maxLength={5000}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags, comma-separated (e.g. billing,refund)"
            maxLength={200}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy || !title.trim() || !body.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {items.length > 0 ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {items.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <button onClick={() => startEdit(r)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium text-slate-900">{r.title}</div>
                <div className="truncate text-xs text-slate-500">{r.body}</div>
                {r.tags && <div className="mt-0.5 text-[10px] text-indigo-500">{r.tags}</div>}
              </button>
              <button
                onClick={() => handleDelete(r.id)}
                className={`shrink-0 text-xs ${confirmingDeleteId === r.id ? "font-medium text-red-600" : "text-slate-400 hover:text-red-600"}`}
              >
                {confirmingDeleteId === r.id ? "Click again" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !editing && <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">No canned responses yet.</p>
      )}
    </section>
  );
}
