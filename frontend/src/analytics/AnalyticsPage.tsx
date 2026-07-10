import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";

type Analytics = {
  days: number;
  totals: { conversations: number; open: number; resolved: number; resolutionRate: number | null };
  firstResponse: { medianMin: number | null; avgMin: number | null };
  resolution: { medianMin: number | null };
  channels: { chat: number; email: number };
  ai: { conversations: number; resolvedAlone: number; deflectionRate: number | null };
  volumeByDay: { day: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  agents: { userId: string; name: string; replies: number; assigned: number; resolved: number }[];
};

function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function fmtPct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
}

export default function AnalyticsPage() {
  const { wsId } = useParams();
  const { showError } = useToast();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!wsId) return;
    api<{ analytics: Analytics }>(`/api/v1/ws/${wsId}/analytics?days=${days}`)
      .then((d) => setData(d.analytics))
      .catch((err) => showError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [wsId, days, showError]);

  if (!data) return <div className="p-6 text-sm text-slate-400">Loading analytics…</div>;

  const maxDay = Math.max(1, ...data.volumeByDay.map((d) => d.count));
  const maxHour = Math.max(1, ...data.busiestHours.map((h) => h.count));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Analytics</h1>
        <div className="flex gap-1">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                days === d ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Conversations" value={String(data.totals.conversations)} hint={`${data.totals.open} open`} />
        <StatCard label="Median first response" value={fmtMin(data.firstResponse.medianMin)} hint={`avg ${fmtMin(data.firstResponse.avgMin)}`} />
        <StatCard label="Resolution rate" value={fmtPct(data.totals.resolutionRate)} hint={`${data.totals.resolved} resolved · median ${fmtMin(data.resolution.medianMin)}`} />
        <StatCard label="AI deflection" value={fmtPct(data.ai.deflectionRate)} hint={`${data.ai.resolvedAlone}/${data.ai.conversations} resolved by AI alone`} />
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Message volume — last {data.days} days</h2>
        {data.volumeByDay.every((d) => d.count === 0) ? (
          <p className="py-6 text-center text-xs text-slate-400">No messages in this window yet.</p>
        ) : (
          <div className="flex h-32 items-end gap-1">
            {data.volumeByDay.map((d) => (
              <div key={d.day} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-indigo-500 transition group-hover:bg-indigo-600"
                  style={{ height: `${Math.max(2, (d.count / maxDay) * 120)}px` }}
                  title={`${d.day}: ${d.count} messages`}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Busiest hours (UTC)</h2>
        <div className="flex gap-1">
          {data.busiestHours.map((h) => (
            <div key={h.hour} className="flex-1 text-center">
              <div
                className="mx-auto w-full rounded-sm bg-indigo-500"
                style={{ opacity: h.count === 0 ? 0.08 : 0.25 + 0.75 * (h.count / maxHour), height: "28px" }}
                title={`${h.hour}:00 — ${h.count} messages`}
              />
              {h.hour % 6 === 0 && <div className="mt-1 text-[9px] text-slate-400">{h.hour}</div>}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Agent performance</h2>
        {data.agents.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">No agent replies in this window yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="pb-2 font-medium">Agent</th>
                <th className="pb-2 font-medium">Replies</th>
                <th className="pb-2 font-medium">Assigned</th>
                <th className="pb-2 font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.userId} className="border-b border-slate-100">
                  <td className="py-2 font-medium text-slate-900">{a.name}</td>
                  <td className="py-2 text-slate-600">{a.replies}</td>
                  <td className="py-2 text-slate-600">{a.assigned}</td>
                  <td className="py-2 text-slate-600">{a.resolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[10px] text-slate-400">
          Channel split: {data.channels.chat} chat · {data.channels.email} email
        </p>
      </section>
    </div>
  );
}
