import type {
  QuickBooksConnectionScope,
  QuickBooksOAuthTokenSet,
  QuickBooksTokenProvider,
  QuickBooksTokenRepository,
  QuickBooksStoredToken,
} from "../../../shared/accounting/quickbooks";
import { quickBooksConnectionKey } from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError, isQuickBooksIntegrationError } from "./errors";
import type { QuickBooksOAuthClient } from "./oauth";
import type { QuickBooksRefreshLease } from "../../accounting/refresh-lease";

const DEFAULT_EXPIRY_SKEW_MS = 60_000;

export interface QuickBooksTokenManagerOptions {
  readonly oauth: Pick<QuickBooksOAuthClient, "refreshToken" | "revokeToken">;
  readonly repository: QuickBooksTokenRepository;
  readonly now?: () => Date;
  readonly expirySkewMs?: number;
  /** Optional database lease for refresh coordination across workers. */
  readonly refreshLease?: QuickBooksRefreshLease;
  readonly refreshLeaseOwnerId?: string;
  readonly refreshLeaseTtlMs?: number;
  /**
   * How long a worker that lost the refresh lease waits for the winner's
   * committed token before reporting a retryable conflict. Default 10s.
   */
  readonly refreshLeaseWaitMs?: number;
  readonly refreshLeasePollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface QuickBooksTokenManager extends QuickBooksTokenProvider {
  saveTokens(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet, expectedVersion?: number): Promise<QuickBooksStoredToken>;
  /** Explicit OAuth reconnect path; refreshes continue to use compare-and-save. */
  saveNewConnection?(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet): Promise<QuickBooksStoredToken>;
  disconnect(scope: QuickBooksConnectionScope): Promise<void>;
}

function validateSkew(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks token expiry skew is invalid");
  }
}

function validUntil(value: string, now: Date, skewMs: number): boolean {
  const expires = Date.parse(value);
  return Number.isFinite(expires) && expires > now.getTime() + skewMs;
}

function tokenStoreFailure(message: string, cause?: unknown): QuickBooksIntegrationError {
  if (isQuickBooksIntegrationError(cause) && cause.code === "quickbooks_token_store") return cause;
  return new QuickBooksIntegrationError("quickbooks_token_store", message, { cause });
}

function isInvalidGrant(error: unknown): error is QuickBooksIntegrationError {
  return isQuickBooksIntegrationError(error)
    && error.code === "quickbooks_oauth"
    && (error.status === 400 || error.status === 401)
    && error.details.error === "invalid_grant";
}

/**
 * Adds refresh-token rotation and per-connection serialization around the
 * injected persistence contract. A stale concurrent refresh can never replace
 * a newer token without the repository accepting the expected version.
 */
export function createQuickBooksTokenManager(options: QuickBooksTokenManagerOptions): QuickBooksTokenManager {
  if (!options.repository || typeof options.repository.load !== "function" || typeof options.repository.save !== "function" || typeof options.repository.revoke !== "function") {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks token repository is incomplete");
  }
  const now = options.now ?? (() => new Date());
  const expirySkewMs = options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  validateSkew(expirySkewMs);
  if (options.refreshLeaseTtlMs !== undefined && (!Number.isSafeInteger(options.refreshLeaseTtlMs) || options.refreshLeaseTtlMs < 1_000 || options.refreshLeaseTtlMs > 600_000)) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks refresh lease TTL is invalid");
  }
  if (options.refreshLease && (!options.refreshLeaseOwnerId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(options.refreshLeaseOwnerId))) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks refresh lease owner is invalid");
  }
  const refreshLeaseWaitMs = options.refreshLeaseWaitMs ?? 10_000;
  const refreshLeasePollMs = options.refreshLeasePollMs ?? 250;
  if (!Number.isSafeInteger(refreshLeaseWaitMs) || refreshLeaseWaitMs < 0 || refreshLeaseWaitMs > 120_000 || !Number.isSafeInteger(refreshLeasePollMs) || refreshLeasePollMs < 1 || refreshLeasePollMs > 10_000) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks refresh lease wait is invalid");
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const locks = new Map<string, Promise<unknown>>();
  // A database outage while recording a reconnect transition must not cause
  // this worker to call Intuit with the same rejected grant on every request.
  // A later, versioned reconnect from another worker clears the local block.
  const reconnectRequiredAtVersion = new Map<string, number | undefined>();

  async function serialized<T>(scope: QuickBooksConnectionScope, work: () => Promise<T>): Promise<T> {
    const key = quickBooksConnectionKey(scope);
    const prior = locks.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(work);
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  async function requireReconnect(
    scope: QuickBooksConnectionScope,
    stored: QuickBooksStoredToken,
    reason: "invalid_grant" | "refresh_token_expired" | "refresh_token_hard_expired",
    intuitTid?: string,
  ): Promise<never> {
    const key = quickBooksConnectionKey(scope);
    reconnectRequiredAtVersion.set(key, stored.version);
    try {
      await options.repository.markNeedsReconnect(scope, { reason, ...(intuitTid ? { intuitTid } : {}) });
    } catch {
      // Do not attach provider or storage details that could contain secrets.
      throw new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks reconnect state could not be safely recorded", { retryable: true });
    }
    throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection needs to be reconnected", {
      ...(intuitTid ? { intuitTid } : {}),
      details: { reason: "needs_reconnect" },
    });
  }

  return {
    async saveTokens(scope, token, expectedVersion): Promise<QuickBooksStoredToken> {
      return serialized(scope, async () => {
        try {
          return await options.repository.save(scope, token, expectedVersion);
        } catch (error) {
          throw tokenStoreFailure("QuickBooks token could not be saved", error);
        }
      });
    },

    async saveNewConnection(scope, token): Promise<QuickBooksStoredToken> {
      return serialized(scope, async () => {
        try {
          const saved = options.repository.saveNewConnection
            ? await options.repository.saveNewConnection(scope, token)
            : await options.repository.save(scope, token);
          reconnectRequiredAtVersion.delete(quickBooksConnectionKey(scope));
          return saved;
        } catch (error) {
          throw tokenStoreFailure("QuickBooks connection could not be saved", error);
        }
      });
    },

    async getAccessToken(scope): Promise<string> {
      return serialized(scope, async () => {
        const key = quickBooksConnectionKey(scope);
        let stored: QuickBooksStoredToken | null | undefined;
        try {
          stored = await options.repository.load(scope);
        } catch (error) {
          throw tokenStoreFailure("QuickBooks token could not be loaded", error);
        }
        if (!stored) throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection is not authorized");
        if (reconnectRequiredAtVersion.has(key)) {
          const blockedVersion = reconnectRequiredAtVersion.get(key);
          if (blockedVersion !== undefined && stored.version !== undefined && stored.version > blockedVersion) {
            reconnectRequiredAtVersion.delete(key);
          } else {
            throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection needs to be reconnected", { details: { reason: "needs_reconnect" } });
          }
        }
        const current = now();
        if (validUntil(stored.accessTokenExpiresAt, current, expirySkewMs)) return stored.accessToken;
        if (stored.refreshTokenHardExpiresAt && !validUntil(stored.refreshTokenHardExpiresAt, current, 0)) {
          return requireReconnect(scope, stored, "refresh_token_hard_expired", stored.intuitTid);
        }
        if (stored.refreshTokenExpiresAt && !validUntil(stored.refreshTokenExpiresAt, current, 0)) {
          return requireReconnect(scope, stored, "refresh_token_expired", stored.intuitTid);
        }
        let leaseHeld = false;
        if (options.refreshLease) {
          try {
            leaseHeld = await options.refreshLease.acquire(scope, options.refreshLeaseOwnerId!, options.refreshLeaseTtlMs ?? 120_000);
          } catch (error) {
            throw tokenStoreFailure("QuickBooks refresh lease could not be acquired", error);
          }
          if (!leaseHeld) {
            // Another worker owns the lease. Wait a bounded time for its
            // committed token; never refresh with a possibly stale token.
            const deadline = Date.now() + refreshLeaseWaitMs;
            for (;;) {
              let winner: QuickBooksStoredToken | null | undefined;
              try {
                winner = await options.repository.load(scope);
              } catch (error) {
                throw tokenStoreFailure("QuickBooks token could not be re-read after a refresh lease conflict", error);
              }
              if (!winner) throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection is not authorized");
              if (validUntil(winner.accessTokenExpiresAt, now(), expirySkewMs)) return winner.accessToken;
              if (Date.now() + refreshLeasePollMs > deadline) break;
              await sleep(refreshLeasePollMs);
            }
            throw new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks token refresh is already in progress", { retryable: true });
          }
        }
        try {
          // A lease winner must re-read after acquisition. The other worker may
          // have committed just before this worker acquired an expired lease.
          if (options.refreshLease) {
            try {
              const latest = await options.repository.load(scope);
              if (latest && validUntil(latest.accessTokenExpiresAt, now(), expirySkewMs)) return latest.accessToken;
              if (latest && latest.version !== undefined) stored = latest;
            } catch (error) {
              throw tokenStoreFailure("QuickBooks token could not be re-read after acquiring a refresh lease", error);
            }
          }
          let rotated: QuickBooksOAuthTokenSet;
          try {
            rotated = await options.oauth.refreshToken(stored.refreshToken, stored.refreshTokenExpiresAt, stored.refreshTokenHardExpiresAt);
          } catch (error) {
            if (isInvalidGrant(error)) {
              // Intuit rejects a refresh token that another worker has already
              // rotated. Only a grant that is still the latest stored one is
              // truly invalid; never disable a connection a winner just renewed.
              let latest: QuickBooksStoredToken | null | undefined;
              try {
                latest = await options.repository.load(scope);
              } catch {
                latest = undefined;
              }
              const current = stored;
              const superseded = latest && (latest.version !== undefined && current.version !== undefined
                ? latest.version !== current.version
                : latest.refreshToken !== current.refreshToken);
              if (latest && superseded) {
                if (validUntil(latest.accessTokenExpiresAt, now(), expirySkewMs)) return latest.accessToken;
                throw new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks token changed during refresh; retry", { retryable: true });
              }
              return requireReconnect(scope, stored, "invalid_grant", error.intuitTid);
            }
            throw error;
          }
          let saved: QuickBooksStoredToken;
          try {
            if (options.refreshLease && options.repository.saveWithLease) {
              if (stored.version === undefined) throw new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks token version is unavailable for a fenced refresh");
              saved = await options.repository.saveWithLease(scope, rotated, stored.version, options.refreshLeaseOwnerId!);
            } else {
              saved = await options.repository.save(scope, rotated, stored.version);
            }
          } catch (error) {
            // A second worker may have won the rotation. Re-read once and use it
            // only when it is already valid; never overwrite it blindly.
            try {
              const winner = await options.repository.load(scope);
              if (winner && validUntil(winner.accessTokenExpiresAt, now(), expirySkewMs)) return winner.accessToken;
            } catch {
              // Preserve the original safe token-store failure below.
            }
            throw tokenStoreFailure("QuickBooks token rotation could not be committed", error);
          }
          return saved.accessToken;
        } finally {
          if (leaseHeld) {
            try {
              await options.refreshLease!.release(scope, options.refreshLeaseOwnerId!);
            } catch {
              // The committed token remains usable; a lease expiry recovers a
              // worker that could not release cleanly.
            }
          }
        }
      });
    },

    async disconnect(scope): Promise<void> {
      await serialized(scope, async () => {
        let stored: QuickBooksStoredToken | null | undefined;
        try {
          stored = await options.repository.load(scope);
        } catch (error) {
          throw tokenStoreFailure("QuickBooks token could not be loaded", error);
        }
        if (!stored) return;
        // The provider revoke is attempted before local deletion. If the
        // network call is uncertain, keeping the record lets the operator
        // retry disconnect instead of falsely reporting completion.
        await options.oauth.revokeToken(stored.refreshToken);
        try {
          await options.repository.revoke(scope);
        } catch (error) {
          throw tokenStoreFailure("QuickBooks token could not be cleared", error);
        }
      });
    },
  };
}
