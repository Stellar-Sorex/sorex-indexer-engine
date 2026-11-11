# sorex-indexer-engine

[![CI](https://github.com/ojuotimi932/sorex-indexer-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/ojuotimi932/sorex-indexer-engine/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)

A self-hostable **Soroban event indexer**. It follows Stellar's Soroban RPC,
decodes SCVal topics/data into JSON, recognises SEP-41 token events, and writes
everything to PostgreSQL (production) or SQLite (zero-config local dev) with a
crash-safe cursor and idempotent upserts.

Part of the [Stellar-Sorex](https://github.com/ojuotimi932/stellar-sorex) stack:

```
Soroban RPC → sorex-indexer-engine → PostgreSQL/SQLite → sorex-query-sdk → sorex-explorer-ui
```

## Why

Soroban contracts emit events as XDR-encoded `ScVal` topics and data. RPC keeps
only a bounded, ledger-denominated event window (120,960 ledgers ≈ 7 days on the
public testnet at the time of writing). This engine gives you durable storage,
decoded payloads and normalized token transfers without a paid vendor.

## Quickstart (Docker Compose, < 5 minutes)

From the [stellar-sorex meta repo](https://github.com/ojuotimi932/stellar-sorex):

```bash
git clone https://github.com/ojuotimi932/stellar-sorex.git
cd stellar-sorex
docker compose up --build -d
curl http://localhost:9464/health
```

This starts PostgreSQL, the indexer (testnet), the GraphQL/REST API and the
explorer UI. See the meta repo for the demo script.

## Quickstart (standalone)

```bash
npm ci
cp .env.example .env
# SQLite zero-config default (DATABASE_URL=sqlite:./data/sorex.db)
npm run dev

# or production build
npm run build
node dist/main.js start
```

Replay the captured testnet fixture without touching the network:

```bash
RPC_URL=https://soroban-testnet.stellar.org \
DATABASE_URL=sqlite:./data/demo.db \
node dist/main.js replay --file test/fixtures/testnet-events.json
```

Apply migrations only:

```bash
npm run migrate
```

## Architecture

```mermaid
flowchart LR
  RPC[(Soroban RPC getEvents)] -->|base64 ScVal XDR| SRC[LedgerSource]
  SRC --> LOOP[IngestionLoop<br/>cursor + gap detection]
  LOOP --> DEC[XdrEventDecoder<br/>scValToNative + JSON-safe]
  DEC --> SEP{SERP-41?}
  SEP -->|yes| TT[(token_transfers)]
  DEC --> DB[(events JSONB)]
  LOOP --> CUR[(cursors)]
  LOOP --> RUN[(ingestion_runs / gaps)]
  LOOP --> MET[/metrics + health/]
  DB --> API[sorex-query-sdk]
  TT --> API
  API --> UI[sorex-explorer-ui]
```

### Ingestion guarantees

- **Cursor persistence** in the same transaction as the events it covers.
- **Idempotency** keyed on the RPC event id (`TOID-eventIndex`); replaying a
  ledger range never duplicates rows or inflates contract counters.
- **Gap detection** by comparing the cursor with RPC `oldestLedger` on startup
  and periodically. Unrecoverable ranges are recorded in `ingestion_gaps`.
- **No reorg logic** — Stellar's SCP gives instant finality. What matters is
  gap detection when the RPC node is unreachable or retention rolls forward.
- **Filter limits** — contract IDs are chunked to 5 per filter and requests to
  5 filters; larger configurations become independent streams with their own
  cursors.

## Configuration

All variables are validated with zod at boot.

| Variable | Default | Description |
| --- | --- | --- |
| `RPC_URL` | *(required)* | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `NETWORK` | `testnet` | Label: `testnet`, `mainnet`, `futurenet`, `custom` |
| `NETWORK_PASSPHRASE` | testnet passphrase | Network passphrase (set for mainnet) |
| `DATABASE_URL` | `sqlite:./data/sorex.db` | `postgres://…` or `sqlite:./path.db` / `sqlite::memory:` |
| `STORAGE_DRIVER` | inferred | `postgres` or `sqlite` |
| `START_LEDGER` | current head | First ledger on a fresh cursor. Must be inside RPC retention |
| `END_LEDGER` | none | Optional stop ledger (exclusive-ish; live mode filters it) |
| `CONTRACT_ID_FILTERS` | all contracts | Comma-separated `C…` contract IDs |
| `TOPIC_FILTERS_JSON` | all topics | JSON `string[][]`, e.g. `[["transfer","*","**"]]` |
| `POLL_INTERVAL_MS` | `5000` | Idle poll interval |
| `BATCH_SIZE` | `200` | `getEvents` page size (1–10000) |
| `GAP_CHECK_INTERVAL_MS` | `60000` | Retention/gap check cadence |
| `MAX_RETRIES` | `5` | RPC retry attempts |
| `RETRY_BASE_DELAY_MS` | `500` | Exponential backoff base (full jitter) |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-attempt RPC timeout |
| `HEALTH_PORT` / `HEALTH_HOST` | `9464` / `0.0.0.0` | `/health`, `/metrics` |
| `METRICS_ENABLED` | `true` | Enable Prometheus output |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | `false` | Human-readable logs in development |
| `STREAM_ID` | `live` | Cursor stream id (suffixed per filter plan) |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown budget |

Topic filters are encoded as symbols automatically: `"transfer"` becomes
`AAAADwAAAAh0cmFuc2Zlcg==`. Use `xdr:<base64>` to supply a raw `ScVal`.

```bash
# Native SAC transfers only, last two days on testnet
CONTRACT_ID_FILTERS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
TOPIC_FILTERS_JSON='[["transfer","*","*","**"]]' \
RPC_URL=https://soroban-testnet.stellar.org \
DATABASE_URL=postgres://sorex:sorex@localhost:5432/sorex \
npm run dev
```

## Database schema

| Table | Purpose |
| --- | --- |
| `events` | One row per RPC event: raw topic/value XDR, decoded JSONB, ledger/tx/op/event indices |
| `token_transfers` | Normalized SEP-41 `transfer`, `mint`, `burn`, `approve`, `clawback` rows |
| `contracts` | First/last seen ledger and event count per contract |
| `cursors` | `(stream_id, last_cursor, last_ledger)` |
| `ingestion_runs` | Run lifecycle and counts for observability |
| `ingestion_gaps` | Unrecoverable ledger ranges with the reason |

PostgreSQL uses `JSONB` with GIN indexes on decoded topics/data; SQLite uses
JSON text. Amounts are stored as text so i128 values never lose precision.
Schema migrations are versioned and applied by Kysely's migrator.

## Observability

- `GET /health` — status (`ok`/`degraded`/`starting`), per-stream cursor/lag,
  last error, event counts, latest run and gap. `503` when degraded.
- `GET /metrics` — Prometheus metrics: events ingested (inserted/duplicate),
  pages, page duration, ledger lag, last success timestamp, errors, gaps.

```bash
curl -s localhost:9464/health | jq
curl -s localhost:9464/metrics | grep sorex_
```

## Backfill and archival data

`getEvents` only serves the node's retention window. Use:

```bash
node dist/main.js backfill --from 5660000 --to 5661000
```

Ranges older than `oldestLedger` fail with an explicit `RetentionError` naming
the archival source requirement. A `GalexieLedgerSource` stub defines the
`LedgerSource` interface for a contributor implementation over Galexie / history
archives; it throws a clear error instead of fabricating data. See
[`.github/seed-issues/galexie-backfill-source.md`](./.github/seed-issues/galexie-backfill-source.md).

## Tests

```bash
npm test                 # unit + SQLite integration tests
npm run test:coverage    # 70%+ thresholds for decoder, ingestion, storage
npm run test:postgres    # requires TEST_DATABASE_URL
```

Decoder fixtures under `test/fixtures/` are **real captured testnet
`getEvents` responses**, including native SAC, USDC and custom token events.

```bash
docker run --rm -d --name sorex-pg -e POSTGRES_PASSWORD=sorex -p 55432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:sorex@localhost:55432/postgres npm run test:postgres
```

## Limitations

- **RPC retention**: only ~120,960 ledgers of events are available from RPC.
  Historical backfill requires an archival ledger source (seed issue).
- **No reorg handling**: not needed on Stellar (SCP finality); duplicates are
  handled by idempotent event-id upserts.
- **Protocol 30 addresses**: claimable-balance, liquidity-pool and muxed address
  StrKeys are preserved as-is; the explorer labels them but does not resolve
  their underlying participants.
- The decoder covers SEP-41; contract-specific schemas can be added through the
  `EventDecoder` interface (see `docs` in the meta repo and seed issues).
- SQLite is intended for local development and small deployments; use
  PostgreSQL for production volume and GIN-indexed topic searches.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the ready-to-file issues in
[`.github/seed-issues/`](./.github/seed-issues/). Conventional commits are
enforced by review; releases are tagged `v0.1.0` onwards.

## License

Apache-2.0. See [LICENSE](./LICENSE).
