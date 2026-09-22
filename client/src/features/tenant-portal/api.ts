import type { TenantIdentity, TenantSessionResponse } from "@shared/tenant-portal-contracts";

export type TenantSessionAccount = TenantIdentity;

export type { TenantPaymentView as TenantPayment, TenantPaymentsView as TenantPayments } from "@shared/tenant-payment-contracts";

export class TenantApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TenantApiError";
  }
}

function messageFor(status: number): string {
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 429) return "Too many attempts. Please wait a few minutes and try again.";
  if (status === 503) return "This service is unavailable right now. Please try again later.";
  return "We could not complete this request. Please try again.";
}

export async function readResponse<T>(response: Response, fallback?: string): Promise<T> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new TenantApiError(response.status, fallback && response.status !== 429 && response.status !== 503 ? fallback : messageFor(response.status));
  if (!payload || typeof payload !== "object") throw new TenantApiError(0, "We could not read the response. Please try again.");
  return payload as T;
}

/** Tenant cookies and CSRF are independent of staff and investor sign-in. */
export class TenantPortalClient {
  private csrfToken?: string;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private fetch(path: string, init: RequestInit = {}) {
    if (!path.startsWith("/api/tenant/")) throw new TenantApiError(0, "This request is outside your tenant account.");
    return this.fetchImpl(path, { ...init, credentials: "include", cache: "no-store", headers: { Accept: "application/json", ...init.headers } });
  }

  private async saveSession(response: Response, fallback?: string): Promise<TenantSessionAccount> {
    const result = await readResponse<TenantSessionResponse>(response, fallback);
    if (typeof result.csrfToken !== "string" || result.csrfToken.length < 32 || result.account?.status !== "active" || typeof result.account?.id !== "string") {
      throw new TenantApiError(0, "We could not verify your session. Please sign in again.");
    }
    this.csrfToken = result.csrfToken;
    return result.account;
  }

  async restore(): Promise<TenantSessionAccount | null> {
    this.csrfToken = undefined;
    const response = await this.fetch("/api/tenant/auth/session");
    if (response.status === 401) return null;
    return this.saveSession(response);
  }

  async login(email: string, password: string): Promise<TenantSessionAccount> {
    this.csrfToken = undefined;
    return this.saveSession(await this.fetch("/api/tenant/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    }), "The email or password was not accepted.");
  }

  async activate(token: string, password: string): Promise<TenantSessionAccount> {
    this.csrfToken = undefined;
    return this.saveSession(await this.fetch("/api/tenant/auth/activate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
    }), "This link is invalid or has expired. Contact management for a new link.");
  }

  async recovery(email: string): Promise<{ message: string }> {
    return readResponse<{ message: string }>(await this.fetch("/api/tenant/auth/recovery", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }));
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      if (!this.csrfToken) throw new TenantApiError(401, messageFor(401));
      headers["x-tenant-csrf"] = this.csrfToken;
      headers["Content-Type"] = "application/json";
    }
    const response = await this.fetch(path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) this.csrfToken = undefined;
    return readResponse<T>(response);
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<TenantSessionAccount> {
    if (!this.csrfToken) throw new TenantApiError(401, messageFor(401));
    return this.saveSession(await this.fetch("/api/tenant/auth/password", {
      method: "POST", headers: { "Content-Type": "application/json", "x-tenant-csrf": this.csrfToken },
      body: JSON.stringify({ currentPassword, newPassword }),
    }));
  }

  async logout(): Promise<void> {
    // Do not claim sign-out unless the server cookie was revoked.
    await this.request("/api/tenant/auth/logout", {});
    this.csrfToken = undefined;
  }

  clear(): void { this.csrfToken = undefined; }
}

export function trustedCheckoutUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password || url.port) {
    throw new TenantApiError(0, "The payment link could not be verified. Please try again.");
  }
  return url.href;
}
