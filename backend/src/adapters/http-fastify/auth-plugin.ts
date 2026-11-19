import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { Pool, PoolClient } from "pg";
import type {
  CompleteLogin,
  CreateOwnerAccessToken,
  GetMe,
  ListOwnerAccessTokens,
  Logout,
  ResolveBearer,
  ResolveOwnerPat,
  ResolveSession,
  RevokeOwnerAccessToken,
  StartLogin,
} from "../../application/use-cases/index.js";
import { isOwnerPatFormat } from "../../domain/auth/access-token.js";
import { AuthError } from "../../domain/auth/errors.js";
import type { Session } from "../../domain/auth/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { JwtVerifier } from "../../ports/outbound/jwt-verifier.js";
import type { OidcProvider } from "../../ports/outbound/oidc-provider.js";
import type { OidcAuthConfig } from "../auth-oidc/oidc-config.js";
import { withOwner } from "../db-postgres/with-owner.js";
import { allowedOriginsFromConfig, csrfTokensMatch, isSafeMethod, originAllowed } from "./csrf.js";
import { sendProblem } from "./problems.js";

export type AuthRequestContext = {
  ownerId: string;
  authMethod: "session" | "bearer" | "pat";
  session: Session | null;
  /** Set when authMethod is `pat`. */
  patTokenId: string | null;
};

export type AuthUseCases = {
  startLogin: StartLogin | null;
  completeLogin: CompleteLogin | null;
  logout: Logout | null;
  getMe: GetMe | null;
  resolveSession: ResolveSession | null;
  resolveBearer: ResolveBearer | null;
  resolveOwnerPat: ResolveOwnerPat | null;
  createOwnerAccessToken: CreateOwnerAccessToken | null;
  listOwnerAccessTokens: ListOwnerAccessTokens | null;
  revokeOwnerAccessToken: RevokeOwnerAccessToken | null;
};

/**
 * Owner routes where a valid PAT is accepted (STH-57: default-deny elsewhere).
 * Keep in sync with `requireOwnerReadAuth` call sites.
 */
export const OWNER_PAT_READ_ALLOWLIST = [
  { method: "GET", url: "/v1/messages" },
  { method: "GET", url: "/v1/messages/:id" },
  { method: "GET", url: "/v1/devices" },
] as const;

export const PAT_READONLY_DETAIL =
  "Personal access tokens are read-only and cannot call this endpoint";

declare module "fastify" {
  interface FastifyInstance {
    authConfig: OidcAuthConfig | null;
    oidcProvider: OidcProvider | null;
    jwtVerifier: JwtVerifier | null;
    dbPool: Pool | null;
    authUseCases: AuthUseCases | null;
  }

  interface FastifyRequest {
    auth: AuthRequestContext | null;
    ownerId: string | null;
    /**
     * Run `fn` inside a transaction with `app.owner_id` set for this request's
     * authenticated owner. Throws if the request is not authenticated.
     */
    withOwner: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  }
}

export type AuthPluginOptions = {
  config: OidcAuthConfig | null;
  pool: Pool | null;
  /** Inject a pre-built JWT verifier (tests). */
  jwtVerifier?: JwtVerifier | null | undefined;
  /** Inject a pre-built OIDC provider (tests). */
  oidcProvider?: OidcProvider | null | undefined;
  useCases?: AuthUseCases | null | undefined;
  skipDiscovery?: boolean | undefined;
};

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  await app.register(cookie);

  app.decorate("authConfig", opts.config);
  app.decorate("dbPool", opts.pool);
  app.decorate("oidcProvider", opts.oidcProvider ?? null);
  app.decorate("jwtVerifier", opts.jwtVerifier ?? null);
  app.decorate("authUseCases", opts.useCases ?? null);

  app.decorateRequest("auth", null);
  app.decorateRequest("ownerId", null);
  app.decorateRequest("withOwner", null as never);

  app.addHook("onRequest", async (request) => {
    request.auth = null;
    request.ownerId = null;
    request.withOwner = async () => {
      throw new Error("withOwner called on unauthenticated request");
    };
  });
}

export const authPlugin = fp(authPluginImpl, {
  name: "sms-gateway-auth",
});

/**
 * Session cookie or OIDC Bearer JWT only. Owner PATs are rejected with 403
 * (STH-57 default-deny). Device-signed requests are not accepted here.
 */
export async function requireUserAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticateOwner(request, reply, { allowPat: false });
}

/**
 * Session, OIDC JWT, or owner PAT. Use only on the PAT read allowlist
 * (`GET /v1/messages`, `GET /v1/messages/:id`, `GET /v1/devices`).
 */
export async function requireOwnerReadAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticateOwner(request, reply, { allowPat: true });
}

/**
 * Alias of `requireUserAuth` for mutating / privileged owner routes.
 * PATs are already denied by default in `requireUserAuth`.
 */
export async function requireOwnerWriteAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireUserAuth(request, reply);
}

async function authenticateOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { allowPat: boolean },
): Promise<void> {
  const app = request.server;
  const pool = app.dbPool;
  const config = app.authConfig;
  const useCases = app.authUseCases;

  if (!pool) {
    sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
      retryable: true,
      instance: request.url,
    });
    return;
  }

  const bearer = extractBearer(request.headers.authorization);
  if (bearer) {
    if (isOwnerPatFormat(bearer)) {
      if (!useCases?.resolveOwnerPat) {
        sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
          instance: request.url,
        });
        return;
      }
      let resolved;
      try {
        resolved = await useCases.resolveOwnerPat.execute({ token: bearer });
      } catch (err) {
        mapAuthError(reply, request, err);
        return;
      }
      if (!opts.allowPat) {
        sendProblem(reply, "forbidden", 403, PAT_READONLY_DETAIL, {
          instance: request.url,
        });
        return;
      }
      bindAuth(request, pool, {
        ownerId: resolved.ownerId,
        authMethod: "pat",
        session: null,
        patTokenId: resolved.tokenId,
      });
      schedulePatTouch(pool, resolved.ownerId, resolved.tokenId, resolved.lastUsedAt);
      return;
    }

    if (!useCases?.resolveBearer) {
      // Match main: missing config/verifier → 401, not 503 (STH-46).
      sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
        instance: request.url,
      });
      return;
    }
    try {
      const resolved = await useCases.resolveBearer.execute({ token: bearer });
      bindAuth(request, pool, {
        ownerId: resolved.ownerId,
        authMethod: "bearer",
        session: null,
        patTokenId: null,
      });
    } catch (err) {
      mapAuthError(reply, request, err);
    }
    return;
  }

  if (!config) {
    sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
      instance: request.url,
    });
    return;
  }

  const sessionId = request.cookies[config.sessionCookieName];
  if (!sessionId) {
    sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
      instance: request.url,
    });
    return;
  }

  if (!useCases?.resolveSession) {
    sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
      instance: request.url,
    });
    return;
  }

  let resolved;
  try {
    resolved = await useCases.resolveSession.execute({ sessionId });
  } catch (err) {
    mapAuthError(reply, request, err);
    return;
  }

  if (!isSafeMethod(request.method)) {
    const origins = allowedOriginsFromConfig({
      publicBaseUrl: config.publicBaseUrl,
      redirectUri: config.redirectUri,
      corsAllowedOrigins: config.corsAllowedOrigins,
    });
    if (!originAllowed(request, origins)) {
      sendProblem(reply, "csrf_rejected", 403, "Origin check failed", {
        instance: request.url,
      });
      return;
    }

    const csrfCookie = request.cookies[config.csrfCookieName];
    const csrfHeader =
      typeof request.headers["x-csrf-token"] === "string"
        ? request.headers["x-csrf-token"]
        : undefined;
    if (!csrfTokensMatch(csrfCookie, csrfHeader, resolved.csrfTokenHash)) {
      sendProblem(reply, "csrf_rejected", 403, "CSRF token mismatch", {
        instance: request.url,
      });
      return;
    }
  }

  bindAuth(request, pool, {
    ownerId: resolved.ownerId,
    authMethod: "session",
    session: {
      sessionRowId: resolved.sessionRowId,
      ownerId: resolved.ownerId,
      csrfTokenHash: resolved.csrfTokenHash,
      expiresAt: resolved.expiresAt,
      revokedAt: resolved.revokedAt,
    },
    patTokenId: null,
  });

  // Best-effort last_seen update after CSRF/origin succeed (STH-46).
  void withOwner(pool, resolved.ownerId, async (client) => {
    await client.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [
      resolved.sessionRowId,
    ]);
  }).catch(() => undefined);
}

function schedulePatTouch(
  pool: Pool,
  ownerId: string,
  tokenId: string,
  lastUsedAt: Date | null,
): void {
  const throttleMs = 60_000;
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < throttleMs) {
    return;
  }
  void withOwner(pool, ownerId, async (client) => {
    await client.query(
      `UPDATE owner_access_tokens
       SET last_used_at = now()
       WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [tokenId],
    );
  }).catch(() => undefined);
}

function mapAuthError(reply: FastifyReply, request: FastifyRequest, err: unknown): void {
  // Infra / unknown non-AuthError must reach the global handler → 500 retryable (STH-46).
  // Never collapse them into unauthorized.
  if (
    err instanceof InfrastructureError ||
    isInfrastructureError(err) ||
    !(err instanceof AuthError)
  ) {
    throw err;
  }
  if (err.code === "mfa_required") {
    sendProblem(reply, "mfa_required", 401, err.message, { instance: request.url });
    return;
  }
  sendProblem(reply, "unauthorized", 401, err.message, { instance: request.url });
}

function bindAuth(request: FastifyRequest, pool: Pool, auth: AuthRequestContext): void {
  request.auth = auth;
  request.ownerId = auth.ownerId;
  request.withOwner = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withOwner(pool, auth.ownerId, fn);
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token;
}
