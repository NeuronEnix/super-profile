import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { acceptInvite, stashPendingInvite } from "../auth/invite";
import { ApiError } from "../lib/api";

export default function InviteAccept() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading, refetchMe } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (loading || ran.current) return;
    const token = params.get("token");
    if (!token) {
      setError("Missing invite token.");
      return;
    }
    if (!user) {
      stashPendingInvite(token);
      navigate("/login", { replace: true });
      return;
    }
    ran.current = true;
    (async () => {
      try {
        const { workspace } = await acceptInvite(token);
        await refetchMe();
        navigate(`/w/${workspace.id}`, { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    })();
  }, [loading, user, params, navigate, refetchMe]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <>
            <h1 className="mb-1 text-lg font-semibold text-slate-900">Couldn't accept invite</h1>
            <p className="text-sm text-slate-500">{error}</p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Joining workspace…</p>
        )}
      </div>
    </div>
  );
}
