import type { DecodedEvent, JsonValue, Sep41EventName, TokenTransfer } from "./types.js";
import { isAddress, isPlainObject } from "./json.js";

export const SEP41_EVENT_NAMES: readonly Sep41EventName[] = [
  "transfer",
  "mint",
  "burn",
  "approve",
  "clawback",
];

const SEP41_EVENT_SET = new Set<string>(SEP41_EVENT_NAMES);

/** True when a decoded topic-0 value names a known SEP-41 event. */
export function isSep41EventName(value: JsonValue | undefined): value is Sep41EventName {
  return typeof value === "string" && SEP41_EVENT_SET.has(value);
}

function asAmount(value: JsonValue | undefined): string | null {
  // Wide integers arrive from the decoder as decimal strings; plain JS
  // integers (u32/i32) arrive as numbers.
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  return null;
}

function asLedger(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** SEP-41 `approve` encodes `[amount, live_until_ledger]`; others encode the amount. */
function unpackData(data: JsonValue): { amount: string | null; expirationLedger: number | null } {
  if (Array.isArray(data)) {
    return { amount: asAmount(data[0]), expirationLedger: asLedger(data[1]) };
  }
  if (isPlainObject(data)) {
    return {
      amount: asAmount(data.amount),
      expirationLedger: asLedger(data.expiration ?? data.live_until_ledger),
    };
  }
  return { amount: asAmount(data), expirationLedger: null };
}

function assetFromTopic(topic: JsonValue | undefined): string | null {
  if (typeof topic === "string" && !isAddress(topic)) return topic;
  if (typeof topic === "number") return String(topic);
  if (topic === null) return null;
  if (isPlainObject(topic)) {
    const raw = topic.asset ?? topic.code ?? topic.symbol;
    return typeof raw === "string" ? raw : null;
  }
  return null;
}

/**
 * Normalise a decoded SEP-41 event into a `token_transfers` row.
 *
 * Recognised shapes (the asset identifier is optional and appended by the
 * Stellar Asset Contract as a fourth topic):
 * - `transfer(from, to[, asset])` data: amount
 * - `mint(to[, asset])` data: amount
 * - `burn(from[, asset])` data: amount
 * - `approve(from, spender[, asset])` data: `[amount, live_until_ledger]`
 * - `clawback(from[, asset])` data: amount (`from` may be a claimable balance)
 *
 * Returns `null` for malformed events rather than guessing at addresses or
 * amounts. The generic event row still keeps the raw XDR.
 */
export function decodeSep41(event: DecodedEvent): TokenTransfer | null {
  const eventName = event.topicsJson[0];
  if (!isSep41EventName(eventName)) return null;

  const topic = (index: number): JsonValue | undefined => event.topicsJson[index];
  const fromTopic = topic(1);
  const secondTopic = topic(2);
  const thirdTopic = topic(3);

  let fromAddress: string | null = null;
  let toAddress: string | null = null;
  let spender: string | null = null;
  let asset: string | null = null;

  switch (eventName) {
    case "transfer":
      if (!isAddress(fromTopic) || !isAddress(secondTopic)) return null;
      fromAddress = fromTopic;
      toAddress = secondTopic;
      asset = assetFromTopic(thirdTopic);
      break;
    case "mint":
      if (!isAddress(fromTopic)) return null;
      toAddress = fromTopic;
      asset = assetFromTopic(secondTopic);
      break;
    case "burn":
      if (!isAddress(fromTopic)) return null;
      fromAddress = fromTopic;
      asset = assetFromTopic(secondTopic);
      break;
    case "approve":
      if (!isAddress(fromTopic) || !isAddress(secondTopic)) return null;
      fromAddress = fromTopic;
      spender = secondTopic;
      asset = assetFromTopic(thirdTopic);
      break;
    case "clawback":
      // SAC shape: ["clawback", from, asset?]. `from` may be a claimable
      // balance address; it is never a destination.
      if (!isAddress(fromTopic)) return null;
      fromAddress = fromTopic;
      asset = assetFromTopic(secondTopic) ?? assetFromTopic(thirdTopic);
      break;
  }

  const { amount, expirationLedger } = unpackData(event.dataJson);
  if (amount === null) return null;

  return {
    eventId: event.id,
    contractId: event.contractId,
    eventName,
    asset,
    fromAddress,
    toAddress,
    spender,
    amount,
    expirationLedger,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
  };
}
