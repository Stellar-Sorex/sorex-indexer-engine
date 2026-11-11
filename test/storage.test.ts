import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KyselyStorage } from "../src/storage/index.js";
import { decodeFixtures } from "./helpers/fixtures.js";
import { createTestStorage } from "./helpers/storage.js";
import type { CommitPageInput } from "../src/storage/types.js";

const { events, transfers } = decodeFixtures();

function page(overrides: Partial<CommitPageInput> = {}): CommitPageInput {
  const last = events.at(-1)!;
  return {
    streamId: "live",
    events,
    transfers,
    lastLedger: last.ledger,
    mode: "live",
    cursor: last.id,
    ...overrides,
  };
}

describe("KyselyStorage (SQLite)", () => {
  let storage: KyselyStorage;

  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("persists events, token transfers, contracts and a cursor atomically", async () => {
    const result = await storage.commitPage(page());
    expect(result.insertedEvents).toBe(events.length);
    expect(result.duplicateEvents).toBe(0);
    expect(result.insertedTransfers).toBe(events.length);

    const cursor = await storage.getCursor("live");
    expect(cursor).toMatchObject({
      lastCursor: events.at(-1)!.id,
      lastLedger: events.at(-1)!.ledger,
    });

    const overview = await storage.getOverview();
    expect(overview.eventCount).toBe(events.length);
    expect(overview.transferCount).toBe(events.length);
    expect(overview.contractCount).toBe(new Set(events.map((event) => event.contractId)).size);
    expect(overview.latestLedger).toBe(Math.max(...events.map((event) => event.ledger)));
    expect(overview.cursors).toHaveLength(1);
  });

  it("is idempotent when the same range is ingested twice", async () => {
    await storage.commitPage(page());
    const before = await storage.getOverview();
    const contractsBefore = await Promise.all(
      [...new Set(events.map((event) => event.contractId))].map((id) => storage.getContract(id)),
    );

    const second = await storage.commitPage(page());
    expect(second).toEqual({
      insertedEvents: 0,
      duplicateEvents: events.length,
      insertedTransfers: 0,
    });

    const after = await storage.getOverview();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.transferCount).toBe(before.transferCount);
    expect(after.contractCount).toBe(before.contractCount);
    expect(after.latestLedger).toBe(before.latestLedger);

    const contractsAfter = await Promise.all(
      [...new Set(events.map((event) => event.contractId))].map((id) => storage.getContract(id)),
    );
    expect(contractsAfter).toEqual(contractsBefore);
  });

  it("round-trips event JSON, raw XDR and flags", async () => {
    await storage.commitPage(page());
    const event = events[0]!;
    const stored = await storage.getEvent(event.id);
    expect(stored).toMatchObject({
      id: event.id,
      contractId: event.contractId,
      topicsXdr: event.topicsXdr,
      topicsJson: event.topicsJson,
      dataXdr: event.dataXdr,
      dataJson: event.dataJson,
      standard: "sep41",
    });
    expect(stored?.eventIndex).toBe(event.eventIndex);
    expect(stored?.inSuccessfulContractCall).toBe(true);
    const recent = await storage.listRecentEvents(5);
    expect(recent).toHaveLength(Math.min(5, events.length));
  });

  it("never moves a cursor backwards", async () => {
    await storage.commitPage(page({ streamId: "cursor-test" }));
    const before = await storage.getCursor("cursor-test");
    await storage.commitPage(
      page({
        streamId: "cursor-test",
        events: events.slice(0, 1).map((event) => ({ ...event, ledger: 1 })),
        transfers: [],
        lastLedger: 1,
        cursor: "older-cursor",
      }),
    );
    const after = await storage.getCursor("cursor-test");
    expect(after?.lastLedger).toBe(before?.lastLedger);
    expect(after?.lastCursor).toBe(before?.lastCursor);
  });

  it("records and lists gaps, runs and overview metadata", async () => {
    const gap = await storage.recordGap({
      streamId: "live",
      fromLedger: 10,
      toLedger: 20,
      reason: "outside retention",
      recoverable: false,
    });
    expect(gap.gapId).toBeTruthy();
    expect(await storage.listGaps("live")).toHaveLength(1);
    expect(await storage.listGaps("other")).toHaveLength(0);

    const runId = await storage.startRun({
      streamId: "live",
      mode: "backfill",
      fromLedger: 10,
      toLedger: 20,
    });
    await storage.finishRun(runId, {
      status: "success",
      eventsIngested: 3,
      duplicates: 1,
      toLedger: 20,
    });
    const overview = await storage.getOverview();
    expect(overview.latestRun).toMatchObject({
      runId,
      mode: "backfill",
      status: "success",
      eventsIngested: 3,
      duplicates: 1,
    });
    expect(overview.latestGap?.gapId).toBe(gap.gapId);
  });

  it("forces cursor positions for gap recovery", async () => {
    await storage.setCursor("live", null, 99);
    expect(await storage.getCursor("live")).toMatchObject({ lastCursor: null, lastLedger: 99 });
    await storage.setCursor("live", "abc", 100);
    expect(await storage.getCursor("live")).toMatchObject({ lastCursor: "abc", lastLedger: 100 });
  });
});
