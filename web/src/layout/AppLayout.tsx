import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          SMS Gateway
        </Link>
        <nav className="nav" aria-label="Main">
          <Link to="/inbox">Inbox</Link>
          <Link to="/devices">Devices</Link>
          <Link to="/tokens">Tokens</Link>
          <Link to="/devices/pair">Add device</Link>
        </nav>
        <div className="topbar-end">
          {user ? <span className="user-email">{user.email}</span> : null}
          <button type="button" className="btn btn-text" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
