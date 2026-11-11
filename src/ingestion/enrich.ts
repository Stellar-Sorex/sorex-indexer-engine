import type { DecodedEvent } from "../decoder/types.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { Storage } from "../storage/types.js";
import {
  parseTransactionResponse,
  type RawTransactionResponse,
  type TransactionRecord,
} from "../transactions/index.js";

export interface TransactionFetcher {
  getTransaction(txHash: string): Promise<RawTransactionResponse | null>;
}

export interface TransactionEnricherOptions {
  fetcher: TransactionFetcher;
  storage: Storage;
  logger: Logger;
  metrics: Metrics;
  concurrency?: number;
  maxPerBatch?: number;
}

/**
 * Enrich ingested events with transaction-level resource data. Failures are
 * logged and skipped: event ingestion must not depend on an extra RPC call.
 */
export class TransactionEnricher {
  readonly #options: TransactionEnricherOptions;
  readonly #seen = new Set<string>();
  readonly #concurrency: number;
  readonly #maxPerBatch: number;

  constructor(options: TransactionEnricherOptions) {
    this.#options = options;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#maxPerBatch = Math.max(1, options.maxPerBatch ?? 100);
  }

  async enrich(events: DecodedEvent[]): Promise<number> {
    return this.enrichHashes(
      events.map((event) => ({ txHash: event.txHash, ledgerClosedAt: event.ledgerClosedAt })),
    );
  }

  /** Enrich known transaction hashes, e.g. from the `enrich` CLI command. */
  async enrichHashes(items: { txHash: string; ledgerClosedAt: string }[]): Promise<number> {
    const closeTimes = new Map<string, string>();
    const queue: string[] = [];
    for (const item of items) {
      if (this.#seen.has(item.txHash)) continue;
      this.#seen.add(item.txHash);
      closeTimes.set(item.txHash, item.ledgerClosedAt);
      queue.push(item.txHash);
      if (queue.length >= this.#maxPerBatch) break;
    }
    if (queue.length === 0) return 0;

    const records: TransactionRecord[] = [];
    const worker = async (): Promise<void> => {
      for (;;) {
        const txHash = queue.shift();
        if (!txHash) return;
        try {
          const raw = await this.#options.fetcher.getTransaction(txHash);
          if (!raw) continue;
          const record = parseTransactionResponse(txHash, raw, closeTimes.get(txHash));
          if (record) records.push(record);
        } catch (error) {
          this.#options.logger.debug(
            { err: error, txHash },
            "transaction enrichment failed for hash",
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, queue.length) }, () => worker()),
    );

    if (records.length === 0) return 0;
    try {
      const inserted = await this.#options.storage.commitTransactions(records);
      this.#options.metrics.transactionsIngested.inc(inserted);
      this.#options.logger.debug(
        { fetched: queue.length, inserted, attempted: closeTimes.size },
        "stored transaction resource metadata",
      );
      return inserted;
    } catch (error) {
      this.#options.logger.warn({ err: error }, "could not store transaction metadata");
      return 0;
    }
  }
}
