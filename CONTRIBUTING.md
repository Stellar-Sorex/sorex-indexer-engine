# Contributing to sorex-indexer-engine

Thanks for helping build open, vendor-neutral Soroban indexing. This repository
is part of the [Stellar-Sorex](https://github.com/ojuotimi932/stellar-sorex)
stack and is maintained under the Apache-2.0 license.

## Ways to contribute

- Pick a ready issue from [`.github/seed-issues/`](./.github/seed-issues/).
- Report a reproducible bug with logs and a fixture (redact secrets).
- Improve docs, add tests for a real contract's events, or propose a decoder.
- Port the decoder to Rust behind the `EventDecoder` interface (advanced).

## Development setup

```bash
git clone https://github.com/ojuotimi932/sorex-indexer-engine.git
cd sorex-indexer-engine
npm ci
cp .env.example .env
npm run dev        # tsx watch, SQLite by default
```

Node 22+ is required (Node 24 LTS pinned in `.nvmrc`).

## Before opening a pull request

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

If you touched storage, also run PostgreSQL integration tests:

```bash
docker run --rm -d --name sorex-pg -e POSTGRES_PASSWORD=sorex -p 55432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:sorex@localhost:55432/postgres npm run test:postgres
```

## Standards

- **TypeScript strict**. No `any` without a comment that justifies it.
- Every external call needs a timeout, a retry policy and typed errors.
- The decoder must never throw or drop an event; unknown values become typed
  `{ type, raw }` fallbacks.
- New behavior needs tests. Coverage thresholds are enforced for decoder,
  ingestion and storage (`npm run test:coverage`).
- Amounts are decimal strings; never store i128 values in JS `number`.
- Public functions require TSDoc.
- No secrets in the repository. New configuration goes in `.env.example` and
  the README config table.

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(decoder): normalise SEP-41 approve expiration
fix(ingestion): keep gap check off the hot path
docs: document RPC retention limits
test(storage): cover cursor rollback protection
```

Keep commits small and reviewable. Releases are tagged `v0.1.0`, `v0.2.0`, …
from `main` after CI is green.

## Review process

Maintainers aim to triage within 3 business days and review PRs within 5
business days. PRs need CI green and one maintainer approval. See
[GOVERNANCE.md](./GOVERNANCE.md) and [MAINTAINERS.md](./MAINTAINERS.md).

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
