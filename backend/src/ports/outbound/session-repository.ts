import type { Session } from "../../domain/auth/types.js";

export type InsertSessionInput = {
  ownerId: string;
  sessionIdHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
};

/**
 * Session persistence.
 *
 * - `null` from lookup = not found / expired row absent (domain absence).
 * - Infra failures (DB down, query error) MUST throw `InfrastructureError`
 *   (never return null for errors).
 */
export interface SessionRepository {
  insert(input: InsertSessionInput): Promise<void>;
  lookupBySessionIdHash(sessionIdHash: string): Promise<Session | null>;
  revokeBySessionIdHash(ownerId: string, sessionIdHash: string): Promise<void>;
  touch(ownerId: string, sessionRowId: string): Promise<void>;
}
