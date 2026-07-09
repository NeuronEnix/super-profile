import { useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { slugify } from "../lib/slug";
import type { ArticleStatus, KbArticle, KbCollection } from "../lib/types";

type ArticlePatch = {
  title: string;
  slug: string;
  collectionId: string | null;
  bodyMd: string;
  status: ArticleStatus;
};

const TOOLBAR: { label: string; before: string; after: string }[] = [
  { label: "B", before: "**", after: "**" },
  { label: "I", before: "_", after: "_" },
  { label: "H2", before: "## ", after: "" },
  { label: "Link", before: "[", after: "](https://)" },
  { label: "List", before: "- ", after: "" },
  { label: "Code", before: "`", after: "`" },
];

export function ArticleEditor({
  article,
  collections,
  onSave,
  onBack,
}: {
  article: KbArticle | null;
  collections: KbCollection[];
  onSave: (patch: ArticlePatch) => Promise<void>;
  onBack: () => void;
}) {
  const [title, setTitle] = useState(article?.title ?? "");
  const [slug, setSlug] = useState(article?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!article);
  const [collectionId, setCollectionId] = useState(article?.collectionId ?? "");
  const [bodyMd, setBodyMd] = useState(article?.bodyMd ?? "");
  const [saving, setSaving] = useState<"draft" | "publish" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const preview = useMemo(() => renderMarkdown(bodyMd), [bodyMd]);

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function insertAtCursor(before: string, after: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = bodyMd.slice(start, end);
    const next = bodyMd.slice(0, start) + before + selected + after + bodyMd.slice(end);
    setBodyMd(next);
    requestAnimationFrame(() => {
      ta.focus();
      const cursor = start + before.length + selected.length;
      ta.setSelectionRange(cursor, cursor);
    });
  }

  async function handleSave(status: ArticleStatus) {
    setSaving(status === "PUBLISHED" ? "publish" : "draft");
    try {
      await onSave({ title, slug, collectionId: collectionId || null, bodyMd, status });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700">
          ← Back
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => handleSave("DRAFT")}
            disabled={!!saving}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {saving === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            onClick={() => handleSave("PUBLISHED")}
            disabled={!!saving}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving === "publish" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 border-b border-slate-200 px-4 py-3">
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Article title"
          className="col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium sm:col-span-1"
        />
        <select
          aria-label="Collection"
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">No collection</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          placeholder="slug"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-xs"
        />
      </div>

      <div className="flex gap-1 border-b border-slate-200 px-4 py-2">
        {TOOLBAR.map((t) => (
          <button
            key={t.label}
            onClick={() => insertAtCursor(t.before, t.after)}
            className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-2 divide-x divide-slate-200 overflow-hidden">
        <textarea
          ref={textareaRef}
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          placeholder="Write markdown here…"
          className="h-full resize-none p-4 font-mono text-sm focus:outline-none"
        />
        <div
          className="prose prose-sm h-full max-w-none overflow-y-auto p-4"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      </div>
    </div>
  );
}
