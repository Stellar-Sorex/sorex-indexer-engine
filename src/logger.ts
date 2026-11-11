import pino, { type Logger, type LoggerOptions } from "pino";
import type { LogLevel } from "./config.js";

export type { Logger };

/**
 * Build the structured JSON logger used by every process component.
 * Pretty output is opt-in (`LOG_PRETTY=true`) and never used in production.
 */
export function createLogger(level: LogLevel, pretty = false): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: "sorex-indexer-engine" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["rpcUrl", "databaseUrl", "*.rpcUrl", "*.databaseUrl", "headers.authorization"],
      censor: "[redacted]",
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (pretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }

  return pino(options);
}
