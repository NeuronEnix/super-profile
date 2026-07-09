import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken } from "../lib/api";
import type { User, Workspace } from "../lib/types";

type AuthState = {
  user: User | null;
  workspaces: Workspace[];
  activeWs: Workspace | null;
  setActiveWs: (ws: Workspace) => void;
  loading: boolean;
  refetchMe: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWs, setActiveWsState] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const refetchMe = useCallback(async () => {
    const data = await api<{ user: User; workspaces: Workspace[] }>("/api/v1/auth/me", {
      redirectOnAuthFailure: false,
    });
    setUser(data.user);
    setWorkspaces(data.workspaces);
    setActiveWsState((prev) => data.workspaces.find((w) => w.id === prev?.id) ?? data.workspaces[0] ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refetchMe();
      } catch {
        // No valid session yet — expected for a fresh visitor.
      } finally {
        setLoading(false);
      }
    })();
  }, [refetchMe]);

  const logout = useCallback(async () => {
    await api("/api/v1/auth/logout", { method: "POST", redirectOnAuthFailure: false }).catch(() => {});
    setAccessToken(null);
    setUser(null);
    setWorkspaces([]);
    setActiveWsState(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, workspaces, activeWs, setActiveWs: setActiveWsState, loading, refetchMe, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
