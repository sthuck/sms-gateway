import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { MappedClaims } from "../../domain/auth/types.js";
import { PgIdentityRepository } from "./identity-repository.js";
import { PgUserRepository } from "./user-repository.js";

export type ResolvedUser = {
  ownerId: string;
  email: string;
  mfaEnrolled: boolean;
  displayName: string | null;
  created: boolean;
};

/**
 * Compatibility helper for tests/callers that need (issuer, sub) provisioning
 * without going through CompleteLogin. Prefer the CompleteLogin use case in
 * production paths.
 */
export async function findOrProvisionUser(
  pool: Pool,
  issuer: string,
  claims: MappedClaims,
  options: {
    mfaEnrolled: boolean;
    lastAuthMethod: string | null;
    autoLinkByEmail: boolean;
  },
): Promise<ResolvedUser> {
  const identities = new PgIdentityRepository(pool);
  const users = new PgUserRepository(pool);

  const existing = await identities.findByIssuerSub(issuer, claims.sub);
  if (existing) {
    await users.updateAuthProfile({
      ownerId: existing.ownerId,
      email: claims.email,
      mfaEnrolled: options.mfaEnrolled,
      lastAuthMethod: options.lastAuthMethod,
      displayName: claims.name,
    });
    return {
      ownerId: existing.ownerId,
      email: claims.email,
      mfaEnrolled: options.mfaEnrolled,
      displayName: claims.name ?? existing.displayName,
      created: false,
    };
  }

  if (options.autoLinkByEmail) {
    const byEmail = await users.findByEmail(claims.email);
    if (byEmail) {
      await users.linkIdentityAndUpdate({
        ownerId: byEmail.ownerId,
        issuer,
        sub: claims.sub,
        mfaEnrolled: options.mfaEnrolled,
        lastAuthMethod: options.lastAuthMethod,
        displayName: claims.name,
      });
      return {
        ownerId: byEmail.ownerId,
        email: byEmail.email,
        mfaEnrolled: options.mfaEnrolled,
        displayName: claims.name,
        created: false,
      };
    }
  }

  const ownerId = randomUUID();
  await users.create({
    ownerId,
    email: claims.email,
    mfaEnrolled: options.mfaEnrolled,
    lastAuthMethod: options.lastAuthMethod,
    displayName: claims.name,
    identity: { issuer, sub: claims.sub },
  });

  return {
    ownerId,
    email: claims.email,
    mfaEnrolled: options.mfaEnrolled,
    displayName: claims.name,
    created: true,
  };
}
