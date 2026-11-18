import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { finishAuthorization, startAuthorization } from "../auth/oidc.js";
import { findOrProvisionUser } from "../auth/identity.js";
import { createSession, revokeSession } from "../auth/sessions.js";
import { requireUserAuth } from "../auth/plugin.js";
import { sendProblem } from "../auth/problems.js";

const cookieBase = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
};

function secureCookies(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/auth/login", async (request, reply) => {
    const config = app.authConfig;
    const oidc = app.oidcClient;
    if (!config || !oidc) {
      return sendProblem(
        reply,
        "auth_misconfigured",
        503,
        "OIDC is not configured. Set OIDC_ISSUER_URL and related env vars.",
        { retryable: true, instance: request.url },
      );
    }

    try {
      const { redirectUrl, sealedState } = await startAuthorization(oidc);
      reply.setCookie(config.oauthStateCookieName, sealedState, {
        ...cookieBase,
        secure: secureCookies(configAsNodeEnv(app)),
        maxAge: 600,
      });
      return reply.redirect(redirectUrl);
    } catch (err) {
      request.log.error({ err: messageOf(err) }, "OIDC login start failed");
      return sendProblem(reply, "internal_error", 500, "Failed to start login", {
        retryable: true,
        instance: request.url,
      });
    }
  });

  app.get("/v1/auth/callback", async (request, reply) => {
    const config = app.authConfig;
    const oidc = app.oidcClient;
    const pool = app.dbPool;

    if (!config || !oidc || !pool) {
      return sendProblem(reply, "auth_misconfigured", 503, "OIDC is not configured", {
        retryable: true,
        instance: request.url,
      });
    }

    const sealedState = request.cookies[config.oauthStateCookieName];
    reply.clearCookie(config.oauthStateCookieName, { path: "/" });

    if (!sealedState) {
      return sendProblem(reply, "invalid_request", 400, "Missing OAuth state cookie", {
        instance: request.url,
      });
    }

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(config.redirectUri);
      const incoming = new URL(request.url, config.redirectUri);
      callbackUrl.search = incoming.search;
    } catch {
      return sendProblem(reply, "invalid_request", 400, "Invalid callback URL", {
        instance: request.url,
      });
    }

    let result;
    try {
      result = await finishAuthorization(oidc, callbackUrl, sealedState);
    } catch (err) {
      request.log.warn({ err: messageOf(err) }, "OIDC callback rejected");
      return sendProblem(
        reply,
        "invalid_request",
        400,
        "Invalid OAuth callback (state, nonce, or code rejected)",
        { instance: request.url },
      );
    }

    if (!result.mfa.ok) {
      return sendProblem(reply, "mfa_required", 401, result.mfa.reason, {
        instance: request.url,
      });
    }

    try {
      const user = await findOrProvisionUser(pool, result.issuer, result.claims, {
        mfaEnrolled: result.mfa.mfaSatisfied,
        lastAuthMethod: result.mfa.method,
        autoLinkByEmail: config.autoLinkByEmail,
      });

      const session = await createSession(pool, user.ownerId, config.sessionTtlSeconds);
      const secure = secureCookies(configAsNodeEnv(app));

      reply.setCookie(config.sessionCookieName, session.sessionId, {
        ...cookieBase,
        secure,
        maxAge: config.sessionTtlSeconds,
      });
      // CSRF double-submit cookie: readable by JS so the SPA can send x-csrf-token.
      reply.setCookie(config.csrfCookieName, session.csrfToken, {
        path: "/",
        httpOnly: false,
        sameSite: "lax",
        secure,
        maxAge: config.sessionTtlSeconds,
      });

      const destination = config.publicBaseUrl ?? "/";
      return reply.redirect(destination);
    } catch (err) {
      request.log.error({ err: messageOf(err) }, "User provisioning failed");
      return sendProblem(reply, "internal_error", 500, "Failed to complete login", {
        retryable: true,
        instance: request.url,
      });
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const config = app.authConfig;
    const pool = app.dbPool;
    if (!config || !pool) {
      return sendProblem(reply, "auth_misconfigured", 503, "OIDC is not configured", {
        retryable: true,
        instance: request.url,
      });
    }

    const sessionId = request.cookies[config.sessionCookieName];
    if (sessionId) {
      await revokeSession(pool, sessionId);
    }

    reply.clearCookie(config.sessionCookieName, { path: "/" });
    reply.clearCookie(config.csrfCookieName, { path: "/" });

    return reply.status(204).send();
  });

  app.get(
    "/v1/auth/me",
    { preHandler: requireUserAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.ownerId) {
        return sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
          instance: request.url,
        });
      }

      const me = await request.withOwner(async (client) => {
        const { rows } = await client.query<{
          id: string;
          email: string;
          mfa_enrolled: boolean;
          display_name: string | null;
          last_auth_method: string | null;
        }>(
          `SELECT id, email, mfa_enrolled, display_name, last_auth_method
           FROM users WHERE id = $1`,
          [request.ownerId],
        );
        return rows[0] ?? null;
      });

      if (!me) {
        return sendProblem(reply, "unauthorized", 401, "User not found", {
          instance: request.url,
        });
      }

      return {
        id: me.id,
        email: me.email,
        mfa_enrolled: me.mfa_enrolled,
        display_name: me.display_name,
        last_auth_method: me.last_auth_method,
        auth_method: request.auth?.authMethod ?? null,
      };
    },
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configAsNodeEnv(_app: FastifyInstance): string {
  // Prefer process NODE_ENV; auth plugin does not stash it separately.
  return process.env.NODE_ENV ?? "development";
}
