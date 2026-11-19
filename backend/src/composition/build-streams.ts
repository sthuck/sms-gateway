import type { Pool } from "pg";
import {
  CreateStream,
  DeleteStream,
  GetStream,
  ListStreams,
  UpdateStream,
} from "../application/use-cases/index.js";
import type { StreamUseCases } from "../adapters/http-fastify/stream-plugin.js";
import { PgStreamRepository } from "../adapters/db-postgres/stream-repository.js";
import type { QueuePublisher } from "../ports/outbound/queue-publisher.js";

export type StreamStack = {
  useCases: StreamUseCases | null;
};

export type BuildStreamStackOptions = {
  pool: Pool | null;
  queuePublisher?: QueuePublisher | null;
};

export function buildStreamStack(options: BuildStreamStackOptions): StreamStack {
  const { pool } = options;
  const queuePublisher = options.queuePublisher ?? null;
  if (!pool || !queuePublisher) {
    return { useCases: null };
  }

  const streams = new PgStreamRepository(pool, queuePublisher);
  return {
    useCases: {
      createStream: new CreateStream({ streams }),
      listStreams: new ListStreams({ streams }),
      getStream: new GetStream({ streams }),
      updateStream: new UpdateStream({ streams }),
      deleteStream: new DeleteStream({ streams }),
    },
  };
}
