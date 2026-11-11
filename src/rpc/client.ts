import { rpc } from "@stellar/stellar-sdk";
import { RpcError } from "../errors.js";
import type { RawSorobanEvent } from "../decoder/types.js";
import type { Logger } from "../logger.js";
import { isRetryableError, withRetry, type RetryPolicy } from "./retry.js";

export interface RpcHealth {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  /** Not exposed by every SDK version; omitted when unavailable. */
  latestLedgerCloseTime?: string;
  oldestLedgerCloseTime?: string;
  ledgerRetentionWindow?: number;
}

export interface RpcEventPage {
  events: RawSorobanEvent[];
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedgerCloseTime: string;
}

export interface GetEventsParams {
  filters: rpc.Api.EventFilter[];
  /** Inclusive ledger sequence; mutually exclusive with `cursor`. */
  startLedger?: number;
  /** Exclusive end ledger; mutually exclusive with `cursor`. */
  endLedger?: number;
  cursor?: string;
  limit: number;
}

export interface SorobanRpcClientOptions {
  url: string;
  policy: RetryPolicy;
  logger: Logger;
}

const NON_RETRYABLE_RPC_MESSAGE =
  /(startLedger|endLedger|cursor|invalid|too many|exceeds|must be|out of range)/i;

function classifyRpcError(method: string, error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const httpStatusMatch = /\b(4\d\d|5\d\d)\b/.exec(message);
  const httpStatus = httpStatusMatch ? Number(httpStatusMatch[1]) : undefined;
  const retryable =
    !NON_RETRYABLE_RPC_MESSAGE.test(message) &&
    (isRetryableError(error) ||
      (httpStatus !== undefined && (httpStatus === 429 || httpStatus >= 500)));
  return new RpcError(`${method} failed: ${message}`, method, {
    cause: error,
    retryable,
    httpStatus,
  });
}

/**
 * Thin, typed wrapper around `rpc.Server` that adds retries, timeouts and raw
 * base64 event payloads.
 *
 * `_getEvents` is the SDK's raw-response accessor (verified against the
 * `@stellar/stellar-sdk` 17.4 API types); the public `getEvents` helper parses
 * ScVals, while this indexer deliberately keeps the original XDR.
 */
export class SorobanRpcClient {
  readonly #server: rpc.Server;
  readonly #policy: RetryPolicy;
  readonly #logger: Logger;

  constructor(options: SorobanRpcClientOptions) {
    this.#server = new rpc.Server(options.url, { allowHttp: options.url.startsWith("http://") });
    this.#policy = options.policy;
    this.#logger = options.logger;
  }

  async getHealth(): Promise<RpcHealth> {
    return this.#call("getHealth", async () => {
      const health = await this.#server.getHealth();
      return {
        status: health.status,
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        ledgerRetentionWindow: health.ledgerRetentionWindow,
      };
    });
  }

  async getLatestLedger(): Promise<number> {
    return this.#call("getLatestLedger", async () => {
      const latest = await this.#server.getLatestLedger();
      return latest.sequence;
    });
  }

  async getEvents(params: GetEventsParams): Promise<RpcEventPage> {
    const request: rpc.Api.GetEventsRequest =
      params.cursor !== undefined
        ? { filters: params.filters, cursor: params.cursor, limit: params.limit }
        : {
            filters: params.filters,
            startLedger: params.startLedger ?? 1,
            ...(params.endLedger !== undefined ? { endLedger: params.endLedger } : {}),
            limit: params.limit,
          };

    return this.#call("getEvents", async () => {
      const response = await this.#server._getEvents(request);
      return {
        events: response.events.map((event) => ({
          id: event.id,
          type: event.type,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          contractId: event.contractId ?? "",
          txHash: event.txHash,
          transactionIndex: event.transactionIndex,
          operationIndex: event.operationIndex,
          topic: event.topic ?? [],
          value: event.value,
          inSuccessfulContractCall: event.inSuccessfulContractCall ?? true,
        })),
        cursor: response.cursor,
        latestLedger: response.latestLedger,
        oldestLedger: response.oldestLedger,
        latestLedgerCloseTime: response.latestLedgerCloseTime,
        oldestLedgerCloseTime: response.oldestLedgerCloseTime,
      };
    });
  }

  async #call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(method, fn, this.#policy, {
        isRetryable: (error) => classifyRpcError(method, error).retryable,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          this.#logger.warn(
            { method, attempt, maxAttempts, delayMs, err: error },
            "retrying Soroban RPC request",
          );
        },
      });
    } catch (error) {
      const rpcError = classifyRpcError(method, error);
      this.#logger.error({ method, err: rpcError }, "Soroban RPC request failed");
      throw rpcError;
    }
  }
}
