import * as client from "openid-client";
import type { OidcAuthConfig } from "./oidc-config.js";
import { mapClaims, type MappedClaims } from "./claims.js";
import { evaluateMfa, type MfaEvaluation } from "./mfa.js";
import { sealOAuthState, openOAuthState, type OAuthDanceState } from "./oauth-state.js";

export type OidcClient = {
  configuration: client.Configuration;
  config: OidcAuthConfig;
};

/**
 * Discover the OIDC provider via `/.well-known/openid-configuration`.
 * Uses generic OIDC only — no Authentik-specific APIs.
 */
export async function createOidcClient(config: OidcAuthConfig): Promise<OidcClient> {
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

export type AuthorizationStart = {
  redirectUrl: string;
  sealedState: string;
};

export async function startAuthorization(oidc: OidcClient): Promise<AuthorizationStart> {
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
  const sealedState = await sealOAuthState(dance, oidc.config.sessionSecret);

  const redirectUrl = client.buildAuthorizationUrl(oidc.configuration, {
    redirect_uri: oidc.config.redirectUri,
    scope: oidc.config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return { redirectUrl: redirectUrl.href, sealedState };
}

export type AuthorizationResult = {
  claims: MappedClaims;
  mfa: MfaEvaluation;
  issuer: string;
};

/**
 * Complete the authorization-code + PKCE flow, validate state/nonce,
 * map claims, and evaluate MFA policy. Never logs tokens or codes.
 */
export async function finishAuthorization(
  oidc: OidcClient,
  callbackUrl: URL,
  sealedState: string,
): Promise<AuthorizationResult> {
  const dance = await openOAuthState(sealedState, oidc.config.sessionSecret);

  const tokens = await client.authorizationCodeGrant(oidc.configuration, callbackUrl, {
    pkceCodeVerifier: dance.codeVerifier,
    expectedState: dance.state,
    expectedNonce: dance.nonce,
  });

  const idClaims = tokens.claims();
  if (!idClaims) {
    throw new Error("OIDC token response missing ID token claims");
  }

  const claims = mapClaims(idClaims as Record<string, unknown>, oidc.config.claimMapping);
  const mfa = evaluateMfa(claims, oidc.config.mfa);
  const issuer = (typeof idClaims.iss === "string" && idClaims.iss) || oidc.config.issuerUrl;

  return { claims, mfa, issuer };
}
