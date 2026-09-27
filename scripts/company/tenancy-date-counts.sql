-- Read-only PR #11 follow-up measurement. Run with the runtime connection.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

SELECT current_user, current_database(), current_setting('transaction_read_only') AS read_only;

WITH t AS (
  SELECT t.id, t.property_id, t.status,
         COALESCE(t.actual_move_in_on, t.planned_move_in_on, l.first_start_on) AS start_on,
         COALESCE(t.actual_move_out_on, (t.ended_at AT TIME ZONE 'America/New_York')::date, l.last_end_on) AS end_on
    FROM rent_ops_tenancies t
    LEFT JOIN LATERAL (
      SELECT MIN(contract_start_on) AS first_start_on, MAX(contract_end_on) AS last_end_on
        FROM rent_ops_lease_terms lt
       WHERE lt.tenancy_id = t.id AND lt.status IS DISTINCT FROM 'cancelled'
    ) l ON true
), linked AS (
  SELECT DISTINCT local_id FROM company_external_identities
   WHERE provider = 'qbo' AND record_kind = 'Customer' AND local_kind = 'tenancy'
), buckets AS (
  SELECT property_id,
         (start_on IS NULL) AS missing_start,
         (end_on IS NULL AND status NOT IN ('current', 'notice', 'future')) AS missing_end,
         (t.id IN (SELECT local_id FROM linked)) AS qbo_linked
    FROM t
)
SELECT 'all' AS property_id, missing_start, missing_end, qbo_linked, COUNT(*)::int AS count
  FROM buckets GROUP BY 2, 3, 4
UNION ALL
SELECT property_id, missing_start, missing_end, qbo_linked, COUNT(*)::int
  FROM buckets GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

ROLLBACK;
