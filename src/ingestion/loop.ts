import type { AppConfig } from "../config.js";
import { RetentionError, RpcError } from "../errors.js";
import type { EventDecoder } from "../decoder/types.js";
import type { LedgerSource, RetentionInfo } from "../ledger-source/types.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { CommitPageResult, CursorState, Storage } from "../storage/types.js";
import { decodeBatch } from "./decode-batch.js";
import { TransactionEnricher, type TransactionFetcher } from "./enrich.js";

export interface IngestionLoopOptions {
  config: AppConfig;
  source: LedgerSource;
  storage: Storage;
  decoder: EventDecoder;
  logger: Logger;
  metrics: Metrics;
  streamId: string;
  /** When provided, store transaction resource metadata after each page. */
  transactionFetcher?: TransactionFetcher;
}

export type LoopStatus = "starting" | "running" | "degraded" | "stopped" | "failed";

export interface LoopHealth {
  streamId: string;
  source: string;
  status: LoopStatus;
  lastLedger: number | null;
  lastCursor: string | null;
  ledgerLag: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  eventsIngested: number;
}

export interface DrainResult {
  pages: number;
  committed: CommitPageResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Polls a ledger source page by page, decoding and committing each page with
 * its cursor in one transaction. Cursor progress is therefore crash-safe and
 * re-ingesting any range is idempotent.
 */
export class IngestionLoop {
  readonly #config: AppConfig;
  readonly #source: LedgerSource;
  readonly #storage: Storage;
  readonly #decoder: EventDecoder;
  readonly #logger: Logger;
  readonly #metrics: Metrics;
  readonly #streamId: string;
  readonly #enricher?: TransactionEnricher;
  #retention: RetentionInfo | null = null;
  #hasGap = false;
  #lastGapKey: string | null = null;
  #lastGapCheck = 0;
  #totalIngested = 0;
  #state: LoopHealth;

  constructor(options: IngestionLoopOptions) {
    this.#config = options.config;
    this.#source = options.source;
    this.#storage = options.storage;
    this.#decoder = options.decoder;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#streamId = options.streamId;
    this.#enricher = options.transactionFetcher
      ? new TransactionEnricher({
          fetcher: options.transactionFetcher,
          storage: options.storage,
          logger: options.logger,
          metrics: options.metrics,
        })
      : undefined;
    this.#state = {
      streamId: options.streamId,
      source: options.source.label,
      status: "starting",
      lastLedger: null,
      lastCursor: null,
      ledgerLag: null,
      lastSuccessAt: null,
      lastError: null,
      eventsIngested: 0,
    };
  }

  health(): LoopHealth {
    return { ...this.#state };
  }

  /** Initialise the cursor (first boot) and check retention before polling. */
  async init(): Promise<CursorState> {
    let cursor = await this.#storage.getCursor(this.#streamId);
    if (!cursor) {
      this.#retention = await this.#source.getRetention();
      let startLedger = this.#config.START_LEDGER ?? this.#retention.latestLedger;
      if (startLedger < this.#retention.oldestLedger) {
        await this.#recordGap(startLedger, this.#retention.oldestLedger - 1, this.#retention);
        this.#logger.error(
          { stream: this.#streamId, startLedger, oldestRetained: this.#retention.oldestLedger },
          "START_LEDGER is outside the RPC retention window; advancing to the oldest retained ledger",
        );
        startLedger = this.#retention.oldestLedger;
      }
      if (startLedger > this.#retention.latestLedger) {
        this.#logger.warn(
          { stream: this.#streamId, startLedger, latestLedger: this.#retention.latestLedger },
          "START_LEDGER is ahead of the network; ingestion will wait for it",
        );
      }
      await this.#storage.setCursor(this.#streamId, null, startLedger - 1);
      cursor = await this.#storage.getCursor(this.#streamId);
      this.#logger.info(
        { stream: this.#streamId, startLedger, source: this.#source.label },
        "initialised ingestion cursor",
      );
    }
    this.#state.lastLedger = cursor?.lastLedger ?? null;
    this.#state.lastCursor = cursor?.lastCursor ?? null;
    return cursor!;
  }

  /**
   * Run until `signal` aborts. Failures are retried on the poll interval;
   * cursor state is never advanced past what was committed.
   */
  async run(signal: AbortSignal): Promise<void> {
    let cursor: CursorState;
    try {
      cursor = await this.init();
    } catch (error) {
      this.#fail(error);
      throw error;
    }

    const runId = await this.#storage.startRun({
      streamId: this.#streamId,
      mode: "live",
      fromLedger: cursor.lastLedger + 1,
      toLedger: null,
    });
    this.#state.status = "running";
    this.#logger.info({ stream: this.#streamId, runId }, "ingestion loop started");

    let cycleEvents = 0;
    let cycleDuplicates = 0;

    try {
      while (!signal.aborted) {
        try {
          await this.#maybeCheckGaps();
          const page = await this.#drain(signal);
          cycleEvents += page.committed.insertedEvents;
          cycleDuplicates += page.committed.duplicateEvents;
          if (
            page.pages === 0 ||
            page.committed.duplicateEvents + page.committed.insertedEvents === 0
          ) {
            await this.#sleep(this.#config.POLL_INTERVAL_MS, signal);
          }
        } catch (error) {
          if (signal.aborted) break;
          this.#fail(error);
          await this.#sleep(this.#config.POLL_INTERVAL_MS, signal);
        }
      }
    } finally {
      this.#state.status = signal.aborted ? "stopped" : this.#state.status;
      await this.#storage
        .finishRun(runId, {
          status: "success",
          eventsIngested: cycleEvents,
          duplicates: cycleDuplicates,
          toLedger: this.#state.lastLedger,
        })
        .catch((error: unknown) => {
          this.#logger.warn({ err: error }, "failed to finalise ingestion run");
        });
      this.#logger.info({ stream: this.#streamId, events: cycleEvents }, "ingestion loop stopped");
    }
  }

  /** Fetch and commit at most one catch-up pass; used by tests and backfill tooling. */
  async runOnce(): Promise<DrainResult> {
    const cursor = await this.init();
    const runId = await this.#storage.startRun({
      streamId: this.#streamId,
      mode: "live",
      fromLedger: cursor.lastLedger + 1,
      toLedger: null,
    });
    try {
      await this.#maybeCheckGaps(true);
      const result = await this.#drain(new AbortController().signal);
      this.#state.lastCursor =
        (await this.#storage.getCursor(this.#streamId))?.lastCursor ?? cursor.lastCursor;
      this.#state.status = this.#hasGap ? "degraded" : "running";
      await this.#storage.finishRun(runId, {
        status: "success",
        eventsIngested: result.committed.insertedEvents,
        duplicates: result.committed.duplicateEvents,
        toLedger: this.#state.lastLedger,
      });
      return result;
    } catch (error) {
      this.#fail(error);
      await this.#storage
        .finishRun(runId, {
          status: "failed",
          eventsIngested: 0,
          toLedger: this.#state.lastLedger,
          error: errorMessage(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #drain(signal: AbortSignal): Promise<DrainResult> {
    let cursor = await this.#storage.getCursor(this.#streamId);
    if (!cursor) throw new Error("ingestion cursor disappeared");

    const committed: CommitPageResult = {
      insertedEvents: 0,
      duplicateEvents: 0,
      insertedTransfers: 0,
    };
    let pages = 0;

    while (!signal.aborted) {
      const page = await this.#source.fetchPage(
        cursor.lastCursor
          ? { cursor: cursor.lastCursor, limit: this.#config.BATCH_SIZE }
          : { startLedger: cursor.lastLedger + 1, limit: this.#config.BATCH_SIZE },
      );

      this.#metrics.pages.inc({ stream: this.#streamId });
      this.#retention = {
        latestLedger: page.latestLedger,
        oldestLedger: page.oldestLedger,
      };
      this.#metrics.ledgerLag.set(
        { stream: this.#streamId },
        Math.max(0, page.latestLedger - cursor.lastLedger),
      );
      this.#state.ledgerLag = Math.max(0, page.latestLedger - cursor.lastLedger);

      const previousCursor: string | null = cursor.lastCursor;
      const lastEvent = page.events.at(-1);
      const scanLedger = lastEvent ? lastEvent.ledger : page.latestLedger;

      const end = this.#config.END_LEDGER;
      const inRange =
        end === undefined ? page.events : page.events.filter((event) => event.ledger <= end);
      const batch = decodeBatch(inRange, this.#decoder);
      for (const event of batch.events) {
        this.#metrics.eventsDecoded.inc({ standard: event.standard ?? "generic" });
      }

      const started = process.hrtime.bigint();
      const pageResult = await this.#storage.commitPage({
        streamId: this.#streamId,
        events: batch.events,
        transfers: batch.transfers,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        lastLedger: scanLedger,
        mode: "live",
      });
      const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.#metrics.pageDuration.observe({ stream: this.#streamId }, elapsedSeconds);

      if (this.#enricher && batch.events.length > 0) {
        await this.#enricher.enrich(batch.events);
      }

      committed.insertedEvents += pageResult.insertedEvents;
      committed.duplicateEvents += pageResult.duplicateEvents;
      committed.insertedTransfers += pageResult.insertedTransfers;
      this.#totalIngested += pageResult.insertedEvents;
      this.#state.eventsIngested = this.#totalIngested;
      this.#metrics.eventsIngested.inc(
        { stream: this.#streamId, outcome: "inserted" },
        pageResult.insertedEvents,
      );
      this.#metrics.eventsIngested.inc(
        { stream: this.#streamId, outcome: "duplicate" },
        pageResult.duplicateEvents,
      );
      this.#lastSuccessNow();

      pages += 1;
      cursor = {
        streamId: this.#streamId,
        lastCursor: page.cursor ?? previousCursor,
        lastLedger: scanLedger,
        updatedAt: new Date().toISOString(),
      };
      this.#state.lastLedger = scanLedger;
      this.#state.lastCursor = cursor.lastCursor;
      this.#state.status = this.#hasGap ? "degraded" : "running";
      if (!this.#hasGap) this.#state.lastError = null;

      this.#logger.debug(
        {
          stream: this.#streamId,
          fetched: page.events.length,
          inserted: pageResult.insertedEvents,
          duplicates: pageResult.duplicateEvents,
          transfers: pageResult.insertedTransfers,
          ledger: scanLedger,
        },
        "committed event page",
      );

      if (end !== undefined && scanLedger >= end) break;
      if (page.events.length === 0) break;
      if (page.events.length < this.#config.BATCH_SIZE) break;
      if (page.cursor !== undefined && page.cursor === previousCursor) {
        this.#logger.warn(
          { stream: this.#streamId },
          "RPC returned a non-advancing cursor; pausing",
        );
        break;
      }
      // Yield so shutdown signals and the health endpoint stay responsive
      // during a long catch-up.
      await new Promise((resolve) => setImmediate(resolve));
    }

    return { pages, committed };
  }

  async #maybeCheckGaps(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.#lastGapCheck < this.#config.GAP_CHECK_INTERVAL_MS) return;
    this.#lastGapCheck = now;

    const cursor = await this.#storage.getCursor(this.#streamId);
    if (!cursor) return;
    let retention: RetentionInfo;
    try {
      retention = await this.#source.getRetention();
    } catch (error) {
      this.#logger.warn({ err: error, stream: this.#streamId }, "could not check RPC retention");
      return;
    }
    this.#retention = retention;
    const lag = Math.max(0, retention.latestLedger - cursor.lastLedger);
    this.#metrics.ledgerLag.set({ stream: this.#streamId }, lag);
    this.#state.ledgerLag = lag;

    if (retention.latestLedger < cursor.lastLedger) {
      this.#logger.warn(
        { stream: this.#streamId, cursorLedger: cursor.lastLedger, latest: retention.latestLedger },
        "cursor is ahead of the RPC latest ledger (node may have failed over to a lagging replica)",
      );
    }

    const gapFrom = cursor.lastLedger + 1;
    const gapTo = retention.oldestLedger - 1;
    if (gapFrom <= gapTo) {
      await this.#recordGap(gapFrom, gapTo, retention);
      // Move the cursor to the oldest retained ledger so ingestion can make
      // progress. The gap is recorded permanently as unrecoverable here.
      await this.#storage.setCursor(this.#streamId, null, gapTo);
      this.#state.lastLedger = gapTo;
      this.#state.lastCursor = null;
      this.#state.status = "degraded";
      const gapKey = `${gapFrom}-${gapTo}-${retention.oldestLedger}`;
      if (this.#lastGapKey !== gapKey) {
        this.#lastGapKey = gapKey;
        this.#logger.error(
          {
            stream: this.#streamId,
            fromLedger: gapFrom,
            toLedger: gapTo,
            oldestRetained: retention.oldestLedger,
          },
          "unrecoverable event gap: ledgers are older than the RPC retention window. " +
            "Use backfill mode with an archival LedgerSource to recover them.",
        );
      }
    }
  }

  async #recordGap(fromLedger: number, toLedger: number, retention: RetentionInfo): Promise<void> {
    const gap = await this.#storage.recordGap({
      streamId: this.#streamId,
      fromLedger,
      toLedger,
      reason: `RPC retention window starts at ledger ${retention.oldestLedger} (window ${retention.ledgerRetentionWindow ?? "unknown"} ledgers)`,
      recoverable: false,
    });
    this.#hasGap = true;
    this.#metrics.gaps.inc({ stream: this.#streamId });
    this.#logger.warn({ gap, stream: this.#streamId }, "recorded ingestion gap");
  }

  #lastSuccessNow(): void {
    const now = Date.now();
    this.#state.lastSuccessAt = new Date(now).toISOString();
    this.#metrics.lastSuccess.set({ stream: this.#streamId }, now / 1000);
  }

  #fail(error: unknown): void {
    this.#state.status = "degraded";
    this.#state.lastError = errorMessage(error);
    const reason =
      error instanceof RetentionError
        ? "retention"
        : error instanceof RpcError
          ? "rpc"
          : "internal";
    this.#metrics.errors.inc({ stream: this.#streamId, reason });
    this.#logger.error(
      { err: error, stream: this.#streamId, reason },
      "ingestion cycle failed; retrying on the next poll",
    );
  }

  async #sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
