import type {
  QuickBooksTransport,
  QuickBooksTransportRequest,
  QuickBooksTransportResponse,
} from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError } from "./errors";

export const DEFAULT_QUICKBOOKS_TIMEOUT_MS = 15_000;

const ALLOWED_INTUIT_ORIGINS = new Set([
  "https://appcenter.intuit.com",
  "https://oauth.platform.intuit.com",
  "https://developer.api.intuit.com",
  "https://developer-sandbox.api.intuit.com",
  "https://quickbooks.api.intuit.com",
  "https://sandbox-quickbooks.api.intuit.com",
]);

export interface QuickBooksFetchTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function assertAllowedIntuitUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks endpoint URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !ALLOWED_INTUIT_ORIGINS.has(url.origin)) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks endpoint URL is not an allowed Intuit HTTPS endpoint");
  }
}

/**
 * Production transport. It is deliberately small so unit tests can inject a
 * deterministic function without credentials or network requests.
 */
export function createQuickBooksFetchTransport(options: QuickBooksFetchTransportOptions = {}): QuickBooksTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUICKBOOKS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks timeout must be between 1 and 120000 milliseconds");
  }

  return async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    assertAllowedIntuitUrl(request.url);
    const controller = new AbortController();
    if (request.signal?.aborted) {
      throw new QuickBooksIntegrationError("quickbooks_transport", "QuickBooks request was cancelled before sending");
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const relayAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        redirect: "error",
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new QuickBooksIntegrationError("quickbooks_timeout", "QuickBooks request timed out", {
          retryable: true,
          cause: error,
        });
      }
      throw new QuickBooksIntegrationError("quickbooks_transport", "QuickBooks request could not be completed", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", relayAbort);
    }
  };
}
