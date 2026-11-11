export type Dialect = "postgres" | "sqlite";

/**
 * Schema migrations, applied by Kysely's Migrator. PostgreSQL uses JSONB with
 * a GIN index; SQLite uses TEXT/JSON for zero-config local development.
 */
export function migrationStatements(dialect: Dialect): string[] {
  const jsonType = dialect === "postgres" ? "JSONB" : "TEXT";
  const timestampType = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
  const bigintType = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const booleanType = dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  const now = dialect === "postgres" ? "now()" : "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const statements = [
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_index INTEGER NOT NULL,
      op_index INTEGER NOT NULL,
      event_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      topics_xdr ${jsonType} NOT NULL,
      topics_json ${jsonType} NOT NULL,
      data_xdr TEXT NOT NULL,
      data_json ${jsonType} NOT NULL,
      in_successful_contract_call ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "true" : "1"},
      event_name TEXT,
      standard TEXT,
      indexed_at ${timestampType} NOT NULL DEFAULT ${now}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_contract_id ON events (contract_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger)`,
    `CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events (tx_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_events_contract_ledger ON events (contract_id, ledger)`,
    `CREATE TABLE IF NOT EXISTS cursors (
      stream_id TEXT PRIMARY KEY,
      last_cursor TEXT,
      last_ledger ${bigintType} NOT NULL,
      updated_at ${timestampType} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS token_transfers (
      event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      contract_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      asset TEXT,
      from_address TEXT,
      to_address TEXT,
      spender TEXT,
      amount TEXT NOT NULL,
      expiration_ledger ${bigintType},
      ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL,
      tx_hash TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_contract ON token_transfers (contract_id)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_from ON token_transfers (from_address)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_to ON token_transfers (to_address)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_ledger ON token_transfers (ledger)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_asset ON token_transfers (asset)`,
    `CREATE TABLE IF NOT EXISTS contracts (
      contract_id TEXT PRIMARY KEY,
      first_seen_ledger ${bigintType} NOT NULL,
      last_seen_ledger ${bigintType} NOT NULL,
      event_count ${bigintType} NOT NULL DEFAULT 0,
      updated_at ${timestampType} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ingestion_runs (
      run_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      started_at ${timestampType} NOT NULL,
      finished_at ${timestampType},
      from_ledger ${bigintType},
      to_ledger ${bigintType},
      events_ingested ${bigintType} NOT NULL DEFAULT 0,
      duplicates ${bigintType} NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ingestion_runs_stream_started ON ingestion_runs (stream_id, started_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ingestion_gaps (
      gap_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      from_ledger ${bigintType} NOT NULL,
      to_ledger ${bigintType} NOT NULL,
      detected_at ${timestampType} NOT NULL,
      reason TEXT NOT NULL,
      recoverable ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "false" : "0"}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ingestion_gaps_stream ON ingestion_gaps (stream_id, detected_at DESC)`,
  ];

  if (dialect === "postgres") {
    statements.push(
      `CREATE INDEX IF NOT EXISTS idx_events_topics_gin ON events USING GIN (topics_json jsonb_path_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_events_data_gin ON events USING GIN (data_json jsonb_path_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_events_name ON events (event_name)`,
    );
  } else {
    statements.push(`CREATE INDEX IF NOT EXISTS idx_events_name ON events (event_name)`);
  }

  return statements;
}

/**
 * Added after the initial schema. Kept separate so databases created before
 * transaction enrichment existed receive the table through the migrator.
 */
export function transactionMigrationStatements(dialect: Dialect): string[] {
  const timestampType = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
  const bigintType = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const booleanType = dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  return [
    `CREATE TABLE IF NOT EXISTS transactions (
      tx_hash TEXT PRIMARY KEY,
      ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL,
      application_order INTEGER NOT NULL DEFAULT 0,
      successful ${booleanType} NOT NULL,
      fee_bump ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "false" : "0"},
      fee_charged TEXT NOT NULL,
      resource_fee TEXT,
      cpu_instructions ${bigintType},
      memory_bytes ${bigintType},
      read_bytes ${bigintType},
      write_bytes ${bigintType},
      envelope_size_bytes ${bigintType} NOT NULL,
      operation_count INTEGER NOT NULL,
      has_soroban_data ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "false" : "0"},
      updated_at ${timestampType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_successful ON transactions (successful)`,
  ];
}
