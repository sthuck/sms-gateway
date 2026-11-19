import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, createApiClient, startLoginRedirect, type ApiClient } from "../api/client";
import type { Me } from "../api/types";

type AuthStatus = "loading" | "authenticated" | "anonymous" | "boot_error";

type AuthContextValue = {
  status: AuthStatus;
  user: Me | null;
  bootError: string | null;
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
  const [bootError, setBootError] = useState<string | null>(null);
  const userRef = useRef<Me | null>(null);
  userRef.current = user;

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
    setBootError(null);
    try {
      const me = await api.get<Me>("/v1/auth/me");
      setUser(me);
      setStatus("authenticated");
      setBootError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setStatus("anonymous");
        setBootError(null);
        return;
      }

      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not reach the server.";

      if (userRef.current) {
        setStatus("authenticated");
        return;
      }

      setStatus("boot_error");
      setBootError(message);
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
      bootError,
      api,
      refresh,
      logout,
      login: startLoginRedirect,
    }),
    [status, user, bootError, api, refresh, logout],
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
