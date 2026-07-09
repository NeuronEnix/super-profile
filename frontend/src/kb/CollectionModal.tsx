import { useState, type FormEvent } from "react";

export function CollectionModal({
  initialName,
  initialDescription,
  onSave,
  onClose,
}: {
  initialName?: string;
  initialDescription?: string;
  onSave: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(name, description);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          {initialName ? "Rename collection" : "New collection"}
        </h2>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Getting started"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          className="mt-2 w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
