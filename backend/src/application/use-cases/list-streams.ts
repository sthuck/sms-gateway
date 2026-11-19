import type { Stream } from "../../domain/stream/types.js";
import { StreamError } from "../../domain/stream/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { StreamRepository } from "../../ports/outbound/stream-repository.js";

export type ListStreamsDeps = {
  streams: StreamRepository;
};

export const DEFAULT_STREAM_LIST_LIMIT = 50;
export const MAX_STREAM_LIST_LIMIT = 100;

export class ListStreams {
  constructor(private readonly deps: ListStreamsDeps) {}

  async execute(input: { ownerId: string; limit?: number }): Promise<Stream[]> {
    const limit = input.limit ?? DEFAULT_STREAM_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STREAM_LIST_LIMIT) {
      throw new StreamError(
        "invalid_request",
        400,
        `limit must be an integer between 1 and ${MAX_STREAM_LIST_LIMIT}`,
      );
    }
    try {
      return await this.deps.streams.list(input.ownerId, limit);
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "stream list failed");
    }
  }
}
