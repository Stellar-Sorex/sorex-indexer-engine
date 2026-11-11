import { XdrEventDecoder } from "../decoder/decoder.js";
import { decodeSep41 } from "../decoder/sep41.js";
import type {
  DecodedEvent,
  EventDecoder,
  RawSorobanEvent,
  TokenTransfer,
} from "../decoder/types.js";

export interface DecodedBatch {
  events: DecodedEvent[];
  transfers: TokenTransfer[];
  sep41Count: number;
}

/**
 * Decode a page of raw events. A decoding failure can only ever produce a
 * fallback JSON value; it never removes the event from the batch.
 */
export function decodeBatch(
  events: RawSorobanEvent[],
  decoder: EventDecoder = new XdrEventDecoder(),
): DecodedBatch {
  const decoded: DecodedEvent[] = [];
  const transfers: TokenTransfer[] = [];
  let sep41Count = 0;

  for (const raw of events) {
    const event = decoder.decode(raw);
    const transfer = event.standard === "sep41" ? decodeSep41(event) : null;
    if (transfer) {
      transfers.push(transfer);
      sep41Count += 1;
    }
    decoded.push(event);
  }

  return { events: decoded, transfers, sep41Count };
}
