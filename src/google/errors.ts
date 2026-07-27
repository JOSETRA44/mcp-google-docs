/**
 * Normalization of Google API errors.
 *
 * Google reports wildly different failures through the same HTTP status. A 400 can mean "your
 * index is out of bounds" (a bug — never retry) or "the document moved on since the revision you
 * targeted" (expected under collaboration — re-read and retry). A 403 can mean "slow down"
 * (retry with backoff) or "you never asked for that scope" (retry is futile).
 *
 * Collapsing those into one opaque error is what turns a recoverable conflict into a corrupted
 * document or an infinite retry loop, so every error is classified into a `kind` that dictates
 * exactly one recovery strategy.
 */

export type ErrorKind =
  /** The document changed since the revision we targeted. Re-read, re-resolve, retry. */
  | "revision_conflict"
  /** Transient: rate limit, quota burst, or backend hiccup. Retry with exponential backoff. */
  | "transient"
  /** Credentials expired or revoked. The user must run `auth` again. */
  | "unauthenticated"
  /** Authenticated, but the granted scopes do not cover this operation. */
  | "insufficient_scope"
  /** Authenticated and scoped, but this account lacks rights on this document. */
  | "permission_denied"
  /** Document does not exist, or is invisible to this account (Google conflates the two). */
  | "not_found"
  /** The request itself is malformed — a bad index or an unsupported combination. Our bug. */
  | "invalid_request"
  /** The feature requires Developer Preview enrollment this account does not have. */
  | "preview_required"
  /** The API itself is not enabled on the Cloud project backing these credentials. */
  | "api_disabled"
  /** Anything unclassified. */
  | "unknown";

export interface GoogleErrorDetail {
  message?: string;
  domain?: string;
  reason?: string;
}

export class GoogleApiError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly reason: string | undefined;
  readonly retryable: boolean;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | undefined;
  override readonly cause: unknown;

  constructor(init: {
    kind: ErrorKind;
    message: string;
    status?: number;
    reason?: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "GoogleApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.reason = init.reason;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.cause = init.cause;
    // Revision conflicts are retryable but only after re-resolving addresses, which the caller
    // must do; the generic backoff wrapper deliberately does not treat them as retryable.
    this.retryable = init.kind === "transient";
  }
}

/** Loosely-typed view of the error shapes googleapis produces across transports. */
interface RawGoogleError {
  code?: number | string;
  status?: number | string;
  message?: string;
  errors?: GoogleErrorDetail[];
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: {
      error?: {
        code?: number;
        message?: string;
        status?: string;
        errors?: GoogleErrorDetail[];
        details?: unknown[];
      };
    };
  };
}

function firstReason(raw: RawGoogleError): string | undefined {
  return raw.errors?.[0]?.reason ?? raw.response?.data?.error?.errors?.[0]?.reason;
}

function parseRetryAfter(raw: RawGoogleError): number | undefined {
  const header = raw.response?.headers?.["retry-after"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  // The header may be an HTTP date rather than a delta.
  const asDate = Date.parse(value);
  return Number.isNaN(asDate) ? undefined : Math.max(0, (asDate - Date.now()) / 1000);
}

/** Reasons Google uses for throttling, all of which mean "the same request will work later". */
const TRANSIENT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
  "internalError",
]);

const SCOPE_REASONS = new Set(["insufficientPermissions", "insufficientScope", "forbidden"]);

/**
 * Classify an arbitrary thrown value into a `GoogleApiError`.
 *
 * `context` is a short description of what was being attempted, prepended to the message so the
 * agent gets "Could not read document abc123: ..." rather than a bare API string.
 */
export function normalizeGoogleError(error: unknown, context: string): GoogleApiError {
  if (error instanceof GoogleApiError) return error;

  const raw = (error ?? {}) as RawGoogleError;
  const status = Number(raw.code ?? raw.status ?? raw.response?.status ?? NaN);
  const apiMessage = raw.response?.data?.error?.message ?? raw.message ?? String(error);
  const reason = firstReason(raw);
  const retryAfterSeconds = parseRetryAfter(raw);

  const build = (kind: ErrorKind, message: string) =>
    new GoogleApiError({
      kind,
      message: `${context}: ${message}`,
      status: Number.isFinite(status) ? status : undefined,
      reason,
      retryAfterSeconds,
      cause: error,
    });

  if (status === 400) {
    // Google signals both a stale `requiredRevisionId` and a too-old `targetRevisionId` as a
    // plain 400 whose only distinguishing feature is the word "revision" in the message. There
    // is no reason code for it, so string matching is unavoidable here.
    if (/revision/i.test(apiMessage)) {
      return build(
        "revision_conflict",
        "the document changed since the revision this edit targeted. " +
          "The edit was not applied; it will be re-resolved against the current document.",
      );
    }
    if (/developer preview|not available to your|preview program/i.test(apiMessage)) {
      return build(
        "preview_required",
        `${apiMessage} — this operation needs Google Workspace Developer Preview enrollment.`,
      );
    }
    return build("invalid_request", apiMessage);
  }

  if (status === 401) {
    return build(
      "unauthenticated",
      "the stored credentials are expired or revoked. Run `gdocs-native auth` to sign in again.",
    );
  }

  if (status === 403) {
    if (reason && TRANSIENT_REASONS.has(reason)) {
      return build("transient", `rate limited (${reason}).`);
    }
    // A disabled API and a genuine permission problem are both 403, and mistaking one for the
    // other sends the user to fix access on a document when the real fix is one click in the
    // Cloud console. Google flags this case explicitly, so it is worth checking first.
    if (
      reason === "accessNotConfigured" ||
      raw.response?.data?.error?.status === "PERMISSION_DENIED" &&
        /has not been used in project|is disabled/i.test(apiMessage)
    ) {
      const api = /\/apis\/api\/([a-z.]+)/i.exec(apiMessage)?.[1];
      return build(
        "api_disabled",
        `the ${api ?? "required"} API is not enabled on the Google Cloud project behind these ` +
          `credentials. Enable it in the Cloud console, wait a minute for it to propagate, then ` +
          `retry.\n\nOriginal message: ${apiMessage}`,
      );
    }
    if (reason && SCOPE_REASONS.has(reason)) {
      return build(
        "insufficient_scope",
        `${apiMessage} — the current session lacks the required OAuth scope. ` +
          "Run `gdocs-native auth` to re-consent with the full scope set.",
      );
    }
    return build("permission_denied", apiMessage);
  }

  if (status === 404) {
    return build(
      "not_found",
      "no such document, or this account cannot see it. Confirm the document ID and that the " +
        "signed-in account has access.",
    );
  }

  if (status === 429 || (Number.isFinite(status) && status >= 500 && status < 600)) {
    return build("transient", apiMessage);
  }

  return build("unknown", apiMessage);
}

/** True when re-reading the document and re-resolving addresses could make the write succeed. */
export function isRevisionConflict(error: unknown): error is GoogleApiError {
  return error instanceof GoogleApiError && error.kind === "revision_conflict";
}
