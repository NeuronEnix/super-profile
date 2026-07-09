import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthContext";

const navItems = [
  { to: "", label: "Inbox", end: true },
  { to: "kb", label: "Knowledge Base" },
  { to: "settings", label: "Settings" },
];

export default function Shell() {
  const { wsId } = useParams();
  const { user, workspaces, activeWs, setActiveWs, logout } = useAuth();
  const navigate = useNavigate();

  const currentWs = workspaces.find((w) => w.id === wsId) ?? activeWs;

  function handleSwitchWorkspace(e: React.ChangeEvent<HTMLSelectElement>) {
    const ws = workspaces.find((w) => w.id === e.target.value);
    if (!ws) return;
    setActiveWs(ws);
    navigate(`/w/${ws.id}`);
  }

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-sm text-slate-800">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-3">
          <select
            value={currentWs?.id ?? ""}
            onChange={handleSwitchWorkspace}
            className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-medium text-slate-900"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => (
            <NavLink
              key={item.label}
              to={`/w/${wsId}/${item.to}`}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 font-medium transition ${
                  isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <div className="mb-2 truncate text-xs text-slate-500">{user?.email}</div>
          <button
            onClick={handleLogout}
            className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-left text-slate-600 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
