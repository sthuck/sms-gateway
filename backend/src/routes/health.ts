import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  app.get("/readyz", async (_request, reply) => {
    // Schema / DB readiness lands with STH-8. For the skeleton, process-up is enough.
    return reply.send({ status: "ready" });
  });
}
