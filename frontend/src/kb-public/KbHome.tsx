import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { KbSearch } from "./KbSearch";

type PublicArticleRef = { title: string; slug: string };
type PublicCollection = { id: string; name: string; slug: string; description: string; articles: PublicArticleRef[] };
type PublicKb = {
  workspace: { name: string; widgetColor: string };
  collections: PublicCollection[];
  uncategorized: PublicArticleRef[];
};

export default function KbHome() {
  const { wsSlug } = useParams();
  const [data, setData] = useState<PublicKb | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wsSlug) return;
    api<PublicKb>(`/api/v1/public/kb/${wsSlug}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [wsSlug]);

  if (error) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">{error}</div>;
  }
  if (!data || !wsSlug) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="px-6 py-10 text-center text-white" style={{ backgroundColor: data.workspace.widgetColor }}>
        <h1 className="text-2xl font-semibold">{data.workspace.name} Help Center</h1>
        <div className="mx-auto mt-4 max-w-md">
          <KbSearch wsSlug={wsSlug} />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {data.collections.map((col) => (
          <section key={col.id} className="mb-8">
            <h2 className="text-sm font-semibold text-slate-900">{col.name}</h2>
            {col.description && <p className="mt-1 text-xs text-slate-500">{col.description}</p>}
            <ul className="mt-3 space-y-1">
              {col.articles.map((a) => (
                <li key={a.slug}>
                  <Link to={`/kb/${wsSlug}/a/${a.slug}`} className="text-sm text-indigo-600 hover:underline">
                    {a.title}
                  </Link>
                </li>
              ))}
              {col.articles.length === 0 && <li className="text-xs text-slate-400">No articles yet.</li>}
            </ul>
          </section>
        ))}

        {data.uncategorized.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-slate-900">More articles</h2>
            <ul className="mt-3 space-y-1">
              {data.uncategorized.map((a) => (
                <li key={a.slug}>
                  <Link to={`/kb/${wsSlug}/a/${a.slug}`} className="text-sm text-indigo-600 hover:underline">
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.collections.length === 0 && data.uncategorized.length === 0 && (
          <p className="text-center text-sm text-slate-400">No published articles yet.</p>
        )}
      </main>
    </div>
  );
}
