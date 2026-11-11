import type { RawSorobanEvent } from "../decoder/types.js";

export interface RetentionInfo {
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow?: number;
}

export interface FetchPageRequest {
  /** Inclusive ledger to start from when no cursor is supplied. */
  startLedger?: number;
  /** Exclusive end ledger for range scans where the source supports it. */
  endLedger?: number;
  cursor?: string;
  limit: number;
}

export interface EventPage {
  events: RawSorobanEvent[];
  cursor?: string;
  latestLedger: number;
  oldestLedger: number;
}

/**
 * A source of Soroban events. The RPC source works for the node's retention
 * window; archival sources (Galexie / history archives) can implement this
 * interface for older ranges without touching ingestion or storage.
 */
export interface LedgerSource {
  readonly kind: "rpc" | "fixture" | "galexie";
  readonly label: string;
  fetchPage(request: FetchPageRequest): Promise<EventPage>;
  getRetention(): Promise<RetentionInfo>;
}
