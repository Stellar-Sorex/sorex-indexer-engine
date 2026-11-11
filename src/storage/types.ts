import type { DecodedEvent, JsonValue, TokenTransfer } from "../decoder/types.js";

export type IngestionMode = "live" | "backfill" | "replay";

export interface CursorState {
  streamId: string;
  lastCursor: string | null;
  lastLedger: number;
  updatedAt: string;
}

export interface CommitPageInput {
  streamId: string;
  events: DecodedEvent[];
  transfers: TokenTransfer[];
  /** Cursor returned by the source for the last event page, if any. */
  cursor?: string;
  /** Highest ledger this page proves was scanned; used for lag and gaps. */
  lastLedger: number;
  mode: IngestionMode;
}

export interface CommitPageResult {
  insertedEvents: number;
  duplicateEvents: number;
  insertedTransfers: number;
}

export interface IngestionRunInput {
  streamId: string;
  mode: IngestionMode;
  fromLedger: number | null;
  toLedger: number | null;
}

export interface IngestionRunUpdate {
  status: "success" | "failed";
  eventsIngested: number;
  duplicates?: number;
  toLedger?: number | null;
  error?: string | null;
}

export interface IngestionRunRow {
  runId: string;
  streamId: string;
  mode: IngestionMode;
  startedAt: string;
  finishedAt: string | null;
  fromLedger: number | null;
  toLedger: number | null;
  eventsIngested: number;
  duplicates: number;
  status: string;
  error: string | null;
}

export interface GapInput {
  streamId: string;
  fromLedger: number;
  toLedger: number;
  reason: string;
  recoverable: boolean;
}

export interface GapRow extends GapInput {
  gapId: string;
  detectedAt: string;
}

export interface EventRow {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  eventIndex: number;
  type: string;
  topicsXdr: string[];
  topicsJson: JsonValue[];
  dataXdr: string;
  dataJson: JsonValue;
  inSuccessfulContractCall: boolean;
  eventName: string | null;
  standard: string | null;
}

export type TokenTransferRow = TokenTransfer;

export interface ContractRow {
  contractId: string;
  firstSeenLedger: number;
  lastSeenLedger: number;
  eventCount: number;
  updatedAt: string;
}

export interface Overview {
  eventCount: number;
  transferCount: number;
  contractCount: number;
  latestLedger: number | null;
  cursors: CursorState[];
  latestRun: IngestionRunRow | null;
  latestGap: GapRow | null;
}

/** Storage contract implemented by the PostgreSQL and SQLite adapters. */
export interface Storage {
  migrate(): Promise<void>;
  close(): Promise<void>;
  getCursor(streamId: string): Promise<CursorState | undefined>;
  /** Force a cursor position; used when recovering from an RPC retention gap. */
  setCursor(streamId: string, lastCursor: string | null, lastLedger: number): Promise<void>;
  commitPage(input: CommitPageInput): Promise<CommitPageResult>;
  startRun(input: IngestionRunInput): Promise<string>;
  finishRun(runId: string, update: IngestionRunUpdate): Promise<void>;
  recordGap(gap: GapInput): Promise<GapRow>;
  listGaps(streamId?: string, limit?: number): Promise<GapRow[]>;
  getOverview(): Promise<Overview>;
  countEvents(): Promise<number>;
  countTokenTransfers(): Promise<number>;
  getEvent(id: string): Promise<EventRow | undefined>;
  getContract(contractId: string): Promise<ContractRow | undefined>;
  listRecentEvents(limit: number): Promise<EventRow[]>;
}
