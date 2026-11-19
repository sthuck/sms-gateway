export type ClaimMapping = {
  email: string;
  name: string;
};

export const DEFAULT_CLAIM_MAPPING: ClaimMapping = {
  email: "email",
  name: "name",
};

export type MappedClaims = {
  sub: string;
  email: string;
  name: string | null;
  amr: string[] | null;
  acr: string | null;
  raw: Record<string, unknown>;
};

export type MfaClaimFields = {
  amr: string[] | null;
  acr: string | null;
};

export type MfaClaimsMissing = "allow" | "deny";

export type MfaPolicy = {
  requireMfa: boolean;
  claimsMissing: MfaClaimsMissing;
};

export type MfaEvaluation = {
  ok: boolean;
  mfaSatisfied: boolean;
  claimsPresent: boolean;
  method: string | null;
  reason?: string;
};

export type User = {
  id: string;
  email: string;
  mfaEnrolled: boolean;
  displayName: string | null;
  lastAuthMethod: string | null;
};

export type Session = {
  sessionRowId: string;
  ownerId: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type IdentityRecord = {
  identityId: string;
  ownerId: string;
  email: string;
  mfaEnrolled: boolean;
  displayName: string | null;
};

export type AuthMethod = "session" | "bearer" | "pat";
