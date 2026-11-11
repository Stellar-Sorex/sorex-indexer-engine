/** Base class for all errors raised by the indexer. */
export class SorexError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options?.retryable ?? false;
  }

  /** Whether the caller may retry the operation that produced this error. */
  readonly retryable: boolean;
}

/** Invalid or missing runtime configuration. */
export class ConfigError extends SorexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG_INVALID", options);
  }
}

/** A JSON-RPC call to the Soroban node failed. */
export class RpcError extends SorexError {
  constructor(
    message: string,
    readonly method: string,
    options?: { cause?: unknown; retryable?: boolean; httpStatus?: number },
  ) {
    super(message, "RPC_ERROR", options);
    this.httpStatus = options?.httpStatus;
  }

  readonly httpStatus?: number;
}

/** The requested ledger range is no longer retained by the RPC node. */
export class RetentionError extends SorexError {
  constructor(
    message: string,
    readonly requestedFrom: number,
    readonly oldestRetained: number,
  ) {
    super(message, "RETENTION_EXCEEDED");
  }
}

/** A ledger source is configured but unavailable in this build. */
export class SourceUnavailableError extends SorexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "SOURCE_UNAVAILABLE", options);
  }
}

/** Storage-level failure (connection, migration, query). */
export class StorageError extends SorexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "STORAGE_ERROR", options);
  }
}
