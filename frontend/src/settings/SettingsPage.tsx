import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { Invite, Member, Role } from "../lib/types";

export default function SettingsPage() {
  const { wsId } = useParams();
  const { user, workspaces, refetchMe } = useAuth();
  const { showError } = useToast();
  const ws = workspaces.find((w) => w.id === wsId);
  const isAdmin = ws?.role === "ADMIN";

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [wsName, setWsName] = useState(ws?.name ?? "");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("AGENT");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const snippet = ws ? `<script src="/widget.js" data-widget-key="${ws.widgetKey}"></script>` : "";

  async function handleCopySnippet() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const load = useCallback(async () => {
    if (!wsId) return;
    const [membersData, invitesData] = await Promise.all([
      api<{ members: Member[] }>(`/api/v1/ws/${wsId}/members`),
      isAdmin ? api<{ invites: Invite[] }>(`/api/v1/ws/${wsId}/invites`) : Promise.resolve({ invites: [] }),
    ]);
    setMembers(membersData.members);
    setInvites(invitesData.invites);
  }, [wsId, isAdmin]);

  useEffect(() => {
    load().catch((err) => showError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [load, showError]);

  useEffect(() => {
    setWsName(ws?.name ?? "");
  }, [ws?.name]);

  async function handleRenameWorkspace(e: FormEvent) {
    e.preventDefault();
    if (!wsId) return;
    setBusy(true);
    try {
      await api(`/api/v1/ws/${wsId}`, { method: "PATCH", body: { name: wsName } });
      await refetchMe();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!wsId) return;
    setBusy(true);
    try {
      await api(`/api/v1/ws/${wsId}/invites`, { method: "POST", body: { email: inviteEmail, role: inviteRole } });
      setInviteEmail("");
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeInvite(id: string) {
    if (!wsId) return;
    try {
      await api(`/api/v1/ws/${wsId}/invites/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function handleRoleChange(userId: string, role: Role) {
    if (!wsId) return;
    try {
      await api(`/api/v1/ws/${wsId}/members/${userId}`, { method: "PATCH", body: { role } });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!wsId) return;
    try {
      await api(`/api/v1/ws/${wsId}/members/${userId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  if (!ws) return null;

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Manage {ws.name}'s workspace and team.</p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Install the widget</h2>
        <p className="mb-2 text-sm text-slate-500">
          Paste this before <code className="rounded bg-slate-100 px-1 py-0.5">&lt;/body&gt;</code> on any site to
          embed the chat widget:
        </p>
        <div className="flex items-start gap-2">
          <code className="flex-1 whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {snippet}
          </code>
          <button
            onClick={handleCopySnippet}
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Try it now:{" "}
          <a
            href={`/demo.html?key=${ws.widgetKey}`}
            target="_blank"
            rel="noreferrer"
            className="text-indigo-600 hover:underline"
          >
            open the demo storefront with your widget key
          </a>
          . Public knowledge base:{" "}
          <a href={`/kb/${ws.slug}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
            /kb/{ws.slug}
          </a>
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Workspace</h2>
        <form onSubmit={handleRenameWorkspace} className="flex gap-2">
          <input
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            disabled={!isAdmin}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
          />
          {isAdmin && (
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Save
            </button>
          )}
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Team members</h2>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">{m.name ?? m.email ?? m.userId}</div>
                {m.name && <div className="truncate text-xs text-slate-500">{m.email}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isAdmin ? (
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.userId, e.target.value as Role)}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                  >
                    <option value="ADMIN">ADMIN</option>
                    <option value="AGENT">AGENT</option>
                  </select>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {m.role}
                  </span>
                )}
                {isAdmin && m.userId !== user?.id && (
                  <button
                    onClick={() => handleRemoveMember(m.userId)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Invite a teammate</h2>
          <form onSubmit={handleInvite} className="flex gap-2">
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="AGENT">AGENT</option>
              <option value="ADMIN">ADMIN</option>
            </select>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Invite
            </button>
          </form>

          {invites.filter((i) => !i.acceptedAt).length > 0 && (
            <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {invites
                .filter((i) => !i.acceptedAt)
                .map((i) => (
                  <li key={i.id} className="flex items-center justify-between px-4 py-2.5">
                    <div className="text-slate-700">
                      {i.email} <span className="text-xs text-slate-400">({i.role})</span>
                    </div>
                    <button onClick={() => handleRevokeInvite(i.id)} className="text-xs text-red-600 hover:underline">
                      Revoke
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
