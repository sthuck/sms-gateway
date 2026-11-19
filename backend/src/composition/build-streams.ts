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
import { Re2SafeRegexCompiler } from "../adapters/re2/index.js";
import type { QueuePublisher } from "../ports/outbound/queue-publisher.js";
import type { SafeRegexCompiler } from "../ports/outbound/safe-regex.js";

export type StreamStack = {
  useCases: StreamUseCases | null;
};

export type BuildStreamStackOptions = {
  pool: Pool | null;
  queuePublisher?: QueuePublisher | null;
  regex?: SafeRegexCompiler;
};

export function buildStreamStack(options: BuildStreamStackOptions): StreamStack {
  const { pool } = options;
  const queuePublisher = options.queuePublisher ?? null;
  if (!pool || !queuePublisher) {
    return { useCases: null };
  }

  const streams = new PgStreamRepository(pool, queuePublisher);
  const regex = options.regex ?? new Re2SafeRegexCompiler();
  return {
    useCases: {
      createStream: new CreateStream({ streams, regex }),
      listStreams: new ListStreams({ streams }),
      getStream: new GetStream({ streams }),
      updateStream: new UpdateStream({ streams, regex }),
      deleteStream: new DeleteStream({ streams }),
    },
  };
}
