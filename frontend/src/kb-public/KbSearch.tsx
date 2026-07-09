import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, ApiError } from "../lib/api";
import type { KbSearchHit } from "../lib/types";

export function KbSearch({ wsSlug }: { wsSlug: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<KbSearchHit[] | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ results: KbSearchHit[] }>(
          `/api/v1/public/kb/${wsSlug}/search?q=${encodeURIComponent(q)}`,
        );
        setResults(data.results);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, wsSlug]);

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search articles…"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      {results && results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((r) => (
            <li key={r.id}>
              <Link
                to={`/kb/${wsSlug}/a/${r.slug}`}
                className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setQ("")}
              >
                {r.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {results && results.length === 0 && q.trim() && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400 shadow-lg">
          No articles found.
        </div>
      )}
    </div>
  );
}
