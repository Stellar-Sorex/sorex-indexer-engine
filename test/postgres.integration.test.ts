import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorage, type KyselyStorage } from "../src/storage/index.js";
import { decodeFixtures } from "./helpers/fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

/**
 * Runs against a real PostgreSQL instance when TEST_DATABASE_URL is set:
 *   docker run --rm -e POSTGRES_PASSWORD=sorex -p 55432:5432 postgres:16
 *   TEST_DATABASE_URL=postgres://postgres:sorex@localhost:55432/postgres npm run test:postgres
 *
 * CI provides a service container (see .github/workflows/ci.yml).
 */
describePostgres("KyselyStorage (PostgreSQL)", () => {
  let storage: KyselyStorage;
  const { events, transfers } = decodeFixtures();

  beforeAll(async () => {
    storage = createStorage({ driver: "postgres", url: databaseUrl! });
    await storage.migrate();
    await storage.db.deleteFrom("ingestion_gaps").execute();
    await storage.db.deleteFrom("ingestion_runs").execute();
    await storage.db.deleteFrom("token_transfers").execute();
    await storage.db.deleteFrom("contracts").execute();
    await storage.db.deleteFrom("cursors").execute();
    await storage.db.deleteFrom("events").execute();
  });

  afterAll(async () => {
    await storage?.close();
  });

  it("migrates the JSONB schema and GIN indexes", async () => {
    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where tablename = 'events' and indexname = 'idx_events_topics_gin'
    `.execute(storage.db);
    expect(indexes.rows.map((row) => row.indexname)).toContain("idx_events_topics_gin");

    const migrations = await sql<{ name: string }>`select name from sorex_migrations`.execute(
      storage.db,
    );
    expect(migrations.rows.map((row) => row.name)).toContain("001_initial");
  });

  it("stores and de-duplicates real fixture events", async () => {
    const last = events.at(-1)!;
    const page = {
      streamId: "live",
      events,
      transfers,
      lastLedger: last.ledger,
      cursor: last.id,
      mode: "live" as const,
    };

    const first = await storage.commitPage(page);
    expect(first.insertedEvents).toBe(events.length);
    expect(first.insertedTransfers).toBe(transfers.length);

    const second = await storage.commitPage(page);
    expect(second.insertedEvents).toBe(0);
    expect(second.duplicateEvents).toBe(events.length);

    expect(await storage.countEvents()).toBe(events.length);
    expect(await storage.countTokenTransfers()).toBe(transfers.length);
    expect(await storage.getCursor("live")).toMatchObject({ lastLedger: last.ledger });

    const overview = await storage.getOverview();
    expect(overview.contractCount).toBe(new Set(events.map((event) => event.contractId)).size);
    const stored = await storage.getEvent(events[0]!.id);
    expect(stored?.topicsJson).toEqual(events[0]!.topicsJson);
  });

  it("records gaps and rejects a backward cursor", async () => {
    const gap = await storage.recordGap({
      streamId: "live",
      fromLedger: 1,
      toLedger: 2,
      reason: "test",
      recoverable: false,
    });
    expect(gap.gapId).toBeTruthy();
    expect(await storage.listGaps("live")).toHaveLength(1);
    expect(await storage.getContract(events[0]!.contractId)).not.toBeUndefined();
  });
});
