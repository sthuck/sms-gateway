export type AuditActorType = "user" | "device" | "agent";

export type AppendAuditInput = {
  ownerId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  /** Optional client IP; null/undefined omits the column. */
  ip?: string | null;
  streamId?: string | null;
  messageCount?: number | null;
};

/**
 * Append-only audit log. Never pass secrets / token material in `action`.
 * Infra failures MUST throw `InfrastructureError`.
 */
export interface AuditRepository {
  append(input: AppendAuditInput): Promise<void>;
}
