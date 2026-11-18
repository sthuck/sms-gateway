import type { Session } from "../../domain/auth/types.js";

export type InsertSessionInput = {
  ownerId: string;
  sessionIdHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
};

export interface SessionRepository {
  insert(input: InsertSessionInput): Promise<void>;
  lookupBySessionIdHash(sessionIdHash: string): Promise<Session | null>;
  revokeBySessionIdHash(ownerId: string, sessionIdHash: string): Promise<void>;
  touch(ownerId: string, sessionRowId: string): Promise<void>;
}
