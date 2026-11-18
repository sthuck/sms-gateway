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

export interface OidcProvider {
  startAuthorization(): Promise<AuthorizationStart>;
  finishAuthorization(callbackUrl: URL, sealedState: string): Promise<AuthorizationResult>;
}
