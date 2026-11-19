import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import type { DeviceList, OwnerMessage, OwnerMessageList } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { inboxPaginationAction } from "../inbox/pagination";
import { datetimeLocalToIso, messagesListPath } from "../inbox/query";

const PAGE_LIMIT = 50;

type Filters = {
  deviceId: string;
  sender: string;
  receivedAfter: string;
  receivedBefore: string;
  q: string;
};

const emptyFilters: Filters = {
  deviceId: "",
  sender: "",
  receivedAfter: "",
  receivedBefore: "",
  q: "",
};

export function InboxPage() {
  const { api } = useAuth();
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [devices, setDevices] = useState<DeviceList["devices"]>([]);
  const [messages, setMessages] = useState<OwnerMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastPageCount, setLastPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<DeviceList>("/v1/devices?limit=100");
        setDevices(list.devices);
      } catch {
        // Device filter is optional if this fails.
      }
    })();
  }, [api]);

  const fetchPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      const path = messagesListPath({
        device_id: applied.deviceId || undefined,
        sender: applied.sender.trim() || undefined,
        received_after: datetimeLocalToIso(applied.receivedAfter),
        received_before: datetimeLocalToIso(applied.receivedBefore),
        q: applied.q.trim() || undefined,
        cursor,
        limit: PAGE_LIMIT,
      });

      const data = await api.get<OwnerMessageList>(path);
      setMessages((prev) => (replace ? data.messages : [...prev, ...data.messages]));
      setNextCursor(data.next_cursor);
      setLastPageCount(data.messages.length);
    },
    [api, applied],
  );

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchPage(undefined, true);
    } catch (err) {
      setMessages([]);
      setNextCursor(null);
      setLastPageCount(0);
      setError(err instanceof ApiError ? err.message : "Failed to load messages.");
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const onSubmitFilters = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ ...filters });
  };

  const onClearFilters = () => {
    setFilters(emptyFilters);
    setApplied(emptyFilters);
  };

  const onLoadMore = async () => {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load more messages.");
    } finally {
      setLoadingMore(false);
    }
  };

  const pagination = inboxPaginationAction({
    nextCursor,
    lastPageCount,
    limit: PAGE_LIMIT,
    searchQuery: applied.q,
  });

  return (
    <main className="page wide">
      <h1>Inbox</h1>
      <p className="lede">SMS received on your paired devices. Search may need several pages.</p>

      <form className="filters" onSubmit={onSubmitFilters}>
        <label>
          Device
          <select
            value={filters.deviceId}
            onChange={(e) => setFilters((f) => ({ ...f, deviceId: e.target.value }))}
          >
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          Sender
          <input
            type="text"
            value={filters.sender}
            maxLength={64}
            onChange={(e) => setFilters((f) => ({ ...f, sender: e.target.value }))}
            placeholder="Exact sender"
          />
        </label>
        <label>
          Received after
          <input
            type="datetime-local"
            value={filters.receivedAfter}
            onChange={(e) => setFilters((f) => ({ ...f, receivedAfter: e.target.value }))}
          />
        </label>
        <label>
          Received before
          <input
            type="datetime-local"
            value={filters.receivedBefore}
            onChange={(e) => setFilters((f) => ({ ...f, receivedBefore: e.target.value }))}
          />
        </label>
        <label className="filters-wide">
          Body contains
          <input
            type="search"
            value={filters.q}
            maxLength={200}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search plaintext body"
          />
        </label>
        <div className="filters-actions">
          <button type="submit" className="btn btn-primary">
            Apply filters
          </button>
          <button type="button" className="btn" onClick={onClearFilters}>
            Clear
          </button>
        </div>
      </form>

      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <p>Loading messages…</p> : null}

      {!loading && messages.length === 0 ? (
        <p className="hint">
          {applied.q.trim() ? "No matches on this page yet." : "No messages yet."}
        </p>
      ) : null}

      {!loading && messages.length > 0 ? (
        <ul className="message-list">
          {messages.map((m) => (
            <li key={m.id}>
              <Link to={`/inbox/${m.id}`} className="message-row">
                <span className="message-meta">
                  <strong>{m.sender}</strong>
                  <span>{formatWhen(m.received_at)}</span>
                </span>
                <span className="message-preview">
                  {m.body.trim() ? truncate(m.body, 120) : "(empty)"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {pagination ? (
        <p>
          <button
            type="button"
            className="btn"
            disabled={loadingMore}
            onClick={() => void onLoadMore()}
          >
            {loadingMore ? "Loading…" : pagination.label}
          </button>
        </p>
      ) : null}
    </main>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}
