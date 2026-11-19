import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <main className="page">
      <h1>Home</h1>
      <p className="lede">
        Pair a phone to start forwarding SMS. Inbox and device management land in a later update.
      </p>
      <p>
        <Link to="/devices/pair" className="btn btn-primary">
          Add device
        </Link>
      </p>
    </main>
  );
}
