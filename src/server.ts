import { createServer, type Server } from "node:http";
import type { LoopHealth } from "./ingestion/loop.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { Overview } from "./storage/types.js";

export interface HealthSnapshot {
  status: "ok" | "degraded" | "starting";
  streams: LoopHealth[];
  overview?: Overview;
  uptimeSeconds?: number;
}

export interface HealthServerOptions {
  host: string;
  port: number;
  metrics: Metrics;
  metricsEnabled: boolean;
  logger: Logger;
  getHealth: () => Promise<HealthSnapshot>;
}

export interface HealthServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function json(
  statusCode: number,
  body: unknown,
): { statusCode: number; body: string; contentType: string } {
  return {
    statusCode,
    body: JSON.stringify(body, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    contentType: "application/json; charset=utf-8",
  };
}

/**
 * Minimal observability endpoint used by Docker/Kubernetes probes and
 * Prometheus. Deliberately separate from the query API.
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServerHandle> {
  const startedAt = Date.now();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    const send = async (): Promise<void> => {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }

      if (url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/ready") {
        try {
          const snapshot = await options.getHealth();
          const payload: HealthSnapshot = {
            ...snapshot,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          };
          const statusCode = snapshot.status === "degraded" ? 503 : 200;
          const body = json(statusCode, payload);
          response.writeHead(body.statusCode, { "content-type": body.contentType });
          response.end(body.body);
        } catch (error) {
          options.logger.error({ err: error }, "health check failed");
          const body = json(503, { status: "error", error: "health check failed" });
          response.writeHead(body.statusCode, { "content-type": body.contentType });
          response.end(body.body);
        }
        return;
      }

      if (url.pathname === "/metrics") {
        if (!options.metricsEnabled) {
          const body = json(404, { error: "metrics disabled" });
          response.writeHead(body.statusCode, { "content-type": body.contentType });
          response.end(body.body);
          return;
        }
        const body = await options.metrics.render();
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(body);
        return;
      }

      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            service: "sorex-indexer-engine",
            endpoints: ["/health", "/metrics"],
          }),
        );
        return;
      }

      const body = json(404, { error: "not found" });
      response.writeHead(body.statusCode, { "content-type": body.contentType });
      response.end(body.body);
    };

    void send();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      options.logger.info({ host: options.host, port }, "health/metrics server listening");
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
