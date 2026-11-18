import { extractMfaClaims } from "../../domain/auth/claims.js";
import { AuthError } from "../../domain/auth/errors.js";
import { evaluateMfa } from "../../domain/auth/mfa.js";
import type { MfaPolicy } from "../../domain/auth/types.js";
import type { ResolveBearerInput, ResolveBearerResult } from "../../ports/inbound/auth.js";
import type { IdentityRepository } from "../../ports/outbound/identity-repository.js";
import type { JwtVerifier } from "../../ports/outbound/jwt-verifier.js";

export type ResolveBearerDeps = {
  jwt: JwtVerifier;
  identities: IdentityRepository;
  mfa: MfaPolicy;
};

export class ResolveBearer {
  constructor(private readonly deps: ResolveBearerDeps) {}

  async execute(input: ResolveBearerInput): Promise<ResolveBearerResult> {
    let verified;
    try {
      verified = await this.deps.jwt.verify(input.token);
    } catch {
      throw new AuthError("unauthorized", "Missing, expired, or invalid access token");
    }

    const mfa = evaluateMfa(extractMfaClaims(verified.payload), this.deps.mfa);
    if (!mfa.ok) {
      throw new AuthError("mfa_required", mfa.reason ?? "MFA required");
    }

    const identity = await this.deps.identities.findByIssuerSub(verified.iss, verified.sub);
    if (!identity) {
      throw new AuthError("unauthorized", "Unknown identity");
    }

    return { ownerId: identity.ownerId };
  }
}
