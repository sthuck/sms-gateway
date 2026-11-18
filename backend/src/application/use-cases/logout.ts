import { isSessionActive } from "../../domain/auth/session.js";
import type { LogoutInput } from "../../ports/inbound/auth.js";
import type { Clock } from "../../ports/outbound/clock.js";
import type { SessionRepository } from "../../ports/outbound/session-repository.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";

export type LogoutDeps = {
  sessions: SessionRepository;
  hasher: TokenHasher;
  clock: Clock;
};

export class Logout {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(input: LogoutInput): Promise<void> {
    if (!input.sessionId) {
      return;
    }

    const hash = this.deps.hasher.hash(input.sessionId);
    const existing = await this.deps.sessions.lookupBySessionIdHash(hash);
    if (!existing || !isSessionActive(existing, this.deps.clock.now())) {
      return;
    }

    await this.deps.sessions.revokeBySessionIdHash(existing.ownerId, hash);
  }
}
