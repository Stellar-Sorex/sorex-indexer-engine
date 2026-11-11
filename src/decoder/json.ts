import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { JsonValue } from "./types.js";

/**
 * True when a decoded value is any Stellar StrKey address. Protocol 30 adds
 * claimable-balance (B), liquidity-pool (L), muxed-account (M) and
 * muxed-contract addresses to Soroban's `ScAddress`, so checking only G/C
 * would drop real token events.
 */
export function isAddress(value: JsonValue | undefined): value is string {
  if (typeof value !== "string") return false;
  return (
    StrKey.isValidEd25519PublicKey(value) ||
    StrKey.isValidContract(value) ||
    StrKey.isValidMed25519PublicKey(value) ||
    StrKey.isValidClaimableBalance(value) ||
    StrKey.isValidLiquidityPool(value) ||
    StrKey.isValidMuxedContract(value)
  );
}

/** True for a JSON object (and not an array or null). */
export function isPlainObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function mapKeyLabel(key: unknown): string {
  switch (typeof key) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(key);
    case "object": {
      if (key === null) return "null";
      const converted = toJsonValue(key);
      return typeof converted === "string" ? converted : JSON.stringify(converted);
    }
    default:
      return String(key);
  }
}

/**
 * Convert a value returned by `scValToNative` into a JSON-safe value.
 *
 * - bigint → decimal string (prevents precision loss and JSON serialisation errors)
 * - Uint8Array/Buffer → lowercase hex string
 * - Map → object keyed by a stable string label
 * - unknown objects → recursively converted properties
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;

  switch (typeof value) {
    case "bigint":
      return value.toString(10);
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "symbol":
    case "function":
      return String(value);
    case "object":
      break;
  }

  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Map) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entryValue] of value.entries()) {
      let label = mapKeyLabel(key);
      // Do not silently overwrite an earlier key with the same label.
      if (Object.hasOwn(result, label)) label = `${label}#${Object.keys(result).length}`;
      result[label] = toJsonValue(entryValue);
    }
    return result;
  }

  const result: { [key: string]: JsonValue } = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toJsonValue(entryValue);
  }
  return result;
}

/**
 * Decode one base64-encoded `ScVal` into a JSON value.
 *
 * This function never throws: invalid XDR and SCVal types the SDK cannot
 * represent become a typed fallback object that retains the raw base64 input,
 * so an event is never dropped because of one exotic value.
 */
export function decodeScVal(base64: string): JsonValue {
  let scv: xdr.ScVal;
  try {
    scv = xdr.ScVal.fromXDR(base64, "base64");
  } catch (error) {
    return {
      type: "InvalidScVal",
      raw: base64,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    return toJsonValue(scValToNative(scv));
  } catch (error) {
    return {
      type: scv.type,
      raw: base64,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
