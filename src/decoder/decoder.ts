import { decodeScVal } from "./json.js";
import { decodeSep41, isSep41EventName } from "./sep41.js";
import type {
  DecodedEvent,
  EventDecoder,
  JsonValue,
  RawSorobanEvent,
  TokenTransfer,
} from "./types.js";

function parseEventIndex(id: string): number {
  const match = /-(\d{1,10})$/.exec(id);
  if (!match?.[1]) return 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function safeDecodeScVal(base64: string): JsonValue {
  return decodeScVal(base64);
}

/**
 * Decodes Soroban RPC events into normalised rows and tags SEP-41 token
 * events. The decoder is total: malformed payloads produce typed fallback
 * values instead of throwing, so ingestion never drops an event.
 */
export class XdrEventDecoder implements EventDecoder {
  decode(event: RawSorobanEvent): DecodedEvent {
    const topicsXdr = Array.isArray(event.topic) ? event.topic : [];
    const topicsJson = topicsXdr.map(safeDecodeScVal);
    const dataXdr = typeof event.value === "string" ? event.value : "";
    const dataJson = dataXdr === "" ? null : safeDecodeScVal(dataXdr);
    const eventName =
      typeof topicsJson[0] === "string" && topicsJson[0].length > 0 ? topicsJson[0] : null;

    return {
      id: event.id,
      contractId: event.contractId ?? "",
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      txHash: event.txHash,
      transactionIndex: event.transactionIndex,
      operationIndex: event.operationIndex,
      eventIndex: parseEventIndex(event.id),
      type: event.type,
      topicsXdr,
      topicsJson,
      dataXdr,
      dataJson,
      inSuccessfulContractCall: event.inSuccessfulContractCall ?? true,
      eventName,
      standard: isSep41EventName(topicsJson[0]) ? "sep41" : null,
    };
  }

  /** Decode an event and, when recognised, produce its normalised token row. */
  decodeWithTransfer(event: RawSorobanEvent): {
    event: DecodedEvent;
    transfer: TokenTransfer | null;
  } {
    const decoded = this.decode(event);
    return { event: decoded, transfer: decodeSep41(decoded) };
  }
}

export { decodeSep41 };
