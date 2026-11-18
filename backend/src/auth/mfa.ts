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

const MFA_AMR_VALUES = new Set([
  "mfa",
  "otp",
  "totp",
  "hotp",
  "sms",
  "swk", // software key / passkey-ish
  "hwk", // hardware key
  "pop",
  "sc", // smart card
  "wia",
]);

const MFA_ACR_HINTS = [/mfa/i, /multi.?factor/i, /aal2/i, /aal3/i];

/**
 * Decide whether MFA requirements are met from amr/acr claims.
 * MFA enrolment itself is enforced in Authentik; we only check claims.
 */
export function evaluateMfa(
  claims: { amr: string[] | null; acr: string | null },
  policy: MfaPolicy,
): MfaEvaluation {
  const claimsPresent = claims.amr !== null || claims.acr !== null;
  const method = detectMfaMethod(claims);
  const mfaSatisfied = method !== null;

  if (!policy.requireMfa) {
    return { ok: true, mfaSatisfied, claimsPresent, method };
  }

  if (!claimsPresent) {
    if (policy.claimsMissing === "allow") {
      return {
        ok: true,
        mfaSatisfied: false,
        claimsPresent: false,
        method: null,
        reason: "MFA claims absent; MFA_CLAIMS_MISSING=allow",
      };
    }
    return {
      ok: false,
      mfaSatisfied: false,
      claimsPresent: false,
      method: null,
      reason: "MFA required but amr/acr claims are missing",
    };
  }

  if (!mfaSatisfied) {
    return {
      ok: false,
      mfaSatisfied: false,
      claimsPresent: true,
      method: null,
      reason: "MFA required but amr/acr do not indicate multi-factor authentication",
    };
  }

  return { ok: true, mfaSatisfied: true, claimsPresent: true, method };
}

export function detectMfaMethod(claims: {
  amr: string[] | null;
  acr: string | null;
}): string | null {
  if (claims.amr) {
    for (const value of claims.amr) {
      const normalized = value.toLowerCase();
      if (MFA_AMR_VALUES.has(normalized) || normalized.includes("mfa")) {
        return value;
      }
    }
  }

  if (claims.acr) {
    for (const hint of MFA_ACR_HINTS) {
      if (hint.test(claims.acr)) {
        return claims.acr;
      }
    }
  }

  return null;
}
