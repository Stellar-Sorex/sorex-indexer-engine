import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createStorage } from "./storage/adapter.js";
import { loadConfig, redactedConfig, type AppConfig } from "./config.js";
import { XdrEventDecoder } from "./decoder/index.js";
import { ConfigError, SourceUnavailableError } from "./errors.js";
import { BackfillRunner, IngestionLoop, type LoopHealth } from "./ingestion/index.js";
import {
  FixtureLedgerSource,
  GalexieLedgerSource,
  RpcLedgerSource,
  parseFixturePayload,
  type LedgerSource,
} from "./ledger-source/index.js";
import { createLogger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { SorobanRpcClient } from "./rpc/client.js";
import { plansFromConfig } from "./rpc/filters.js";
import { startHealthServer, type HealthSnapshot } from "./server.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [maybeCommand, ...rest] = argv;
  const command = maybeCommand && !maybeCommand.startsWith("-") ? maybeCommand : "start";
  const args = maybeCommand === command ? rest : argv;
  const flags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) continue;
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    if (!rawKey) continue;
    const next = args[index + 1];
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = "true";
    }
  }
  return { command, flags };
}

function requireInt(flags: Record<string, string>, name: string): number {
  const raw = flags[name];
  if (!raw || !/^\d+$/.test(raw)) {
    throw new ConfigError(`--${name} is required and must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`--${name} must be a positive integer`);
  }
  return value;
}

function usage(): string {
  return `sorex-indexer-engine v0.1.0

Usage:
  sorex-indexer start                    Follow the chain in live mode (default)
  sorex-indexer migrate                  Apply database migrations and exit
  sorex-indexer replay --file <path>     Replay a captured getEvents payload (offline)
  sorex-indexer backfill --from <n> --to <n> [--source rpc|galexie]
  sorex-indexer --help

Environment: see .env.example and README.md. RPC_URL is required.
`;
}

async function withStorage<T>(
  config: AppConfig,
  fn: (deps: {
    storage: ReturnType<typeof createStorage>;
    logger: ReturnType<typeof createLogger>;
    metrics: Metrics;
  }) => Promise<T>,
): Promise<T> {
  const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);
  const metrics = new Metrics(true);
  const storage = createStorage({ driver: config.storageDriver, url: config.DATABASE_URL });
  try {
    await storage.migrate();
    return await fn({ storage, logger, metrics });
  } finally {
    await storage.close();
  }
}

async function runStart(config: AppConfig): Promise<void> {
  const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);
  const metrics = new Metrics(true);
  const storage = createStorage({ driver: config.storageDriver, url: config.DATABASE_URL });
  const decoder = new XdrEventDecoder();

  await storage.migrate();

  const client = new SorobanRpcClient({
    url: config.RPC_URL,
    logger,
    policy: {
      retries: config.MAX_RETRIES,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      maxDelayMs: 30_000,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
    },
  });

  const plans = plansFromConfig(config);
  const loops = plans.map((plan) => {
    const streamId = plans.length === 1 ? config.STREAM_ID : `${config.STREAM_ID}:${plan.suffix}`;
    const source = new RpcLedgerSource(client, plan.filters);
    return new IngestionLoop({
      config,
      source,
      storage,
      decoder,
      logger,
      metrics,
      streamId,
    });
  });

  logger.info(
    { config: redactedConfig(config), streams: loops.map((loop) => loop.health().streamId) },
    "sorex-indexer-engine starting",
  );

  const abort = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutdown signal received; finishing in-flight page");
    abort.abort();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const getHealth = async (): Promise<HealthSnapshot> => {
    const streams: LoopHealth[] = loops.map((loop) => loop.health());
    const overview = await storage.getOverview();
    const status: HealthSnapshot["status"] = streams.some((stream) => stream.status === "degraded")
      ? "degraded"
      : streams.every((stream) => stream.status === "running") ||
          streams.every((stream) => stream.status === "starting")
        ? streams.every((stream) => stream.status === "starting")
          ? "starting"
          : "ok"
        : "degraded";
    return { status, streams, overview };
  };

  const healthServer = await startHealthServer({
    host: config.HEALTH_HOST,
    port: config.HEALTH_PORT,
    metrics,
    metricsEnabled: config.METRICS_ENABLED,
    logger,
    getHealth,
  });

  try {
    await Promise.all(loops.map((loop) => loop.run(abort.signal)));
  } finally {
    const timeout = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    await healthServer
      .close()
      .catch((error: unknown) => logger.warn({ err: error }, "health server close failed"));
    await storage.close();
    clearTimeout(timeout);
    logger.info("shutdown complete");
  }
}

async function runMigrate(config: AppConfig): Promise<void> {
  await withStorage(config, async ({ storage, logger }) => {
    logger.info({ driver: config.storageDriver }, "migrations applied");
    await storage.getOverview();
  });
}

async function runReplay(config: AppConfig, flags: Record<string, string>): Promise<void> {
  const file = flags.file;
  if (!file) throw new ConfigError("replay requires --file <path>");
  const payload: unknown = JSON.parse(await readFile(file, "utf8"));
  const events = parseFixturePayload(payload);
  await withStorage(config, async ({ storage, logger, metrics }) => {
    const source = new FixtureLedgerSource(events);
    const retention = await source.getRetention();
    const runner = new BackfillRunner({
      source,
      storage,
      decoder: new XdrEventDecoder(),
      logger,
      metrics,
      batchSize: config.BATCH_SIZE,
      streamId: "replay",
    });
    const result = await runner.run(retention.oldestLedger, retention.latestLedger);
    logger.info({ ...result, file }, "replay complete");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}

async function runBackfill(config: AppConfig, flags: Record<string, string>): Promise<void> {
  const from = requireInt(flags, "from");
  const to = requireInt(flags, "to");
  const sourceKind = flags.source ?? "rpc";
  if (sourceKind !== "rpc" && sourceKind !== "galexie") {
    throw new ConfigError("--source must be 'rpc' or 'galexie'");
  }

  const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);
  const metrics = new Metrics(true);
  const storage = createStorage({ driver: config.storageDriver, url: config.DATABASE_URL });
  await storage.migrate();

  const client = new SorobanRpcClient({
    url: config.RPC_URL,
    logger,
    policy: {
      retries: config.MAX_RETRIES,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      maxDelayMs: 30_000,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
    },
  });

  const plans = plansFromConfig(config);
  const sources: LedgerSource[] =
    sourceKind === "galexie"
      ? [new GalexieLedgerSource()]
      : plans.map((plan) => new RpcLedgerSource(client, plan.filters));

  let inserted = 0;
  let duplicates = 0;
  try {
    for (const [index, source] of sources.entries()) {
      const streamId = sources.length === 1 ? "backfill" : `backfill:${index}`;
      const runner = new BackfillRunner({
        source,
        storage,
        decoder: new XdrEventDecoder(),
        logger,
        metrics,
        batchSize: config.BATCH_SIZE,
        streamId,
      });
      const result = await runner.run(from, to);
      inserted += result.insertedEvents;
      duplicates += result.duplicateEvents;
    }
    process.stdout.write(`${JSON.stringify({ from, to, inserted, duplicates }, null, 2)}\n`);
  } finally {
    await storage.close();
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || flags.help === "true") {
    process.stdout.write(usage());
    return;
  }
  if (command === "version" || flags.version === "true") {
    process.stdout.write("0.1.0\n");
    return;
  }

  const config = loadConfig();
  switch (command) {
    case "start":
      await runStart(config);
      return;
    case "migrate":
      await runMigrate(config);
      return;
    case "replay":
      await runReplay(config, flags);
      return;
    case "backfill":
      await runBackfill(config, flags);
      return;
    case "galexie":
      throw new SourceUnavailableError(
        "Galexie backfill is not implemented in v0.1.0; see .github/seed-issues/galexie-backfill-source.md",
      );
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.error({ err: error }, "fatal error");
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
});
