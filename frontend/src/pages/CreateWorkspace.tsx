import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { Workspace } from "../lib/types";

/** Each rule ticks green the moment the handle satisfies it — live, as the user types. */
function handleRules(v: string): { label: string; ok: boolean }[] {
  return [
    { label: "Lowercase letters, numbers, dots and hyphens only", ok: v.length > 0 && /^[a-z0-9.-]+$/.test(v) },
    { label: "Starts with a letter", ok: /^[a-z]/.test(v) },
    { label: "Doesn't end with a dot or hyphen", ok: v.length > 0 && /[a-z0-9]$/.test(v) },
    { label: "Between 2 and 40 characters", ok: v.length >= 2 && v.length <= 40 },
  ];
}

function Rule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? "text-emerald-600" : "text-slate-400"}`}>
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          ok ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"
        }`}
      >
        {ok ? "✓" : "○"}
      </span>
      {label}
    </li>
  );
}

export default function CreateWorkspace() {
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(false);
  const { refetchMe, workspaces } = useAuth();
  const { showError } = useToast();
  const navigate = useNavigate();
  const hasWorkspaces = workspaces.length > 0;

  const rules = handleRules(slug);
  const slugValid = rules.every((r) => r.ok);
  const canSubmit = slugValid && !loading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      const { workspace } = await api<{ workspace: Workspace }>("/api/v1/workspaces", {
        method: "POST",
        body: { slug },
      });
      await refetchMe();
      navigate(`/w/${workspace.id}`, { replace: true });
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">
          {hasWorkspaces ? "Create a new workspace" : "Create your workspace"}
        </h1>
        <p className="mb-6 text-sm text-slate-500">This is where your team and customer conversations live.</p>

        <label className="mb-1 block text-xs font-medium text-slate-600">Workspace handle</label>
        <input
          required
          autoFocus
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="acme"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={slug.length > 0 && !slugValid}
          className={`w-full rounded-lg border px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-1 ${
            slug.length > 0 && !slugValid
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
        />
        <p className="mt-1.5 text-xs text-slate-400">
          Used for email and links, e.g. <span className="font-mono">{slug || "acme"}@inbox.hyugorix.com</span>
        </p>

        <ul className="mt-3 space-y-1 text-xs">
          {rules.map((r) => (
            <Rule key={r.label} ok={r.ok} label={r.label} />
          ))}
        </ul>

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-5 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? "Creating…" : "Create workspace"}
        </button>
        {hasWorkspaces && (
          <button
            type="button"
            onClick={() => navigate(`/w/${workspaces[0].id}`)}
            className="mt-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
