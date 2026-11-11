import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { Pool } from "pg";
import type { DecodedEvent, JsonValue, TokenTransfer } from "../decoder/types.js";
import { StorageError } from "../errors.js";
import type { LogLevel } from "../config.js";
import { migrationStatements, type Dialect } from "./migrations.js";
import type {
  CommitPageInput,
  CommitPageResult,
  ContractRow,
  CursorState,
  EventRow,
  GapInput,
  GapRow,
  IngestionMode,
  IngestionRunInput,
  IngestionRunRow,
  IngestionRunUpdate,
  Overview,
  Storage,
} from "./types.js";

interface EventsTable {
  id: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
  tx_index: number;
  op_index: number;
  event_index: number;
  type: string;
  topics_xdr: string;
  topics_json: string;
  data_xdr: string;
  data_json: string;
  in_successful_contract_call: boolean | number;
  event_name: string | null;
  standard: string | null;
  indexed_at: string;
}

interface CursorsTable {
  stream_id: string;
  last_cursor: string | null;
  last_ledger: number;
  updated_at: string;
}

interface TokenTransfersTable {
  event_id: string;
  contract_id: string;
  event_name: string;
  asset: string | null;
  from_address: string | null;
  to_address: string | null;
  spender: string | null;
  amount: string;
  expiration_ledger: number | null;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
}

interface ContractsTable {
  contract_id: string;
  first_seen_ledger: number;
  last_seen_ledger: number;
  event_count: number;
  updated_at: string;
}

interface IngestionRunsTable {
  run_id: string;
  stream_id: string;
  mode: string;
  started_at: string;
  finished_at: string | null;
  from_ledger: number | null;
  to_ledger: number | null;
  events_ingested: number;
  duplicates: number;
  status: string;
  error: string | null;
}

interface IngestionGapsTable {
  gap_id: string;
  stream_id: string;
  from_ledger: number;
  to_ledger: number;
  detected_at: string;
  reason: string;
  recoverable: boolean | number;
}

interface Database {
  events: EventsTable;
  cursors: CursorsTable;
  token_transfers: TokenTransfersTable;
  contracts: ContractsTable;
  ingestion_runs: IngestionRunsTable;
  ingestion_gaps: IngestionGapsTable;
}

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly dialect: Dialect) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const dialect = this.dialect;
    return {
      "001_initial": {
        async up(db): Promise<void> {
          const database = db as unknown as Kysely<Database>;
          for (const statement of migrationStatements(dialect)) {
            await sql.raw(statement).execute(database);
          }
        },
        async down(db): Promise<void> {
          const database = db as unknown as Kysely<Database>;
          const tables = [
            "ingestion_gaps",
            "ingestion_runs",
            "contracts",
            "token_transfers",
            "cursors",
            "events",
          ];
          for (const table of tables) {
            await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(database);
          }
        },
      },
    };
  }
}

export interface StorageOptions {
  driver: Dialect;
  url: string;
  logger?: { warn: (obj: object, message: string) => void };
}

function sqlitePath(url: string): string {
  const target = url.replace(/^sqlite:(\/\/)?/, "");
  if (target === "" || target === ":memory:") return ":memory:";
  return target;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseJson<T extends JsonValue>(value: unknown, fallback: T): JsonValue {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return fallback;
    }
  }
  return value as JsonValue;
}

function isoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class KyselyStorage implements Storage {
  readonly #db: Kysely<Database>;
  readonly #dialect: Dialect;
  readonly #sqlite?: Database.Database;
  readonly #logger?: StorageOptions["logger"];

  constructor(options: StorageOptions) {
    this.#dialect = options.driver;
    this.#logger = options.logger;

    if (options.driver === "postgres") {
      const pool = new Pool({
        connectionString: options.url,
        max: 10,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      });
      pool.on("error", (error) => {
        this.#logger?.warn({ err: error }, "idle PostgreSQL client error");
      });
      this.#db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    } else {
      const target = sqlitePath(options.url);
      if (target !== ":memory:") mkdirSync(dirname(target), { recursive: true });
      const sqlite = new Database(target);
      if (target !== ":memory:") sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("busy_timeout = 5000");
      this.#sqlite = sqlite;
      this.#db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    }
  }

  get dialect(): Dialect {
    return this.#dialect;
  }

  /** Expose a Kysely instance for integration tests and tooling. */
  get db(): Kysely<Database> {
    return this.#db;
  }

  async migrate(): Promise<void> {
    try {
      const migrator = new Migrator({
        db: this.#db,
        provider: new StaticMigrationProvider(this.#dialect),
        migrationTableName: "sorex_migrations",
        migrationLockTableName: "sorex_migration_lock",
      });
      const { error, results } = await migrator.migrateToLatest();
      for (const result of results ?? []) {
        if (result.status === "Error") {
          throw new StorageError(`Migration ${result.migrationName} failed`, {
            cause: result,
          });
        }
      }
      if (error) throw error;
    } catch (error) {
      throw new StorageError(
        `Failed to migrate ${this.#dialect} database: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    await this.#db.destroy();
    if (this.#sqlite?.open) this.#sqlite.close();
  }

  async getCursor(streamId: string): Promise<CursorState | undefined> {
    const row = await this.#db
      .selectFrom("cursors")
      .selectAll()
      .where("stream_id", "=", streamId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      streamId: row.stream_id,
      lastCursor: row.last_cursor,
      lastLedger: toNumber(row.last_ledger),
      updatedAt: isoString(row.updated_at),
    };
  }

  async setCursor(streamId: string, lastCursor: string | null, lastLedger: number): Promise<void> {
    const timestamp = nowIso();
    await this.#db
      .insertInto("cursors")
      .values({
        stream_id: streamId,
        last_cursor: lastCursor,
        last_ledger: lastLedger,
        updated_at: timestamp,
      })
      .onConflict((conflict) =>
        conflict.column("stream_id").doUpdateSet({
          last_cursor: lastCursor,
          last_ledger: lastLedger,
          updated_at: timestamp,
        }),
      )
      .execute();
  }

  /**
   * Persist a decoded page and its cursor atomically. Events are keyed by their
   * RPC event id, so replaying any ledger range is safe: duplicates are
   * ignored, contract counters only move for newly inserted rows, and the
   * cursor never moves backwards.
   */
  async commitPage(input: CommitPageInput): Promise<CommitPageResult> {
    try {
      return await this.#db.transaction().execute(async (trx) => {
        let insertedIds: string[] = [];

        if (input.events.length > 0) {
          const rows = input.events.map((event) => this.#eventToRow(event));
          const inserted = await trx
            .insertInto("events")
            .values(rows)
            .onConflict((conflict) => conflict.column("id").doNothing())
            .returning("id")
            .execute();
          insertedIds = inserted.map((row) => row.id);
        }

        const insertedSet = new Set(insertedIds);

        let insertedTransfers = 0;
        const transferRows = input.transfers
          .filter((transfer) => insertedSet.has(transfer.eventId))
          .map((transfer) => this.#transferToRow(transfer));
        if (transferRows.length > 0) {
          const inserted = await trx
            .insertInto("token_transfers")
            .values(transferRows)
            .onConflict((conflict) => conflict.column("event_id").doNothing())
            .returning("event_id")
            .execute();
          insertedTransfers = inserted.length;
        }

        const contractAggregates = new Map<
          string,
          { first: number; last: number; count: number }
        >();
        for (const event of input.events) {
          if (!insertedSet.has(event.id) || event.contractId === "") continue;
          const aggregate = contractAggregates.get(event.contractId);
          if (aggregate) {
            aggregate.first = Math.min(aggregate.first, event.ledger);
            aggregate.last = Math.max(aggregate.last, event.ledger);
            aggregate.count += 1;
          } else {
            contractAggregates.set(event.contractId, {
              first: event.ledger,
              last: event.ledger,
              count: 1,
            });
          }
        }

        if (contractAggregates.size > 0) {
          const timestamp = nowIso();
          const rows = [...contractAggregates.entries()].map(([contractId, aggregate]) => ({
            contract_id: contractId,
            first_seen_ledger: aggregate.first,
            last_seen_ledger: aggregate.last,
            event_count: aggregate.count,
            updated_at: timestamp,
          }));
          await trx
            .insertInto("contracts")
            .values(rows)
            .onConflict((conflict) =>
              conflict.column("contract_id").doUpdateSet({
                event_count: sql`contracts.event_count + excluded.event_count`,
                first_seen_ledger:
                  this.#dialect === "postgres"
                    ? sql`least(contracts.first_seen_ledger, excluded.first_seen_ledger)`
                    : sql`min(contracts.first_seen_ledger, excluded.first_seen_ledger)`,
                last_seen_ledger:
                  this.#dialect === "postgres"
                    ? sql`greatest(contracts.last_seen_ledger, excluded.last_seen_ledger)`
                    : sql`max(contracts.last_seen_ledger, excluded.last_seen_ledger)`,
                updated_at: sql`excluded.updated_at`,
              }),
            )
            .execute();
        }

        const existing = await trx
          .selectFrom("cursors")
          .select(["last_cursor", "last_ledger"])
          .where("stream_id", "=", input.streamId)
          .executeTakeFirst();

        const existingLedger = existing ? toNumber(existing.last_ledger) : 0;
        const cursorMovesForward = input.lastLedger >= existingLedger;
        const nextCursor = cursorMovesForward
          ? (input.cursor ?? existing?.last_cursor ?? null)
          : (existing?.last_cursor ?? null);
        const nextLedger = Math.max(existingLedger, input.lastLedger);
        const timestamp = nowIso();

        await trx
          .insertInto("cursors")
          .values({
            stream_id: input.streamId,
            last_cursor: nextCursor,
            last_ledger: nextLedger,
            updated_at: timestamp,
          })
          .onConflict((conflict) =>
            conflict.column("stream_id").doUpdateSet({
              last_cursor: nextCursor,
              last_ledger: nextLedger,
              updated_at: timestamp,
            }),
          )
          .execute();

        return {
          insertedEvents: insertedIds.length,
          duplicateEvents: input.events.length - insertedIds.length,
          insertedTransfers,
        };
      });
    } catch (error) {
      throw new StorageError(
        `Failed to commit page for stream ${input.streamId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async startRun(input: IngestionRunInput): Promise<string> {
    const runId = randomUUID();
    await this.#db
      .insertInto("ingestion_runs")
      .values({
        run_id: runId,
        stream_id: input.streamId,
        mode: input.mode,
        started_at: nowIso(),
        finished_at: null,
        from_ledger: input.fromLedger,
        to_ledger: input.toLedger,
        events_ingested: 0,
        duplicates: 0,
        status: "running",
        error: null,
      })
      .execute();
    return runId;
  }

  async finishRun(runId: string, update: IngestionRunUpdate): Promise<void> {
    await this.#db
      .updateTable("ingestion_runs")
      .set({
        status: update.status,
        finished_at: nowIso(),
        events_ingested: update.eventsIngested,
        duplicates: update.duplicates ?? 0,
        to_ledger: update.toLedger ?? null,
        error: update.error ?? null,
      })
      .where("run_id", "=", runId)
      .execute();
  }

  async recordGap(gap: GapInput): Promise<GapRow> {
    const row: IngestionGapsTable = {
      gap_id: randomUUID(),
      stream_id: gap.streamId,
      from_ledger: gap.fromLedger,
      to_ledger: gap.toLedger,
      detected_at: nowIso(),
      reason: gap.reason,
      recoverable: this.#dialect === "postgres" ? gap.recoverable : gap.recoverable ? 1 : 0,
    };
    await this.#db.insertInto("ingestion_gaps").values(row).execute();
    return {
      gapId: row.gap_id,
      streamId: row.stream_id,
      fromLedger: row.from_ledger,
      toLedger: row.to_ledger,
      detectedAt: row.detected_at,
      reason: row.reason,
      recoverable: truthy(row.recoverable),
    };
  }

  async listGaps(streamId?: string, limit = 20): Promise<GapRow[]> {
    let query = this.#db.selectFrom("ingestion_gaps").selectAll();
    if (streamId) query = query.where("stream_id", "=", streamId);
    const rows = await query.orderBy("detected_at", "desc").limit(limit).execute();
    return rows.map((row) => ({
      gapId: row.gap_id,
      streamId: row.stream_id,
      fromLedger: toNumber(row.from_ledger),
      toLedger: toNumber(row.to_ledger),
      detectedAt: isoString(row.detected_at),
      reason: row.reason,
      recoverable: truthy(row.recoverable),
    }));
  }

  async getOverview(): Promise<Overview> {
    const [
      eventCount,
      transferCount,
      contractCount,
      latestLedgerRow,
      cursorRows,
      latestRunRow,
      latestGap,
    ] = await Promise.all([
      this.countEvents(),
      this.countTokenTransfers(),
      this.#db
        .selectFrom("contracts")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .executeTakeFirst(),
      this.#db
        .selectFrom("events")
        .select((expression) => expression.fn.max("ledger").as("max_ledger"))
        .executeTakeFirst(),
      this.#db.selectFrom("cursors").selectAll().orderBy("stream_id", "asc").execute(),
      this.#db
        .selectFrom("ingestion_runs")
        .selectAll()
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst(),
      this.#db
        .selectFrom("ingestion_gaps")
        .selectAll()
        .orderBy("detected_at", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);

    return {
      eventCount,
      transferCount,
      contractCount: toNumber(contractCount?.count ?? 0),
      latestLedger:
        latestLedgerRow?.max_ledger === null || latestLedgerRow?.max_ledger === undefined
          ? null
          : toNumber(latestLedgerRow.max_ledger),
      cursors: cursorRows.map((row) => ({
        streamId: row.stream_id,
        lastCursor: row.last_cursor,
        lastLedger: toNumber(row.last_ledger),
        updatedAt: isoString(row.updated_at),
      })),
      latestRun: latestRunRow ? this.#mapRun(latestRunRow) : null,
      latestGap: latestGap
        ? {
            gapId: latestGap.gap_id,
            streamId: latestGap.stream_id,
            fromLedger: toNumber(latestGap.from_ledger),
            toLedger: toNumber(latestGap.to_ledger),
            detectedAt: isoString(latestGap.detected_at),
            reason: latestGap.reason,
            recoverable: truthy(latestGap.recoverable),
          }
        : null,
    };
  }

  async countEvents(): Promise<number> {
    const row = await this.#db
      .selectFrom("events")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirst();
    return toNumber(row?.count ?? 0);
  }

  async countTokenTransfers(): Promise<number> {
    const row = await this.#db
      .selectFrom("token_transfers")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirst();
    return toNumber(row?.count ?? 0);
  }

  async getEvent(id: string): Promise<EventRow | undefined> {
    const row = await this.#db
      .selectFrom("events")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.#mapEvent(row) : undefined;
  }

  async getContract(contractId: string): Promise<ContractRow | undefined> {
    const row = await this.#db
      .selectFrom("contracts")
      .selectAll()
      .where("contract_id", "=", contractId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      contractId: row.contract_id,
      firstSeenLedger: toNumber(row.first_seen_ledger),
      lastSeenLedger: toNumber(row.last_seen_ledger),
      eventCount: toNumber(row.event_count),
      updatedAt: isoString(row.updated_at),
    };
  }

  async listRecentEvents(limit: number): Promise<EventRow[]> {
    const rows = await this.#db
      .selectFrom("events")
      .selectAll()
      .orderBy("ledger", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => this.#mapEvent(row));
  }

  #eventToRow(event: DecodedEvent): EventsTable {
    return {
      id: event.id,
      contract_id: event.contractId,
      ledger: event.ledger,
      ledger_closed_at: event.ledgerClosedAt,
      tx_hash: event.txHash,
      tx_index: event.transactionIndex,
      op_index: event.operationIndex,
      event_index: event.eventIndex,
      type: event.type,
      topics_xdr: JSON.stringify(event.topicsXdr),
      topics_json: JSON.stringify(event.topicsJson),
      data_xdr: event.dataXdr,
      data_json: JSON.stringify(event.dataJson),
      in_successful_contract_call:
        this.#dialect === "postgres"
          ? event.inSuccessfulContractCall
          : event.inSuccessfulContractCall
            ? 1
            : 0,
      event_name: event.eventName,
      standard: event.standard,
      indexed_at: nowIso(),
    };
  }

  #transferToRow(transfer: TokenTransfer): TokenTransfersTable {
    return {
      event_id: transfer.eventId,
      contract_id: transfer.contractId,
      event_name: transfer.eventName,
      asset: transfer.asset,
      from_address: transfer.fromAddress,
      to_address: transfer.toAddress,
      spender: transfer.spender,
      amount: transfer.amount,
      expiration_ledger: transfer.expirationLedger,
      ledger: transfer.ledger,
      ledger_closed_at: transfer.ledgerClosedAt,
      tx_hash: transfer.txHash,
    };
  }

  #mapEvent(row: EventsTable): EventRow {
    return {
      id: row.id,
      contractId: row.contract_id,
      ledger: toNumber(row.ledger),
      ledgerClosedAt: isoString(row.ledger_closed_at),
      txHash: row.tx_hash,
      transactionIndex: toNumber(row.tx_index),
      operationIndex: toNumber(row.op_index),
      eventIndex: toNumber(row.event_index),
      type: row.type,
      topicsXdr: parseJson(row.topics_xdr, []) as string[],
      topicsJson: parseJson(row.topics_json, []) as JsonValue[],
      dataXdr: row.data_xdr,
      dataJson: parseJson(row.data_json, null),
      inSuccessfulContractCall: truthy(row.in_successful_contract_call),
      eventName: row.event_name,
      standard: row.standard,
    };
  }

  #mapRun(row: IngestionRunsTable): IngestionRunRow {
    return {
      runId: row.run_id,
      streamId: row.stream_id,
      mode: row.mode as IngestionMode,
      startedAt: isoString(row.started_at),
      finishedAt: row.finished_at === null ? null : isoString(row.finished_at),
      fromLedger: row.from_ledger === null ? null : toNumber(row.from_ledger),
      toLedger: row.to_ledger === null ? null : toNumber(row.to_ledger),
      eventsIngested: toNumber(row.events_ingested),
      duplicates: toNumber(row.duplicates),
      status: row.status,
      error: row.error,
    };
  }
}

export interface CreateStorageOptions {
  driver: Dialect;
  url: string;
  logLevel?: LogLevel;
}

/** Create a storage adapter from validated configuration. */
export function createStorage(options: CreateStorageOptions): KyselyStorage {
  return new KyselyStorage({ driver: options.driver, url: options.url });
}
