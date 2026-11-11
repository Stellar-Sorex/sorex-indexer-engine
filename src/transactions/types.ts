/**
 * Transaction-level data used for the resource-consumption panel.
 *
 * Soroban CPU instructions and read/write bytes in a transaction envelope are
 * the *declared limits* the submitter paid for, not measured usage. Public
 * RPC does not expose measured memory bytes for historical transactions, so
 * `memoryBytes` is null unless a source explicitly provides it. The UI labels
 * these fields accordingly; nothing is estimated or invented.
 */
export interface TransactionRecord {
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  applicationOrder: number;
  successful: boolean;
  feeBump: boolean;
  /** Actual fee charged by the network, in stroops (decimal string). */
  feeCharged: string;
  /** Soroban resource fee declared in the envelope, in stroops. */
  resourceFee: string | null;
  /** Declared CPU instruction limit from `SorobanTransactionData`. */
  cpuInstructions: number | null;
  /** Measured memory usage is not returned by Soroban RPC; kept for API shape. */
  memoryBytes: number | null;
  /** Declared disk read byte limit. */
  readBytes: number | null;
  /** Declared write byte limit. */
  writeBytes: number | null;
  envelopeSizeBytes: number;
  operationCount: number;
  hasSorobanData: boolean;
}

/** Minimal raw `getTransaction` response needed by the parser. */
export interface RawTransactionResponse {
  status: string;
  ledger?: number;
  applicationOrder?: number;
  feeBump?: boolean;
  createdAt?: number;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
}
