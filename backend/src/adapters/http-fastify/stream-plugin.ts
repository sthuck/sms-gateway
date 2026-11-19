import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type {
  CreateStream,
  DeleteStream,
  GetStream,
  ListStreams,
  UpdateStream,
} from "../../application/use-cases/index.js";
import { StreamError } from "../../domain/stream/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { buildProblem, type ProblemCode } from "./problems.js";

export type StreamUseCases = {
  createStream: CreateStream | null;
  listStreams: ListStreams | null;
  getStream: GetStream | null;
  updateStream: UpdateStream | null;
  deleteStream: DeleteStream | null;
};

declare module "fastify" {
  interface FastifyInstance {
    streamUseCases: StreamUseCases | null;
  }
}

export type StreamPluginOptions = {
  useCases?: StreamUseCases | null | undefined;
};

async function streamPluginImpl(app: FastifyInstance, opts: StreamPluginOptions): Promise<void> {
  app.decorate("streamUseCases", opts.useCases ?? null);
}

export const streamPlugin = fp(streamPluginImpl, {
  name: "sms-gateway-streams",
});

export function mapStreamError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: unknown,
): FastifyReply {
  if (isInfrastructureError(err) || err instanceof InfrastructureError) {
    throw err;
  }
  if (!(err instanceof StreamError)) {
    throw err;
  }
  const instance = request.url.split("?")[0] ?? request.url;
  const problem = buildProblem(err.code as ProblemCode, err.status, err.message, { instance });
  const body = err.errors && err.errors.length > 0 ? { ...problem, errors: err.errors } : problem;
  return reply
    .status(err.status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send(body);
}
