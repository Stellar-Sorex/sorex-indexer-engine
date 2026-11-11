# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub Security
Advisories ("Security" → "Report a vulnerability") on this repository, or email
the maintainers listed in [MAINTAINERS.md](./MAINTAINERS.md).

Include:

- affected version/commit,
- a minimal reproduction (config, request, fixture),
- impact assessment (data integrity, RCE, DoS, secret exposure).

We acknowledge reports within 3 business days and aim to publish a fix and
advisory within 30 days for confirmed vulnerabilities.

## Operational defaults

- Copy `.env.example` to `.env`; never commit credentials.
- PostgreSQL/SQLite data directories are gitignored.
- Logs redact `rpcUrl`, `databaseUrl` and authorization headers.
- The health/metrics endpoint is unauthenticated by design; bind it to a private
  network or put it behind your ingress in production.
- RPC URLs and network passphrases must match; a mismatch is a misconfiguration,
  not a security boundary.
