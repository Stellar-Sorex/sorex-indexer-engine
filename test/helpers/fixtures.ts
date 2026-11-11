import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { XdrEventDecoder, decodeSep41 } from "../../src/decoder/index.js";
import type { DecodedEvent, RawSorobanEvent, TokenTransfer } from "../../src/decoder/types.js";

export interface FixtureFile {
  description: string;
  network: string;
  rpc: string;
  capturedAt: string;
  latestLedger: number;
  oldestLedger: number;
  events: RawSorobanEvent[];
}

const fixtureUrl = new URL("../fixtures/testnet-events.json", import.meta.url);

export function loadFixture(): FixtureFile {
  return JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as FixtureFile;
}

export function loadRawEvents(): RawSorobanEvent[] {
  return loadFixture().events;
}

export function decodeFixtures(): {
  events: DecodedEvent[];
  transfers: TokenTransfer[];
} {
  const decoder = new XdrEventDecoder();
  const events: DecodedEvent[] = [];
  const transfers: TokenTransfer[] = [];
  for (const raw of loadRawEvents()) {
    const event = decoder.decode(raw);
    events.push(event);
    const transfer = decodeSep41(event);
    if (transfer) transfers.push(transfer);
  }
  return { events, transfers };
}
