import * as client from "openid-client";
import { extractMfaClaims, evaluateMfa, mapClaims } from "../../domain/auth/index.js";
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
  const configuration = await client.discovery(
    new URL(config.issuerUrl),
    config.clientId,
    config.clientSecret,
    undefined,
    execute ? { execute } : undefined,
  );
  return { configuration, config };
}

export class OpenIdClientOidcProvider implements OidcProvider {
  constructor(private readonly oidc: OidcClientHandle) {}

  async startAuthorization(): Promise<AuthorizationStart> {
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
  }

  async finishAuthorization(callbackUrl: URL, sealedState: string): Promise<AuthorizationResult> {
    const dance = await openOAuthState(sealedState, this.oidc.config.sessionSecret);

    const tokens = await client.authorizationCodeGrant(this.oidc.configuration, callbackUrl, {
      pkceCodeVerifier: dance.codeVerifier,
      expectedState: dance.state,
      expectedNonce: dance.nonce,
    });

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
