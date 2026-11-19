import { StreamError } from "../../domain/stream/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { StreamRepository } from "../../ports/outbound/stream-repository.js";

export type DeleteStreamDeps = {
  streams: StreamRepository;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeleteStream {
  constructor(private readonly deps: DeleteStreamDeps) {}

  async execute(input: { ownerId: string; streamId: string }): Promise<void> {
    if (!UUID_RE.test(input.streamId)) {
      throw new StreamError("invalid_request", 400, "Invalid stream id");
    }
    try {
      const deleted = await this.deps.streams.delete(input.ownerId, input.streamId);
      if (!deleted) {
        throw new StreamError("not_found", 404, "Stream not found");
      }
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream delete failed");
    }
  }
}
