import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/** Shell + nav placeholders for part B (inbox, devices, tokens). */
export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          SMS Gateway
        </Link>
        <nav className="nav" aria-label="Main">
          <Link to="/devices/pair">Add device</Link>
          {/* Part B: Inbox, Devices, Tokens */}
          <span className="nav-muted" title="Coming in a later PR">
            Inbox
          </span>
          <span className="nav-muted" title="Coming in a later PR">
            Devices
          </span>
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
