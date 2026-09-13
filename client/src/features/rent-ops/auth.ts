export const RENT_OPS_AUTH_ROUTES = Object.freeze({
  login: "/api/rent-ops/auth/login",
  session: "/api/rent-ops/auth/session",
  csrf: "/api/rent-ops/auth/csrf",
  logout: "/api/rent-ops/auth/logout",
});

export const RENT_OPS_MUTATING_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"] as const);

export interface RentOpsAdminUser {
  id: string;
  email: string;
  role: "admin";
  firstName: string;
  lastName: string;
  createdAt?: string;
}

export type RentOpsAuthStatus = "unknown" | "authenticated" | "unauthenticated";

export interface RentOpsAuthSnapshot {
  status: RentOpsAuthStatus;
  user?: RentOpsAdminUser;
  message?: string;
}

export class RentOpsAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RentOpsAuthError";
    this.status = status;
  }
}

type FetchImplementation = typeof fetch;
type Listener = () => void;

interface AuthClientOptions {
  fetchImpl?: FetchImplementation;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonPayload(response: Response): Promise<JsonRecord> {
  const payload = await response.json().catch(() => undefined);
  return isRecord(payload) ? payload : {};
}

function safeMessage(payload: JsonRecord, fallback: string): string {
  return typeof payload.message === "string" && payload.message.length > 0 && payload.message.length <= 240
    ? payload.message
    : fallback;
}

function parseUser(value: unknown): RentOpsAdminUser {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.email !== "string"
    || value.role !== "admin"
    || typeof value.firstName !== "string"
    || typeof value.lastName !== "string"
    || "password" in value) {
    throw new Error("Rent Operations returned an invalid administrator session.");
  }
  return {
    id: value.id,
    email: value.email,
    role: "admin",
    firstName: value.firstName,
    lastName: value.lastName,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
  };
}

function parseCsrfToken(value: unknown): string {
  if (!isRecord(value) || typeof value.csrfToken !== "string" || value.csrfToken.length < 32 || value.csrfToken.length > 256) {
    throw new Error("Rent Operations returned an invalid security token.");
  }
  return value.csrfToken;
}

function isMutation(method: string): boolean {
  return RENT_OPS_MUTATING_METHODS.includes(method.toUpperCase() as (typeof RENT_OPS_MUTATING_METHODS)[number]);
}

/**
 * Browser-only Rent Ops session client. Credentials remain in the server
 * session cookie; the CSRF token is retained only in this module's memory.
 */
export class RentOpsAuthClient {
  private readonly fetchImpl?: FetchImplementation;
  private snapshot: RentOpsAuthSnapshot = { status: "unknown" };
  private generation = 0;
  private csrfToken: string | undefined;
  private csrfRequest: Promise<string> | undefined;
  private initialization: Promise<boolean> | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(options: AuthClientOptions = {}) {
    // Resolve the browser fetch function at request time. This keeps the
    // module compatible with same-origin test/browser shims without retaining
    // a stale global function reference.
    this.fetchImpl = options.fetchImpl;
  }

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.fetchImpl ? this.fetchImpl(input, init) : globalThis.fetch(input, init);
  }

  getSnapshot(): RentOpsAuthSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(next: RentOpsAuthSnapshot): void {
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new RentOpsAuthError(0, "This request belongs to an earlier Rent Operations session.");
  }

  private beginSessionChange(): number {
    this.csrfToken = undefined;
    this.csrfRequest = undefined;
    return ++this.generation;
  }

  private clearSession(message?: string): void {
    this.beginSessionChange();
    this.publish({ status: "unauthenticated", ...(message ? { message } : {}) });
  }

  /** Clear memory state after a 401/403 without attempting generic auth. */
  expireSession(): void {
    this.clearSession("Your Rent Operations session has ended. Sign in again.");
  }

  /** Share startup restoration between the entry module and the mounted page.
   * Explicit restore/login/logout operations keep their existing generation checks. */
  initialize(): Promise<boolean> {
    if (this.snapshot.status !== 'unknown') return Promise.resolve(this.snapshot.status === 'authenticated');
    if (this.initialization) return this.initialization;
    const request = this.restore();
    this.initialization = request;
    void request.finally(() => { if (this.initialization === request) this.initialization = undefined; }).catch(() => undefined);
    return request;
  }

  async restore(): Promise<boolean> {
    const generation = this.beginSessionChange();
    try {
      const response = await this.fetch(RENT_OPS_AUTH_ROUTES.session, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await jsonPayload(response);
      this.assertCurrent(generation);
      if (response.status === 401 || response.status === 403) {
        this.clearSession();
        return false;
      }
      if (!response.ok) {
        this.clearSession("Rent Operations sign-in is unavailable right now.");
        throw new RentOpsAuthError(response.status, safeMessage(payload, "Rent Operations sign-in is unavailable right now."));
      }
      const user = parseUser(payload.user);
      // The authenticated session response already carries this session's
      // CSRF token. Keep it only in memory; every mutation still sends it.
      this.csrfToken = parseCsrfToken(payload);
      this.assertCurrent(generation);
      this.publish({ status: "authenticated", user });
      return true;
    } catch (error) {
      if (generation !== this.generation) throw error;
      if (error instanceof RentOpsAuthError) {
        if (this.snapshot.status !== "unauthenticated") this.clearSession(error.message);
        throw error;
      }
      this.clearSession("Rent Operations sign-in is unavailable right now.");
      throw new RentOpsAuthError(0, "Rent Operations sign-in is unavailable right now.");
    }
  }

  async login(email: string, password: string): Promise<RentOpsAdminUser> {
    const generation = this.beginSessionChange();
    try {
      const response = await this.fetch(RENT_OPS_AUTH_ROUTES.login, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await jsonPayload(response);
      this.assertCurrent(generation);
      if (!response.ok) {
        this.clearSession(response.status === 401 || response.status === 403
          ? "The dedicated administrator sign-in was not accepted."
          : "Rent Operations sign-in is unavailable right now.");
        throw new RentOpsAuthError(response.status, safeMessage(payload, "The dedicated administrator sign-in was not accepted."));
      }
      const user = parseUser(payload.user);
      this.csrfToken = parseCsrfToken(payload);
      this.assertCurrent(generation);
      this.publish({ status: "authenticated", user });
      return user;
    } catch (error) {
      if (generation !== this.generation) throw error;
      if (error instanceof RentOpsAuthError) {
        if (this.snapshot.status !== "unauthenticated") this.clearSession(error.message);
        throw error;
      }
      this.clearSession("Rent Operations sign-in is unavailable right now.");
      throw new RentOpsAuthError(0, "Rent Operations sign-in is unavailable right now.");
    }
  }

  private async ensureCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    if (this.csrfRequest) return this.csrfRequest;
    const generation = this.generation;
    const pending = (async () => {
      const response = await this.fetch(RENT_OPS_AUTH_ROUTES.csrf, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await jsonPayload(response);
      this.assertCurrent(generation);
      if (response.status === 401 || response.status === 403) {
        this.expireSession();
        throw new RentOpsAuthError(response.status, "Your Rent Operations session has ended. Sign in again.");
      }
      if (!response.ok) throw new RentOpsAuthError(response.status, safeMessage(payload, "Rent Operations security could not be established."));
      const token = parseCsrfToken(payload);
      this.csrfToken = token;
      return token;
    })();
    this.csrfRequest = pending;
    try {
      return await pending;
    } finally {
      if (this.csrfRequest === pending) this.csrfRequest = undefined;
    }
  }

  /** Same-origin Rent Ops request with an in-memory CSRF header on mutations. */
  async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const generation = this.generation;
    const method = (init.method ?? "GET").toString().toUpperCase();
    const headers = new Headers(init.headers ?? {});
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    if (isMutation(method)) headers.set("x-rent-ops-csrf", await this.ensureCsrfToken());
    this.assertCurrent(generation);
    const response = await this.fetch(input, { ...init, method, credentials: "include", headers });
    this.assertCurrent(generation);
    if (response.status === 401 || response.status === 403) {
      this.expireSession();
      throw new RentOpsAuthError(response.status, "Your Rent Operations session has ended. Sign in again.");
    }
    return response;
  }

  async logout(): Promise<void> {
    const generation = this.beginSessionChange();
    try {
      if (this.snapshot.status === "authenticated") await this.request(RENT_OPS_AUTH_ROUTES.logout, { method: "POST" });
    } catch {
      // Local memory state is cleared even if the session endpoint is already
      // unavailable. No generic logout or API-key fallback is attempted.
    } finally {
      if (generation === this.generation) this.clearSession();
    }
  }
}

export const rentOpsAuthClient = new RentOpsAuthClient();
