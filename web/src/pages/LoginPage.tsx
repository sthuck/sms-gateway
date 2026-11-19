import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { status, bootError, refresh, login } = useAuth();

  if (status === "loading") {
    return (
      <main className="page narrow">
        <p>Checking session…</p>
      </main>
    );
  }

  if (status === "boot_error") {
    return (
      <main className="page narrow">
        <h1>Sign in</h1>
        <p className="banner banner-error" role="alert">
          {bootError ?? "Could not reach the server to check your session."}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
          Retry
        </button>
      </main>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="page narrow">
      <h1>Sign in</h1>
      <p className="lede">
        Sign in with your identity provider. Multi-factor authentication is required.
      </p>
      <button type="button" className="btn btn-primary" onClick={login}>
        Continue to sign in
      </button>
    </main>
  );
}
