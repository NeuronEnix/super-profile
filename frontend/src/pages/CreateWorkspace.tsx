import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { slugify, isValidSlug } from "../lib/slug";
import type { Workspace } from "../lib/types";

export default function CreateWorkspace() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const { refetchMe, workspaces } = useAuth();
  const { showError } = useToast();
  const navigate = useNavigate();
  const hasWorkspaces = workspaces.length > 0;

  // The handle auto-tracks the name until the user edits it directly.
  function onNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }
  function onSlugChange(value: string) {
    setSlugTouched(true);
    // Keep it in the allowed alphabet as they type; full-format validity is checked separately.
    setSlug(value.toLowerCase().replace(/[^a-z0-9.-]/g, ""));
  }

  const slugValid = slug.length >= 2 && slug.length <= 40 && isValidSlug(slug);
  const canSubmit = name.trim().length > 0 && slugValid && !loading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      const { workspace } = await api<{ workspace: Workspace }>("/api/v1/workspaces", {
        method: "POST",
        body: { name: name.trim(), slug },
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

        <label className="mb-1 block text-xs font-medium text-slate-600">Workspace name</label>
        <input
          required
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme Corp"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />

        <label className="mb-1 mt-4 block text-xs font-medium text-slate-600">Handle</label>
        <input
          required
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          placeholder="acme"
          aria-invalid={slug.length > 0 && !slugValid}
          className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-1 ${
            slug.length > 0 && !slugValid
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
        />
        {slug.length > 0 && !slugValid ? (
          <p className="mt-1 text-xs text-red-600">
            Lowercase letters, numbers, dots and hyphens. Start with a letter; don't end with a dot or hyphen (2–40 chars).
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">
            Used for email and links, e.g. <span className="font-mono">{slug || "acme"}@inbox.hyugorix.com</span>
          </p>
        )}

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
