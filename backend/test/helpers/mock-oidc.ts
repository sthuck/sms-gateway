import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { createHash, randomBytes } from "node:crypto";

export type MockOidcOptions = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  defaultClaims?: Record<string, unknown>;
};

type Pending = {
  codeChallenge: string;
  nonce?: string | undefined;
  state?: string | undefined;
  claims: Record<string, unknown>;
};

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export type MockEndpointFault = { status: number; body: string; contentType?: string } | null;

export type MockOidc = {
  issuer: string;
  jwksUri: string;
  baseUrl: string;
  privateKey: SigningKey;
  publicJwk: JWK;
  server: Server;
  /** Override claims for a pending authorization code (before token exchange). */
  setCodeClaims: (code: string, claims: Record<string, unknown>) => void;
  /** Force the next JWKS responses to this fault until cleared (`null`). */
  setJwksFault: (fault: MockEndpointFault) => void;
  /** Force the next /token responses to this fault until cleared (`null`). */
  setTokenFault: (fault: MockEndpointFault) => void;
  /**
   * Serve 3 RS256 keys in JWKS (simulates IdP key rotation).
   * Used by STH-50: kid-less tokens against multi-key JWKS.
   */
  setMultiKeyJwks: (enabled: boolean) => void;
  signToken: (
    claims: Record<string, unknown>,
    overrides?: { aud?: string; exp?: number; iss?: string; omitKid?: boolean; kid?: string },
  ) => Promise<string>;
  close: () => Promise<void>;
};

/**
 * Minimal OIDC provider for integration tests:
 * discovery, authorize (redirect with code), token, JWKS.
 * Never logs tokens or codes.
 */
export async function startMockOidc(options: MockOidcOptions): Promise<MockOidc> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  publicJwk.kid = "test-key";

  const rotB = await generateKeyPair("RS256");
  const rotC = await generateKeyPair("RS256");
  const publicJwkB = await exportJWK(rotB.publicKey);
  publicJwkB.alg = "RS256";
  publicJwkB.use = "sig";
  publicJwkB.kid = "kid-b";
  const publicJwkC = await exportJWK(rotC.publicKey);
  publicJwkC.alg = "RS256";
  publicJwkC.use = "sig";
  publicJwkC.kid = "kid-c";

  const pending = new Map<string, Pending>();
  let baseUrl = "";
  let jwksFault: MockEndpointFault = null;
  let tokenFault: MockEndpointFault = null;
  let multiKeyJwks = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl || "http://127.0.0.1");

    if (url.pathname === "/.well-known/openid-configuration") {
      json(res, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        jwks_uri: `${baseUrl}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email"],
      });
      return;
    }

    if (url.pathname === "/jwks") {
      if (jwksFault) {
        res.statusCode = jwksFault.status;
        res.setHeader("content-type", jwksFault.contentType ?? "application/json");
        res.end(jwksFault.body);
        return;
      }
      json(res, {
        keys: multiKeyJwks ? [publicJwk, publicJwkB, publicJwkC] : [publicJwk],
      });
      return;
    }

    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? undefined;
      const nonce = url.searchParams.get("nonce") ?? undefined;
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");

      if (clientId !== options.clientId || redirectUri !== options.redirectUri) {
        res.statusCode = 400;
        res.end("invalid_client");
        return;
      }
      if (method !== "S256" || !challenge) {
        res.statusCode = 400;
        res.end("pkce_required");
        return;
      }

      const code = randomBytes(16).toString("hex");
      pending.set(code, {
        codeChallenge: challenge,
        nonce,
        state,
        claims: { ...(options.defaultClaims ?? {}) },
      });
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", code);
      if (state) dest.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("location", dest.href);
      res.end();
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      if (tokenFault) {
        res.statusCode = tokenFault.status;
        res.setHeader("content-type", tokenFault.contentType ?? "application/json");
        res.end(tokenFault.body);
        return;
      }
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const code = params.get("code") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const redirectUri = params.get("redirect_uri");

      let clientId: string | null = params.get("client_id");
      let clientSecret: string | null = params.get("client_secret");
      const auth = req.headers.authorization;
      if (auth?.startsWith("Basic ")) {
        const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
        const [id, secret] = decoded.split(":", 2);
        clientId = id ?? null;
        clientSecret = secret ?? null;
      }

      if (clientId !== options.clientId || clientSecret !== options.clientSecret) {
        res.statusCode = 401;
        json(res, { error: "invalid_client" });
        return;
      }
      if (redirectUri !== options.redirectUri) {
        res.statusCode = 400;
        json(res, { error: "invalid_grant" });
        return;
      }

      const entry = pending.get(code);
      if (!entry) {
        res.statusCode = 400;
        json(res, { error: "invalid_grant" });
        return;
      }

      const expected = base64url(createHash("sha256").update(verifier).digest());
      if (expected !== entry.codeChallenge) {
        res.statusCode = 400;
        json(res, { error: "invalid_grant", error_description: "pkce" });
        return;
      }

      pending.delete(code);

      const claims = {
        sub: "mock-sub",
        email: "mock@example.com",
        name: "Mock User",
        amr: ["pwd", "otp"],
        ...entry.claims,
      };

      // Allow tests to clear MFA by setting amr/acr to null explicitly.
      if (Object.prototype.hasOwnProperty.call(entry.claims, "amr") && entry.claims.amr === null) {
        delete (claims as { amr?: unknown }).amr;
      }
      if (Object.prototype.hasOwnProperty.call(entry.claims, "acr") && entry.claims.acr === null) {
        delete (claims as { acr?: unknown }).acr;
      }

      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        ...claims,
        nonce: entry.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(baseUrl)
        .setAudience(options.clientId)
        .setSubject(String(claims.sub))
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);

      const accessToken = await new SignJWT({ ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(baseUrl)
        .setAudience(options.clientId)
        .setSubject(String(claims.sub))
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);

      json(res, {
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 300,
      });
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind mock OIDC server");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    issuer: baseUrl,
    jwksUri: `${baseUrl}/jwks`,
    baseUrl,
    privateKey,
    publicJwk,
    server,
    setCodeClaims(code, claims) {
      const entry = pending.get(code);
      if (!entry) {
        throw new Error("Unknown authorization code");
      }
      entry.claims = { ...claims };
    },
    setJwksFault(fault) {
      jwksFault = fault;
    },
    setTokenFault(fault) {
      tokenFault = fault;
    },
    setMultiKeyJwks(enabled) {
      multiKeyJwks = enabled;
    },
    async signToken(claims, overrides) {
      const now = Math.floor(Date.now() / 1000);
      const header: { alg: "RS256"; kid?: string } = { alg: "RS256" };
      if (!overrides?.omitKid) {
        header.kid = overrides?.kid ?? "test-key";
      }
      return new SignJWT({ ...claims })
        .setProtectedHeader(header)
        .setIssuer(overrides?.iss ?? baseUrl)
        .setAudience(overrides?.aud ?? options.clientId)
        .setSubject(String(claims.sub ?? "mock-sub"))
        .setIssuedAt(now)
        .setExpirationTime(overrides?.exp ?? now + 300)
        .sign(privateKey);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
