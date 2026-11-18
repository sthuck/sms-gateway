import type { Session } from "./types.js";

export function isSessionActive(session: Session, now = new Date()): boolean {
  if (session.revokedAt) return false;
  return session.expiresAt.getTime() > now.getTime();
}
