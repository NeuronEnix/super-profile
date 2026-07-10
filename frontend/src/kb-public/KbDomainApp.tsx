import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { api, ApiError } from "../lib/api";
import KbHome from "./KbHome";
import KbArticle from "./KbArticle";

type HostInfo = { wsSlug: string; workspace: { name: string; widgetColor: string } };

/**
 * The whole app when served on a customer docs domain (Cloudflare for SaaS custom
 * hostname). Resolves the workspace from the Host header once, then serves the public
 * KB at `/` and articles at `/a/:slug` — no auth, no dashboard, no widget.
 */
export default function KbDomainApp() {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<HostInfo>("/api/v1/public/kb/host")
      .then(setHost)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-slate-500">
        This domain isn't connected to a help center yet.
      </div>
    );
  }
  if (!host) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<KbHome wsSlug={host.wsSlug} base="" />} />
      <Route path="/a/:slug" element={<KbArticle wsSlug={host.wsSlug} base="" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
