import type { Stream } from "../../domain/stream/types.js";
import { StreamError } from "../../domain/stream/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { StreamRepository } from "../../ports/outbound/stream-repository.js";

export type GetStreamDeps = {
  streams: StreamRepository;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GetStream {
  constructor(private readonly deps: GetStreamDeps) {}

  async execute(input: { ownerId: string; streamId: string }): Promise<Stream> {
    if (!UUID_RE.test(input.streamId)) {
      throw new StreamError("invalid_request", 400, "Invalid stream id");
    }
    try {
      const stream = await this.deps.streams.findById(input.ownerId, input.streamId);
      if (!stream) {
        throw new StreamError("not_found", 404, "Stream not found");
      }
      return stream;
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream get failed");
    }
  }
}
