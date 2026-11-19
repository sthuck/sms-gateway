import type { Pool } from "pg";
import type { AppendAuditInput, AuditRepository } from "../../ports/outbound/audit-repository.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  append(input: AppendAuditInput): Promise<void> {
    return withDbInfra("audit append failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        await client.query(
          `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, stream_id, message_count, ip)
           VALUES (
             app.current_owner_id(),
             $1,
             $2,
             $3,
             $4,
             $5,
             $6::inet
           )`,
          [
            input.actorType,
            input.actorId,
            input.action,
            input.streamId ?? null,
            input.messageCount ?? null,
            input.ip ?? null,
          ],
        );
      }),
    );
  }
}
