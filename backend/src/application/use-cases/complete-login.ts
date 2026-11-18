import { AuthError } from "../../domain/auth/errors.js";
import type { MappedClaims } from "../../domain/auth/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { CompleteLoginInput, CompleteLoginResult } from "../../ports/inbound/auth.js";
import type { Clock } from "../../ports/outbound/clock.js";
import type { IdGenerator } from "../../ports/outbound/id-generator.js";
import type { IdentityRepository } from "../../ports/outbound/identity-repository.js";
import type { OidcProvider } from "../../ports/outbound/oidc-provider.js";
import type { SessionRepository } from "../../ports/outbound/session-repository.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";
import type { UserRepository } from "../../ports/outbound/user-repository.js";

export type CompleteLoginConfig = {
  autoLinkByEmail: boolean;
  sessionTtlSeconds: number;
  publicBaseUrl: string | null;
};

export type CompleteLoginDeps = {
  oidc: OidcProvider;
  identities: IdentityRepository;
  users: UserRepository;
  sessions: SessionRepository;
  ids: IdGenerator;
  hasher: TokenHasher;
  clock: Clock;
  config: CompleteLoginConfig;
};

export class CompleteLogin {
  constructor(private readonly deps: CompleteLoginDeps) {}

  async execute(input: CompleteLoginInput): Promise<CompleteLoginResult> {
    let result;
    try {
      result = await this.deps.oidc.finishAuthorization(input.callbackUrl, input.sealedState);
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        throw err;
      }
      throw new AuthError(
        "invalid_callback",
        err instanceof Error ? err.message : "Invalid OAuth callback",
      );
    }

    if (!result.mfa.ok) {
      throw new AuthError("mfa_required", result.mfa.reason ?? "MFA required");
    }

    const user = await this.findOrProvisionUser(result.issuer, result.claims, {
      mfaEnrolled: result.mfa.mfaSatisfied,
      lastAuthMethod: result.mfa.method,
    });

    const sessionId = this.deps.ids.randomToken(32);
    const csrfToken = this.deps.ids.randomToken(32);
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + this.deps.config.sessionTtlSeconds * 1000,
    );

    await this.deps.sessions.insert({
      ownerId: user.ownerId,
      sessionIdHash: this.deps.hasher.hash(sessionId),
      csrfTokenHash: this.deps.hasher.hash(csrfToken),
      expiresAt,
    });

    return {
      sessionId,
      csrfToken,
      expiresAt,
      ownerId: user.ownerId,
      redirectTo: this.deps.config.publicBaseUrl ?? "/",
    };
  }

  private async findOrProvisionUser(
    issuer: string,
    claims: MappedClaims,
    options: { mfaEnrolled: boolean; lastAuthMethod: string | null },
  ): Promise<{ ownerId: string }> {
    const existing = await this.deps.identities.findByIssuerSub(issuer, claims.sub);
    if (existing) {
      await this.deps.users.updateAuthProfile({
        ownerId: existing.ownerId,
        email: claims.email,
        mfaEnrolled: options.mfaEnrolled,
        lastAuthMethod: options.lastAuthMethod,
        displayName: claims.name,
      });
      return { ownerId: existing.ownerId };
    }

    if (this.deps.config.autoLinkByEmail) {
      const byEmail = await this.deps.users.findByEmail(claims.email);
      if (byEmail) {
        await this.deps.users.linkIdentityAndUpdate({
          ownerId: byEmail.ownerId,
          issuer,
          sub: claims.sub,
          mfaEnrolled: options.mfaEnrolled,
          lastAuthMethod: options.lastAuthMethod,
          displayName: claims.name,
        });
        return { ownerId: byEmail.ownerId };
      }
    }

    const ownerId = this.deps.ids.uuid();
    await this.deps.users.create({
      ownerId,
      email: claims.email,
      mfaEnrolled: options.mfaEnrolled,
      lastAuthMethod: options.lastAuthMethod,
      displayName: claims.name,
      identity: { issuer, sub: claims.sub },
    });
    return { ownerId };
  }
}
