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

const DEFAULT_EXPIRY_SKEW_MS = 60_000;

export interface QuickBooksTokenManagerOptions {
  readonly oauth: Pick<QuickBooksOAuthClient, "refreshToken" | "revokeToken">;
  readonly repository: QuickBooksTokenRepository;
  readonly now?: () => Date;
  readonly expirySkewMs?: number;
}

export interface QuickBooksTokenManager extends QuickBooksTokenProvider {
  saveTokens(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet, expectedVersion?: number): Promise<QuickBooksStoredToken>;
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
  const locks = new Map<string, Promise<unknown>>();

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

    async getAccessToken(scope): Promise<string> {
      return serialized(scope, async () => {
        let stored: QuickBooksStoredToken | null | undefined;
        try {
          stored = await options.repository.load(scope);
        } catch (error) {
          throw tokenStoreFailure("QuickBooks token could not be loaded", error);
        }
        if (!stored) throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection is not authorized");
        const current = now();
        if (validUntil(stored.accessTokenExpiresAt, current, expirySkewMs)) return stored.accessToken;
        if (stored.refreshTokenExpiresAt && !validUntil(stored.refreshTokenExpiresAt, current, 0)) {
          throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks refresh token has expired; reconnect is required");
        }
        const rotated = await options.oauth.refreshToken(stored.refreshToken, stored.refreshTokenExpiresAt);
        let saved: QuickBooksStoredToken;
        try {
          saved = await options.repository.save(scope, rotated, stored.version);
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
