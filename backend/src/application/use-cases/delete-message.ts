import { MessageError } from "../../domain/message/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { MessageRepository } from "../../ports/outbound/message-repository.js";

export type DeleteMessageDeps = {
  messages: MessageRepository;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a message under RLS. Missing / other-owner → 404 (never 403).
 * Port delete is zero-row safe (no throw); UC maps absence to not_found.
 */
export class DeleteMessage {
  constructor(private readonly deps: DeleteMessageDeps) {}

  async execute(input: { ownerId: string; messageId: string }): Promise<void> {
    if (!UUID_RE.test(input.messageId)) {
      throw new MessageError("invalid_request", 400, "Invalid message id");
    }
    try {
      const deleted = await this.deps.messages.delete(input.ownerId, input.messageId);
      if (!deleted) {
        throw new MessageError("not_found", 404, "Message not found");
      }
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof MessageError) throw err;
      throw InfrastructureError.wrap(err, "message delete failed");
    }
  }
}
