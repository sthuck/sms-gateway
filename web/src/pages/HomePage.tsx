import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <main className="page">
      <h1>Home</h1>
      <p className="lede">
        Pair a phone, read forwarded SMS in the inbox, manage devices, and mint read-only API tokens
        for automation.
      </p>
      <ul className="home-links">
        <li>
          <Link to="/inbox">Inbox</Link> — browse and search messages
        </li>
        <li>
          <Link to="/devices">Devices</Link> — rename or revoke paired phones
        </li>
        <li>
          <Link to="/tokens">Access tokens</Link> — personal tokens for scripts
        </li>
      </ul>
      <p>
        <Link to="/devices/pair" className="btn btn-primary">
          Add device
        </Link>
      </p>
    </main>
  );
}
