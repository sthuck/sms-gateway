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

function isOidcClientProtocolError(err: unknown): boolean {
  // openid-client / oauth4webapi surface ResponseBodyError, AuthorizationResponseError, etc.
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return (
    name.includes("AuthorizationResponse") ||
    name.includes("ClientError") ||
    name.includes("OperationProcessing") ||
    name.includes("WWWAuthenticateChallenge")
  );
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
      if (isOidcClientProtocolError(err)) throw err;
      // Network / IdP down / 5xx from token endpoint → infrastructure.
      if (
        err instanceof TypeError ||
        (err instanceof Error && /fetch|network|econn|etimedout/i.test(err.message))
      ) {
        throw InfrastructureError.wrap(err, "OIDC token exchange failed");
      }
      // Preserve main behaviour for remaining openid-client rejects (bad code/state/nonce) → 400.
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
