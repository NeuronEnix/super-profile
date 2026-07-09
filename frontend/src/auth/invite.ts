import { api } from "../lib/api";

const KEY = "sp_pending_invite_token";

export function stashPendingInvite(token: string) {
  sessionStorage.setItem(KEY, token);
}

export function takePendingInvite(): string | null {
  const token = sessionStorage.getItem(KEY);
  if (token) sessionStorage.removeItem(KEY);
  return token;
}

export function acceptInvite(token: string): Promise<{ workspace: { id: string; name: string; slug: string } }> {
  return api("/api/v1/auth/invite-accept", { method: "POST", body: { token } });
}
