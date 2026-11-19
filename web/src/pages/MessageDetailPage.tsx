import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import type { OwnerMessage } from "../api/types";
import { useAuth } from "../auth/AuthContext";

export function MessageDetailPage() {
  const { messageId } = useParams<{ messageId: string }>();
  const navigate = useNavigate();
  const { api } = useAuth();
  const [message, setMessage] = useState<OwnerMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!messageId) {
      setError("Missing message id.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<OwnerMessage>(`/v1/messages/${messageId}`);
      setMessage(data);
    } catch (err) {
      setMessage(null);
      setError(err instanceof ApiError ? err.message : "Failed to load message.");
    } finally {
      setLoading(false);
    }
  }, [api, messageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = async () => {
    if (!messageId) {
      return;
    }
    if (!window.confirm("Delete this message permanently?")) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.delete<void>(`/v1/messages/${messageId}`);
      navigate("/inbox", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate("/inbox", { replace: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : "Failed to delete message.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="page wide">
      <p>
        <Link to="/inbox">← Inbox</Link>
      </p>
      <h1>Message</h1>

      {loading ? <p>Loading…</p> : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}

      {message ? (
        <article className="message-detail">
          <dl className="meta-grid">
            <div>
              <dt>Sender</dt>
              <dd>{message.sender}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{new Date(message.received_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>
                <code>{message.device_id}</code>
              </dd>
            </div>
            <div>
              <dt>Direction</dt>
              <dd>{message.direction}</dd>
            </div>
            {message.sim_slot !== null ? (
              <div>
                <dt>SIM slot</dt>
                <dd>{message.sim_slot}</dd>
              </div>
            ) : null}
          </dl>

          <section className="message-body">
            <h2>Body</h2>
            <pre className="plain-body">{message.body.trim() ? message.body : "(empty)"}</pre>
          </section>

          <p>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleting}
              onClick={() => void onDelete()}
            >
              {deleting ? "Deleting…" : "Delete message"}
            </button>
          </p>
        </article>
      ) : null}
    </main>
  );
}
