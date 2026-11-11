import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { startHealthServer, type HealthServerHandle } from "../src/server.js";

const logger = createLogger("silent");

describe("health server", () => {
  let handle: HealthServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("serves health JSON, Prometheus metrics and 404s", async () => {
    handle = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      metrics: new Metrics(),
      metricsEnabled: true,
      logger,
      getHealth: async () => ({
        status: "ok",
        streams: [],
      }),
    });

    const base = `http://127.0.0.1:${handle.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe("ok");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("sorex_events_ingested_total");

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  it("returns 503 when degraded", async () => {
    handle = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      metrics: new Metrics(),
      metricsEnabled: false,
      logger,
      getHealth: async () => ({ status: "degraded", streams: [] }),
    });
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});
