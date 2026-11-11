import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics with an isolated registry, so tests and embedded use
 * never collide with a global registry.
 */
export class Metrics {
  readonly registry: Registry;
  readonly eventsIngested: Counter<"stream" | "outcome">;
  readonly pages: Counter<"stream">;
  readonly pageDuration: Histogram<"stream">;
  readonly ledgerLag: Gauge<"stream">;
  readonly lastSuccess: Gauge<"stream">;
  readonly errors: Counter<"stream" | "reason">;
  readonly gaps: Counter<"stream">;
  readonly eventsDecoded: Counter<"standard">;

  constructor(collectDefaults = false) {
    this.registry = new Registry();
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });

    this.eventsIngested = new Counter({
      name: "sorex_events_ingested_total",
      help: "Events committed to storage, by insert outcome",
      labelNames: ["stream", "outcome"] as const,
      registers: [this.registry],
    });
    this.pages = new Counter({
      name: "sorex_event_pages_total",
      help: "Number of event pages fetched from the ledger source",
      labelNames: ["stream"] as const,
      registers: [this.registry],
    });
    this.pageDuration = new Histogram({
      name: "sorex_event_page_duration_seconds",
      help: "Time to fetch, decode and commit one page",
      labelNames: ["stream"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.ledgerLag = new Gauge({
      name: "sorex_ledger_lag",
      help: "Latest RPC ledger minus the last ledger covered by the cursor",
      labelNames: ["stream"] as const,
      registers: [this.registry],
    });
    this.lastSuccess = new Gauge({
      name: "sorex_last_success_timestamp_seconds",
      help: "Unix timestamp of the last successful ingestion cycle",
      labelNames: ["stream"] as const,
      registers: [this.registry],
    });
    this.errors = new Counter({
      name: "sorex_ingestion_errors_total",
      help: "Ingestion errors by reason",
      labelNames: ["stream", "reason"] as const,
      registers: [this.registry],
    });
    this.gaps = new Counter({
      name: "sorex_ingestion_gaps_total",
      help: "Unrecoverable event gaps detected because of RPC retention",
      labelNames: ["stream"] as const,
      registers: [this.registry],
    });
    this.eventsDecoded = new Counter({
      name: "sorex_events_decoded_total",
      help: "Decoded events by recognised standard",
      labelNames: ["standard"] as const,
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
