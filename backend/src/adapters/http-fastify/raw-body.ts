import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { MAX_BODY_BYTES } from "../device-crypto/signing.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request body bytes as received on the wire (no re-serialisation). */
    rawBody: Buffer;
  }
}

/**
 * Capture the exact JSON body bytes for content-hash and signature checks.
 * Rejects bodies larger than 1 MiB before JSON parse.
 */
async function rawBodyPluginImpl(app: FastifyInstance): Promise<void> {
  // Reference types must start as null; assigned per-request below.
  app.decorateRequest("rawBody", null as unknown as Buffer);

  app.addHook("onRequest", async (request) => {
    request.rawBody = Buffer.alloc(0);
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES },
    (request: FastifyRequest, body: Buffer, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(body.toString("utf8"));
        done(null, parsed);
      } catch {
        const err = new Error("Malformed JSON") as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 400;
        err.code = "invalid_request";
        done(err, undefined);
      }
    },
  );
}

export const rawBodyPlugin = fp(rawBodyPluginImpl, {
  name: "sms-gateway-raw-body",
});
