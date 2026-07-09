import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";

type PublicArticle = { id: string; title: string; slug: string; bodyMd: string; publishedAt: number | null };

export default function KbArticle() {
  const { wsSlug, slug } = useParams();
  const [article, setArticle] = useState<PublicArticle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wsSlug || !slug) return;
    api<{ article: PublicArticle }>(`/api/v1/public/kb/${wsSlug}/articles/${slug}`)
      .then((data) => setArticle(data.article))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [wsSlug, slug]);

  if (error) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">{error}</div>;
  }
  if (!article) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-2xl px-6 py-10">
        <Link to={`/kb/${wsSlug}`} className="text-xs text-indigo-600 hover:underline">
          ← Back to Help Center
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900">{article.title}</h1>
        <div
          className="prose prose-slate mt-6 max-w-none"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(article.bodyMd) }}
        />
      </main>
    </div>
  );
}
