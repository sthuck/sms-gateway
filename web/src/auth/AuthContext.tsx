import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, createApiClient, startLoginRedirect, type ApiClient } from "../api/client";
import type { Me } from "../api/types";

type AuthStatus = "loading" | "authenticated" | "anonymous";

type AuthContextValue = {
  status: AuthStatus;
  user: Me | null;
  api: ApiClient;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  login: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<Me | null>(null);

  const onUnauthorized = useCallback(() => {
    setUser(null);
    setStatus("anonymous");
    navigate("/login", { replace: true });
  }, [navigate]);

  const api = useMemo(
    () =>
      createApiClient({
        onUnauthorized,
      }),
    [onUnauthorized],
  );

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<Me>("/v1/auth/me");
      setUser(me);
      setStatus("authenticated");
    } catch (err) {
      setUser(null);
      if (err instanceof ApiError && err.status === 401 && err.code === "mfa_required") {
        setStatus("anonymous");
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        setStatus("anonymous");
        return;
      }
      setStatus("anonymous");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post<void>("/v1/auth/logout");
    } catch {
      // Clear local state even if the server session was already gone.
    }
    setUser(null);
    setStatus("anonymous");
    navigate("/login", { replace: true });
  }, [api, navigate]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      api,
      refresh,
      logout,
      login: startLoginRedirect,
    }),
    [status, user, api, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
