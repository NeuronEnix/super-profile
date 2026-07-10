import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { KbDomain } from "../lib/types";

const STATUS_CHIP: Record<KbDomain["status"], { label: string; className: string }> = {
  ACTIVE: { label: "Active", className: "bg-emerald-100 text-emerald-700" },
  PENDING_DNS: { label: "Pending DNS", className: "bg-amber-100 text-amber-700" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-700" },
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100"
      title="Copy"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Links a customer docs domain (e.g. docs.acme.com) to this workspace's public KB.
 * Saving only records the mapping; the expanded card shows the DNS records the domain
 * owner pastes at their provider. Activation happens on our side once DNS is in place.
 */
export function DomainPanel({ wsId }: { wsId: string }) {
  const { showError } = useToast();
  const [domains, setDomains] = useState<KbDomain[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hostname, setHostname] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ domains: KbDomain[] }>(`/api/v1/ws/${wsId}/kb/domains`);
      setDomains(data.domains);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    const value = hostname.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      await api(`/api/v1/ws/${wsId}/kb/domains`, { method: "POST", body: { hostname: value } });
      setHostname("");
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  // Two-click confirm (no native dialog): first click arms, second click within 3s deletes.
  async function handleRemove(domain: KbDomain) {
    if (confirmingRemoveId !== domain.id) {
      setConfirmingRemoveId(domain.id);
      setTimeout(() => setConfirmingRemoveId((cur) => (cur === domain.id ? null : cur)), 3000);
      return;
    }
    setConfirmingRemoveId(null);
    try {
      await api(`/api/v1/ws/${wsId}/kb/domains/${domain.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  if (domains === null) return null;

  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-slate-400">🌐</span>
        <span className="font-medium text-slate-700">Docs domain</span>
        {domains.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-slate-600">{domains[0].hostname}</span>
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${STATUS_CHIP[domains[0].status].className}`}>
              {STATUS_CHIP[domains[0].status].label}
            </span>
            {domains.length > 1 && <span className="text-slate-400">+{domains.length - 1} more</span>}
          </span>
        ) : (
          <span className="text-slate-400">none connected — serve this knowledge base on your own domain</span>
        )}
        <span className="ml-auto text-slate-400">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 px-3 py-3">
          {domains.map((d) => (
            <div key={d.id} className="mb-3 rounded-md border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-800">{d.hostname}</span>
                <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${STATUS_CHIP[d.status].className}`}>
                  {STATUS_CHIP[d.status].label}
                </span>
                <button
                  onClick={() => handleRemove(d)}
                  className={`ml-auto text-[11px] ${
                    confirmingRemoveId === d.id ? "font-medium text-red-600" : "text-slate-400 hover:text-red-600"
                  }`}
                >
                  {confirmingRemoveId === d.id ? "Click again to remove" : "Remove"}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Add these records at your DNS provider. We'll finish the hookup and flip the status to
                Active once they're in place.
              </p>
              <table className="mt-2 w-full text-left text-[11px]">
                <thead>
                  <tr className="text-[10px] uppercase text-slate-400">
                    <th className="pb-1 pr-2 font-medium">Type</th>
                    <th className="pb-1 pr-2 font-medium">Name</th>
                    <th className="pb-1 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {d.records.map((r) => (
                    <tr key={r.type + r.name} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-2 font-medium text-slate-600">{r.type}</td>
                      <td className="py-1.5 pr-2">
                        <span className="flex items-center gap-1">
                          <code className="break-all text-slate-700">{r.name}</code>
                          <CopyButton value={r.name} />
                        </span>
                      </td>
                      <td className="py-1.5">
                        <span className="flex items-center gap-1">
                          <code className="break-all text-slate-700">{r.value}</code>
                          <CopyButton value={r.value} />
                        </span>
                        <div className="mt-0.5 text-[10px] text-slate-400">{r.note}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="flex gap-2">
            <input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="docs.yourcompany.com"
              className="flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
            <button
              onClick={handleAdd}
              disabled={saving || !hostname.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add domain"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
