import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from "jose";
import type { JwtVerifier, VerifiedBearer } from "../../ports/outbound/jwt-verifier.js";
import type { OidcAuthConfig } from "./oidc-config.js";

/**
 * Bearer JWT verification via JWKS (cached/rotated by jose's createRemoteJWKSet).
 * Checks iss, aud, exp, nbf, and allowed algorithms.
 */
export function createJwtVerifier(
  config: OidcAuthConfig,
  jwksUri: string,
  options?: { getKey?: JWTVerifyGetKey; allowInsecure?: boolean },
): JwtVerifier {
  const getKey =
    options?.getKey ??
    createRemoteJWKSet(new URL(jwksUri), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });

  const verifyOptions: JWTVerifyOptions = {
    issuer: config.issuerUrl,
    audience: config.audience,
    algorithms: config.allowedAlgs,
    clockTolerance: 30,
  };

  return {
    async verify(token: string): Promise<VerifiedBearer> {
      const { payload } = await jwtVerify(token, getKey, verifyOptions);
      if (typeof payload.sub !== "string" || !payload.sub) {
        throw new Error("JWT missing sub");
      }
      if (typeof payload.iss !== "string" || !payload.iss) {
        throw new Error("JWT missing iss");
      }
      return {
        payload: payload as Record<string, unknown>,
        sub: payload.sub,
        iss: payload.iss,
      };
    },
  };
}

export async function resolveJwksUri(issuerUrl: string, allowInsecure: boolean): Promise<string> {
  const discoveryUrl = new URL(
    "/.well-known/openid-configuration",
    issuerUrl.endsWith("/") ? issuerUrl : `${issuerUrl}/`,
  );
  if (discoveryUrl.protocol === "http:" && !allowInsecure) {
    throw new Error("Refusing HTTP JWKS discovery; set OIDC_ALLOW_INSECURE for local IdPs");
  }
  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) {
    throw new Error("OIDC discovery document missing jwks_uri");
  }
  return doc.jwks_uri;
}
