import type { FastifyInstance } from "fastify";
import { sendProblem } from "../adapters/http-fastify/problems.js";

const READY_TIMEOUT_MS = 3_000;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  app.get("/readyz", async (_request, reply) => {
    const pool = app.dbPool;
    if (!pool) {
      return reply.send({ status: "ready" });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Database readiness check timed out"));
          }, READY_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      return reply.send({ status: "ready" });
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "readiness check failed",
      );
      return sendProblem(reply, "service_unavailable", 503, "Database is not ready", {
        retryable: true,
        instance: "/readyz",
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  });
}
