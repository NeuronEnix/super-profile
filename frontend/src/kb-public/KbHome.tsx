import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { KbSearch } from "./KbSearch";

type PublicArticleRef = { title: string; slug: string; excerpt: string };
type PublicCollection = { id: string; name: string; slug: string; description: string; articles: PublicArticleRef[] };
type PublicKb = {
  workspace: { name: string; widgetColor: string };
  collections: PublicCollection[];
  uncategorized: PublicArticleRef[];
};

function ArticleCard({ article, base }: { article: PublicArticleRef; base: string }) {
  return (
    <Link
      to={`${base}/a/${article.slug}`}
      className="block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
    >
      <h3 className="font-semibold text-slate-900">{article.title}</h3>
      {article.excerpt && <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-slate-500">{article.excerpt}</p>}
      <span className="mt-3 inline-block text-xs font-medium text-indigo-600">Read article →</span>
    </Link>
  );
}

function CollectionSection({ title, description, articles, base }: {
  title: string;
  description?: string;
  articles: PublicArticleRef[];
  base: string;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      {articles.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {articles.map((a) => (
            <ArticleCard key={a.slug} article={a} base={base} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-400">No articles yet.</p>
      )}
    </section>
  );
}

// On the app origin this renders at /kb/:wsSlug (slug from the URL); on a customer docs
// domain KbDomainApp mounts it at / and passes the resolved slug + an empty link base.
export default function KbHome({ wsSlug: wsSlugProp, base: baseProp }: { wsSlug?: string; base?: string }) {
  const params = useParams();
  const wsSlug = wsSlugProp ?? params.wsSlug;
  const base = baseProp ?? `/kb/${wsSlug}`;
  const [data, setData] = useState<PublicKb | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wsSlug) return;
    api<PublicKb>(`/api/v1/public/kb/${wsSlug}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [wsSlug]);

  useEffect(() => {
    if (data) document.title = `${data.workspace.name} Help Center`;
  }, [data]);

  if (error) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">{error}</div>;
  }
  if (!data || !wsSlug) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="px-6 pb-14 pt-16 text-center text-white" style={{ backgroundColor: data.workspace.widgetColor }}>
        <p className="text-xs font-medium uppercase tracking-widest text-white/70">Help Center</p>
        <h1 className="mt-2 text-3xl font-semibold">{data.workspace.name}</h1>
        <p className="mt-2 text-sm text-white/80">Guides and answers from the {data.workspace.name} team</p>
        <div className="mx-auto mt-6 max-w-lg">
          <KbSearch wsSlug={wsSlug} base={base} />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        {data.collections.map((col) => (
          <CollectionSection key={col.id} title={col.name} description={col.description} articles={col.articles} base={base} />
        ))}

        {data.uncategorized.length > 0 && (
          <CollectionSection title="More articles" articles={data.uncategorized} base={base} />
        )}

        {data.collections.length === 0 && data.uncategorized.length === 0 && (
          <p className="text-center text-sm text-slate-400">No published articles yet.</p>
        )}
      </main>

      <footer className="pb-8 text-center text-xs text-slate-400">
        Powered by{" "}
        <a href="https://sp.hyugorix.com" className="font-medium text-slate-500 hover:text-indigo-600">
          Hyugorix
        </a>
      </footer>
    </div>
  );
}
