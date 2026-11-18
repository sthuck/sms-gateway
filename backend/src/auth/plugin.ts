import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { Pool, PoolClient } from "pg";
import { withOwner } from "../db/with-owner.js";
import type { OidcAuthConfig } from "./oidc-config.js";
import { createOidcClient, type OidcClient } from "./oidc.js";
import { createJwtVerifier, resolveJwksUri, type JwtVerifier } from "./jwt.js";
import { isSessionActive, lookupSession, touchSession, type SessionRecord } from "./sessions.js";
import { resolveOwnerFromIdentity } from "./identity.js";
import { allowedOriginsFromConfig, csrfTokensMatch, isSafeMethod, originAllowed } from "./csrf.js";
import { sendProblem } from "./problems.js";
import { extractMfaClaims } from "./claims.js";
import { evaluateMfa } from "./mfa.js";

export type AuthRequestContext = {
  ownerId: string;
  authMethod: "session" | "bearer";
  session: SessionRecord | null;
};

declare module "fastify" {
  interface FastifyInstance {
    authConfig: OidcAuthConfig | null;
    oidcClient: OidcClient | null;
    jwtVerifier: JwtVerifier | null;
    dbPool: Pool | null;
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
  /** Skip remote discovery (tests supply jwtVerifier + stub oidc). */
  oidcClient?: OidcClient | null | undefined;
  skipDiscovery?: boolean | undefined;
};

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  await app.register(cookie);

  app.decorate("authConfig", opts.config);
  app.decorate("dbPool", opts.pool);
  app.decorate("oidcClient", opts.oidcClient ?? null);
  app.decorate("jwtVerifier", opts.jwtVerifier ?? null);

  app.decorateRequest("auth", null);
  app.decorateRequest("ownerId", null);
  app.decorateRequest("withOwner", null as never);

  if (opts.config && !opts.skipDiscovery) {
    try {
      if (!opts.oidcClient) {
        app.oidcClient = await createOidcClient(opts.config);
      }
      if (!opts.jwtVerifier) {
        const jwksUri = await resolveJwksUri(opts.config.issuerUrl, opts.config.allowInsecure);
        app.jwtVerifier = createJwtVerifier(opts.config, jwksUri);
      }
    } catch (err) {
      app.log.error({ err: errMessage(err) }, "OIDC discovery failed at startup");
      throw err;
    }
  } else if (opts.config && opts.skipDiscovery) {
    app.oidcClient = opts.oidcClient ?? null;
    app.jwtVerifier = opts.jwtVerifier ?? null;
  }

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Authenticate via session cookie or Authorization: Bearer JWT, then expose
 * `request.ownerId` and `request.withOwner`. Device-signed and agent routes
 * are out of scope for STH-9.
 */
export async function requireUserAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const app = request.server;
  const pool = app.dbPool;
  const config = app.authConfig;

  if (!pool) {
    sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
      retryable: true,
      instance: request.url,
    });
    return;
  }

  const bearer = extractBearer(request.headers.authorization);
  if (bearer) {
    await authenticateBearer(request, reply, bearer);
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

  const session = await lookupSession(pool, sessionId);
  if (!session || !isSessionActive(session)) {
    sendProblem(reply, "unauthorized", 401, "Session expired or revoked", {
      instance: request.url,
    });
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
    if (!csrfTokensMatch(csrfCookie, csrfHeader, session.csrfTokenHash)) {
      sendProblem(reply, "csrf_rejected", 403, "CSRF token mismatch", {
        instance: request.url,
      });
      return;
    }
  }

  bindAuth(request, pool, {
    ownerId: session.ownerId,
    authMethod: "session",
    session,
  });

  // Best-effort last_seen update; ignore failures.
  void withOwner(pool, session.ownerId, async (client) => {
    await touchSession(client, session.sessionRowId);
  }).catch(() => undefined);
}

async function authenticateBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): Promise<void> {
  const app = request.server;
  const pool = app.dbPool;
  const config = app.authConfig;
  const verifier = app.jwtVerifier;

  if (!pool || !config || !verifier) {
    sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
      instance: request.url,
    });
    return;
  }

  let verified;
  try {
    verified = await verifier.verify(token);
  } catch {
    // Never log the token.
    sendProblem(reply, "unauthorized", 401, "Missing, expired, or invalid access token", {
      instance: request.url,
    });
    return;
  }

  // MFA is independent of email/name mapping — access tokens may omit email.
  const mfa = evaluateMfa(
    extractMfaClaims(verified.payload as Record<string, unknown>),
    config.mfa,
  );
  if (!mfa.ok) {
    sendProblem(reply, "mfa_required", 401, mfa.reason ?? "MFA required", {
      instance: request.url,
    });
    return;
  }

  const user = await resolveOwnerFromIdentity(pool, verified.iss, verified.sub);
  if (!user) {
    sendProblem(reply, "unauthorized", 401, "Unknown identity", {
      instance: request.url,
    });
    return;
  }

  bindAuth(request, pool, {
    ownerId: user.ownerId,
    authMethod: "bearer",
    session: null,
  });
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
