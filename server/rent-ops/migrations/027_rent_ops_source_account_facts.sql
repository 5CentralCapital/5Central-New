-- Account observation is separate from occupancy and recurring schedule dates.
ALTER TABLE rent_ops_people ADD COLUMN source_account_facts jsonb;
ALTER TABLE rent_ops_people ADD CONSTRAINT rent_ops_people_source_account_facts_check CHECK (
 source_account_facts IS NULL OR (
  jsonb_typeof(source_account_facts) = 'object'
  AND source_account_facts ?& ARRAY['status','rawStatus','statusKnowledge','postingStartOn','postingEndOn','postingStartKnowledge','postingEndKnowledge','observedOn','artifactSha256']
  AND (source_account_facts->>'artifactSha256') ~ '^[a-f0-9]{64}$'
  AND (source_account_facts->>'observedOn') ~ '^\d{4}-\d{2}-\d{2}$'
  AND (source_account_facts->>'statusKnowledge') IN ('source','unknown')
  AND ((source_account_facts->>'statusKnowledge' = 'source' AND source_account_facts->>'status' IN ('current','future','past','notice','cancelled'))
       OR (source_account_facts->>'statusKnowledge' = 'unknown' AND source_account_facts->'status' = 'null'::jsonb))
  AND ((source_account_facts->>'postingStartKnowledge' = 'source' AND source_account_facts->>'postingStartOn' ~ '^\d{4}-\d{2}-\d{2}$')
       OR (source_account_facts->>'postingStartKnowledge' = 'unknown' AND source_account_facts->'postingStartOn' = 'null'::jsonb))
  AND ((source_account_facts->>'postingEndKnowledge' = 'source' AND source_account_facts->>'postingEndOn' ~ '^\d{4}-\d{2}-\d{2}$')
       OR (source_account_facts->>'postingEndKnowledge' = 'unknown' AND source_account_facts->'postingEndOn' = 'null'::jsonb))
 ) IS TRUE
);
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (27, '__RENT_OPS_V27_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=27 AND checksum_sha256='__RENT_OPS_V27_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v27_post_insert_checksum_guard;
