import type { Contact } from "../lib/types";

export function ContactPanel({ contact }: { contact: Contact }) {
  return (
    <div className="border-b border-slate-200 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contact</h3>
      <div className="mt-2 text-sm font-medium text-slate-900">{contact.name ?? "Anonymous visitor"}</div>
      {contact.email && <div className="mt-0.5 text-xs text-slate-500">{contact.email}</div>}
    </div>
  );
}
