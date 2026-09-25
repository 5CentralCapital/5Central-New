export type QuickBooksErrorCode =
  | "quickbooks_configuration"
  | "quickbooks_validation"
  | "quickbooks_transport"
  | "quickbooks_timeout"
  | "quickbooks_oauth"
  | "quickbooks_api"
  | "quickbooks_rate_limited"
  | "quickbooks_server"
  | "quickbooks_unauthorized"
  | "quickbooks_conflict"
  | "quickbooks_ambiguous_write"
  | "quickbooks_token_store"
  | "quickbooks_unsupported_capability";

export interface QuickBooksErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly ambiguous?: boolean;
  readonly intuitTid?: string;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly cause?: unknown;
}

/**
 * Safe provider-boundary error. The adapter never stores or exposes raw
 * response bodies, access tokens, refresh tokens, or client secrets here.
 */
export class QuickBooksIntegrationError extends Error {
  readonly code: QuickBooksErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly intuitTid?: string;
  readonly retryAfterMs?: number;
  readonly details: Readonly<Record<string, string | number | boolean | undefined>>;

  constructor(code: QuickBooksErrorCode, message: string, options: QuickBooksErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QuickBooksIntegrationError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.intuitTid = options.intuitTid;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details ?? {};
  }
}

export function isQuickBooksIntegrationError(value: unknown): value is QuickBooksIntegrationError {
  return value instanceof QuickBooksIntegrationError;
}

const unsentRequestErrors = new WeakSet<object>();

/**
 * Tag an error raised before a request reached the transport (capability
 * gate, rate-limit cooldown, token acquisition, input validation). Only a
 * tagged error proves a write was never sent; every other failure keeps its
 * outcome unknown.
 */
export function markQuickBooksRequestNotSent<T>(error: T): T {
  if (error !== null && typeof error === "object") unsentRequestErrors.add(error);
  return error;
}

export function isQuickBooksRequestNotSent(error: unknown): boolean {
  return error !== null && typeof error === "object" && unsentRequestErrors.has(error);
}
