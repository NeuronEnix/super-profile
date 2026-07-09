import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import Shell from "./components/Shell";
import Login from "./pages/Login";
import Verify from "./pages/Verify";
import InviteAccept from "./pages/InviteAccept";
import CreateWorkspace from "./pages/CreateWorkspace";
import InboxPage from "./inbox/InboxPage";
import KbAdminPage from "./kb/KbAdminPage";
import SettingsPage from "./settings/SettingsPage";
import WidgetApp from "./widget/WidgetApp";

function FullscreenSpinner() {
  return <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">Loading…</div>;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullscreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RootLanding() {
  const { loading, workspaces } = useAuth();
  if (loading) return <FullscreenSpinner />;
  if (workspaces.length === 0) return <CreateWorkspace />;
  return <Navigate to={`/w/${workspaces[0].id}`} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<Verify />} />
      <Route path="/invite" element={<InviteAccept />} />
      <Route path="/widget-app" element={<WidgetApp />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <RootLanding />
          </RequireAuth>
        }
      />
      <Route
        path="/w/:wsId"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<InboxPage />} />
        <Route path="kb" element={<KbAdminPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
