import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { CannedSection } from "./CannedSection";
import { SlaSection } from "./SlaSection";
import type { Invite, Member, Role } from "../lib/types";

export default function SettingsPage() {
  const { wsId } = useParams();
  const { user, workspaces, refetchMe } = useAuth();
  const { showError } = useToast();
  const ws = workspaces.find((w) => w.id === wsId);
  const isAdmin = ws?.role === "ADMIN";

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [profileName, setProfileName] = useState(user?.name ?? "");
  const [savedName, setSavedName] = useState(false);
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
    setProfileName(user?.name ?? "");
  }, [user?.name]);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    const name = profileName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api("/api/v1/auth/me", { method: "PATCH", body: { name } });
      await refetchMe();
      setSavedName(true);
      setTimeout(() => setSavedName(false), 2000);
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
        <h2 className="mb-1 text-sm font-semibold text-slate-900">Your profile</h2>
        <p className="mb-3 text-xs text-slate-400">
          Signed in as {user?.email}. Your name is shown to teammates on the conversations you handle.
        </p>
        <form onSubmit={handleSaveProfile} className="flex gap-2">
          <input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="Your name"
            maxLength={80}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !profileName.trim() || profileName.trim() === (user?.name ?? "")}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {savedName ? "Saved!" : "Save"}
          </button>
        </form>
      </section>

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

      {wsId && <CannedSection wsId={wsId} />}

      {isAdmin && ws && <SlaSection ws={ws} />}

      <section>
        <h2 className="mb-1 text-sm font-semibold text-slate-900">Workspace</h2>
        <p className="mb-3 text-xs text-slate-400">The name and handle are permanent — they can't be changed once the workspace is created.</p>
        <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-slate-500">Name</dt>
            <dd className="font-medium text-slate-900">{ws.name}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-slate-500">Handle</dt>
            <dd className="font-mono text-slate-900">{ws.slug}</dd>
          </div>
        </dl>
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
