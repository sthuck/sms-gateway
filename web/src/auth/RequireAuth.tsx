import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function RequireAuth() {
  const { status, bootError, refresh } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <main className="page">
        <p>Checking session…</p>
      </main>
    );
  }

  if (status === "boot_error") {
    return (
      <main className="page">
        <h1>Could not verify session</h1>
        <p className="banner banner-error" role="alert">
          {bootError ?? "The server did not respond."}
        </p>
        <p className="hint">Your session was not cleared. Try again when the API is reachable.</p>
        <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
          Retry
        </button>
      </main>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
