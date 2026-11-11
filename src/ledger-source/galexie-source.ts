import { SourceUnavailableError } from "../errors.js";
import type { EventPage, FetchPageRequest, LedgerSource, RetentionInfo } from "./types.js";

/**
 * Placeholder for archival backfill from a Galexie data lake or Stellar
 * history archives.
 *
 * Soroban RPC only retains roughly seven days of events (120,960 ledgers by
 * default). Historical ingestion needs a ledger meta source. The interface is
 * deliberately small so a contributor can implement it without touching the
 * ingestion loop, decoder or storage layers.
 *
 * Tracking issue: https://github.com/ojuotimi932/sorex-indexer-engine/issues
 * (seed issue `galexie-backfill-source.md`).
 */
export class GalexieLedgerSource implements LedgerSource {
  readonly kind = "galexie" as const;
  readonly label = "galexie (not implemented)";

  constructor(_options: { endpoint?: string; bucket?: string } = {}) {
    throw new SourceUnavailableError(
      "The Galexie/history-archive LedgerSource is not implemented in v0.1.0. " +
        "Soroban RPC only retains ~120,960 ledgers of events, so ranges older than the RPC " +
        "retention window currently cannot be backfilled by this build. " +
        "Implement LedgerSource.fetchPage() over a Galexie data lake to enable it; " +
        "see .github/seed-issues/galexie-backfill-source.md. " +
        "Use `--source rpc` for ranges inside the retention window.",
    );
  }

  fetchPage(_request: FetchPageRequest): Promise<EventPage> {
    return Promise.reject(
      new SourceUnavailableError("Galexie backfill source is not implemented (see seed issue)"),
    );
  }

  getRetention(): Promise<RetentionInfo> {
    return Promise.reject(
      new SourceUnavailableError("Galexie backfill source is not implemented (see seed issue)"),
    );
  }
}
