import { SorexError } from "../errors.js";

export interface RetryPolicy {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export interface RetryHooks {
  /** Called before sleeping between attempts. */
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: unknown;
    operation: string;
  }) => void;
  /** Override the default decision for whether an error is retryable. */
  isRetryable?: (error: unknown) => boolean;
}

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NON_RETRYABLE_MESSAGE =
  /(invalid|required|must be|not found|unauthorized|forbidden|bad request)/i;

/** Heuristic used when the RPC layer has not already classified an error. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof SorexError) return error.retryable;
  if (!(error instanceof Error)) return false;

  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (NON_RETRYABLE_MESSAGE.test(error.message)) return false;
  if (
    /(fetch failed|network|timeout|timed out|socket hang up|rate limit|too many requests|5\d\d)/i.test(
      error.message,
    )
  ) {
    return true;
  }
  return false;
}

/** Reject after `ms`, keeping the original operation running only until it settles. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new SorexError(`${label} timed out after ${ms}ms`, "TIMEOUT", { retryable: true })),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run an async operation with a hard per-attempt timeout and full-jitter
 * exponential backoff. The final error is rethrown unchanged so callers keep
 * their typed error information.
 */
export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<T> {
  const maxAttempts = policy.retries + 1;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await withTimeout(fn(), policy.timeoutMs, operation);
    } catch (error) {
      lastError = error;
      const retryable = hooks.isRetryable ? hooks.isRetryable(error) : isRetryableError(error);
      if (!retryable || attempt >= maxAttempts) break;

      const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      const delayMs = Math.round(Math.random() * exponential);
      hooks.onRetry?.({ attempt, maxAttempts, delayMs, error, operation });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
