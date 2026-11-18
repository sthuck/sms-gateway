import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import { InfrastructureError } from "../../domain/errors.js";
import type { JwtVerifier, VerifiedBearer } from "../../ports/outbound/jwt-verifier.js";
import type { OidcAuthConfig } from "./oidc-config.js";

function isJwtCredentialFailure(err: unknown): boolean {
  return (
    err instanceof joseErrors.JWTExpired ||
    err instanceof joseErrors.JWTClaimValidationFailed ||
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JOSEAlgNotAllowed
  );
}

function isJwtInfraFailure(err: unknown): boolean {
  if (err instanceof InfrastructureError) return true;
  if (err instanceof joseErrors.JWKSTimeout) return true;
  if (err instanceof TypeError) return true; // fetch failed / network
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      (msg.includes("jwks") && msg.includes("timeout"))
    ) {
      return true;
    }
  }
  return false;
}

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
      try {
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
      } catch (err) {
        if (isJwtInfraFailure(err) && !isJwtCredentialFailure(err)) {
          throw InfrastructureError.wrap(err, "JWKS or JWT infrastructure failure");
        }
        throw err;
      }
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
  let res: Response;
  try {
    res = await fetch(discoveryUrl);
  } catch (err) {
    throw InfrastructureError.wrap(err, "OIDC discovery fetch failed");
  }
  if (!res.ok) {
    throw new InfrastructureError(`OIDC discovery failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) {
    throw new Error("OIDC discovery document missing jwks_uri");
  }
  return doc.jwks_uri;
}
