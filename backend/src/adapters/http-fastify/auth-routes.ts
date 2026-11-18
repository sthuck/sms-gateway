import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError } from "../../domain/auth/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { requireUserAuth } from "./auth-plugin.js";
import { sendProblem } from "./problems.js";

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
    // Match main: login needs config + OIDC client, not a DB pool (STH-46).
    const startLogin = app.authUseCases?.startLogin ?? null;
    if (!config || !startLogin) {
      return sendProblem(
        reply,
        "auth_misconfigured",
        503,
        "OIDC is not configured. Set OIDC_ISSUER_URL and related env vars.",
        { retryable: true, instance: request.url },
      );
    }

    try {
      const { redirectUrl, sealedState } = await startLogin.execute();
      reply.setCookie(config.oauthStateCookieName, sealedState, {
        ...cookieBase,
        secure: secureCookies(configAsNodeEnv()),
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
    const completeLogin = app.authUseCases?.completeLogin ?? null;
    const pool = app.dbPool;

    // Match main: callback needs config + oidc + pool.
    if (!config || !completeLogin || !pool) {
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

    try {
      const result = await completeLogin.execute({ callbackUrl, sealedState });
      const secure = secureCookies(configAsNodeEnv());

      reply.setCookie(config.sessionCookieName, result.sessionId, {
        ...cookieBase,
        secure,
        maxAge: config.sessionTtlSeconds,
      });
      reply.setCookie(config.csrfCookieName, result.csrfToken, {
        path: "/",
        httpOnly: false,
        sameSite: "lax",
        secure,
        maxAge: config.sessionTtlSeconds,
      });

      return reply.redirect(result.redirectTo);
    } catch (err) {
      if (err instanceof InfrastructureError || isInfrastructureError(err)) {
        request.log.error({ err: messageOf(err) }, "OIDC/callback infrastructure failure");
        return sendProblem(reply, "internal_error", 500, "Failed to complete login", {
          retryable: true,
          instance: request.url,
        });
      }
      if (err instanceof AuthError) {
        if (err.code === "mfa_required") {
          return sendProblem(reply, "mfa_required", 401, err.message, {
            instance: request.url,
          });
        }
        if (err.code === "invalid_callback") {
          request.log.warn({ err: err.message }, "OIDC callback rejected");
          return sendProblem(
            reply,
            "invalid_request",
            400,
            "Invalid OAuth callback (state, nonce, or code rejected)",
            { instance: request.url },
          );
        }
      }
      request.log.error({ err: messageOf(err) }, "User provisioning failed");
      return sendProblem(reply, "internal_error", 500, "Failed to complete login", {
        retryable: true,
        instance: request.url,
      });
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const config = app.authConfig;
    const logout = app.authUseCases?.logout ?? null;
    const pool = app.dbPool;
    if (!config || !logout || !pool) {
      return sendProblem(reply, "auth_misconfigured", 503, "OIDC is not configured", {
        retryable: true,
        instance: request.url,
      });
    }

    const sessionId = request.cookies[config.sessionCookieName];
    await logout.execute({ sessionId });

    reply.clearCookie(config.sessionCookieName, { path: "/" });
    reply.clearCookie(config.csrfCookieName, { path: "/" });

    return reply.status(204).send();
  });

  app.get(
    "/v1/auth/me",
    { preHandler: requireUserAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const getMe = app.authUseCases?.getMe ?? null;
      if (!request.ownerId || !request.auth || !getMe) {
        return sendProblem(reply, "unauthorized", 401, "Missing or invalid access token", {
          instance: request.url,
        });
      }

      try {
        const me = await getMe.execute({
          ownerId: request.ownerId,
          authMethod: request.auth.authMethod,
        });
        return {
          id: me.id,
          email: me.email,
          mfa_enrolled: me.mfaEnrolled,
          display_name: me.displayName,
          last_auth_method: me.lastAuthMethod,
          auth_method: me.authMethod,
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return sendProblem(reply, "unauthorized", 401, err.message, {
            instance: request.url,
          });
        }
        throw err;
      }
    },
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configAsNodeEnv(): string {
  return process.env.NODE_ENV ?? "development";
}
