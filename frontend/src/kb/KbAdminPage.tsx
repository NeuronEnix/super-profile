import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { CollectionModal } from "./CollectionModal";
import { ArticleEditor } from "./ArticleEditor";
import { DomainPanel } from "./DomainPanel";
import { KbSyncPanel } from "./KbSyncPanel";
import type { KbArticle, KbCollection } from "../lib/types";

type View = { mode: "list" } | { mode: "editor"; articleId: string | null };

export default function KbAdminPage() {
  const { wsId } = useParams();
  const { showError } = useToast();
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const [editingArticle, setEditingArticle] = useState<KbArticle | null>(null);
  const [showCollectionModal, setShowCollectionModal] = useState<KbCollection | null | "new">(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | "all">("all");

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const [colData, artData] = await Promise.all([
        api<{ collections: KbCollection[] }>(`/api/v1/ws/${wsId}/kb/collections`),
        api<{ articles: KbArticle[] }>(`/api/v1/ws/${wsId}/kb/articles`),
      ]);
      setCollections(colData.collections);
      setArticles(artData.articles);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveCollection(name: string, description: string) {
    if (!wsId) return;
    try {
      if (showCollectionModal && showCollectionModal !== "new") {
        await api(`/api/v1/ws/${wsId}/kb/collections/${showCollectionModal.id}`, {
          method: "PATCH",
          body: { name, description },
        });
      } else {
        await api(`/api/v1/ws/${wsId}/kb/collections`, { method: "POST", body: { name, description } });
      }
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function openArticle(id: string) {
    if (!wsId) return;
    try {
      const { article } = await api<{ article: KbArticle }>(`/api/v1/ws/${wsId}/kb/articles/${id}`);
      setEditingArticle(article);
      setView({ mode: "editor", articleId: id });
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  function newArticle() {
    setEditingArticle(null);
    setView({ mode: "editor", articleId: null });
  }

  async function handleSaveArticle(patch: {
    title: string;
    slug: string;
    collectionId: string | null;
    bodyMd: string;
    status: "DRAFT" | "PUBLISHED";
  }) {
    if (!wsId) return;
    try {
      if (view.mode === "editor" && view.articleId) {
        await api(`/api/v1/ws/${wsId}/kb/articles/${view.articleId}`, { method: "PATCH", body: patch });
      } else {
        const { article } = await api<{ article: KbArticle }>(`/api/v1/ws/${wsId}/kb/articles`, {
          method: "POST",
          body: { title: patch.title, collectionId: patch.collectionId, bodyMd: patch.bodyMd },
        });
        if (patch.status === "PUBLISHED") {
          await api(`/api/v1/ws/${wsId}/kb/articles/${article.id}`, {
            method: "PATCH",
            body: { slug: patch.slug, status: "PUBLISHED" },
          });
        } else if (patch.slug !== article.slug) {
          await api(`/api/v1/ws/${wsId}/kb/articles/${article.id}`, { method: "PATCH", body: { slug: patch.slug } });
        }
        setView({ mode: "editor", articleId: article.id });
      }
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  if (view.mode === "editor") {
    return (
      <ArticleEditor
        article={editingArticle}
        collections={collections}
        onSave={handleSaveArticle}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }

  const filteredArticles =
    activeCollectionId === "all" ? articles : articles.filter((a) => a.collectionId === activeCollectionId);

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-slate-200 p-3">
        <button
          onClick={() => setActiveCollectionId("all")}
          className={`block w-full rounded-md px-2.5 py-1.5 text-left text-sm ${
            activeCollectionId === "all" ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          All articles
        </button>
        {collections.map((col) => (
          <button
            key={col.id}
            onClick={() => setActiveCollectionId(col.id)}
            onDoubleClick={() => setShowCollectionModal(col)}
            className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm ${
              activeCollectionId === col.id ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {col.name}
          </button>
        ))}
        <button
          onClick={() => setShowCollectionModal("new")}
          className="mt-2 block w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50"
        >
          + New collection
        </button>
      </aside>

      <div className="flex-1 p-4">
        {wsId && <DomainPanel wsId={wsId} />}
        {wsId && <KbSyncPanel wsId={wsId} />}
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">Knowledge Base</h1>
          <button
            onClick={newArticle}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
          >
            + New article
          </button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="pb-2 font-medium">Title</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filteredArticles.map((a) => (
              <tr
                key={a.id}
                onClick={() => openArticle(a.id)}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
              >
                <td className="py-2 font-medium text-slate-900">{a.title}</td>
                <td className="py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      a.status === "PUBLISHED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {a.status}
                  </span>
                </td>
                <td className="py-2 text-slate-500">{new Date(a.updatedAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {filteredArticles.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 text-center text-xs text-slate-400">
                  No articles yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showCollectionModal && (
        <CollectionModal
          initialName={showCollectionModal !== "new" ? showCollectionModal.name : undefined}
          initialDescription={showCollectionModal !== "new" ? showCollectionModal.description : undefined}
          onSave={handleSaveCollection}
          onClose={() => setShowCollectionModal(null)}
        />
      )}
    </div>
  );
}
