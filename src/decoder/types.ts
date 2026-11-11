/**
 * JSON-safe representation of decoded SCVal data. Big integers become decimal
 * strings and byte arrays become lowercase hex strings so nothing is lost.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Raw event as returned by Soroban RPC `getEvents` (base64 XDR payloads). */
export interface RawSorobanEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  /** Base64-encoded `ScVal` values. */
  topic: string[];
  /** Base64-encoded `ScVal` value. */
  value: string;
  inSuccessfulContractCall?: boolean;
}

/** A SEP-41 event recognised by the decoder. */
export type Sep41EventName = "transfer" | "mint" | "burn" | "approve" | "clawback";

/** One event after normalisation; this is what gets persisted. */
export interface DecodedEvent {
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
  /** First topic when it is a symbol, e.g. `transfer`. */
  eventName: string | null;
  /** `sep41` when a known SEP-41 signature matched, otherwise null. */
  standard: "sep41" | null;
}

/** Normalised row in `token_transfers`. */
export interface TokenTransfer {
  eventId: string;
  contractId: string;
  eventName: Sep41EventName;
  asset: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  spender: string | null;
  amount: string;
  expirationLedger: number | null;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

/** Implemented by every decoder (the XDR decoder today, a Rust service later). */
export interface EventDecoder {
  decode(event: RawSorobanEvent): DecodedEvent;
}
