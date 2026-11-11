import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionEnricher } from "../src/ingestion/enrich.js";
import { createLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { KyselyStorage } from "../src/storage/index.js";
import {
  parseTransactionResponse,
  type RawTransactionResponse,
} from "../src/transactions/index.js";
import { decodeFixtures, loadRawEvents } from "./helpers/fixtures.js";
import { createTestStorage } from "./helpers/storage.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/testnet-transaction.json", import.meta.url)),
    "utf8",
  ),
) as { result: RawTransactionResponse };

describe("transaction resource parsing", () => {
  it("parses declared Soroban resources and the fee charged from real testnet XDR", () => {
    const record = parseTransactionResponse("a-tx-hash", fixture.result)!;
    expect(record.successful).toBe(true);
    expect(record.ledger).toBe(5670000);
    expect(BigInt(record.feeCharged)).toBeGreaterThan(0n);
    expect(record.hasSorobanData).toBe(true);
    expect(record.cpuInstructions).toBeGreaterThan(0);
    expect(record.readBytes).toBeGreaterThanOrEqual(0);
    expect(record.writeBytes).toBeGreaterThanOrEqual(0);
    expect(record.resourceFee).toMatch(/^\d+$/);
    expect(record.memoryBytes).toBeNull();
    expect(record.envelopeSizeBytes).toBeGreaterThan(0);
    expect(record.operationCount).toBeGreaterThan(0);
    expect(record.feeBump).toBe(false);
  });

  it("returns null for missing or unparseable transactions", () => {
    expect(parseTransactionResponse("missing", { status: "NOT_FOUND" })).toBeNull();
    expect(
      parseTransactionResponse("bad", { ...fixture.result, envelopeXdr: "not-xdr" }),
    ).toBeNull();
    expect(parseTransactionResponse("bad", { status: "SUCCESS" })).toBeNull();
  });
});

describe("transaction storage and enrichment", () => {
  let storage: KyselyStorage;

  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("stores transaction metadata idempotently and finds un-enriched hashes", async () => {
    const { events } = decodeFixtures();
    const last = events.at(-1)!;
    await storage.commitPage({
      streamId: "live",
      events,
      transfers: [],
      cursor: last.id,
      lastLedger: last.ledger,
      mode: "live",
    });

    const pending = await storage.listTransactionHashesWithoutMetadata(100);
    expect(pending.length).toBeGreaterThan(0);

    const record = parseTransactionResponse("tx-1", {
      ...fixture.result,
      createdAt: 1_760_000_000,
    })!;
    expect(await storage.commitTransactions([record])).toBe(1);
    expect(await storage.commitTransactions([record])).toBe(0);

    const stored = await storage.getTransaction("tx-1");
    expect(stored).toMatchObject({
      txHash: "tx-1",
      successful: true,
      hasSorobanData: true,
      memoryBytes: null,
    });
    expect(stored?.ledgerClosedAt).toBe(new Date(1_760_000_000 * 1000).toISOString());
  });

  it("enriches stored events exactly once", async () => {
    const { events } = decodeFixtures();
    const last = events.at(-1)!;
    await storage.commitPage({
      streamId: "live",
      events,
      transfers: [],
      cursor: last.id,
      lastLedger: last.ledger,
      mode: "live",
    });

    const getTransaction = vi.fn(async () => fixture.result);
    const enricher = new TransactionEnricher({
      fetcher: { getTransaction },
      storage,
      logger: createLogger("silent"),
      metrics: new Metrics(),
    });

    const uniqueHashes = new Set(events.map((event) => event.txHash)).size;
    const first = await enricher.enrich(events);
    expect(first).toBe(uniqueHashes);
    expect(getTransaction).toHaveBeenCalledTimes(uniqueHashes);

    const second = await enricher.enrich(events);
    expect(second).toBe(0);
    expect(getTransaction).toHaveBeenCalledTimes(uniqueHashes);

    const pending = await storage.listTransactionHashesWithoutMetadata(100);
    expect(pending).toHaveLength(0);
  });

  it("skips missing transactions without failing ingestion", async () => {
    const event = loadRawEvents()[0]!;
    const enricher = new TransactionEnricher({
      fetcher: { getTransaction: async () => null },
      storage,
      logger: createLogger("silent"),
      metrics: new Metrics(),
    });
    expect(
      await enricher.enrichHashes([{ txHash: event.txHash, ledgerClosedAt: event.ledgerClosedAt }]),
    ).toBe(0);
  });
});
