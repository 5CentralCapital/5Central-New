-- Shared public request limits. Client addresses are keyed HMAC digests;
-- request bodies, query strings, tokens, and raw addresses are never stored.
CREATE TABLE IF NOT EXISTS rent_ops_public_rate_limits (
  bucket_key text PRIMARY KEY CHECK (
    bucket_key ~ '^(global:[a-z_]+|client:[a-f0-9]{64}:[a-z_]+)$'
  ),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 1000000),
  expires_at timestamptz NOT NULL CHECK (expires_at > window_start)
);
CREATE INDEX IF NOT EXISTS rent_ops_public_rate_limits_expiry_index
  ON rent_ops_public_rate_limits(expires_at, bucket_key);
REVOKE ALL ON rent_ops_public_rate_limits FROM PUBLIC;

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (13, '__RENT_OPS_V13_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 13 AND checksum_sha256 = '__RENT_OPS_V13_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v13_post_insert_checksum_guard;
