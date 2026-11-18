import { AuthError } from "../../domain/auth/errors.js";
import { isSessionActive } from "../../domain/auth/session.js";
import type { ResolveSessionInput, ResolveSessionResult } from "../../ports/inbound/auth.js";
import type { Clock } from "../../ports/outbound/clock.js";
import type { SessionRepository } from "../../ports/outbound/session-repository.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";

export type ResolveSessionDeps = {
  sessions: SessionRepository;
  hasher: TokenHasher;
  clock: Clock;
};

export class ResolveSession {
  constructor(private readonly deps: ResolveSessionDeps) {}

  async execute(input: ResolveSessionInput): Promise<ResolveSessionResult> {
    const hash = this.deps.hasher.hash(input.sessionId);
    const session = await this.deps.sessions.lookupBySessionIdHash(hash);
    if (!session || !isSessionActive(session, this.deps.clock.now())) {
      throw new AuthError("unauthorized", "Session expired or revoked");
    }

    // Do not touch last_seen_at here — CSRF/origin must pass first (STH-46).
    return {
      ownerId: session.ownerId,
      sessionRowId: session.sessionRowId,
      csrfTokenHash: session.csrfTokenHash,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    };
  }
}
