import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import type { OwnerAccessToken, OwnerAccessTokenCreated, OwnerAccessTokenList } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useCreatedTokenSecret } from "../tokens/created-secret";

type ExpiryChoice = "30" | "90" | "365" | "none";

function expiryDays(choice: ExpiryChoice): number | null {
  if (choice === "none") {
    return null;
  }
  return Number(choice);
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&");
}

function buildCurlSnippet(
  token: string,
  accessHeaders: Record<string, string>,
  baseUrl: string,
): string {
  const lines = [
    `curl -sS -H "Authorization: Bearer ${escapeDoubleQuotedShell(token)}" \\`,
    ...Object.entries(accessHeaders).map(
      ([header, value]) =>
        `  -H "${escapeDoubleQuotedShell(header)}: ${escapeDoubleQuotedShell(value)}" \\`,
    ),
    `  "${escapeDoubleQuotedShell(baseUrl)}/v1/messages?limit=100"`,
  ];
  return lines.join("\n");
}

export function TokensPage() {
  const { api } = useAuth();
  const { secret, accessHeaders, showSecret, dismissSecret } = useCreatedTokenSecret();
  const [tokens, setTokens] = useState<OwnerAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.get<OwnerAccessTokenList>("/v1/tokens");
      setTokens(list.tokens);
    } catch (err) {
      setTokens([]);
      setError(err instanceof ApiError ? err.message : "Failed to load tokens.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setCreating(true);
    setError(null);
    setCopied(false);
    setCopiedCurl(false);
    try {
      const created = await api.post<OwnerAccessTokenCreated>("/v1/tokens", {
        name: trimmed,
        expires_in_days: expiryDays(expiry),
      });
      showSecret(created.token, created.access_headers);
      setName("");
      setTokens((prev) => [
        {
          id: created.id,
          name: created.name,
          created_at: created.created_at,
          last_used_at: created.last_used_at,
          expires_at: created.expires_at,
          revoked_at: created.revoked_at,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create token.");
    } finally {
      setCreating(false);
    }
  };

  const onCopy = async () => {
    if (!secret) {
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const onRevoke = async (token: OwnerAccessToken) => {
    if (token.revoked_at) {
      return;
    }
    if (!window.confirm(`Revoke token "${token.name}"? Scripts using it will get 401.`)) {
      return;
    }
    setRevokingId(token.id);
    setError(null);
    try {
      await api.delete<void>(`/v1/tokens/${token.id}`);
      setTokens((prev) =>
        prev.map((t) => (t.id === token.id ? { ...t, revoked_at: new Date().toISOString() } : t)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke token.");
    } finally {
      setRevokingId(null);
    }
  };

  const baseUrl =
    typeof window !== "undefined" && window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : "https://your-gateway.example";
  const curlSnippet =
    secret && accessHeaders ? buildCurlSnippet(secret, accessHeaders, baseUrl) : null;

  const onCopyCurl = async () => {
    if (!curlSnippet) {
      return;
    }
    try {
      await navigator.clipboard.writeText(curlSnippet);
      setCopiedCurl(true);
    } catch {
      setCopiedCurl(false);
    }
  };

  const onDismiss = () => {
    setCopied(false);
    setCopiedCurl(false);
    dismissSecret();
  };

  return (
    <main className="page wide">
      <h1>Access tokens</h1>
      <p className="lede">
        Personal access tokens for read-only API access (messages and devices). Use{" "}
        <code>Authorization: Bearer &lt;token&gt;</code> in scripts — see{" "}
        <code>docs/agent-access.md</code> in the repository.
      </p>

      {secret ? (
        <div className="banner banner-warn secret-once" role="status">
          <p>
            <strong>Copy this token now.</strong> It will not be shown again.
          </p>
          <pre className="secret-value">{secret}</pre>
          {accessHeaders ? (
            <>
              <p>
                <strong>Required tunnel access headers:</strong>
              </p>
              <pre className="secret-value" aria-label="Required access headers">
                {Object.entries(accessHeaders)
                  .map(([header, value]) => `${header}: ${value}`)
                  .join("\n")}
              </pre>
              {curlSnippet ? (
                <>
                  <p>
                    <strong>Example curl command:</strong>
                  </p>
                  <pre className="secret-value" aria-label="Example curl command">
                    {curlSnippet}
                  </pre>
                </>
              ) : null}
            </>
          ) : null}
          <div className="filters-actions">
            <button type="button" className="btn" onClick={() => void onCopy()}>
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
            {curlSnippet ? (
              <button type="button" className="btn" onClick={() => void onCopyCurl()}>
                {copiedCurl ? "Copied curl" : "Copy curl snippet"}
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <form className="filters token-create" onSubmit={(e) => void onCreate(e)}>
        <label className="filters-wide">
          Name
          <input
            type="text"
            value={name}
            maxLength={120}
            required
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. home assistant"
          />
        </label>
        <label>
          Expiry
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="none">No expiry</option>
          </select>
        </label>
        <div className="filters-actions">
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? "Creating…" : "Create token"}
          </button>
        </div>
      </form>

      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <p>Loading tokens…</p> : null}

      {!loading && tokens.length === 0 ? <p className="hint">No tokens yet.</p> : null}

      {!loading && tokens.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Expires</th>
              <th scope="col">Revoked</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{formatWhen(token.created_at)}</td>
                <td>{token.last_used_at ? formatWhen(token.last_used_at) : "—"}</td>
                <td>{token.expires_at ? formatWhen(token.expires_at) : "Never"}</td>
                <td>{token.revoked_at ? formatWhen(token.revoked_at) : "—"}</td>
                <td>
                  {!token.revoked_at ? (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={revokingId === token.id}
                      onClick={() => void onRevoke(token)}
                    >
                      {revokingId === token.id ? "Revoking…" : "Revoke"}
                    </button>
                  ) : (
                    <span className="hint">Revoked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
