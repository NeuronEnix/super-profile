import { useParams } from "react-router";
import { useAuth } from "../auth/AuthContext";

export default function InboxPage() {
  const { wsId } = useParams();
  const { workspaces } = useAuth();
  const ws = workspaces.find((w) => w.id === wsId);

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-slate-900">{ws?.name ?? "Inbox"}</h1>
      <p className="mt-1 text-sm text-slate-500">Conversation list and ticket view land in Task 8.</p>
    </div>
  );
}
