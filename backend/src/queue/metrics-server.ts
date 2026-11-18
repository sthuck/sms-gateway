import { createServer, type Server } from "node:http";
import type { Logger } from "pino";
import type { QueueMetrics } from "./metrics.js";

export type MetricsServer = {
  port: number;
  close: () => Promise<void>;
};

/**
 * Tiny HTTP server exposing Prometheus text at GET /metrics.
 */
export async function startMetricsServer(options: {
  host: string;
  port: number;
  metrics: QueueMetrics;
  log: Logger;
}): Promise<MetricsServer | null> {
  if (options.port <= 0) {
    return null;
  }

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/metrics" || req.url?.startsWith("/metrics?"))) {
      const body = options.metrics.renderPrometheus();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.log.info({ host: options.host, port }, "queue metrics server listening");

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
