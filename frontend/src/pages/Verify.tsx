import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, ApiError, setAccessToken } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { acceptInvite, takePendingInvite } from "../auth/invite";
import type { User } from "../lib/types";

export default function Verify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refetchMe } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const token = params.get("token");
    if (!token) {
      setError("Missing verification token.");
      return;
    }

    (async () => {
      try {
        const data = await api<{ accessToken: string; user: User }>("/api/v1/auth/verify", {
          method: "POST",
          body: { token },
          redirectOnAuthFailure: false,
        });
        setAccessToken(data.accessToken);
        await refetchMe();

        const pendingInvite = takePendingInvite();
        if (pendingInvite) {
          try {
            const { workspace } = await acceptInvite(pendingInvite);
            await refetchMe();
            navigate(`/w/${workspace.id}`, { replace: true });
            return;
          } catch {
            // Invite failed (expired/wrong email) — fall through to normal landing.
          }
        }
        navigate("/", { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "This link is invalid or has expired.");
      }
    })();
  }, [params, navigate, refetchMe]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <>
            <h1 className="mb-1 text-lg font-semibold text-slate-900">Sign-in failed</h1>
            <p className="text-sm text-slate-500">{error}</p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
