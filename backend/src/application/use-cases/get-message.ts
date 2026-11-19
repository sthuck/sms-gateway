import { MessageError } from "../../domain/message/errors.js";
import type { MessageDirection } from "../../domain/message/types.js";
import {
  DecryptionError,
  InfrastructureError,
  isDecryptionError,
  isInfrastructureError,
} from "../../domain/errors.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type { MessageRepository } from "../../ports/outbound/message-repository.js";
import type { OwnerMessageDto } from "./list-messages.js";

export type GetMessageDeps = {
  messages: MessageRepository;
  bodyCodec: BodyCodec;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GetMessage {
  constructor(private readonly deps: GetMessageDeps) {}

  async execute(input: { ownerId: string; messageId: string }): Promise<OwnerMessageDto> {
    if (!UUID_RE.test(input.messageId)) {
      throw new MessageError("invalid_request", 400, "Invalid message id");
    }

    try {
      const row = await this.deps.messages.findById(input.ownerId, input.messageId);
      if (!row) {
        throw new MessageError("not_found", 404, "Message not found");
      }

      const body = await this.deps.bodyCodec.decode(
        {
          ownerId: input.ownerId,
          deviceId: row.deviceId,
          deviceMsgId: row.deviceMsgId,
        },
        row.bodyCiphertext,
      );

      return {
        id: row.id,
        sender: row.sender,
        body,
        receivedAt: row.receivedAt,
        deviceId: row.deviceId,
        simSlot: row.simSlot,
        direction: row.direction as MessageDirection,
      };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (isDecryptionError(err) || err instanceof DecryptionError) throw err;
      if (err instanceof MessageError) throw err;
      throw InfrastructureError.wrap(err, "message get failed");
    }
  }
}
