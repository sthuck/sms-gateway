import type { MappedClaims, MfaEvaluation } from "../../domain/auth/types.js";

export type AuthorizationStart = {
  redirectUrl: string;
  sealedState: string;
};

export type AuthorizationResult = {
  claims: MappedClaims;
  mfa: MfaEvaluation;
  issuer: string;
};

/**
 * OIDC authorization code + PKCE dance.
 *
 * - Bad state/nonce/code (client/protocol): throw a non-`InfrastructureError`
 *   (mapped to invalid_callback / 400 — matches main).
 * - Discovery / token endpoint / network failures: throw `InfrastructureError` → 5xx.
 */
export interface OidcProvider {
  startAuthorization(): Promise<AuthorizationStart>;
  finishAuthorization(callbackUrl: URL, sealedState: string): Promise<AuthorizationResult>;
}
