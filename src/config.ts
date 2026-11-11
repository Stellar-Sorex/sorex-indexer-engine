import { z } from "zod";
import { ConfigError } from "./errors.js";

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalInt = (schema: z.ZodType<number>) =>
  z.preprocess(emptyToUndefined, schema.optional());

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

/**
 * Environment schema. Every value is validated at boot so a misconfigured
 * deployment fails fast instead of silently indexing the wrong network.
 */
export const envSchema = z.object({
  RPC_URL: z
    .string()
    .min(1, "RPC_URL is required")
    .refine((value) => /^https?:\/\//.test(value), "RPC_URL must be an http(s) URL"),
  NETWORK: z.enum(["testnet", "mainnet", "futurenet", "custom"]).default("testnet"),
  NETWORK_PASSPHRASE: z.string().min(1).default("Test SDF Network ; September 2015"),
  DATABASE_URL: z.string().min(1).default("sqlite:./data/sorex.db"),
  STORAGE_DRIVER: z.enum(["postgres", "sqlite"]).optional(),
  START_LEDGER: optionalInt(z.coerce.number().int().positive()),
  END_LEDGER: optionalInt(z.coerce.number().int().positive()),
  CONTRACT_ID_FILTERS: z.preprocess(emptyToUndefined, z.string().optional()),
  TOPIC_FILTERS_JSON: z.preprocess(emptyToUndefined, z.string().optional()),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(600_000).default(5_000),
  BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(200),
  GAP_CHECK_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(60_000).default(500),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  HEALTH_HOST: z.string().default("0.0.0.0"),
  METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  LOG_LEVEL: z.enum(logLevels).default("info"),
  LOG_PRETTY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  STREAM_ID: z.string().min(1).default("live"),
  DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Omit<
  Env,
  "CONTRACT_ID_FILTERS" | "TOPIC_FILTERS_JSON" | "STORAGE_DRIVER"
> {
  contractIdFilters: string[];
  topicFilters: string[][];
  storageDriver: "postgres" | "sqlite";
  /** True when the operator explicitly configured contract IDs or topics. */
  hasFilters: boolean;
}

/** A topic filter row, e.g. `["transfer", "*", "**"]`. */
export const MAX_CONTRACT_IDS_PER_FILTER = 5;
/** Stellar RPC accepts at most five filters per getEvents request. */
export const MAX_FILTERS_PER_REQUEST = 5;
/** Stellar RPC accepts one to four topic segment matchers (plus `**`). */
export const MAX_TOPIC_SEGMENTS = 4;

function parseContractIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = ids.filter((id) => !CONTRACT_ID.test(id));
  if (invalid.length > 0) {
    throw new ConfigError(
      `CONTRACT_ID_FILTERS contains invalid contract IDs: ${invalid.join(", ")}`,
    );
  }
  return [...new Set(ids)];
}

function parseTopicFilters(raw: string | undefined): string[][] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError("TOPIC_FILTERS_JSON must be valid JSON (string[][])", { cause });
  }
  if (!Array.isArray(parsed) || parsed.some((row) => !Array.isArray(row))) {
    throw new ConfigError("TOPIC_FILTERS_JSON must be a JSON array of string arrays");
  }
  return parsed.map((row: unknown[], index) => {
    const segments = row.map((segment) => {
      if (typeof segment !== "string" || segment.length === 0) {
        throw new ConfigError(`TOPIC_FILTERS_JSON[${index}] must contain non-empty strings`);
      }
      return segment;
    });
    const wildcardCount = segments.filter((segment) => segment === "**").length;
    if (wildcardCount > 1 || (wildcardCount === 1 && segments.at(-1) !== "**")) {
      throw new ConfigError(
        `TOPIC_FILTERS_JSON[${index}]: "**" is allowed once, as the last segment`,
      );
    }
    if (segments.filter((segment) => segment !== "**").length > MAX_TOPIC_SEGMENTS) {
      throw new ConfigError(
        `TOPIC_FILTERS_JSON[${index}] exceeds ${MAX_TOPIC_SEGMENTS} topic segments`,
      );
    }
    return segments;
  });
}

/** Load and validate configuration from process environment (or a supplied map). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment: ${details}`);
  }

  const value = parsed.data;
  const storageDriver =
    value.STORAGE_DRIVER ??
    (/^postgres(ql)?:\/\//.test(value.DATABASE_URL) ? "postgres" : "sqlite");
  if (storageDriver === "postgres" && !/^postgres(ql)?:\/\//.test(value.DATABASE_URL)) {
    throw new ConfigError("STORAGE_DRIVER=postgres requires a postgres:// DATABASE_URL");
  }

  const contractIdFilters = parseContractIds(value.CONTRACT_ID_FILTERS);
  const topicFilters = parseTopicFilters(value.TOPIC_FILTERS_JSON);

  return {
    ...value,
    contractIdFilters,
    topicFilters,
    storageDriver,
    hasFilters: contractIdFilters.length > 0 || topicFilters.length > 0,
  };
}

/** Remove filter-specific fields before serialising config into logs. */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    network: config.NETWORK,
    storageDriver: config.storageDriver,
    startLedger: config.START_LEDGER ?? null,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    batchSize: config.BATCH_SIZE,
    contractFilters: config.contractIdFilters.length,
    topicFilters: config.topicFilters.length,
    logLevel: config.LOG_LEVEL,
  };
}
