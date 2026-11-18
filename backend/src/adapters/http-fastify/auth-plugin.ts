import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { Pool, PoolClient } from "pg";
import type { ResolveBearer } from "../../application/use-cases/resolve-bearer.js";
import type { ResolveSession } from "../../application/use-cases/resolve-session.js";
import { AuthError } from "../../domain/auth/errors.js";
import type { Session } from "../../domain/auth/types.js";
import type { JwtVerifier } from "../../ports/outbound/jwt-verifier.js";
import type { OidcProvider } from "../../ports/outbound/oidc-provider.js";
import type { OidcAuthConfig } from "../auth-oidc/oidc-config.js";
import { withOwner } from "../db-postgres/with-owner.js";
import { allowedOriginsFromConfig, csrfTokensMatch, isSafeMethod, originAllowed } from "./csrf.js";
import { sendProblem } from "./problems.js";
import type {
  CompleteLogin,
  GetMe,
  Logout,
  StartLogin,
} from "../../application/use-cases/index.js";

export type AuthRequestContext = {
  ownerId: string;
  authMethod: "session" | "bearer";
  session: Session | null;
};

export type AuthUseCases = {
  startLogin: StartLogin;
  completeLogin: CompleteLogin;
  logout: Logout;
  getMe: GetMe;
  resolveSession: ResolveSession;
  resolveBearer: ResolveBearer;
};

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
  jwtVerifier?: JwtVerifier | null | undefined;
  oidcProvider?: OidcProvider | null | undefined;
  useCases?: AuthUseCases | null | undefined;
  /** @deprecated tests may still pass oidcClient; prefer oidcProvider */
  oidcClient?: OidcProvider | null | undefined;
  skipDiscovery?: boolean | undefined;
};

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  await app.register(cookie);

  const oidcProvider = opts.oidcProvider ?? opts.oidcClient ?? null;

  app.decorate("authConfig", opts.config);
  app.decorate("dbPool", opts.pool);
  app.decorate("oidcProvider", oidcProvider);
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
 * Authenticate via session cookie or Authorization: Bearer JWT, then expose
 * `request.ownerId` and `request.withOwner`. Device-signed requests are not
 * accepted here (see `requireDeviceAuth`); agent routes remain separate.
 */
export async function requireUserAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

  if (!useCases) {
    sendProblem(reply, "auth_misconfigured", 503, "Auth use cases are not configured", {
      retryable: true,
      instance: request.url,
    });
    return;
  }

  const bearer = extractBearer(request.headers.authorization);
  if (bearer) {
    try {
      const resolved = await useCases.resolveBearer.execute({ token: bearer });
      bindAuth(request, pool, {
        ownerId: resolved.ownerId,
        authMethod: "bearer",
        session: null,
      });
    } catch (err) {
      mapAuthError(reply, request, err, "Missing or invalid access token");
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

  let resolved;
  try {
    resolved = await useCases.resolveSession.execute({ sessionId });
  } catch (err) {
    mapAuthError(reply, request, err, "Session expired or revoked");
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
      expiresAt: new Date(0),
      revokedAt: null,
    },
  });
}

function mapAuthError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: unknown,
  fallbackDetail: string,
): void {
  if (err instanceof AuthError) {
    if (err.code === "mfa_required") {
      sendProblem(reply, "mfa_required", 401, err.message, { instance: request.url });
      return;
    }
    sendProblem(reply, "unauthorized", 401, err.message, { instance: request.url });
    return;
  }
  sendProblem(reply, "unauthorized", 401, fallbackDetail, { instance: request.url });
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
