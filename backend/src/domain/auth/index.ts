export {
  DEFAULT_CLAIM_MAPPING,
  type AuthMethod,
  type ClaimMapping,
  type IdentityRecord,
  type MappedClaims,
  type MfaClaimFields,
  type MfaClaimsMissing,
  type MfaEvaluation,
  type MfaPolicy,
  type Session,
  type User,
} from "./types.js";
export { extractMfaClaims, mapClaims } from "./claims.js";
export { detectMfaMethod, evaluateMfa } from "./mfa.js";
export { isSessionActive } from "./session.js";
export { AuthError, type AuthErrorCode } from "./errors.js";
export { InfrastructureError, isInfrastructureError } from "../errors.js";
