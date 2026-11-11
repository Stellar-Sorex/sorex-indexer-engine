import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  XdrEventDecoder,
  decodeScVal,
  decodeSep41,
  isAddress,
  toJsonValue,
} from "../src/decoder/index.js";
import type { DecodedEvent, RawSorobanEvent } from "../src/decoder/types.js";
import { decodeFixtures, loadRawEvents } from "./helpers/fixtures.js";

function byName(events: DecodedEvent[], name: string): DecodedEvent {
  const found = events.find((event) => event.eventName === name);
  if (!found) throw new Error(`fixture has no ${name} event`);
  return found;
}

describe("XdrEventDecoder with real testnet fixtures", () => {
  const raw = loadRawEvents();
  const { events, transfers } = decodeFixtures();

  it("decodes every captured event without dropping any", () => {
    expect(raw.length).toBeGreaterThanOrEqual(20);
    expect(events).toHaveLength(raw.length);
    expect(events.every((event) => event.topicsXdr.length > 0)).toBe(true);
    expect(events.every((event) => event.standard === "sep41")).toBe(true);
  });

  it("keeps raw XDR alongside decoded JSON", () => {
    const event = events[0]!;
    expect(event.dataXdr).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(event.topicsXdr[0]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(typeof event.topicsJson[0]).toBe("string");
  });

  it("decodes a native SAC transfer with asset and decimal amount", () => {
    const event = byName(events, "transfer");
    const transfer = decodeSep41(event)!;
    expect(event.contractId).toBe("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
    expect(transfer.eventName).toBe("transfer");
    expect(transfer.asset).toBe("native");
    expect(transfer.fromAddress).toMatch(/^G/);
    expect(transfer.toAddress).toMatch(/^G/);
    expect(transfer.amount).toMatch(/^\d+$/);
    expect(transfer.toAddress).not.toBe(transfer.fromAddress);
  });

  it("decodes mint data encoded as a map", () => {
    const event = byName(events, "mint");
    const transfer = decodeSep41(event)!;
    expect(transfer.eventName).toBe("mint");
    expect(transfer.fromAddress).toBeNull();
    expect(transfer.toAddress).toMatch(/^C/);
    expect(transfer.amount).toBe("50000000");
  });

  it("decodes approve amount and expiration from a vector", () => {
    const event = byName(events, "approve");
    const transfer = decodeSep41(event)!;
    expect(transfer.spender).toMatch(/^C/);
    expect(transfer.expirationLedger).toBeTypeOf("number");
    expect(transfer.expirationLedger).toBeGreaterThan(0);
    expect(transfer.asset).toContain("USDC:");
  });

  it("decodes burn and clawback, including protocol-30 claimable balance addresses", () => {
    const burn = decodeSep41(byName(events, "burn"))!;
    expect(burn.fromAddress).toMatch(/^G/);
    expect(burn.toAddress).toBeNull();

    const clawback = decodeSep41(byName(events, "clawback"))!;
    expect(isAddress(clawback.fromAddress)).toBe(true);
    // The captured clawback claws back from a claimable balance (B...), an
    // ScAddress variant added in protocol 30.
    expect(clawback.fromAddress).toMatch(/^B/);
    expect(clawback.asset).toContain("dICE:");
  });

  it("normalises all SEP-41 fixtures into token transfers", () => {
    expect(transfers).toHaveLength(events.length);
    for (const transfer of transfers) {
      expect(transfer.amount).toMatch(/^-?\d+$/);
      expect(["transfer", "mint", "burn", "approve", "clawback"]).toContain(transfer.eventName);
    }
  });

  it("never throws on malformed XDR and keeps a typed fallback", () => {
    const malformed: RawSorobanEvent = {
      id: "0000000000000000001-0000000001",
      type: "contract",
      ledger: 1,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      txHash: "deadbeef",
      transactionIndex: 0,
      operationIndex: 0,
      topic: ["not-base64-xdr"],
      value: "definitely-not-xdr",
    };
    const decoded = new XdrEventDecoder().decode(malformed);
    expect(decoded.topicsJson[0]).toMatchObject({ type: "InvalidScVal" });
    expect(decoded.dataJson).toMatchObject({ type: "InvalidScVal" });
    expect(decoded.id).toBe(malformed.id);
    expect(decoded.eventIndex).toBe(1);
    expect(decodeSep41(decoded)).toBeNull();
  });

  it("rejects malformed SEP-41 signatures instead of guessing", () => {
    const malformed = new XdrEventDecoder().decode({
      ...loadRawEvents()[0]!,
      topic: [xdr.ScVal.scvSymbol("transfer").toXDR("base64")],
      value: nativeToScVal(10n, { type: "i128" }).toXDR("base64"),
    });
    expect(decodeSep41(malformed)).toBeNull();
  });
});

describe("SCVal JSON conversion", () => {
  it("stringifies bigints, hex-encodes bytes and keeps maps/vectors", () => {
    const big = nativeToScVal(2n ** 100n, { type: "i128" });
    expect(decodeScVal(big.toXDR("base64"))).toBe("1267650600228229401496703205376");

    const bytes = nativeToScVal(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(decodeScVal(bytes.toXDR("base64"))).toBe("deadbeef");

    const vec = nativeToScVal([1, 2, 3], { type: "u32" });
    expect(decodeScVal(vec.toXDR("base64"))).toEqual([1, 2, 3]);

    const map = nativeToScVal({ amount: 42n, symbol: "USDC" });
    expect(decodeScVal(map.toXDR("base64"))).toEqual({ amount: "42", symbol: "USDC" });

    const address = new Address("GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH");
    expect(decodeScVal(address.toScVal().toXDR("base64"))).toBe(address.toString());

    const voidValue = nativeToScVal(null);
    expect(decodeScVal(voidValue.toXDR("base64"))).toBeNull();
  });

  it("converts Maps and Buffers through the public helper", () => {
    expect(
      toJsonValue(
        new Map<unknown, unknown>([
          ["a", 1n],
          [2, new Uint8Array([1])],
        ]),
      ),
    ).toEqual({
      a: "1",
      "2": "01",
    });
    expect(toJsonValue(new Map<unknown, unknown>([[{ complex: true }, "value"]]))).toEqual({
      '{"complex":true}': "value",
    });
    expect(toJsonValue(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(toJsonValue(Number.NaN)).toBe("NaN");
  });
});
