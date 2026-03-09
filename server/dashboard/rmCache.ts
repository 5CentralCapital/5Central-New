/**
 * Server-side cache for expensive Rent Manager API calls.
 * Prevents redundant API hits when multiple dashboard tabs fetch the same data.
 *
 * Default TTL: 5 minutes. ChargeTypes cached indefinitely (rarely changes).
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<any>>();

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function cacheSet<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL): void {
  cache.set(key, {
    data,
    expiresAt: ttlMs > 0 ? Date.now() + ttlMs : -1, // -1 = never expires
  });
}

export function cacheInvalidate(keyPrefix?: string): void {
  if (!keyPrefix) {
    cache.clear();
    return;
  }
  const keysToDelete: string[] = [];
  cache.forEach((_, key) => {
    if (key.startsWith(keyPrefix)) keysToDelete.push(key);
  });
  keysToDelete.forEach((k) => cache.delete(k));
}

/**
 * Fetch-through cache: returns cached value if available, otherwise calls fetchFn and caches result.
 */
export async function cachedFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL,
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) return cached;
  const data = await fetchFn();
  cacheSet(key, data, ttlMs);
  return data;
}
