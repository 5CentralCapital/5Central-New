import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

/** Header written by the reviewed edge/WAF integration, never by the browser. */
export const RENT_OPS_EDGE_ATTESTATION_HEADER = "x-rent-ops-edge-attestation" as const;
const DEFAULT_ATTESTATION_MAX_AGE_SECONDS = 90;

export interface RentOpsEdgeAttestationOptions {
  secret?: string;
  now?: () => number;
  maxAgeSeconds?: number;
  enforce?: boolean;
}

export interface RentOpsPublicRateLimiterOptions extends RentOpsEdgeAttestationOptions {
  executor?: RentOpsQueryExecutor;
  env?: Readonly<Record<string, string | undefined>>;
}

const PUBLIC_ROUTE_LIMITS = Object.freeze({
  "GET /application-options": { bucket: "listings", seconds: 60, global: 300, client: 30 },
  "GET /listings": { bucket: "listings", seconds: 60, global: 300, client: 30 },
  "POST /applications/start": { bucket: "start", seconds: 600, global: 100, client: 5 },
  "GET /applications/resume": { bucket: "resume", seconds: 60, global: 300, client: 30 },
  "PATCH /applications/resume": { bucket: "save", seconds: 60, global: 300, client: 30 },
  "POST /applications/resume/certify": { bucket: "certify", seconds: 60, global: 120, client: 10 },
  "POST /applications/resume/submit": { bucket: "submit", seconds: 60, global: 120, client: 10 },
  "POST /applications/resume/household-members": { bucket: "household", seconds: 60, global: 200, client: 20 },
  "POST /applications/resume/documents": { bucket: "documents", seconds: 600, global: 100, client: 10 },
});

// A single statement serializes each counter with ON CONFLICT. Global
// admission precedes client writes, bounding row creation during an attack.
// The database clock is authoritative across processes and older in-flight
// requests cannot rewind a newer window. Cleanup touches at most 64 expired
// rows and excludes every bucket that this statement may update.
const CONSUME_PUBLIC_LIMIT_SQL = `
WITH settings AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS s(bucket_key text, window_seconds integer, request_limit integer, is_global boolean)
), expired AS (
  DELETE FROM rent_ops_public_rate_limits WHERE bucket_key IN (
    SELECT r.bucket_key FROM rent_ops_public_rate_limits r
    WHERE r.expires_at <= statement_timestamp()
      AND r.bucket_key NOT IN (SELECT bucket_key FROM settings)
    ORDER BY r.expires_at, r.bucket_key LIMIT 64 FOR UPDATE SKIP LOCKED
  ) RETURNING bucket_key
), global_counts AS (
  INSERT INTO rent_ops_public_rate_limits(bucket_key, window_start, request_count, expires_at)
  SELECT s.bucket_key,
    to_timestamp(floor(extract(epoch FROM statement_timestamp()) / s.window_seconds) * s.window_seconds),
    1,
    to_timestamp(floor(extract(epoch FROM statement_timestamp()) / s.window_seconds) * s.window_seconds)
      + (2 * s.window_seconds) * interval '1 second'
  FROM settings s CROSS JOIN (SELECT count(*) FROM expired) cleanup
  WHERE s.is_global ORDER BY s.bucket_key
  ON CONFLICT(bucket_key) DO UPDATE SET
    window_start = greatest(rent_ops_public_rate_limits.window_start, EXCLUDED.window_start),
    request_count = CASE WHEN rent_ops_public_rate_limits.window_start < EXCLUDED.window_start THEN 1
      ELSE least(rent_ops_public_rate_limits.request_count + 1, 1000000) END,
    expires_at = greatest(rent_ops_public_rate_limits.expires_at, EXCLUDED.expires_at)
  RETURNING bucket_key, window_start, request_count
), client_counts AS (
  INSERT INTO rent_ops_public_rate_limits(bucket_key, window_start, request_count, expires_at)
  SELECT s.bucket_key,
    to_timestamp(floor(extract(epoch FROM statement_timestamp()) / s.window_seconds) * s.window_seconds),
    1,
    to_timestamp(floor(extract(epoch FROM statement_timestamp()) / s.window_seconds) * s.window_seconds)
      + (2 * s.window_seconds) * interval '1 second'
  FROM settings s WHERE NOT s.is_global
    AND (SELECT count(*) = 2 AND bool_and(g.request_count <= limits.request_limit)
      FROM global_counts g JOIN settings limits USING(bucket_key))
  ORDER BY s.bucket_key
  ON CONFLICT(bucket_key) DO UPDATE SET
    window_start = greatest(rent_ops_public_rate_limits.window_start, EXCLUDED.window_start),
    request_count = CASE WHEN rent_ops_public_rate_limits.window_start < EXCLUDED.window_start THEN 1
      ELSE least(rent_ops_public_rate_limits.request_count + 1, 1000000) END,
    expires_at = greatest(rent_ops_public_rate_limits.expires_at, EXCLUDED.expires_at)
  RETURNING bucket_key, window_start, request_count
), counts AS (
  SELECT * FROM global_counts UNION ALL SELECT * FROM client_counts
)
SELECT count(*) = 4 AND bool_and(c.request_count <= s.request_limit) AS allowed,
  greatest(1, coalesce(max(ceil(extract(epoch FROM
    (c.window_start + s.window_seconds * interval '1 second' - statement_timestamp()))))
    FILTER (WHERE c.request_count > s.request_limit), 1)) AS retry_after_seconds
FROM counts c JOIN settings s USING(bucket_key)`;

function trustedClientAddress(req: Request): string | undefined {
  // Express resolves this from the configured trusted proxy chain. Never
  // parse client-supplied forwarded headers directly in the limiter.
  let address = req.ip;
  if (typeof address !== "string" || address.length > 64 || !isIP(address)) return undefined;
  if (isIP(address) === 6) {
    address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return address;
}

function createDatabasePublicRateLimiter(executor: RentOpsQueryExecutor, secret: string): RequestHandler {
  return async (req, res, next) => {
    const method = req.method.toUpperCase() === "HEAD" ? "GET" : req.method.toUpperCase();
    const key = `${method} ${requestPath(req)}`;
    const rule = PUBLIC_ROUTE_LIMITS[key as keyof typeof PUBLIC_ROUTE_LIMITS];
    if (!rule) { res.status(404).json({ code: "not_found" }); return; }
    try {
      const address = trustedClientAddress(req);
      if (!address) throw new Error("public_client_address_unavailable");
      const hash = createHmac("sha256", secret).update(`rent-ops-public-rate-limit:${address}`).digest("hex");
      const settings = [
        { bucket_key: "global:all", window_seconds: 60, request_limit: 600, is_global: true },
        { bucket_key: `global:${rule.bucket}`, window_seconds: rule.seconds, request_limit: rule.global, is_global: true },
        { bucket_key: `client:${hash}:all`, window_seconds: 60, request_limit: 60, is_global: false },
        { bucket_key: `client:${hash}:${rule.bucket}`, window_seconds: rule.seconds, request_limit: rule.client, is_global: false },
      ];
      const result = await executor.query<{ allowed: boolean; retry_after_seconds: number | string }>(CONSUME_PUBLIC_LIMIT_SQL, [JSON.stringify(settings)]);
      const decision = result.rows[0];
      const retryAfter = Number(decision?.retry_after_seconds);
      if (result.rows.length !== 1 || typeof decision?.allowed !== "boolean" || !Number.isFinite(retryAfter) || retryAfter < 1 || retryAfter > 600) {
        throw new Error("public_limiter_result_invalid");
      }
      if (decision.allowed) { next(); return; }
      res.set("Retry-After", String(Math.ceil(retryAfter)));
      res.status(429).json({ code: "rate_limited" });
    } catch {
      res.set("Retry-After", "30");
      res.status(503).json({ code: "public_limiter_unavailable" });
    }
  };
}

function secretValue(options: RentOpsEdgeAttestationOptions): string | undefined {
  const value = options.secret ?? process.env.RENT_OPS_EDGE_ATTESTATION_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestPath(req: Request): string {
  return req.path || req.originalUrl.split("?", 1)[0] || "/";
}

function signaturePayload(timestampSeconds: number, method: string, path: string): string {
  return `${timestampSeconds}:${method.toUpperCase()}:${path}`;
}

export function signRentOpsEdgeAttestation(input: {
  secret: string;
  timestampSeconds: number;
  method: string;
  path: string;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(signaturePayload(input.timestampSeconds, input.method, input.path))
    .digest("hex");
  return `${input.timestampSeconds}.${digest}`;
}

export function verifyRentOpsEdgeAttestation(req: Request, token: string | undefined, options: RentOpsEdgeAttestationOptions = {}): boolean {
  const secret = secretValue(options);
  if (!secret || !token) return false;
  const match = /^(\d{1,12})\.([a-f0-9]{64})$/i.exec(token.trim());
  if (!match) return false;
  const timestampSeconds = Number(match[1]);
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_ATTESTATION_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(timestampSeconds) || !Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) return false;
  const expected = signRentOpsEdgeAttestation({ secret, timestampSeconds, method: req.method, path: requestPath(req) });
  const expectedSignature = expected.slice(expected.indexOf(".") + 1);
  const suppliedSignature = match[2].toLowerCase();
  try {
    return timingSafeEqual(Buffer.from(expectedSignature, "hex"), Buffer.from(suppliedSignature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Production uses either atomic shared database counters or a reviewed edge
 * limiter. Missing dependencies never fall back to a per-process map.
 */
export function createRentOpsPublicRateLimiter(options: RentOpsPublicRateLimiterOptions = {}): RequestHandler {
  const env = options.env ?? process.env;
  const enforce = options.enforce ?? env.NODE_ENV === "production";
  const mode = env.RENT_OPS_PUBLIC_LIMITER_MODE ?? "edge-attestation";
  if (enforce && mode === "database") {
    const secret = env.RENT_OPS_SESSION_SECRET;
    if (!options.executor || !secret || secret.length < 32) throw new Error("public_database_limiter_configuration_required");
    return createDatabasePublicRateLimiter(options.executor, secret);
  }
  if (enforce && mode !== "edge-attestation") throw new Error("public_limiter_mode_invalid");
  const edgeOptions = { ...options, secret: options.secret ?? env.RENT_OPS_EDGE_ATTESTATION_SECRET };
  return (req, res, next) => {
    if (!enforce || verifyRentOpsEdgeAttestation(req, req.get(RENT_OPS_EDGE_ATTESTATION_HEADER), edgeOptions)) {
      next();
      return;
    }
    res.status(403).json({ code: "edge_attestation_required" });
  };
}
