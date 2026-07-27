import { GoogleApiError, normalizeGoogleError } from "./errors.js";

/**
 * Exponential backoff for transient Google API failures.
 *
 * Scope note: this retries *transient* failures only — throttling and backend errors, where the
 * identical request will eventually succeed. Revision conflicts are deliberately excluded even
 * though they are recoverable, because replaying the same request would re-apply indices that
 * are now stale. Those are handled a layer up, where the document can be re-read and the
 * addresses re-resolved first.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Delay before the second attempt, in ms; doubles thereafter. */
  baseDelayMs?: number;
  /** Ceiling for any single delay, in ms. */
  maxDelayMs?: number;
  /** Called before each wait, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: GoogleApiError) => void;
}

const DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
} as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with full jitter.
 *
 * Full jitter (a uniform draw over `[0, backoff]` rather than `backoff` exactly) is what stops
 * concurrent tool calls that were throttled together from retrying in lockstep and re-throttling
 * each other.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;

  let lastError: GoogleApiError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (caught) {
      const error = normalizeGoogleError(caught, context);
      lastError = error;

      if (!error.retryable || attempt === maxAttempts) throw error;

      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      // An explicit Retry-After is the server telling us exactly how long it wants; honour it
      // rather than our guess, but never wait less than it asked.
      const serverAsk = (error.retryAfterSeconds ?? 0) * 1000;
      const delayMs = Math.max(serverAsk, Math.random() * exponential);

      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws. Present to satisfy the type checker.
  throw lastError ?? new Error(`${context}: retry loop exited without a result`);
}
