import type { EventDecoder } from "../decoder/types.js";
import { RetentionError } from "../errors.js";
import type { LedgerSource } from "../ledger-source/types.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { CommitPageResult, Storage } from "../storage/types.js";
import { decodeBatch } from "./decode-batch.js";

export interface BackfillOptions {
  source: LedgerSource;
  storage: Storage;
  decoder: EventDecoder;
  logger: Logger;
  metrics: Metrics;
  batchSize: number;
  streamId: string;
}

export interface BackfillResult extends CommitPageResult {
  pages: number;
  fromLedger: number;
  toLedger: number;
}

/**
 * Ingest an explicit ledger range into a dedicated backfill stream. Safe to
 * run repeatedly: events are keyed by RPC event id. Ranges older than the RPC
 * retention window fail with a `RetentionError` that names the archival source
 * requirement instead of silently skipping data.
 */
export class BackfillRunner {
  readonly #options: BackfillOptions;

  constructor(options: BackfillOptions) {
    this.#options = options;
  }

  async run(fromLedger: number, toLedger: number, signal?: AbortSignal): Promise<BackfillResult> {
    if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger) || fromLedger <= 0) {
      throw new Error("Backfill requires positive integer ledger bounds");
    }
    if (fromLedger > toLedger) throw new Error("Backfill --from must be <= --to");

    const { source, storage, decoder, logger, metrics, batchSize, streamId } = this.#options;
    const retention = await source.getRetention();

    if (source.kind === "rpc" && fromLedger < retention.oldestLedger) {
      throw new RetentionError(
        `Ledger ${fromLedger} is older than the RPC retention window (oldest retained: ${retention.oldestLedger}). ` +
          "Soroban RPC cannot serve it. Use an archival LedgerSource (Galexie/history archives) " +
          "once implemented; see .github/seed-issues/galexie-backfill-source.md.",
        fromLedger,
        retention.oldestLedger,
      );
    }
    if (toLedger > retention.latestLedger) {
      throw new RangeError(
        `Backfill --to (${toLedger}) is beyond the latest ledger known to the source (${retention.latestLedger})`,
      );
    }

    const runId = await storage.startRun({
      streamId,
      mode: "backfill",
      fromLedger,
      toLedger,
    });

    const total: BackfillResult = {
      insertedEvents: 0,
      duplicateEvents: 0,
      insertedTransfers: 0,
      pages: 0,
      fromLedger,
      toLedger,
    };

    logger.info({ streamId, fromLedger, toLedger, source: source.label }, "backfill started");

    try {
      let cursor: string | undefined;
      let startLedger = fromLedger;
      let lastPersisted = fromLedger - 1;

      while (!signal?.aborted) {
        const page = await source.fetchPage({
          ...(cursor ? { cursor } : { startLedger }),
          limit: batchSize,
        });

        if (page.events.length === 0) break;

        const inRange = page.events.filter((event) => event.ledger <= toLedger);
        const lastEvent = page.events.at(-1);
        if (inRange.length > 0) {
          const batch = decodeBatch(inRange, decoder);
          const result = await storage.commitPage({
            streamId,
            events: batch.events,
            transfers: batch.transfers,
            ...(page.cursor ? { cursor: page.cursor } : {}),
            lastLedger: inRange.at(-1)!.ledger,
            mode: "backfill",
          });
          total.insertedEvents += result.insertedEvents;
          total.duplicateEvents += result.duplicateEvents;
          total.insertedTransfers += result.insertedTransfers;
          total.pages += 1;
          lastPersisted = inRange.at(-1)!.ledger;
          metrics.pages.inc({ stream: streamId });
          metrics.eventsIngested.inc(
            { stream: streamId, outcome: "inserted" },
            result.insertedEvents,
          );
          metrics.eventsIngested.inc(
            { stream: streamId, outcome: "duplicate" },
            result.duplicateEvents,
          );
        }

        if (lastEvent && lastEvent.ledger >= toLedger) break;
        if (!page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
        startLedger = (lastEvent?.ledger ?? startLedger) + 1;
        await new Promise((resolve) => setImmediate(resolve));
      }

      await storage.finishRun(runId, {
        status: "success",
        eventsIngested: total.insertedEvents,
        duplicates: total.duplicateEvents,
        toLedger: lastPersisted,
      });
      logger.info({ ...total, streamId }, "backfill completed");
      return total;
    } catch (error) {
      await storage.finishRun(runId, {
        status: "failed",
        eventsIngested: total.insertedEvents,
        duplicates: total.duplicateEvents,
        toLedger: total.toLedger,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error({ err: error, streamId, fromLedger, toLedger }, "backfill failed");
      throw error;
    }
  }
}
