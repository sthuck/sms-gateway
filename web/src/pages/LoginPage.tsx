import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { status, login } = useAuth();

  if (status === "loading") {
    return (
      <main className="page narrow">
        <p>Checking session…</p>
      </main>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/devices/pair" replace />;
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
