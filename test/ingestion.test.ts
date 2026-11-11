import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { XdrEventDecoder } from "../src/decoder/index.js";
import { RetentionError } from "../src/errors.js";
import { IngestionLoop, BackfillRunner } from "../src/ingestion/index.js";
import { FixtureLedgerSource } from "../src/ledger-source/index.js";
import { createLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { KyselyStorage } from "../src/storage/index.js";
import { decodeFixtures, loadRawEvents } from "./helpers/fixtures.js";
import { TestLedgerSource } from "./helpers/sources.js";
import { createTestStorage } from "./helpers/storage.js";

const logger = createLogger("silent");
const { events: decoded } = decodeFixtures();
const rawEvents = loadRawEvents();
const fixtureStartLedger = String(Math.min(...rawEvents.map((event) => event.ledger)));

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    RPC_URL: "https://soroban-testnet.stellar.org",
    DATABASE_URL: "sqlite::memory:",
    LOG_LEVEL: "silent",
    POLL_INTERVAL_MS: "250",
    BATCH_SIZE: "200",
    // The live mode default starts at the current chain head; tests replay the
    // full captured window explicitly.
    START_LEDGER: fixtureStartLedger,
    ...overrides,
  });
}

function loopFor(
  storage: KyselyStorage,
  source: FixtureLedgerSource | TestLedgerSource,
  overrides: Record<string, string> = {},
) {
  return new IngestionLoop({
    config: config(overrides),
    source,
    storage,
    decoder: new XdrEventDecoder(),
    logger,
    metrics: new Metrics(),
    streamId: "live",
  });
}

describe("IngestionLoop", () => {
  let storage: KyselyStorage;

  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("ingests a captured testnet page and persists its cursor", async () => {
    const loop = loopFor(storage, new FixtureLedgerSource(rawEvents));
    const result = await loop.runOnce();

    expect(result.committed.insertedEvents).toBe(rawEvents.length);
    expect(result.committed.insertedTransfers).toBe(decoded.length);
    const cursor = await storage.getCursor("live");
    expect(cursor?.lastCursor).toBe(rawEvents.at(-1)!.id);
    expect((await storage.getOverview()).eventCount).toBe(rawEvents.length);
    expect(loop.health().status).toBe("running");
  });

  it("is idempotent across repeated passes", async () => {
    await loopFor(storage, new FixtureLedgerSource(rawEvents)).runOnce();
    const before = await storage.getOverview();
    const second = await loopFor(storage, new FixtureLedgerSource(rawEvents)).runOnce();
    expect(second.committed.insertedEvents).toBe(0);
    expect(second.committed.duplicateEvents).toBe(0);
    expect((await storage.getOverview()).eventCount).toBe(before.eventCount);
    expect((await storage.getOverview()).transferCount).toBe(before.transferCount);
  });

  it("honours START_LEDGER on first boot", async () => {
    const start = Math.min(...rawEvents.map((event) => event.ledger)) + 1;
    const loop = loopFor(storage, new FixtureLedgerSource(rawEvents), {
      START_LEDGER: String(start),
    });
    await loop.runOnce();
    const overview = await storage.getOverview();
    expect(overview.eventCount).toBe(rawEvents.filter((event) => event.ledger >= start).length);
    expect(overview.eventCount).toBeLessThan(rawEvents.length);
  });

  it("records an unrecoverable gap and resumes at the oldest retained ledger", async () => {
    const retention = { oldestLedger: 500, latestLedger: 600 };
    const lateEvent = { ...rawEvents[0]!, id: "0000000000000000500-0000000001", ledger: 500 };
    await storage.setCursor("live", null, 100);
    const source = new TestLedgerSource([lateEvent], retention);
    const loop = loopFor(storage, source);

    await loop.runOnce();

    const gaps = await storage.listGaps("live");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      fromLedger: 101,
      toLedger: 499,
      recoverable: false,
    });
    const cursor = await storage.getCursor("live");
    expect(cursor?.lastLedger).toBe(500);
    expect(cursor?.lastCursor).toBe(lateEvent.id);
    expect((await storage.getOverview()).eventCount).toBe(1);
    expect(loop.health().status).toBe("degraded");
  });

  it("survives source failures, reports degraded health and stops cleanly", async () => {
    const source = new TestLedgerSource(
      rawEvents,
      {
        oldestLedger: 1,
        latestLedger: 1000,
      },
      { failures: 2 },
    );
    const loop = loopFor(storage, source, { POLL_INTERVAL_MS: "300" });
    await storage.setCursor("live", null, 0);

    const abort = new AbortController();
    const running = loop.run(abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 80));
    abort.abort();
    await running;

    expect(loop.health().status).toBe("stopped");
    expect(loop.health().lastError).toContain("simulated RPC outage");
    expect((await storage.getOverview()).latestRun?.status).toBe("success");
  });

  it("records the ingestion run lifecycle", async () => {
    const loop = loopFor(storage, new FixtureLedgerSource(rawEvents));
    await loop.runOnce();
    const runs = await storage.getOverview();
    expect(runs.latestRun).not.toBeNull();
  });
});

describe("BackfillRunner", () => {
  let storage: KyselyStorage;

  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  function runner(source: FixtureLedgerSource | TestLedgerSource) {
    return new BackfillRunner({
      source,
      storage,
      decoder: new XdrEventDecoder(),
      logger,
      metrics: new Metrics(),
      batchSize: 3,
      streamId: "backfill",
    });
  }

  it("backfills only the requested range and is repeatable", async () => {
    const source = new FixtureLedgerSource(rawEvents);
    const retention = await source.getRetention();
    const to = retention.oldestLedger + 2;
    const expected = rawEvents.filter((event) => event.ledger <= to).length;

    const first = await runner(source).run(retention.oldestLedger, to);
    expect(first.insertedEvents).toBe(expected);
    expect(first.toLedger).toBe(to);

    const second = await runner(source).run(retention.oldestLedger, to);
    expect(second.insertedEvents).toBe(0);
    expect((await storage.getOverview()).eventCount).toBe(expected);
  });

  it("rejects ranges older than the RPC retention window with a clear error", async () => {
    const source = new TestLedgerSource(
      rawEvents,
      { oldestLedger: 5000, latestLedger: 6000 },
      { kind: "rpc" },
    );
    await expect(runner(source).run(100, 5500)).rejects.toThrow(RetentionError);
    await expect(runner(source).run(100, 5500)).rejects.toThrow(/archival LedgerSource/);
  });

  it("rejects ranges beyond the source's latest ledger", async () => {
    const source = new FixtureLedgerSource(rawEvents);
    const retention = await source.getRetention();
    await expect(
      runner(source).run(retention.oldestLedger, retention.latestLedger + 1),
    ).rejects.toThrow(/beyond the latest ledger/);
  });

  it("rejects invalid bounds", async () => {
    const source = new FixtureLedgerSource(rawEvents);
    const retention = await source.getRetention();
    await expect(runner(source).run(10, 5)).rejects.toThrow(/--from must be <= --to/);
    await expect(runner(source).run(-1, 5)).rejects.toThrow(/positive integer/);
    expect(retention.oldestLedger).toBeGreaterThan(0);
  });
});
