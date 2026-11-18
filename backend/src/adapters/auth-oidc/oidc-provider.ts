import * as client from "openid-client";
import { extractMfaClaims, evaluateMfa, mapClaims } from "../../domain/auth/index.js";
import { InfrastructureError } from "../../domain/errors.js";
import type {
  AuthorizationResult,
  AuthorizationStart,
  OidcProvider,
} from "../../ports/outbound/oidc-provider.js";
import type { OidcAuthConfig } from "./oidc-config.js";
import { openOAuthState, sealOAuthState, type OAuthDanceState } from "./oauth-state.js";

export type OidcClientHandle = {
  configuration: client.Configuration;
  config: OidcAuthConfig;
};

/**
 * Discover the OIDC provider via `/.well-known/openid-configuration`.
 * Uses generic OIDC only — no Authentik-specific APIs.
 */
export async function createOidcClient(config: OidcAuthConfig): Promise<OidcClientHandle> {
  const execute = config.allowInsecure ? [client.allowInsecureRequests] : undefined;
  try {
    const configuration = await client.discovery(
      new URL(config.issuerUrl),
      config.clientId,
      config.clientSecret,
      undefined,
      execute ? { execute } : undefined,
    );
    return { configuration, config };
  } catch (err) {
    throw InfrastructureError.wrap(err, "OIDC discovery failed");
  }
}

function httpStatusFromOidcError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "status" in cause) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const direct = (err as { status?: unknown }).status;
  return typeof direct === "number" ? direct : undefined;
}

function oidcErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Token-endpoint / transport failures → InfrastructureError (5xx).
 * Protocol / credential rejects (invalid_grant, bad state/nonce) → rethrow as-is → 400.
 */
export function isOidcTokenInfrastructureFailure(err: unknown): boolean {
  if (err instanceof InfrastructureError) return true;
  // Node fetch network failures are TypeError ("fetch failed") — classify by type, not message.
  if (err instanceof TypeError) return true;

  const code = oidcErrorCode(err);
  // Non-JSON / unexpected content-type from the token endpoint.
  if (code === "OAUTH_RESPONSE_IS_NOT_JSON") return true;

  const status = httpStatusFromOidcError(err);
  if (typeof status === "number" && status >= 500) return true;

  // Conformity failures with an HTTP 5xx Response cause (openid-client ClientError).
  if (code === "OAUTH_RESPONSE_IS_NOT_CONFORM" && typeof status === "number" && status >= 500) {
    return true;
  }

  return false;
}

export class OpenIdClientOidcProvider implements OidcProvider {
  constructor(private readonly oidc: OidcClientHandle) {}

  async startAuthorization(): Promise<AuthorizationStart> {
    try {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      const dance: OAuthDanceState = {
        state,
        nonce,
        codeVerifier,
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const sealedState = await sealOAuthState(dance, this.oidc.config.sessionSecret);

      const redirectUrl = client.buildAuthorizationUrl(this.oidc.configuration, {
        redirect_uri: this.oidc.config.redirectUri,
        scope: this.oidc.config.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });

      return { redirectUrl: redirectUrl.href, sealedState };
    } catch (err) {
      if (err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "OIDC startAuthorization failed");
    }
  }

  async finishAuthorization(callbackUrl: URL, sealedState: string): Promise<AuthorizationResult> {
    // State unseal failures are client/protocol errors (bad/missing cookie), not infra.
    const dance = await openOAuthState(sealedState, this.oidc.config.sessionSecret);

    let tokens;
    try {
      tokens = await client.authorizationCodeGrant(this.oidc.configuration, callbackUrl, {
        pkceCodeVerifier: dance.codeVerifier,
        expectedState: dance.state,
        expectedNonce: dance.nonce,
      });
    } catch (err) {
      if (isOidcTokenInfrastructureFailure(err)) {
        throw InfrastructureError.wrap(err, "OIDC token exchange failed");
      }
      // invalid_grant / invalid_client / state/nonce mismatches → protocol (400).
      throw err;
    }

    const idClaims = tokens.claims();
    if (!idClaims) {
      throw new Error("OIDC token response missing ID token claims");
    }

    const raw = idClaims as Record<string, unknown>;
    const mfa = evaluateMfa(extractMfaClaims(raw), this.oidc.config.mfa);
    const claims = mapClaims(raw, this.oidc.config.claimMapping);
    const issuer = (typeof idClaims.iss === "string" && idClaims.iss) || this.oidc.config.issuerUrl;

    return { claims, mfa, issuer };
  }
}
