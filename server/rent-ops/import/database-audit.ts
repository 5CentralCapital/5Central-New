import { createHash } from "node:crypto";
import type { RentOpsSourceRecord } from "../../../shared/rent-ops-contracts";
import { RENT_OPS_AUDIT_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION, rentOpsMigrationChecksumForVersion } from "../persistence";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

/**
 * These queries intentionally do not depend on the repository's snapshot
 * loader. The audit is a second view of the database and should be able to
 * catch a repository or mapper defect. Every statement is a SELECT; this
 * module never performs migration or business writes.
 */
const FINANCIAL_REPORT_V8_SQL = `SELECT * FROM (
WITH RECURSIVE
report_interval AS (
  SELECT
    DATE_TRUNC('month', $1::date)::date AS month_start,
    (DATE_TRUNC('month', $1::date) + INTERVAL '1 month - 1 day')::date AS month_end,
    DATE_TRUNC('month', $1::date)::date = DATE_TRUNC('month', CURRENT_DATE)::date AS observation_month
),
lease_overlap AS (
  SELECT
    t.id AS tenancy_id,
    COUNT(l.id)::bigint AS lease_count,
    COUNT(l.id) FILTER (WHERE l.status IN ('executed', 'month_to_month')
      AND l.status_knowledge IN ('source', 'manual')
      AND l.contract_start_on IS NOT NULL
      AND l.contract_start_knowledge IN ('source', 'manual')
      AND (
        (l.contract_end_on IS NOT NULL AND (
          l.contract_end_knowledge IN ('source', 'manual')
          OR (l.status = 'month_to_month' AND l.status_knowledge IN ('source', 'manual'))
          OR (l.month_to_month IS TRUE AND l.month_to_month_knowledge IN ('source', 'manual'))
        ))
        OR (l.contract_end_on IS NULL AND (
          (l.status = 'month_to_month' AND l.status_knowledge IN ('source', 'manual'))
          OR (l.month_to_month IS TRUE AND l.month_to_month_knowledge IN ('source', 'manual'))
        ))
      )
      AND l.tenancy_link_knowledge IN ('exact', 'manual')
      AND l.contract_start_on <= i.month_end
      AND (l.contract_end_on IS NULL OR l.contract_end_on >= i.month_start))::bigint AS effective_lease_count,
    COUNT(l.id) FILTER (WHERE l.status IN ('executed', 'month_to_month')
      AND l.contract_start_on IS NOT NULL
      AND l.contract_start_on <= i.month_end
      AND (l.contract_end_on IS NULL OR l.contract_end_on >= i.month_start))::bigint AS overlapping_lease_count
  FROM rent_ops_tenancies t
  CROSS JOIN report_interval i
  LEFT JOIN rent_ops_lease_terms l ON l.tenancy_id = t.id
  GROUP BY t.id, i.month_start, i.month_end
),
tenancy_effective AS (
  SELECT
    t.id AS tenancy_id,
    t.property_id,
    t.unit_id,
    t.primary_person_id,
    t.status,
    t.property_link_knowledge,
    t.unit_link_knowledge,
    i.month_start,
    i.month_end,
    lo.effective_lease_count,
    lo.overlapping_lease_count,
    CASE
      WHEN t.property_id IS NULL OR t.unit_id IS NULL OR t.primary_person_id IS NULL
        OR t.property_link_knowledge NOT IN ('exact', 'manual')
        OR t.unit_link_knowledge NOT IN ('exact', 'manual')
        OR t.primary_person_link_knowledge NOT IN ('exact', 'manual') THEN 'unknown'
      WHEN t.status IS NULL OR t.status NOT IN ('current', 'notice', 'past', 'future', 'cancelled')
        OR t.status_knowledge NOT IN ('source', 'manual') THEN 'unknown'
      WHEN t.status = 'cancelled' THEN 'excluded'
      WHEN t.status = 'future' AND (t.planned_move_in_on IS NULL OR t.planned_move_in_knowledge NOT IN ('source', 'manual')) THEN 'unknown'
      WHEN t.status = 'future' AND t.planned_move_in_on > i.month_end THEN 'excluded'
      WHEN t.status = 'future' AND t.actual_move_in_on IS NOT NULL AND t.actual_move_in_on <= i.month_end THEN 'unknown'
      WHEN t.status = 'future' AND COALESCE(lo.effective_lease_count, 0) <> 1 THEN 'unknown'
      WHEN t.status = 'future' THEN 'future_preleased'
      WHEN t.actual_move_in_on IS NULL OR t.actual_move_in_knowledge NOT IN ('source', 'manual') THEN 'unknown'
      WHEN t.actual_move_in_on > i.month_end THEN 'excluded'
      WHEN t.actual_move_out_on IS NOT NULL AND t.actual_move_out_knowledge NOT IN ('source', 'manual') THEN 'unknown'
      WHEN t.status = 'past' AND t.actual_move_out_on IS NULL THEN 'unknown'
      WHEN t.actual_move_out_on IS NOT NULL AND t.actual_move_out_on < i.month_start THEN 'excluded'
      WHEN COALESCE(lo.effective_lease_count, 0) <> 1 THEN 'unknown'
      WHEN t.status IN ('current', 'notice') THEN 'current'
      ELSE 'past'
    END AS tenancy_state,
    CASE
      WHEN t.status = 'future' THEN t.planned_move_in_on
      ELSE t.actual_move_in_on
    END AS effective_move_in_on
  FROM rent_ops_tenancies t
  CROSS JOIN report_interval i
  LEFT JOIN lease_overlap lo ON lo.tenancy_id = t.id
),
unit_occupancy_candidates AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (
      PARTITION BY e.property_id, e.unit_id
      ORDER BY CASE e.tenancy_state WHEN 'current' THEN 1 WHEN 'past' THEN 2 WHEN 'future_preleased' THEN 3 ELSE 4 END,
        e.effective_move_in_on DESC NULLS LAST, e.tenancy_id
    ) AS occupancy_rank
  FROM tenancy_effective e
  WHERE e.tenancy_state <> 'excluded'
),
property_unknown_unit_tenancies AS (
  SELECT e.property_id, COUNT(*)::bigint AS unknown_assignment_count
  FROM tenancy_effective e
  WHERE e.property_id IS NOT NULL
    AND e.property_link_knowledge IN ('exact', 'manual')
    AND (e.unit_id IS NULL OR e.unit_link_knowledge NOT IN ('exact', 'manual'))
    AND e.tenancy_state <> 'excluded'
  GROUP BY e.property_id
),
unit_occupancy AS (
  SELECT
    base.property_id,
    base.id AS unit_id,
    COUNT(*) FILTER (WHERE u.tenancy_state IN ('current', 'past', 'future_preleased'))::bigint AS effective_tenancy_count,
    (COUNT(*) FILTER (WHERE u.tenancy_state = 'unknown') + COALESCE(MAX(pu.unknown_assignment_count), 0))::bigint AS unknown_tenancy_count,
    CASE
      WHEN COUNT(*) FILTER (WHERE u.tenancy_state = 'unknown') > 0
        OR COALESCE(MAX(pu.unknown_assignment_count), 0) > 0
        OR COUNT(*) FILTER (WHERE u.tenancy_state IN ('current', 'past', 'future_preleased')) > 1 THEN 'unknown'
      WHEN COUNT(u.unit_id) = 0 THEN 'vacant'
      ELSE MAX(u.tenancy_state) FILTER (WHERE u.occupancy_rank = 1)
    END AS occupancy_state,
    CASE
      WHEN COUNT(*) FILTER (WHERE u.tenancy_state = 'unknown') = 0
        AND COALESCE(MAX(pu.unknown_assignment_count), 0) = 0
        AND COUNT(*) FILTER (WHERE u.tenancy_state IN ('current', 'past', 'future_preleased')) = 1
      THEN MAX(u.tenancy_id) FILTER (WHERE u.occupancy_rank = 1)
      ELSE NULL
    END AS tenancy_id,
    CASE
      WHEN COUNT(*) FILTER (WHERE u.tenancy_state = 'unknown') = 0
        AND COALESCE(MAX(pu.unknown_assignment_count), 0) = 0
        AND COUNT(*) FILTER (WHERE u.tenancy_state IN ('current', 'past', 'future_preleased')) = 1
      THEN MAX(u.primary_person_id) FILTER (WHERE u.occupancy_rank = 1)
      ELSE NULL
    END AS person_id
  FROM rent_ops_units base
  LEFT JOIN unit_occupancy_candidates u
    ON u.property_id = base.property_id AND u.unit_id = base.id
  LEFT JOIN property_unknown_unit_tenancies pu ON pu.property_id = base.property_id
  GROUP BY base.property_id, base.id
),
schedule_rows AS (
  SELECT
    s.*,
    CASE
      WHEN s.charge_definition_id IS NOT NULL
        AND s.charge_definition_link_knowledge IN ('exact', 'manual') THEN s.charge_definition_id
      ELSE 'unknown:' || s.id
    END AS definition_key,
    CASE s.scope_type WHEN 'tenant' THEN 3 WHEN 'unit' THEN 2 WHEN 'property' THEN 1 ELSE 0 END AS scope_rank,
    CASE WHEN s.amount_cents IS NULL OR s.amount_knowledge = 'unknown' THEN 1 ELSE 0 END AS unknown_amount,
    CASE WHEN s.effective_from IS NULL AND s.effective_from_knowledge = 'unknown_open_start' THEN 1 ELSE 0 END AS unknown_open_start
  FROM rent_ops_recurring_charge_schedules s
),
lineage_walk AS (
  SELECT
    s.id,
    s.id AS lineage_root_id,
    s.supersedes_id,
    0::integer AS lineage_depth,
    s.version_action,
    s.effective_from,
    s.effective_to,
    s.active,
    s.amount_cents,
    s.scope_type,
    s.scope_id,
    s.scope_type_knowledge,
    s.scope_link_knowledge,
    s.charge_definition_id,
    s.charge_definition_key,
    s.charge_definition_knowledge,
    s.charge_definition_link_knowledge,
    s.property_id,
    s.unit_id,
    s.tenancy_id,
    s.person_id,
    s.category,
    s.category_knowledge,
    s.description,
    s.description_knowledge,
    s.source_confidence,
    s.effective_from_knowledge,
    s.active_knowledge,
    s.lineage_root_origin,
    s.source_artifact_sha256,
    s.artifact_observation_on,
    ARRAY[s.id]::text[] AS lineage_path,
    false AS lineage_broken
  FROM schedule_rows s
  WHERE s.version_action = 'root' AND s.lineage_root_id = s.id
  UNION ALL
  SELECT
    child.id,
    walk.lineage_root_id,
    child.supersedes_id,
    walk.lineage_depth + 1,
    child.version_action,
    child.effective_from,
    child.effective_to,
    child.active,
    child.amount_cents,
    child.scope_type,
    child.scope_id,
    child.scope_type_knowledge,
    child.scope_link_knowledge,
    child.charge_definition_id,
    child.charge_definition_key,
    child.charge_definition_knowledge,
    child.charge_definition_link_knowledge,
    child.property_id,
    child.unit_id,
    child.tenancy_id,
    child.person_id,
    child.category,
    child.category_knowledge,
    child.description,
    child.description_knowledge,
    child.source_confidence,
    child.effective_from_knowledge,
    child.active_knowledge,
    child.lineage_root_origin,
    child.source_artifact_sha256,
    child.artifact_observation_on,
    walk.lineage_path || child.id,
    walk.lineage_broken
      OR child.lineage_root_id IS DISTINCT FROM walk.lineage_root_id
      OR child.version_action NOT IN ('replace', 'end')
      OR child.effective_from IS NULL
      OR child.effective_from_knowledge IS DISTINCT FROM 'manual'
      OR (walk.version_action = 'end')
      OR (walk.effective_from IS NOT NULL AND child.effective_from <= walk.effective_from)
      OR (walk.effective_from IS NULL
        AND walk.effective_from_knowledge = 'unknown_open_start'
        AND (walk.artifact_observation_on IS NULL OR child.effective_from < walk.artifact_observation_on))
      OR (walk.effective_to IS NOT NULL AND child.effective_from > walk.effective_to)
      OR child.scope_type IS DISTINCT FROM walk.scope_type
      OR child.scope_id IS DISTINCT FROM walk.scope_id
      OR child.scope_type_knowledge IS DISTINCT FROM walk.scope_type_knowledge
      OR child.scope_link_knowledge IS DISTINCT FROM walk.scope_link_knowledge
      OR child.charge_definition_id IS DISTINCT FROM walk.charge_definition_id
      OR child.charge_definition_key IS DISTINCT FROM walk.charge_definition_key
      OR child.charge_definition_knowledge IS DISTINCT FROM walk.charge_definition_knowledge
      OR child.charge_definition_link_knowledge IS DISTINCT FROM walk.charge_definition_link_knowledge
      OR child.tenancy_id IS DISTINCT FROM walk.tenancy_id
      OR child.person_id IS DISTINCT FROM walk.person_id
      OR child.property_id IS DISTINCT FROM walk.property_id
      OR child.unit_id IS DISTINCT FROM walk.unit_id
      OR child.category IS DISTINCT FROM walk.category
      OR child.category_knowledge IS DISTINCT FROM walk.category_knowledge
      OR child.description IS DISTINCT FROM walk.description
      OR child.description_knowledge IS DISTINCT FROM walk.description_knowledge
      OR child.source_confidence IS DISTINCT FROM walk.source_confidence
      OR child.lineage_root_origin IS DISTINCT FROM walk.lineage_root_origin
      OR child.source_artifact_sha256 IS DISTINCT FROM walk.source_artifact_sha256
      OR child.artifact_observation_on IS DISTINCT FROM walk.artifact_observation_on
      OR (child.version_action = 'replace' AND (
        child.active IS DISTINCT FROM walk.active
        OR child.active_knowledge IS DISTINCT FROM walk.active_knowledge
        OR child.effective_to IS DISTINCT FROM walk.effective_to))
      OR (child.version_action = 'end' AND (
        child.active IS DISTINCT FROM FALSE
        OR child.active_knowledge IS DISTINCT FROM 'manual'
        OR child.effective_to IS DISTINCT FROM child.effective_from))
  FROM lineage_walk walk
  JOIN schedule_rows child ON child.supersedes_id = walk.id
    AND NOT child.id = ANY(walk.lineage_path)
),
lineage_orphans AS (
  SELECT s.id
  FROM schedule_rows s
  LEFT JOIN lineage_walk w ON w.id = s.id
  WHERE w.id IS NULL
),
lineage_branches AS (
  SELECT supersedes_id AS predecessor_id
  FROM schedule_rows
  WHERE supersedes_id IS NOT NULL
  GROUP BY supersedes_id
  HAVING COUNT(*) > 1
),
lineage_rows_base AS (
  SELECT s.*, COALESCE(w.lineage_root_id, s.lineage_root_id) AS resolved_root_id,
    (o.id IS NOT NULL OR w.lineage_broken OR s.id IN (SELECT predecessor_id FROM lineage_branches)
      OR s.supersedes_id IN (SELECT predecessor_id FROM lineage_branches)
      OR s.lineage_root_id IS NULL
      OR s.version_action IS NULL OR s.version_action NOT IN ('root', 'replace', 'end')
      OR s.lineage_root_origin NOT IN ('artifact', 'manual')
      OR s.version_origin NOT IN ('artifact', 'manual')
      OR ((s.source_system IS NULL) IS DISTINCT FROM (s.source_id IS NULL))
      OR (s.source_system IS NOT NULL AND length(btrim(s.source_system)) = 0)
      OR (s.source_id IS NOT NULL AND length(btrim(s.source_id)) = 0)
      OR (s.version_action = 'root' AND (
        s.lineage_root_id IS DISTINCT FROM s.id
        OR s.supersedes_id IS NOT NULL
        OR (s.lineage_root_origin = 'artifact' AND (
          s.version_origin IS DISTINCT FROM 'artifact'
          OR s.source_system IS NULL OR s.source_id IS NULL
          OR length(btrim(s.source_system)) = 0 OR length(btrim(s.source_id)) = 0
          OR s.source_artifact_sha256 IS NULL OR s.source_artifact_sha256 !~ '^[a-f0-9]{64}$'
          OR s.artifact_observation_on IS NULL
          OR (s.effective_from IS NULL AND s.effective_from_knowledge IS DISTINCT FROM 'unknown_open_start')
          OR (s.effective_from IS NOT NULL AND s.effective_from_knowledge IS DISTINCT FROM 'source')
        ))
        OR (s.lineage_root_origin = 'manual' AND (
          s.version_origin IS DISTINCT FROM 'manual'
          OR s.source_system IS NOT NULL OR s.source_id IS NOT NULL
          OR s.source_artifact_sha256 IS NOT NULL OR s.artifact_observation_on IS NOT NULL
          OR s.effective_from IS NULL OR s.effective_from_knowledge IS DISTINCT FROM 'manual'
        ))
      ))
      OR (s.version_action IN ('replace', 'end') AND (
        s.supersedes_id IS NULL
        OR s.version_origin IS DISTINCT FROM 'manual'
        OR s.source_system IS NOT NULL OR s.source_id IS NOT NULL
        OR s.effective_from IS NULL OR s.effective_from_knowledge IS DISTINCT FROM 'manual'
      ))
      OR (s.version_action = 'replace' AND (s.amount_cents IS NULL OR s.amount_cents <= 0 OR s.amount_knowledge IS DISTINCT FROM 'known'))
      OR (s.version_action = 'end' AND (s.amount_cents IS NOT NULL OR s.amount_knowledge IS DISTINCT FROM 'unknown'))) AS lineage_invalid,
    w.lineage_depth
  FROM schedule_rows s
  LEFT JOIN lineage_walk w ON w.id = s.id
  LEFT JOIN lineage_orphans o ON o.id = s.id
),
lineage_invalid_roots AS (
  SELECT DISTINCT resolved_root_id
  FROM lineage_rows_base
  WHERE lineage_invalid OR resolved_root_id IS NULL
  UNION
  SELECT resolved_root_id
  FROM lineage_rows_base
  WHERE effective_from IS NOT NULL
  GROUP BY resolved_root_id, effective_from
  HAVING COUNT(*) > 1
),
lineage_rows AS (
  SELECT l.*,
    (l.lineage_invalid OR q.resolved_root_id IS NOT NULL) AS lineage_invalid_quarantined
  FROM lineage_rows_base l
  LEFT JOIN lineage_invalid_roots q ON q.resolved_root_id = l.resolved_root_id
),
lineage_eligible AS (
  SELECT
    l.*,
    i.month_start,
    i.month_end,
    i.observation_month,
    ROW_NUMBER() OVER (
      PARTITION BY l.resolved_root_id
      ORDER BY l.effective_from DESC NULLS LAST, l.lineage_depth DESC NULLS LAST, l.id
    ) AS effective_rank
  FROM lineage_rows l
  CROSS JOIN report_interval i
  WHERE NOT l.lineage_invalid_quarantined
    AND (
      -- Rank the latest started lineage version first, then apply the
      -- winner's terminal/end state in lineage_classified. Otherwise an end
      -- tombstone falls out after its own effective_to and revives the root.
      (l.effective_from IS NOT NULL AND l.effective_from <= i.month_end)
      OR (l.effective_from IS NULL AND l.effective_from_knowledge = 'unknown_open_start'
        AND l.artifact_observation_on IS NOT NULL
        AND i.month_start >= DATE_TRUNC('month', l.artifact_observation_on)::date)
    )
),
lineage_classified AS (
  SELECT
    l.*,
    COALESCE(e.effective_rank = 1, false) AS is_effective_version,
    CASE
      WHEN l.lineage_invalid_quarantined THEN 'invalid'
      WHEN e.id IS NULL AND l.effective_from IS NOT NULL AND l.effective_from > i.month_end THEN 'future'
      WHEN e.id IS NULL AND l.effective_from IS NULL AND l.effective_from_knowledge = 'unknown_open_start'
        AND (l.artifact_observation_on IS NULL
          OR i.month_start < DATE_TRUNC('month', l.artifact_observation_on)::date) THEN 'future'
      WHEN e.id IS NULL AND l.active IS FALSE THEN 'inactive'
      WHEN e.id IS NULL THEN 'ended'
      WHEN e.id IS NOT NULL AND e.effective_rank <> 1 THEN 'superseded'
      WHEN e.version_action = 'end' OR (e.effective_to IS NOT NULL AND e.effective_to < i.month_start) THEN 'ended'
      WHEN e.active IS FALSE THEN 'inactive'
      ELSE 'selected'
    END AS lineage_bucket
  FROM lineage_rows l
  CROSS JOIN report_interval i
  LEFT JOIN lineage_eligible e ON e.id = l.id
),
scope_candidates AS (
  SELECT
    l.*,
    st.property_id AS scheduled_tenancy_property_id,
    st.unit_id AS scheduled_tenancy_unit_id,
    st.primary_person_id AS scheduled_tenancy_person_id,
    st.property_link_knowledge AS scheduled_tenancy_property_link_knowledge,
    st.unit_link_knowledge AS scheduled_tenancy_unit_link_knowledge,
    st.primary_person_link_knowledge AS scheduled_tenancy_person_link_knowledge,
    uo.occupancy_state,
    uo.tenancy_id AS assigned_tenancy_id,
    uo.person_id AS assigned_person_id,
    COUNT(uo.unit_id) OVER (PARTITION BY l.id) AS person_assignment_count,
    CASE
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'property'
        AND l.scope_id = l.property_id
        AND l.unit_id IS NULL AND l.person_id IS NULL AND l.tenancy_id IS NULL THEN l.property_id
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'unit'
        AND uo.unit_id IS NOT NULL
        AND uo.property_id = l.property_id
        AND l.scope_id = uo.unit_id
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND l.tenancy_id IS NULL AND l.person_id IS NULL THEN uo.property_id
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant'
        AND l.tenancy_id IS NOT NULL
        AND st.id = l.tenancy_id
        AND st.property_id = l.property_id
        AND st.primary_person_id = l.scope_id
        AND st.unit_id = uo.unit_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = st.unit_id)
        AND st.property_link_knowledge IN ('exact', 'manual')
        AND st.unit_link_knowledge IN ('exact', 'manual')
        AND st.primary_person_link_knowledge IN ('exact', 'manual')
        AND uo.property_id = l.property_id THEN uo.property_id
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant'
        AND l.tenancy_id IS NULL
        AND l.scope_id IS NOT NULL
        AND l.scope_id = uo.person_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND uo.property_id = l.property_id
        AND uo.occupancy_state IN ('current', 'past', 'future_preleased') THEN uo.property_id
      ELSE NULL
    END AS resolved_property_id,
    CASE
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'property' AND l.scope_id = l.property_id
        AND l.unit_id IS NULL AND l.person_id IS NULL AND l.tenancy_id IS NULL THEN NULL
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'unit' AND uo.unit_id IS NOT NULL
        AND uo.property_id = l.property_id AND l.scope_id = uo.unit_id
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND l.tenancy_id IS NULL AND l.person_id IS NULL THEN uo.unit_id
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant' AND l.tenancy_id IS NOT NULL
        AND st.id = l.tenancy_id AND st.property_id = l.property_id
        AND st.primary_person_id = l.scope_id AND st.unit_id = uo.unit_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = st.unit_id)
        AND st.property_link_knowledge IN ('exact', 'manual')
        AND st.unit_link_knowledge IN ('exact', 'manual')
        AND st.primary_person_link_knowledge IN ('exact', 'manual') THEN uo.unit_id
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant' AND l.tenancy_id IS NULL
        AND l.scope_id = uo.person_id AND uo.property_id = l.property_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND uo.occupancy_state IN ('current', 'past', 'future_preleased') THEN uo.unit_id
      ELSE NULL
    END AS resolved_unit_id,
    CASE
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant' AND l.tenancy_id IS NULL
        AND l.scope_id = uo.person_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id) THEN 'person_only'
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'tenant' AND l.tenancy_id IS NOT NULL
        AND st.id = l.tenancy_id AND st.primary_person_id = l.scope_id
        AND (l.person_id IS NULL OR l.person_id = l.scope_id)
        AND (l.unit_id IS NULL OR l.unit_id = st.unit_id) THEN 'tenancy_bound'
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'property' AND l.scope_id = l.property_id
        AND l.unit_id IS NULL AND l.person_id IS NULL AND l.tenancy_id IS NULL THEN 'property'
      WHEN l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_type = 'unit' AND l.scope_id = uo.unit_id
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND l.tenancy_id IS NULL AND l.person_id IS NULL THEN 'unit'
      ELSE 'unknown'
    END AS resolved_scope_kind
  FROM lineage_classified l
  LEFT JOIN rent_ops_tenancies st
    ON l.scope_type = 'tenant' AND l.tenancy_id IS NOT NULL AND st.id = l.tenancy_id
  LEFT JOIN unit_occupancy uo
    ON (
      (l.scope_type = 'unit'
        AND l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_id = uo.unit_id)
      OR (l.scope_type = 'tenant' AND l.tenancy_id IS NOT NULL
        AND l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND st.unit_id = uo.unit_id AND st.property_id = uo.property_id)
      OR (l.scope_type = 'tenant' AND l.tenancy_id IS NULL
        AND l.scope_type_knowledge IN ('source', 'manual')
        AND l.scope_link_knowledge IN ('exact', 'manual')
        AND l.scope_id = uo.person_id
        AND (l.unit_id IS NULL OR l.unit_id = uo.unit_id)
        AND uo.occupancy_state IN ('current', 'past', 'future_preleased'))
    )
  WHERE l.lineage_bucket = 'selected'
),
scope_candidates_ranked AS (
  SELECT c.*,
    ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY c.resolved_unit_id NULLS LAST, c.assigned_tenancy_id NULLS LAST) AS scope_candidate_rank
  FROM scope_candidates c
),
scope_resolved AS (
  SELECT c.*,
    CASE
      WHEN c.scope_type_knowledge NOT IN ('source', 'manual')
        OR c.scope_link_knowledge NOT IN ('exact', 'manual')
        OR c.resolved_scope_kind = 'unknown' THEN 'unassigned'
      WHEN c.resolved_property_id IS NULL THEN 'unassigned'
      WHEN c.resolved_scope_kind = 'person_only' AND c.person_assignment_count <> 1 THEN 'unassigned'
      WHEN c.resolved_scope_kind = 'tenancy_bound' AND c.assigned_tenancy_id IS DISTINCT FROM c.tenancy_id THEN 'not_applicable'
      WHEN c.occupancy_state = 'vacant' THEN 'not_applicable'
      WHEN c.resolved_scope_kind IN ('unit', 'tenancy_bound', 'person_only') AND c.occupancy_state = 'unknown' THEN 'uncertain'
      WHEN c.resolved_scope_kind IN ('unit', 'tenancy_bound', 'person_only') AND c.occupancy_state IS NULL THEN 'unassigned'
      ELSE 'resolved'
    END AS scope_bucket
  FROM scope_candidates_ranked c
  WHERE c.scope_candidate_rank = 1
),
property_winners AS (
  SELECT s.*,
    COUNT(*) OVER (PARTITION BY s.property_id, s.definition_key) AS property_definition_count,
    ROW_NUMBER() OVER (PARTITION BY s.property_id, s.definition_key ORDER BY s.effective_from DESC NULLS LAST, s.id) AS property_once_rank
  FROM scope_resolved s
  WHERE s.scope_type = 'property' AND s.scope_bucket = 'resolved'
),
unit_tenant_ranked AS (
  SELECT s.*,
    MAX(s.scope_rank) OVER (PARTITION BY s.resolved_unit_id, s.definition_key) AS maximum_scope_rank
  FROM scope_resolved s
  WHERE s.scope_type IN ('tenant', 'unit') AND s.scope_bucket IN ('resolved', 'uncertain')
    AND s.resolved_unit_id IS NOT NULL
),
unit_tenant_candidates AS (
  SELECT s.*,
    COUNT(*) FILTER (WHERE s.scope_rank = s.maximum_scope_rank)
      OVER (PARTITION BY s.resolved_unit_id, s.definition_key) AS maximum_scope_rank_count,
    ROW_NUMBER() OVER (
      PARTITION BY s.resolved_unit_id, s.definition_key
      ORDER BY s.scope_rank DESC, s.effective_from DESC NULLS LAST, s.id
    ) AS precedence_rank
  FROM unit_tenant_ranked s
),
unit_tenant_conflict_buckets AS (
  SELECT s.id, s.property_id, s.amount_cents, s.unknown_amount, 'unassigned'::text AS bucket
  FROM unit_tenant_candidates s
  WHERE s.maximum_scope_rank_count <> 1
),
assigned_buckets AS (
  SELECT s.id, s.property_id, s.amount_cents, s.unknown_amount, s.category,
    CASE
      WHEN s.scope_bucket = 'unassigned' THEN 'unassigned'
      WHEN s.category IS NULL OR s.category_knowledge NOT IN ('source', 'manual')
        OR s.unknown_amount = 1
        OR s.active IS NOT TRUE OR s.active_knowledge NOT IN ('source', 'manual')
        OR s.scope_type_knowledge NOT IN ('source', 'manual')
        OR s.scope_link_knowledge NOT IN ('exact', 'manual')
        OR s.charge_definition_link_knowledge NOT IN ('exact', 'manual')
        OR s.effective_from_knowledge = 'unknown_open_start'
        OR s.scope_bucket = 'uncertain' THEN 'uncertain'
      ELSE 'known'
    END AS bucket,
    CASE WHEN s.scope_type = 'property' THEN 1 ELSE 0 END AS property_once
  FROM scope_resolved s
  WHERE s.scope_type IN ('tenant', 'unit')
    AND EXISTS (SELECT 1 FROM unit_tenant_candidates c WHERE c.id = s.id AND c.precedence_rank = 1 AND c.maximum_scope_rank_count = 1)
  UNION ALL
  SELECT p.id, p.property_id, p.amount_cents, p.unknown_amount, p.category,
    CASE
      WHEN p.category IS NULL OR p.category_knowledge NOT IN ('source', 'manual')
        OR p.unknown_amount = 1
        OR p.active IS NOT TRUE OR p.active_knowledge NOT IN ('source', 'manual')
        OR p.scope_type_knowledge NOT IN ('source', 'manual')
        OR p.scope_link_knowledge NOT IN ('exact', 'manual')
        OR p.charge_definition_link_knowledge NOT IN ('exact', 'manual')
        OR p.effective_from_knowledge = 'unknown_open_start' THEN 'uncertain'
      ELSE 'known'
    END AS bucket,
    1 AS property_once
  FROM property_winners p
  WHERE p.property_definition_count = 1 AND p.property_once_rank = 1
  UNION ALL
  SELECT s.id, s.property_id, s.amount_cents, s.unknown_amount, s.category,
    'unassigned'::text AS bucket,
    0 AS property_once
  FROM scope_resolved s
  WHERE s.scope_bucket = 'unassigned'
  UNION ALL
  SELECT p.id, p.property_id, p.amount_cents, p.unknown_amount, p.category,
    'unassigned'::text AS bucket,
    0 AS property_once
  FROM property_winners p
  WHERE p.property_definition_count > 1
  UNION ALL
  SELECT c.id, c.property_id, c.amount_cents, c.unknown_amount, NULL, c.bucket, 0
  FROM unit_tenant_conflict_buckets c
),
suppressed_buckets AS (
  SELECT s.id, s.property_id, s.amount_cents, s.unknown_amount, 'suppressed'::text AS bucket
  FROM scope_resolved s
  JOIN unit_tenant_candidates c ON c.id = s.id
  WHERE c.maximum_scope_rank_count = 1 AND c.precedence_rank > 1
),
not_applicable_buckets AS (
  SELECT s.id, s.property_id, s.amount_cents, s.unknown_amount, 'not_applicable'::text AS bucket
  FROM scope_resolved s
  WHERE s.scope_bucket = 'not_applicable'
),
lineage_buckets AS (
  SELECT l.id, l.property_id, l.amount_cents, l.unknown_amount, l.lineage_bucket AS bucket
  FROM lineage_classified l
  WHERE l.lineage_bucket IN ('invalid', 'superseded', 'ended', 'inactive', 'future')
),
all_buckets AS (
  SELECT * FROM assigned_buckets
  UNION ALL SELECT id, property_id, amount_cents, unknown_amount, NULL, bucket, 0 FROM suppressed_buckets
  UNION ALL SELECT id, property_id, amount_cents, unknown_amount, NULL, bucket, 0 FROM not_applicable_buckets
  UNION ALL SELECT id, property_id, amount_cents, unknown_amount, NULL, bucket, 0 FROM lineage_buckets
),
property_inventory AS (
  SELECT p.id AS property_id FROM rent_ops_properties p
  UNION
  SELECT b.property_id FROM all_buckets b
),
property_aggregates AS (
  SELECT inventory.property_id,
    COUNT(bucket.id)::bigint AS source_row_count,
    COUNT(*) FILTER (WHERE bucket.bucket = 'known')::bigint AS known_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'known' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS known_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'uncertain')::bigint AS uncertain_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'uncertain' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS uncertain_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'unassigned')::bigint AS unassigned_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'unassigned' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS unassigned_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'not_applicable')::bigint AS not_applicable_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'not_applicable' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS not_applicable_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'suppressed')::bigint AS suppressed_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'suppressed' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS suppressed_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'ended')::bigint AS ended_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'ended' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS ended_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'inactive')::bigint AS inactive_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'inactive' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS inactive_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'future')::bigint AS future_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'future' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS future_cents,
    COUNT(*) FILTER (WHERE bucket.unknown_amount = 1)::bigint AS unknown_amount_count,
    0::bigint AS unknown_amount_cents,
    COUNT(*) FILTER (WHERE bucket.bucket = 'invalid')::bigint AS invalid_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.bucket = 'invalid' AND bucket.amount_cents IS NOT NULL), 0)::bigint AS invalid_cents,
    COUNT(*) FILTER (WHERE bucket.property_once = 1)::bigint AS property_once_count,
    COALESCE(SUM(bucket.amount_cents) FILTER (WHERE bucket.property_once = 1 AND bucket.amount_cents IS NOT NULL), 0)::bigint AS property_once_cents
  FROM property_inventory inventory
  LEFT JOIN all_buckets bucket ON bucket.property_id IS NOT DISTINCT FROM inventory.property_id
  GROUP BY inventory.property_id
),
former_leakage AS (
  SELECT s.property_id, COUNT(*)::bigint AS former_tenancy_leakage_count
  FROM lineage_classified s
  JOIN rent_ops_tenancies former ON former.id = s.tenancy_id AND former.status IN ('past', 'cancelled')
  JOIN unit_occupancy current_unit ON current_unit.property_id = former.property_id
    AND current_unit.unit_id = former.unit_id AND current_unit.occupancy_state = 'current'
  WHERE s.lineage_bucket = 'selected'
    AND s.scope_type = 'tenant' AND s.tenancy_id IS NOT NULL AND current_unit.tenancy_id IS DISTINCT FROM s.tenancy_id
  GROUP BY s.property_id
),
portfolio AS (
  SELECT NULL::varchar AS property_id,
    COALESCE(SUM(source_row_count), 0)::bigint AS source_row_count,
    COALESCE(SUM(known_count), 0)::bigint AS known_count,
    COALESCE(SUM(known_cents), 0)::bigint AS known_cents,
    COALESCE(SUM(uncertain_count), 0)::bigint AS uncertain_count,
    COALESCE(SUM(uncertain_cents), 0)::bigint AS uncertain_cents,
    COALESCE(SUM(unassigned_count), 0)::bigint AS unassigned_count,
    COALESCE(SUM(unassigned_cents), 0)::bigint AS unassigned_cents,
    COALESCE(SUM(not_applicable_count), 0)::bigint AS not_applicable_count,
    COALESCE(SUM(not_applicable_cents), 0)::bigint AS not_applicable_cents,
    COALESCE(SUM(suppressed_count), 0)::bigint AS suppressed_count,
    COALESCE(SUM(suppressed_cents), 0)::bigint AS suppressed_cents,
    COALESCE(SUM(ended_count), 0)::bigint AS ended_count,
    COALESCE(SUM(ended_cents), 0)::bigint AS ended_cents,
    COALESCE(SUM(inactive_count), 0)::bigint AS inactive_count,
    COALESCE(SUM(inactive_cents), 0)::bigint AS inactive_cents,
    COALESCE(SUM(future_count), 0)::bigint AS future_count,
    COALESCE(SUM(future_cents), 0)::bigint AS future_cents,
    COALESCE(SUM(unknown_amount_count), 0)::bigint AS unknown_amount_count,
    0::bigint AS unknown_amount_cents,
    COALESCE(SUM(invalid_count), 0)::bigint AS invalid_count,
    COALESCE(SUM(invalid_cents), 0)::bigint AS invalid_cents,
    COALESCE(SUM(property_once_count), 0)::bigint AS property_once_count,
    COALESCE(SUM(property_once_cents), 0)::bigint AS property_once_cents,
    COALESCE(SUM(fl.former_tenancy_leakage_count), 0)::bigint AS former_tenancy_leakage_count
  FROM property_aggregates pa
  LEFT JOIN former_leakage fl ON fl.property_id = pa.property_id
),
property_with_leakage AS (
  SELECT pa.*,
    COALESCE(fl.former_tenancy_leakage_count, 0)::bigint AS former_tenancy_leakage_count
  FROM property_aggregates pa
  LEFT JOIN former_leakage fl ON fl.property_id = pa.property_id
  WHERE pa.property_id IS NOT NULL
)
SELECT * FROM portfolio
UNION ALL
SELECT * FROM property_with_leakage
ORDER BY property_id NULLS FIRST
) AS financial_report_v8
`;

export const DATABASE_AUDIT_SQL = Object.freeze({
  targetIdentity: "SELECT current_database() AS database_name, current_user AS database_user, current_setting('server_version_num', true) AS server_version_num",
  // Ordered migration evidence lives in the v2 ledger. The legacy v1
  // schema_meta row remains immutable and is never queried as v2 evidence.
  schemaMeta: "SELECT version, checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version ASC",
  schema: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
  counts: `
    SELECT 'properties'::text AS metric, COUNT(*)::bigint AS value FROM rent_ops_properties
    UNION ALL SELECT 'units', COUNT(*)::bigint FROM rent_ops_units
    UNION ALL SELECT 'people', COUNT(*)::bigint FROM rent_ops_people
    UNION ALL SELECT 'applications', COUNT(*)::bigint FROM rent_ops_applications
    UNION ALL SELECT 'applicationHouseholdMembers', COUNT(*)::bigint FROM rent_ops_application_household_members
    UNION ALL SELECT 'applicationRequirements', COUNT(*)::bigint FROM rent_ops_application_requirements
    UNION ALL SELECT 'tenancies', COUNT(*)::bigint FROM rent_ops_tenancies
    UNION ALL SELECT 'householdMemberships', COUNT(*)::bigint FROM rent_ops_household_memberships
    UNION ALL SELECT 'leaseTerms', COUNT(*)::bigint FROM rent_ops_lease_terms
    UNION ALL SELECT 'recurringSchedules', COUNT(*)::bigint FROM rent_ops_recurring_charge_schedules
    UNION ALL SELECT 'ledgerTransactions', COUNT(*)::bigint FROM rent_ops_ledger_transactions
    UNION ALL SELECT 'paymentAllocations', COUNT(*)::bigint FROM rent_ops_payment_allocations
    UNION ALL SELECT 'securityDeposits', COUNT(*)::bigint FROM rent_ops_security_deposits
    UNION ALL SELECT 'subsidyContracts', COUNT(*)::bigint FROM rent_ops_subsidy_contracts
    UNION ALL SELECT 'subsidyTenants', COUNT(*)::bigint FROM rent_ops_subsidy_tenants
    UNION ALL SELECT 'subsidyPayments', COUNT(*)::bigint FROM rent_ops_subsidy_payments
    UNION ALL SELECT 'documents', COUNT(*)::bigint FROM rent_ops_documents
    UNION ALL SELECT 'activityEvents', COUNT(*)::bigint FROM rent_ops_activity_events
    UNION ALL SELECT 'prospects', COUNT(*)::bigint FROM rent_ops_prospects
    UNION ALL SELECT 'applicationHistory', COUNT(*)::bigint FROM rent_ops_application_history
    UNION ALL SELECT 'applicationInterests', COUNT(*)::bigint FROM rent_ops_application_interests
    UNION ALL SELECT 'applicationParticipants', COUNT(*)::bigint FROM rent_ops_application_participants
    UNION ALL SELECT 'applicationRequirementOccurrences', COUNT(*)::bigint FROM rent_ops_application_requirement_occurrences
    UNION ALL SELECT 'applicationTemplateDefinitions', COUNT(*)::bigint FROM rent_ops_application_template_definitions
    UNION ALL SELECT 'applicationTemplateSections', COUNT(*)::bigint FROM rent_ops_application_template_sections
    UNION ALL SELECT 'applicationTemplateFields', COUNT(*)::bigint FROM rent_ops_application_template_fields
    UNION ALL SELECT 'applicationAnswerOccurrences', COUNT(*)::bigint FROM rent_ops_application_answer_occurrences
    UNION ALL SELECT 'applicationHistoryDocuments', COUNT(*)::bigint FROM rent_ops_application_history_documents
    UNION ALL SELECT 'applicationHistoryActivities', COUNT(*)::bigint FROM rent_ops_application_history_activities
    UNION ALL SELECT 'applicationHistoryBlockers', COUNT(*)::bigint FROM rent_ops_application_history_blockers
    UNION ALL SELECT 'applicationHistoryAggregates', COUNT(*)::bigint FROM rent_ops_application_history_aggregates
    UNION ALL SELECT 'sourceRecords', COUNT(*)::bigint FROM rent_ops_source_records
    UNION ALL SELECT 'importRuns', COUNT(*)::bigint FROM rent_ops_import_runs
  `,
  totals: `
    SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'charge'), 0)::bigint AS charges_cents,
      COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'payment'), 0)::bigint AS payments_cents,
      COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'credit'), 0)::bigint AS credits_cents,
      COALESCE(SUM(CASE
        WHEN kind = 'charge' THEN amount_cents
        WHEN kind IN ('payment', 'credit') THEN -amount_cents
        WHEN kind = 'adjustment' AND adjustment_direction = 'debit' THEN amount_cents
        WHEN kind = 'adjustment' AND adjustment_direction = 'credit' THEN -amount_cents
        WHEN kind = 'reversal' AND reversal_of_id IS NOT NULL THEN
          CASE
            WHEN NOT EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id) THEN 0
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'reversal') THEN 0
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND (original.kind IN ('payment', 'credit') OR (original.kind = 'adjustment' AND original.adjustment_direction = 'credit'))) THEN amount_cents
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'adjustment' AND original.adjustment_direction = 'debit') THEN -amount_cents
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'charge') THEN -amount_cents
            ELSE 0
          END
        WHEN kind = 'reversal' THEN 0
        ELSE 0 END), 0)::bigint AS net_ledger_cents,
      COALESCE(SUM(CASE
        WHEN kind = 'charge' THEN amount_cents
        WHEN kind IN ('payment', 'credit') THEN -amount_cents
        WHEN kind = 'adjustment' AND adjustment_direction = 'debit' THEN amount_cents
        WHEN kind = 'adjustment' AND adjustment_direction = 'credit' THEN -amount_cents
        WHEN kind = 'reversal' AND reversal_of_id IS NOT NULL THEN
          CASE
            WHEN NOT EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id) THEN 0
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'reversal') THEN 0
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND (original.kind IN ('payment', 'credit') OR (original.kind = 'adjustment' AND original.adjustment_direction = 'credit'))) THEN amount_cents
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'adjustment' AND original.adjustment_direction = 'debit') THEN -amount_cents
            WHEN EXISTS (SELECT 1 FROM rent_ops_ledger_transactions original WHERE original.id = reversal_of_id AND original.kind = 'charge') THEN -amount_cents
            ELSE 0
          END
        WHEN kind = 'reversal' THEN 0
        ELSE 0 END), 0)::bigint AS net_ledger_balance_cents,
      (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM rent_ops_payment_allocations) AS allocations_cents,
      (SELECT COALESCE(SUM(COALESCE(source_balance_cents, amount_held_cents)), 0)::bigint FROM rent_ops_security_deposits) AS deposits_cents,
      (SELECT COALESCE(SUM(agency_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts) AS hap_agency_obligation_cents,
      (SELECT COALESCE(SUM(tenant_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts) AS hap_tenant_obligation_cents,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE amount_knowledge = 'known' AND amount_cents IS NOT NULL), 0)::bigint FROM rent_ops_subsidy_tenants) AS hap_subsidy_tenant_cents,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE amount_knowledge = 'known' AND amount_cents IS NOT NULL), 0)::bigint FROM rent_ops_subsidy_payments) AS hap_subsidy_payment_cents,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants WHERE amount_knowledge = 'known' AND amount_cents IS NOT NULL) AS hap_subsidy_tenant_known_amount_count,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants WHERE amount_knowledge = 'unknown' OR amount_cents IS NULL) AS hap_subsidy_tenant_unknown_amount_count,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments WHERE amount_knowledge = 'known' AND amount_cents IS NOT NULL) AS hap_subsidy_payment_known_amount_count,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments WHERE amount_knowledge = 'unknown' OR amount_cents IS NULL) AS hap_subsidy_payment_unknown_amount_count
    FROM rent_ops_ledger_transactions
  `,
  orphans: `
    SELECT
      (SELECT COUNT(*) FROM rent_ops_units u LEFT JOIN rent_ops_properties p ON p.id = u.property_id WHERE p.id IS NULL) AS units_property,
      (SELECT COUNT(*) FROM rent_ops_tenancies t LEFT JOIN rent_ops_properties p ON p.id = t.property_id WHERE p.id IS NULL) AS tenancies_property,
      (SELECT COUNT(*) FROM rent_ops_tenancies t LEFT JOIN rent_ops_units u ON u.id = t.unit_id WHERE u.id IS NULL) AS tenancies_unit,
      (SELECT COUNT(*) FROM rent_ops_tenancies t LEFT JOIN rent_ops_people p ON p.id = t.primary_person_id WHERE p.id IS NULL) AS tenancies_primary_person,
      (SELECT COUNT(*) FROM rent_ops_tenancies t LEFT JOIN rent_ops_applications a ON a.id = t.application_id WHERE t.application_id IS NOT NULL AND a.id IS NULL) AS tenancies_application,
      (SELECT COUNT(*) FROM rent_ops_household_memberships h LEFT JOIN rent_ops_people p ON p.id = h.person_id WHERE p.id IS NULL) AS household_person,
      (SELECT COUNT(*) FROM rent_ops_household_memberships h LEFT JOIN rent_ops_people p ON p.id = h.account_person_id WHERE h.account_person_id IS NOT NULL AND p.id IS NULL) AS household_account_person,
      (SELECT COUNT(*) FROM rent_ops_household_memberships h LEFT JOIN rent_ops_tenancies t ON t.id = h.tenancy_id WHERE h.tenancy_id IS NOT NULL AND t.id IS NULL) AS household_tenancy,
      (SELECT COUNT(*) FROM rent_ops_household_memberships h LEFT JOIN rent_ops_applications a ON a.id = h.application_id WHERE h.application_id IS NOT NULL AND a.id IS NULL) AS household_application,
      (SELECT COUNT(*) FROM rent_ops_household_memberships h WHERE ((CASE WHEN h.account_person_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN h.tenancy_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN h.application_id IS NOT NULL THEN 1 ELSE 0 END)) <> 1) AS household_scope_invalid,
      (SELECT COUNT(*) FROM rent_ops_lease_terms l LEFT JOIN rent_ops_tenancies t ON t.id = l.tenancy_id WHERE t.id IS NULL) AS lease_tenancy,
      (SELECT COUNT(*) FROM rent_ops_lease_terms l LEFT JOIN rent_ops_documents d ON d.id = l.executed_document_id WHERE l.executed_document_id IS NOT NULL AND d.id IS NULL) AS lease_document,
      (SELECT COUNT(*) FROM rent_ops_lease_terms l LEFT JOIN rent_ops_lease_terms parent ON parent.id = l.renewal_of_id WHERE l.renewal_of_id IS NOT NULL AND parent.id IS NULL) AS lease_renewal,
      (SELECT COUNT(*) FROM rent_ops_recurring_charge_schedules s LEFT JOIN rent_ops_tenancies t ON t.id = s.tenancy_id WHERE s.tenancy_id IS NOT NULL AND t.id IS NULL) AS schedules_tenancy,
      (SELECT COUNT(*) FROM rent_ops_recurring_charge_schedules s LEFT JOIN rent_ops_properties p ON p.id = s.property_id WHERE p.id IS NULL) AS schedules_property,
      (SELECT COUNT(*) FROM rent_ops_recurring_charge_schedules s LEFT JOIN rent_ops_units u ON u.id = s.unit_id WHERE s.unit_id IS NOT NULL AND u.id IS NULL) AS schedules_unit,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l LEFT JOIN rent_ops_properties p ON p.id = l.property_id WHERE p.id IS NULL AND NOT (l.kind='payment' AND l.allocation_mode='multi_property' AND l.source_system='rent_manager' AND l.source_artifact_sha256 IS NOT NULL AND l.person_id IS NOT NULL AND l.person_link_knowledge='exact')) AS ledger_property,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l LEFT JOIN rent_ops_units u ON u.id = l.unit_id WHERE l.unit_id IS NOT NULL AND u.id IS NULL) AS ledger_unit,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l LEFT JOIN rent_ops_tenancies t ON t.id = l.tenancy_id WHERE l.tenancy_id IS NOT NULL AND t.id IS NULL) AS ledger_tenancy,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l LEFT JOIN rent_ops_people p ON p.id = l.person_id WHERE l.person_id IS NOT NULL AND p.id IS NULL) AS ledger_person,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l LEFT JOIN rent_ops_ledger_transactions r ON r.id = l.reversal_of_id WHERE l.reversal_of_id IS NOT NULL AND r.id IS NULL) AS ledger_reversal,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a LEFT JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE p.id IS NULL) AS allocations_payment,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a LEFT JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE c.id IS NULL) AS allocations_charge,
      (SELECT COUNT(*) FROM rent_ops_security_deposits d LEFT JOIN rent_ops_properties p ON p.id = d.property_id WHERE p.id IS NULL) AS deposits_property,
      (SELECT COUNT(*) FROM rent_ops_security_deposits d LEFT JOIN rent_ops_units u ON u.id = d.unit_id WHERE d.unit_id IS NOT NULL AND u.id IS NULL) AS deposits_unit,
      (SELECT COUNT(*) FROM rent_ops_security_deposits d LEFT JOIN rent_ops_tenancies t ON t.id = d.tenancy_id WHERE d.tenancy_id IS NOT NULL AND t.id IS NULL) AS deposits_tenancy,
      (SELECT COUNT(*) FROM rent_ops_security_deposits d LEFT JOIN rent_ops_people p ON p.id = d.person_id WHERE p.id IS NULL) AS deposits_person,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts s LEFT JOIN rent_ops_properties p ON p.id = s.property_id WHERE p.id IS NULL) AS subsidy_property,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts s LEFT JOIN rent_ops_units u ON u.id = s.unit_id WHERE u.id IS NULL) AS subsidy_unit,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts s LEFT JOIN rent_ops_tenancies t ON t.id = s.tenancy_id WHERE t.id IS NULL) AS subsidy_tenancy,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants s LEFT JOIN rent_ops_subsidy_contracts c ON c.id = s.subsidy_contract_id WHERE s.subsidy_contract_id IS NOT NULL AND c.id IS NULL) AS hap_subsidy_tenant_orphan_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments s LEFT JOIN rent_ops_subsidy_contracts c ON c.id = s.subsidy_contract_id WHERE s.subsidy_contract_id IS NOT NULL AND c.id IS NULL) AS hap_subsidy_payment_orphan_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants s WHERE s.subsidy_contract_link_knowledge = 'exact' AND s.subsidy_contract_id IS NULL) AS hap_subsidy_tenant_exact_link_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments s WHERE s.subsidy_contract_link_knowledge = 'exact' AND s.subsidy_contract_id IS NULL) AS hap_subsidy_payment_exact_contract_link_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments s LEFT JOIN rent_ops_ledger_transactions p ON p.id = s.payment_transaction_id WHERE s.payment_link_knowledge = 'exact' AND (s.payment_transaction_id IS NULL OR p.id IS NULL OR p.kind <> 'payment')) AS hap_subsidy_payment_link_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants s JOIN rent_ops_subsidy_contracts c ON c.id = s.subsidy_contract_id WHERE s.subsidy_contract_id IS NOT NULL AND (s.property_id IS NOT NULL AND s.property_id IS DISTINCT FROM c.property_id OR s.unit_id IS NOT NULL AND s.unit_id IS DISTINCT FROM c.unit_id OR s.tenancy_id IS NOT NULL AND s.tenancy_id IS DISTINCT FROM c.tenancy_id)) AS hap_subsidy_contract_scope_violation_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants s JOIN rent_ops_tenancies t ON t.id = s.tenancy_id WHERE s.tenancy_id IS NOT NULL AND (s.property_id IS NOT NULL AND s.property_id IS DISTINCT FROM t.property_id OR s.unit_id IS NOT NULL AND s.unit_id IS DISTINCT FROM t.unit_id OR s.person_id IS NOT NULL AND s.person_id IS DISTINCT FROM t.primary_person_id)) AS hap_subsidy_tenant_scope_violation_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments s LEFT JOIN rent_ops_subsidy_tenants st ON st.id = s.subsidy_tenant_id JOIN rent_ops_subsidy_contracts c ON c.id = s.subsidy_contract_id WHERE s.subsidy_contract_id IS NOT NULL AND (s.property_id IS NOT NULL AND s.property_id IS DISTINCT FROM c.property_id OR s.unit_id IS NOT NULL AND s.unit_id IS DISTINCT FROM c.unit_id OR s.tenancy_id IS NOT NULL AND s.tenancy_id IS DISTINCT FROM c.tenancy_id OR s.subsidy_tenant_id IS NOT NULL AND st.id IS NULL OR s.subsidy_tenant_id IS NOT NULL AND st.subsidy_contract_id IS DISTINCT FROM s.subsidy_contract_id)) AS hap_subsidy_payment_scope_violation_rows,
      (SELECT COUNT(*) FROM rent_ops_applications a LEFT JOIN rent_ops_properties p ON p.id = a.property_id WHERE a.property_id IS NOT NULL AND p.id IS NULL) AS applications_property,
      (SELECT COUNT(*) FROM rent_ops_applications a LEFT JOIN rent_ops_units u ON u.id = a.unit_id WHERE a.unit_id IS NOT NULL AND u.id IS NULL) AS applications_unit,
      (SELECT COUNT(*) FROM rent_ops_applications a LEFT JOIN rent_ops_tenancies t ON t.id = a.converted_tenancy_id WHERE a.converted_tenancy_id IS NOT NULL AND t.id IS NULL) AS applications_converted_tenancy,
      (SELECT COUNT(*) FROM rent_ops_application_household_members m LEFT JOIN rent_ops_applications a ON a.id = m.application_id WHERE a.id IS NULL) AS application_members_application,
      (SELECT COUNT(*) FROM rent_ops_application_requirements r LEFT JOIN rent_ops_applications a ON a.id = r.application_id WHERE a.id IS NULL) AS application_requirements_application,
      (SELECT COUNT(*) FROM rent_ops_application_requirements r LEFT JOIN rent_ops_documents d ON d.id = r.document_id WHERE r.document_id IS NOT NULL AND d.id IS NULL) AS application_requirements_document,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_properties p ON p.id = d.property_id WHERE d.property_id IS NOT NULL AND p.id IS NULL) AS documents_property,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_units u ON u.id = d.unit_id WHERE d.unit_id IS NOT NULL AND u.id IS NULL) AS documents_unit,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_people p ON p.id = d.person_id WHERE d.person_id IS NOT NULL AND p.id IS NULL) AS documents_person,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_tenancies t ON t.id = d.tenancy_id WHERE d.tenancy_id IS NOT NULL AND t.id IS NULL) AS documents_tenancy,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_applications a ON a.id = d.application_id WHERE d.application_id IS NOT NULL AND a.id IS NULL) AS documents_application,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_properties p ON p.id = e.property_id WHERE e.property_id IS NOT NULL AND p.id IS NULL) AS activity_property,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_units u ON u.id = e.unit_id WHERE e.unit_id IS NOT NULL AND u.id IS NULL) AS activity_unit,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_people p ON p.id = e.person_id WHERE e.person_id IS NOT NULL AND p.id IS NULL) AS activity_person,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_tenancies t ON t.id = e.tenancy_id WHERE e.tenancy_id IS NOT NULL AND t.id IS NULL) AS activity_tenancy,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_applications a ON a.id = e.application_id WHERE e.application_id IS NOT NULL AND a.id IS NULL) AS activity_application,
      (SELECT COUNT(*) FROM rent_ops_applications a LEFT JOIN rent_ops_prospects p ON p.id = a.prospect_id WHERE a.prospect_id IS NOT NULL AND p.id IS NULL) AS applications_prospect,
      (SELECT COUNT(*) FROM rent_ops_applications WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS applications_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_application_history a ON a.id = d.historical_application_id WHERE d.historical_application_id IS NOT NULL AND a.id IS NULL) AS documents_historical_application,
      (SELECT COUNT(*) FROM rent_ops_documents d LEFT JOIN rent_ops_prospects p ON p.id = d.prospect_id WHERE d.prospect_id IS NOT NULL AND p.id IS NULL) AS documents_prospect,
      (SELECT COUNT(*) FROM rent_ops_documents WHERE historical_application_id IS NOT NULL AND historical_application_link_knowledge IS NULL) AS documents_historical_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_documents WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS documents_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_application_history a ON a.id = e.historical_application_id WHERE e.historical_application_id IS NOT NULL AND a.id IS NULL) AS activity_historical_application,
      (SELECT COUNT(*) FROM rent_ops_activity_events e LEFT JOIN rent_ops_prospects p ON p.id = e.prospect_id WHERE e.prospect_id IS NOT NULL AND p.id IS NULL) AS activity_prospect,
      (SELECT COUNT(*) FROM rent_ops_activity_events WHERE historical_application_id IS NOT NULL AND historical_application_link_knowledge IS NULL) AS activity_historical_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_activity_events WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS activity_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_prospects p LEFT JOIN rent_ops_people pe ON pe.id = p.person_id WHERE p.person_id IS NOT NULL AND pe.id IS NULL) AS history_prospect_person,
      (SELECT COUNT(*) FROM rent_ops_prospects WHERE person_id IS NOT NULL AND person_link_knowledge IS NULL) AS history_prospect_person_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_prospects WHERE contact_id IS NOT NULL AND contact_link_knowledge IS NULL) AS history_prospect_contact_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_history a LEFT JOIN rent_ops_prospects p ON p.id = a.prospect_id WHERE a.prospect_id IS NOT NULL AND p.id IS NULL) AS history_application_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_history a LEFT JOIN rent_ops_people pe ON pe.id = a.person_id WHERE a.person_id IS NOT NULL AND pe.id IS NULL) AS history_application_person,
      (SELECT COUNT(*) FROM rent_ops_application_history WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS history_application_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_history WHERE person_id IS NOT NULL AND person_link_knowledge IS NULL) AS history_application_person_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_interests i LEFT JOIN rent_ops_prospects p ON p.id = i.prospect_id WHERE i.prospect_id IS NOT NULL AND p.id IS NULL) AS history_interest_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_interests i LEFT JOIN rent_ops_application_history a ON a.id = i.application_id WHERE i.application_id IS NOT NULL AND a.id IS NULL) AS history_interest_application,
      (SELECT COUNT(*) FROM rent_ops_application_interests i LEFT JOIN rent_ops_properties p ON p.id = i.property_id WHERE i.property_id IS NOT NULL AND p.id IS NULL) AS history_interest_property,
      (SELECT COUNT(*) FROM rent_ops_application_interests i LEFT JOIN rent_ops_units u ON u.id = i.unit_id WHERE i.unit_id IS NOT NULL AND u.id IS NULL) AS history_interest_unit,
      (SELECT COUNT(*) FROM rent_ops_application_interests WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS history_interest_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_interests WHERE application_id IS NOT NULL AND application_link_knowledge IS NULL) AS history_interest_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_interests WHERE property_id IS NOT NULL AND property_link_knowledge IS NULL) AS history_interest_property_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_interests WHERE unit_id IS NOT NULL AND unit_link_knowledge IS NULL) AS history_interest_unit_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_participants p LEFT JOIN rent_ops_prospects pr ON pr.id = p.prospect_id WHERE p.prospect_id IS NOT NULL AND pr.id IS NULL) AS history_participant_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_participants p LEFT JOIN rent_ops_application_history a ON a.id = p.application_id WHERE p.application_id IS NOT NULL AND a.id IS NULL) AS history_participant_application,
      (SELECT COUNT(*) FROM rent_ops_application_participants p LEFT JOIN rent_ops_people pe ON pe.id = p.person_id WHERE p.person_id IS NOT NULL AND pe.id IS NULL) AS history_participant_person,
      (SELECT COUNT(*) FROM rent_ops_application_participants WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS history_participant_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_participants WHERE application_id IS NOT NULL AND application_link_knowledge IS NULL) AS history_participant_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_participants WHERE person_id IS NOT NULL AND person_link_knowledge IS NULL) AS history_participant_person_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences r LEFT JOIN rent_ops_prospects p ON p.id = r.prospect_id WHERE r.prospect_id IS NOT NULL AND p.id IS NULL) AS history_requirement_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences r LEFT JOIN rent_ops_application_history a ON a.id = r.application_id WHERE r.application_id IS NOT NULL AND a.id IS NULL) AS history_requirement_application,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences r LEFT JOIN rent_ops_application_history_documents d ON d.id = r.document_id WHERE r.document_id IS NOT NULL AND d.id IS NULL) AS history_requirement_document,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS history_requirement_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences WHERE application_id IS NOT NULL AND application_link_knowledge IS NULL) AS history_requirement_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences WHERE document_id IS NOT NULL AND document_link_knowledge IS NULL) AS history_requirement_document_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_template_sections s LEFT JOIN rent_ops_application_template_definitions t ON t.id = s.template_id WHERE s.template_id IS NOT NULL AND t.id IS NULL) AS history_template_section_template,
      (SELECT COUNT(*) FROM rent_ops_application_template_fields f LEFT JOIN rent_ops_application_template_definitions t ON t.id = f.template_id WHERE f.template_id IS NOT NULL AND t.id IS NULL) AS history_template_field_template,
      (SELECT COUNT(*) FROM rent_ops_application_template_fields f LEFT JOIN rent_ops_application_template_sections s ON s.id = f.section_id WHERE f.section_id IS NOT NULL AND s.id IS NULL) AS history_template_field_section,
      (SELECT COUNT(*) FROM rent_ops_application_template_sections WHERE template_id IS NOT NULL AND template_link_knowledge IS NULL) AS history_template_section_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_template_fields WHERE template_id IS NOT NULL AND template_link_knowledge IS NULL) AS history_template_field_template_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_template_fields WHERE section_id IS NOT NULL AND section_link_knowledge IS NULL) AS history_template_field_section_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences a LEFT JOIN rent_ops_prospects p ON p.id = a.prospect_id WHERE a.prospect_id IS NOT NULL AND p.id IS NULL) AS history_answer_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences a LEFT JOIN rent_ops_application_history h ON h.id = a.application_id WHERE a.application_id IS NOT NULL AND h.id IS NULL) AS history_answer_application,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences a LEFT JOIN rent_ops_application_template_fields f ON f.id = a.field_id WHERE a.field_id IS NOT NULL AND f.id IS NULL) AS history_answer_field,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences WHERE prospect_id IS NOT NULL AND prospect_link_knowledge IS NULL) AS history_answer_prospect_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences WHERE application_id IS NOT NULL AND application_link_knowledge IS NULL) AS history_answer_application_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences WHERE field_id IS NOT NULL AND field_link_knowledge IS NULL) AS history_answer_field_link_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_answer_occurrences WHERE value_knowledge <> 'known' AND safe_value IS NOT NULL) AS history_answer_value_knowledge,
      (SELECT COUNT(*) FROM rent_ops_application_history_documents d LEFT JOIN rent_ops_prospects p ON p.id = d.prospect_id WHERE d.prospect_id IS NOT NULL AND p.id IS NULL) AS history_document_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_history_documents d LEFT JOIN rent_ops_application_history a ON a.id = d.application_id WHERE d.application_id IS NOT NULL AND a.id IS NULL) AS history_document_application,
      (SELECT COUNT(*) FROM rent_ops_application_history_activities a LEFT JOIN rent_ops_prospects p ON p.id = a.prospect_id WHERE a.prospect_id IS NOT NULL AND p.id IS NULL) AS history_activity_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_history_activities a LEFT JOIN rent_ops_application_history h ON h.id = a.application_id WHERE a.application_id IS NOT NULL AND h.id IS NULL) AS history_activity_application,
      (SELECT COUNT(*) FROM rent_ops_application_history_blockers b LEFT JOIN rent_ops_prospects p ON p.id = b.prospect_id WHERE b.prospect_id IS NOT NULL AND p.id IS NULL) AS history_blocker_prospect,
      (SELECT COUNT(*) FROM rent_ops_application_history_blockers b LEFT JOIN rent_ops_application_history a ON a.id = b.application_id WHERE b.application_id IS NOT NULL AND a.id IS NULL) AS history_blocker_application
  `,
  /**
   * Allocation invariants are kept separate from the generic orphan query so
   * the independent audit proves the domain rules, not merely foreign-key
   * existence.  The migration intentionally has no FK from an allocation to
   * a payment/charge *kind*, and it cannot express scope, reversal, or amount
   * limits as table constraints.  Every expression returns a count only.
   */
  allocationInvariants: `
    SELECT
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a LEFT JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE p.id IS NULL AND a.kind <> 'credit_allocation') AS allocation_payment_missing,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE p.kind <> 'payment') AS allocation_payment_not_payment,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE p.status <> 'posted') AS allocation_payment_not_posted,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a LEFT JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE c.id IS NULL) AS allocation_charge_missing,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE c.kind <> 'charge') AS allocation_charge_not_charge,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE c.status <> 'posted') AS allocation_charge_not_posted,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE p.property_id IS DISTINCT FROM c.property_id AND NOT (p.kind='payment' AND p.allocation_mode='multi_property' AND p.property_id IS NULL AND p.source_system='rent_manager' AND p.source_artifact_sha256 IS NOT NULL AND p.person_id=c.person_id AND p.person_link_knowledge='exact' AND c.person_link_knowledge='exact')) AS allocation_property_mismatch,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE p.tenancy_id IS NOT NULL AND c.tenancy_id IS NOT NULL AND p.tenancy_id IS DISTINCT FROM c.tenancy_id) AS allocation_tenancy_mismatch,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE a.amount_cents <= 0 AND NOT ((a.kind = 'reversal' AND a.source_system = 'rent_manager' AND a.source_artifact_sha256 ~ '^[a-f0-9]{64}$' AND a.artifact_observation_on IS NOT NULL AND a.payment_link_knowledge='exact' AND a.charge_link_knowledge='exact' AND a.amount_knowledge='known' AND a.allocated_on_knowledge='source') IS TRUE)) AS allocation_non_positive,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE EXISTS (SELECT 1 FROM rent_ops_ledger_transactions r WHERE r.kind = 'reversal' AND r.status = 'posted' AND r.reversal_of_id = p.id AND (r.posted_on IS NULL OR ((a.allocated_on IS NULL OR a.allocated_on > r.posted_on) AND NOT COALESCE((a.source_system = 'rent_manager' AND a.source_artifact_sha256 ~ '^[a-f0-9]{64}$' AND a.payment_link_knowledge = 'exact' AND a.charge_link_knowledge = 'exact' AND a.source_updated_at IS NOT NULL AND (a.source_updated_at AT TIME ZONE 'UTC')::date <= r.posted_on), false))))) AS allocation_payment_reversed,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE EXISTS (SELECT 1 FROM rent_ops_ledger_transactions r WHERE r.kind = 'reversal' AND r.status = 'posted' AND r.reversal_of_id = c.id AND (r.posted_on IS NULL OR ((a.allocated_on IS NULL OR a.allocated_on > r.posted_on) AND NOT COALESCE((a.source_system = 'rent_manager' AND a.source_artifact_sha256 ~ '^[a-f0-9]{64}$' AND a.payment_link_knowledge = 'exact' AND a.charge_link_knowledge = 'exact' AND a.source_updated_at IS NOT NULL AND (a.source_updated_at AT TIME ZONE 'UTC')::date <= r.posted_on), false))))) AS allocation_charge_reversed,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE p.status = 'voided') AS allocation_payment_voided,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE c.status = 'voided') AS allocation_charge_voided,
      (SELECT COUNT(*) FROM (
        SELECT COALESCE(a.payment_transaction_id,a.credit_transaction_id)
        FROM rent_ops_payment_allocations a
        JOIN rent_ops_ledger_transactions p ON p.id = COALESCE(a.payment_transaction_id,a.credit_transaction_id)
        WHERE a.kind <> 'transfer'
        GROUP BY COALESCE(a.payment_transaction_id,a.credit_transaction_id), p.amount_cents
        HAVING SUM(a.amount_cents) > p.amount_cents
      ) over_allocated_payments) AS allocations_exceed_payment,
      (SELECT COUNT(*) FROM (
        SELECT a.charge_transaction_id
        FROM rent_ops_payment_allocations a
        JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id
        WHERE a.kind <> 'transfer' AND NOT EXISTS (SELECT 1 FROM rent_ops_ledger_transactions r WHERE r.kind='reversal' AND r.status='posted' AND (r.reversal_of_id=COALESCE(a.payment_transaction_id,a.credit_transaction_id) OR r.reversal_of_id=a.charge_transaction_id))
        GROUP BY a.charge_transaction_id, c.amount_cents
        HAVING SUM(a.amount_cents) > c.amount_cents
      ) over_allocated_charges) AS allocations_exceed_charge,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a LEFT JOIN rent_ops_ledger_transactions c ON c.id=a.credit_transaction_id LEFT JOIN rent_ops_ledger_transactions q ON q.id=a.charge_transaction_id WHERE a.kind='credit_allocation' AND (c.id IS NULL OR c.kind IS DISTINCT FROM 'credit' OR a.payment_transaction_id IS NOT NULL OR a.credit_link_knowledge IS DISTINCT FROM 'exact' OR (c.status IS NOT NULL AND c.status<>'posted') OR (c.property_id IS NOT NULL AND q.property_id IS NOT NULL AND c.property_id<>q.property_id) OR (c.tenancy_id IS NOT NULL AND q.tenancy_id IS NOT NULL AND c.tenancy_id<>q.tenancy_id) OR (c.person_id IS NOT NULL AND q.person_id IS NOT NULL AND c.person_id<>q.person_id))) AS credit_allocation_parent_invalid,
      (SELECT COUNT(*) FROM (SELECT SUM(amount_cents) OVER (PARTITION BY payment_transaction_id,charge_transaction_id ORDER BY allocated_on,amount_cents DESC,id ROWS UNBOUNDED PRECEDING) AS running_amount FROM rent_ops_payment_allocations WHERE kind <> 'transfer') a WHERE running_amount < 0) AS allocation_reversal_exceeds_history
  `,
  /**
   * Reversal and void controls mirror the domain validator.  They remain an
   * independent SELECT view because database CHECK constraints do not prove
   * that a reversal target exists or that its payload/scope is unchanged.
   */
  ledgerInvariants: `
    SELECT
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r WHERE r.kind = 'reversal' AND r.reversal_of_id IS NULL) AS reversal_missing_link,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r LEFT JOIN rent_ops_ledger_transactions original ON original.id = r.reversal_of_id WHERE r.kind = 'reversal' AND r.reversal_of_id IS NOT NULL AND original.id IS NULL) AS reversal_target_missing,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r JOIN rent_ops_ledger_transactions original ON original.id = r.reversal_of_id WHERE r.kind = 'reversal' AND original.kind = 'reversal') AS reversal_of_reversal,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r WHERE r.kind = 'reversal' AND r.status <> 'posted') AS reversal_not_posted,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r JOIN rent_ops_ledger_transactions original ON original.id = r.reversal_of_id WHERE r.kind = 'reversal' AND r.posted_on < original.posted_on) AS reversal_predates_original,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r JOIN rent_ops_ledger_transactions original ON original.id = r.reversal_of_id WHERE r.kind = 'reversal' AND (
        r.amount_cents IS DISTINCT FROM original.amount_cents
        OR r.category IS DISTINCT FROM original.category
        OR r.property_id IS DISTINCT FROM original.property_id
        OR r.unit_id IS DISTINCT FROM original.unit_id
        OR r.tenancy_id IS DISTINCT FROM original.tenancy_id
        OR r.person_id IS DISTINCT FROM original.person_id
      )) AS reversal_payload_mismatch,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r JOIN rent_ops_ledger_transactions original ON original.id = r.reversal_of_id WHERE r.kind = 'reversal' AND original.status <> 'posted') AS reversal_of_non_posted,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions r WHERE r.kind <> 'reversal' AND r.reversal_of_id IS NOT NULL) AS non_reversal_has_link,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l WHERE l.kind = 'adjustment' AND l.adjustment_direction IS NULL) AS adjustment_direction_missing,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l WHERE l.kind <> 'adjustment' AND l.adjustment_direction IS NOT NULL) AS adjustment_direction_unexpected,
      (SELECT COUNT(*) FROM (
        SELECT r.reversal_of_id
        FROM rent_ops_ledger_transactions r
        WHERE r.kind = 'reversal' AND r.status = 'posted'
        GROUP BY r.reversal_of_id
        HAVING COUNT(*) > 1
      ) repeated_reversals) AS transaction_reversed_twice
  `,
  duplicates: `
    SELECT
      (
        SELECT COALESCE(SUM(duplicate_rows), 0) FROM (
          SELECT COUNT(*)::bigint AS duplicate_rows FROM rent_ops_properties WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_units WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_people WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_tenancies WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_lease_terms WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_recurring_charge_schedules WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_ledger_transactions WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_payment_allocations WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_security_deposits WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_subsidy_contracts WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_subsidy_tenants WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_subsidy_payments WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_applications WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_documents WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_activity_events WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_prospects WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_history WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_interests WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_participants WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_requirement_occurrences WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_template_definitions WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_template_sections WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_template_fields WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_answer_occurrences WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_history_documents WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_application_history_activities WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
          UNION ALL SELECT COUNT(*) FROM rent_ops_source_records WHERE system IS NOT NULL AND source_id IS NOT NULL GROUP BY system, entity_type, source_id HAVING COUNT(*) > 1
        ) duplicate_groups
      ) AS source_key_duplicate_rows,
      (
        SELECT COUNT(*) FROM (
          SELECT unit_id FROM rent_ops_tenancies WHERE status IN ('current', 'notice') GROUP BY unit_id HAVING COUNT(*) > 1
        ) active_unit_conflicts
      ) AS active_tenancy_unit_conflicts,
      (
        SELECT COUNT(*) FROM rent_ops_lease_terms left_term
        JOIN rent_ops_lease_terms right_term ON right_term.tenancy_id = left_term.tenancy_id
          AND right_term.id > left_term.id
          AND left_term.status <> 'cancelled' AND right_term.status <> 'cancelled'
          AND left_term.contract_start_on <= COALESCE(right_term.contract_end_on, DATE '9999-12-31')
          AND right_term.contract_start_on <= COALESCE(left_term.contract_end_on, DATE '9999-12-31')
      ) AS overlapping_lease_term_pairs,
      (
        SELECT COUNT(*) FROM (
          SELECT payment_transaction_id, charge_transaction_id FROM rent_ops_payment_allocations WHERE source_system IS NULL GROUP BY payment_transaction_id, charge_transaction_id HAVING COUNT(*) > 1
        ) allocation_pairs
      ) AS duplicate_payment_charge_pairs,
      (
        SELECT COUNT(*) FROM (
          SELECT application_id, key FROM rent_ops_application_requirements GROUP BY application_id, key HAVING COUNT(*) > 1
        ) requirement_keys
      ) AS duplicate_application_requirement_keys,
      (
        SELECT COALESCE(SUM(duplicate_rows), 0) FROM (
          SELECT COUNT(*)::bigint AS duplicate_rows FROM rent_ops_subsidy_tenants WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
        ) duplicate_hap_tenants
      ) AS hap_subsidy_tenant_duplicate_identity_rows,
      (
        SELECT COALESCE(SUM(duplicate_rows), 0) FROM (
          SELECT COUNT(*)::bigint AS duplicate_rows FROM rent_ops_subsidy_payments WHERE source_system IS NOT NULL AND source_id IS NOT NULL GROUP BY source_system, source_id HAVING COUNT(*) > 1
        ) duplicate_hap_payments
      ) AS hap_subsidy_payment_duplicate_identity_rows,
      (
        SELECT COALESCE(SUM(duplicate_rows), 0) FROM (
          SELECT COUNT(*)::bigint AS duplicate_rows FROM rent_ops_application_history_blockers GROUP BY code, application_id, prospect_id HAVING COUNT(*) > 1
        ) duplicate_history_blockers
      ) AS history_blocker_duplicate_identity_rows
  `,
  dates: `
    SELECT
      (SELECT COUNT(*) FROM rent_ops_tenancies WHERE actual_move_in_on IS NOT NULL AND actual_move_out_on IS NOT NULL AND actual_move_out_on < actual_move_in_on) AS tenancy_moveout_before_movein,
      (SELECT COUNT(*) FROM rent_ops_lease_terms WHERE contract_end_on IS NOT NULL AND contract_end_on < contract_start_on) AS lease_end_before_start,
      (SELECT COUNT(*) FROM rent_ops_recurring_charge_schedules WHERE effective_to IS NOT NULL AND effective_to < effective_from) AS schedule_end_before_start,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts WHERE effective_to IS NOT NULL AND effective_to < effective_from) AS subsidy_end_before_start,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants WHERE effective_to IS NOT NULL AND effective_from IS NOT NULL AND effective_to < effective_from) AS hap_subsidy_tenant_date_conflict_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments s JOIN rent_ops_subsidy_contracts c ON c.id = s.subsidy_contract_id WHERE s.payment_on IS NOT NULL AND c.effective_from IS NOT NULL AND s.payment_on < c.effective_from) AS hap_subsidy_payment_date_conflict_rows,
      (SELECT COUNT(*) FROM rent_ops_security_deposits WHERE ((disposition_status IN ('disposed', 'returned')) AND disposed_on IS NULL) OR (disposed_on IS NOT NULL AND disposed_on < received_on)) AS deposit_date_conflicts,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions p ON p.id = a.payment_transaction_id WHERE a.allocated_on < p.posted_on) AS allocation_before_payment,
      (SELECT COUNT(*) FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions c ON c.id = a.charge_transaction_id WHERE a.allocated_on < c.posted_on) AS allocation_before_charge,
      (SELECT COUNT(*) FROM rent_ops_tenancies WHERE status IN ('current', 'notice') AND (actual_move_in_on IS NULL OR (actual_move_out_on IS NOT NULL AND actual_move_out_on <= actual_move_in_on))) AS current_occupancy_date_conflicts,
      (SELECT COUNT(*) FROM rent_ops_tenancies WHERE status = 'future' AND planned_move_in_on IS NULL) AS future_movein_missing,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts WHERE status = 'ended' AND effective_to IS NULL) AS ended_subsidy_without_end,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_subsidy_contract_status_unknown_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_tenants WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_subsidy_tenant_status_unknown_rows,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_subsidy_payment_status_unknown_rows
  `,
  propertyControls: `
    SELECT
      p.id AS property_id,
      (SELECT COUNT(*) FROM rent_ops_units u WHERE u.property_id = p.id) AS unit_count,
      (SELECT COUNT(DISTINCT t.unit_id) FROM rent_ops_tenancies t WHERE t.property_id = p.id AND t.status IN ('current', 'notice') AND t.actual_move_in_on <= $1::date AND (t.actual_move_out_on IS NULL OR t.actual_move_out_on > $1::date)) AS current_occupied_units,
      (SELECT COUNT(DISTINCT t.unit_id) FROM rent_ops_tenancies t WHERE t.property_id = p.id AND t.status = 'future' AND t.planned_move_in_on > $1::date) AS future_preleased_units,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'charge') AS charge_count,
      (SELECT COALESCE(SUM(l.amount_cents), 0)::bigint FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'charge') AS charges_cents,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'payment') AS payment_count,
      (SELECT COALESCE(SUM(l.amount_cents), 0)::bigint FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'payment') AS payments_cents,
      (SELECT COUNT(*) FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'credit') AS credit_count,
      (SELECT COALESCE(SUM(l.amount_cents), 0)::bigint FROM rent_ops_ledger_transactions l WHERE l.property_id = p.id AND l.kind = 'credit') AS credits_cents,
      (SELECT COALESCE(SUM(a.amount_cents), 0)::bigint FROM rent_ops_payment_allocations a JOIN rent_ops_ledger_transactions pay ON pay.id = a.payment_transaction_id JOIN rent_ops_ledger_transactions charge ON charge.id = a.charge_transaction_id WHERE pay.property_id = p.id OR charge.property_id = p.id) AS allocations_cents,
      (SELECT COALESCE(SUM(COALESCE(d.source_balance_cents, d.amount_held_cents)), 0)::bigint FROM rent_ops_security_deposits d WHERE d.property_id = p.id) AS deposits_cents,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts s WHERE s.property_id = p.id AND s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS active_hap_contracts,
      (SELECT COALESCE(SUM(s.agency_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.property_id = p.id AND s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS hap_agency_cents,
      (SELECT COALESCE(SUM(s.tenant_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.property_id = p.id AND s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS hap_tenant_cents
    FROM rent_ops_properties p
    ORDER BY p.id
  `,
  sourceRecords: "SELECT system, entity_type, source_id, checksum, target_id FROM rent_ops_source_records ORDER BY system, entity_type, source_id, id",
  /**
   * Restricted-source audit metadata. These statements intentionally omit the
   * JSON payload and filesystem storage key. The returned rows contain only
   * identifiers/checksums needed to prove archive parity; the result mapper
   * below hashes identifiers before anything can leave this module.
   */
  sourcePayloadMetadata: "SELECT system, source_collection, source_id, checksum_sha256, import_run_id FROM rent_ops_source_payloads ORDER BY system, source_collection, source_id, checksum_sha256, id",
  sourceBinaryMetadata: "SELECT system, source_collection, source_id, import_run_id, checksum_sha256, size_bytes, content_type, verification_status FROM rent_ops_source_binaries ORDER BY system, source_collection, source_id, checksum_sha256, id",
  /** Independent v8 scheduled-income report. It returns aggregate rows only:
   * one redacted portfolio row followed by one row per property. */
  financialReportV8: FINANCIAL_REPORT_V8_SQL,
  financialReport: FINANCIAL_REPORT_V8_SQL,
  reportParity: `
    SELECT
      (SELECT COUNT(*) FROM rent_ops_units) AS rent_roll_rows,
      (SELECT COUNT(DISTINCT t.unit_id) FROM rent_ops_tenancies t WHERE t.status IN ('current', 'notice') AND t.actual_move_in_on <= $1::date AND (t.actual_move_out_on IS NULL OR t.actual_move_out_on > $1::date)) AS current_occupied_units,
      (SELECT COUNT(DISTINCT t.unit_id) FROM rent_ops_tenancies t WHERE t.status = 'future' AND t.planned_move_in_on > $1::date) AS future_preleased_units,
      (SELECT COUNT(*) FROM rent_ops_units u WHERE NOT EXISTS (SELECT 1 FROM rent_ops_tenancies t WHERE t.unit_id = u.id AND t.status IN ('current', 'notice') AND t.actual_move_in_on <= $1::date AND (t.actual_move_out_on IS NULL OR t.actual_move_out_on > $1::date)) AND NOT EXISTS (SELECT 1 FROM rent_ops_tenancies t WHERE t.unit_id = u.id AND t.status = 'future' AND t.planned_move_in_on > $1::date) AND NOT EXISTS (SELECT 1 FROM rent_ops_tenancies t WHERE (t.unit_id = u.id OR (t.unit_id IS NULL AND (t.property_id = u.property_id OR t.property_id IS NULL))) AND (t.status IS NULL OR t.status NOT IN ('current', 'notice', 'future', 'past', 'cancelled') OR t.unit_id IS NULL OR t.unit_link_knowledge IN ('unknown', 'ambiguous') OR ((t.status IN ('current', 'notice')) AND t.actual_move_in_on IS NULL) OR (t.status = 'future' AND t.planned_move_in_on IS NULL)))) AS vacant_units,
      (SELECT COUNT(*) FROM rent_ops_subsidy_contracts s WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS active_hap_contracts,
      (SELECT COALESCE(SUM(s.agency_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS hap_agency_cents,
      (SELECT COALESCE(SUM(s.tenant_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS hap_tenant_cents,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status IS DISTINCT FROM 'pending' AND p.status IS DISTINCT FROM 'voided' AND p.status IS DISTINCT FROM 'reversed') AS hap_receipt_count,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status = 'received' AND p.status_knowledge = 'source' AND p.amount_knowledge = 'known' AND p.amount_cents IS NOT NULL AND p.payment_on_knowledge = 'source' AND p.payment_on IS NOT NULL AND p.payment_on <= $1::date AND p.payment_on >= DATE_TRUNC('month', $1::date)::date AND p.payment_on < (DATE_TRUNC('month', $1::date) + INTERVAL '1 month')::date) AS hap_known_receipt_count,
      (SELECT COUNT(*) FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status IS DISTINCT FROM 'pending' AND p.status IS DISTINCT FROM 'voided' AND p.status IS DISTINCT FROM 'reversed' AND (p.status IS NULL OR p.status_knowledge IS DISTINCT FROM 'source' OR p.status = 'received' AND (p.amount_knowledge IS DISTINCT FROM 'known' OR p.amount_cents IS NULL OR p.payment_on_knowledge IS DISTINCT FROM 'source' OR p.payment_on IS NULL))) AS hap_unknown_receipt_count,
      (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status = 'received' AND p.status_knowledge = 'source' AND p.amount_knowledge = 'known' AND p.amount_cents IS NOT NULL AND p.payment_on_knowledge = 'source' AND p.payment_on IS NOT NULL AND p.payment_on <= $1::date AND p.payment_on >= DATE_TRUNC('month', $1::date)::date AND p.payment_on < (DATE_TRUNC('month', $1::date) + INTERVAL '1 month')::date) AS hap_receipt_cents,
      (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status = 'received' AND p.status_knowledge = 'source' AND p.amount_knowledge = 'known' AND p.amount_cents IS NOT NULL AND p.payment_on_knowledge = 'source' AND p.payment_on IS NOT NULL AND p.payment_on <= $1::date AND p.payment_on >= DATE_TRUNC('month', $1::date)::date AND p.payment_on < (DATE_TRUNC('month', $1::date) + INTERVAL '1 month')::date) AS hap_received_agency_cents,
      (SELECT COALESCE(SUM(s.agency_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date)) AS hap_expected_agency_cents,
      ((SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM rent_ops_subsidy_payments p JOIN rent_ops_subsidy_contracts s ON s.id = p.subsidy_contract_id WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date) AND p.status = 'received' AND p.status_knowledge = 'source' AND p.amount_knowledge = 'known' AND p.amount_cents IS NOT NULL AND p.payment_on_knowledge = 'source' AND p.payment_on IS NOT NULL AND p.payment_on <= $1::date AND p.payment_on >= DATE_TRUNC('month', $1::date)::date AND p.payment_on < (DATE_TRUNC('month', $1::date) + INTERVAL '1 month')::date) - (SELECT COALESCE(SUM(s.agency_obligation_cents), 0)::bigint FROM rent_ops_subsidy_contracts s WHERE s.status <> 'pending' AND NOT (s.status = 'ended' AND s.effective_to IS NULL) AND s.effective_from <= DATE_TRUNC('month', $1::date)::date AND (s.effective_to IS NULL OR s.effective_to >= DATE_TRUNC('month', $1::date)::date))) AS hap_variance_cents,
      (SELECT COALESCE(SUM(s.amount_cents), 0)::bigint FROM rent_ops_recurring_charge_schedules s WHERE s.category = 'base_rent' AND s.active IS DISTINCT FROM FALSE AND (s.effective_from IS NULL OR s.effective_from <= $1::date) AND (s.effective_to IS NULL OR s.effective_to >= $1::date)) AS effective_base_rent_cents,
      (SELECT COALESCE(SUM(s.amount_cents), 0)::bigint FROM rent_ops_recurring_charge_schedules s WHERE s.category = 'recurring_fee' AND s.active IS DISTINCT FROM FALSE AND (s.effective_from IS NULL OR s.effective_from <= $1::date) AND (s.effective_to IS NULL OR s.effective_to >= $1::date)) AS effective_recurring_fees_cents
  `,
  /**
   * Independent v2 fidelity controls. This query deliberately recomputes
   * recurring/deposit source parity and effective-scope precedence from the
   * target tables rather than using the repository snapshot loader. The
   * scalar values are returned as one aggregate row so an audit runner can
   * compare them with the approved 285-schedule/108-deposit control artifact.
   */
  fidelityControls: `
    SELECT * FROM (
    WITH schedule_rows AS (
      SELECT s.*,
        COALESCE(s.charge_definition_id, s.charge_definition_key, 'unknown:' || s.id) AS definition_key,
        CASE s.scope_type WHEN 'tenant' THEN 3 WHEN 'unit' THEN 2 WHEN 'property' THEN 1 ELSE 0 END AS scope_rank
      FROM rent_ops_recurring_charge_schedules s
    ),
    schedule_sources AS (
      SELECT system AS source_system, source_id
      FROM rent_ops_source_records
      WHERE entity_type = 'recurring_schedule'
    ),
    schedule_target_duplicates AS (
      SELECT source_system, source_id, COUNT(*)::bigint AS row_count
      FROM schedule_rows
      WHERE source_system IS NOT NULL AND source_id IS NOT NULL
      GROUP BY source_system, source_id
      HAVING COUNT(*) > 1
    ),
    current_tenancies AS (
      SELECT t.id, t.property_id, t.unit_id, t.primary_person_id
      FROM rent_ops_tenancies t
      WHERE t.status IN ('current', 'notice')
    ),
    applicable_schedules AS (
      SELECT s.*, t.id AS target_tenancy_id,
        ROW_NUMBER() OVER (
          PARTITION BY t.id, s.category, s.definition_key
          ORDER BY s.scope_rank DESC, s.effective_from DESC NULLS LAST, s.id
        ) AS precedence_rank
      FROM schedule_rows s
      JOIN current_tenancies t ON t.property_id = s.property_id
      WHERE s.active IS DISTINCT FROM FALSE
        AND s.scope_type IN ('tenant', 'unit')
        AND (s.effective_from IS NULL OR s.effective_from <= $1::date)
        AND (s.effective_to IS NULL OR s.effective_to >= $1::date)
        AND (
          (s.scope_type = 'tenant' AND (
            (s.tenancy_id IS NOT NULL AND s.tenancy_id = t.id
              AND (s.property_id = t.property_id)
              AND (s.unit_id IS NULL OR s.unit_id = t.unit_id)
              AND (s.person_id IS NULL OR s.person_id = t.primary_person_id))
            OR (s.tenancy_id IS NULL
              AND (s.person_id = t.primary_person_id OR s.scope_id = t.primary_person_id)
              AND (s.property_id = t.property_id)
              AND (s.unit_id IS NULL OR s.unit_id = t.unit_id)
              AND NOT EXISTS (
                SELECT 1 FROM rent_ops_tenancies other
                WHERE other.id <> t.id
                  AND other.primary_person_id = t.primary_person_id
                  AND other.property_id = t.property_id
                  AND other.unit_id = t.unit_id
              )
            )
          ))
          OR (s.scope_type = 'unit' AND (s.unit_id = t.unit_id OR s.scope_id = t.unit_id))
        )
    ),
    property_schedules AS (
      SELECT s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s.property_id, s.category, s.definition_key
          ORDER BY s.effective_from DESC NULLS LAST, s.id
        ) AS property_rank
      FROM schedule_rows s
      WHERE s.active IS DISTINCT FROM FALSE AND s.scope_type = 'property'
        AND (s.effective_from IS NULL OR s.effective_from <= $1::date)
        AND (s.effective_to IS NULL OR s.effective_to >= $1::date)
    ),
    effective_report_schedules AS (
      SELECT a.property_id, a.category, a.amount_cents
      FROM applicable_schedules a
      WHERE a.precedence_rank = 1
      UNION ALL
      SELECT p.property_id, p.category, p.amount_cents
      FROM property_schedules p
      WHERE p.property_rank = 1
    ),
    deposit_sources AS (
      SELECT system AS source_system, source_id
      FROM rent_ops_source_records
      WHERE entity_type = 'deposit'
    ),
    deposit_target_duplicates AS (
      SELECT source_system, source_id, COUNT(*)::bigint AS row_count
      FROM rent_ops_security_deposits
      WHERE source_system IS NOT NULL AND source_id IS NOT NULL
      GROUP BY source_system, source_id
      HAVING COUNT(*) > 1
    ),
    held_deposits AS (
      SELECT d.*
      FROM rent_ops_security_deposits d
      WHERE (d.received_on IS NULL OR d.received_on <= $1::date)
        AND NOT (
          d.disposition_status IN ('disposed', 'returned')
          AND d.disposed_on IS NOT NULL
          AND d.disposed_on <= $1::date
        )
    ),
    hap_contract_sources AS (
      SELECT system AS source_system, source_id
      FROM rent_ops_source_records
      WHERE entity_type = 'subsidy'
    ),
    hap_tenant_sources AS (
      SELECT system AS source_system, source_id
      FROM rent_ops_source_records
      WHERE entity_type = 'subsidy_tenant'
    ),
    hap_payment_sources AS (
      SELECT system AS source_system, source_id
      FROM rent_ops_source_records
      WHERE entity_type = 'subsidy_payment'
    )
    SELECT
      (SELECT COUNT(*)::bigint FROM schedule_rows) AS schedule_row_count,
      (SELECT COUNT(*)::bigint FROM schedule_sources) AS schedule_source_row_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM schedule_rows WHERE source_system IS NOT NULL AND source_id IS NOT NULL) AS schedule_distinct_target_identity_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM schedule_sources) AS schedule_distinct_source_identity_count,
      (SELECT COALESCE(SUM(row_count - 1), 0)::bigint FROM schedule_target_duplicates) AS schedule_duplicate_identity_rows,
      (SELECT COUNT(*)::bigint FROM schedule_sources src WHERE NOT EXISTS (SELECT 1 FROM schedule_rows s WHERE s.source_system = src.source_system AND s.source_id = src.source_id)) AS schedule_missing_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows s WHERE s.source_system IS NOT NULL AND s.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schedule_sources src WHERE src.source_system = s.source_system AND src.source_id = s.source_id)) AS schedule_unexpected_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type IS NULL OR scope_id IS NULL OR scope_type NOT IN ('tenant', 'unit', 'property')) AS schedule_scope_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'tenant' AND person_id IS NULL AND tenancy_id IS NULL) AS schedule_tenant_reference_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'property' AND (unit_id IS NOT NULL OR person_id IS NOT NULL OR tenancy_id IS NOT NULL)) AS schedule_property_shape_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'unit' AND (unit_id IS NULL OR person_id IS NOT NULL OR tenancy_id IS NOT NULL)) AS schedule_unit_shape_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE (effective_from IS NULL AND effective_from_knowledge IS DISTINCT FROM 'unknown_open_start') OR (effective_from IS NOT NULL AND effective_from_knowledge NOT IN ('source', 'manual'))) AS schedule_date_knowledge_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE effective_from IS NULL AND effective_from_knowledge = 'unknown_open_start' AND (lineage_root_origin IS DISTINCT FROM 'artifact' OR artifact_observation_on IS NULL)) AS schedule_unknown_open_start_boundary_violation_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'tenant' AND tenancy_id IS NOT NULL AND EXISTS (SELECT 1 FROM rent_ops_tenancies former JOIN rent_ops_tenancies current ON current.primary_person_id = former.primary_person_id AND current.id <> former.id WHERE former.id = schedule_rows.tenancy_id AND former.status IN ('past', 'cancelled') AND current.status IN ('current', 'notice'))) AS schedule_former_tenant_leakage_rows,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'tenant') AS schedule_tenant_count,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE scope_type = 'tenant'), 0)::bigint FROM schedule_rows) AS schedule_tenant_amount_cents,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'unit') AS schedule_unit_count,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE scope_type = 'unit'), 0)::bigint FROM schedule_rows) AS schedule_unit_amount_cents,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE scope_type = 'property') AS schedule_property_count,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE scope_type = 'property'), 0)::bigint FROM schedule_rows) AS schedule_property_amount_cents,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE effective_from_knowledge = 'source' AND effective_from IS NOT NULL) AS schedule_known_start_count,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE effective_from_knowledge = 'source' AND effective_from IS NOT NULL), 0)::bigint FROM schedule_rows) AS schedule_known_start_amount_cents,
      (SELECT COUNT(*)::bigint FROM schedule_rows WHERE effective_from_knowledge = 'unknown_open_start' OR effective_from IS NULL) AS schedule_unknown_start_count,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE effective_from_knowledge = 'unknown_open_start' OR effective_from IS NULL), 0)::bigint FROM schedule_rows) AS schedule_unknown_start_amount_cents,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE category = 'base_rent'), 0)::bigint FROM effective_report_schedules) AS effective_base_rent_cents_independent,
      (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE category = 'recurring_fee'), 0)::bigint FROM effective_report_schedules) AS effective_recurring_fees_cents_independent,
      (SELECT COUNT(*)::bigint FROM property_schedules p WHERE p.property_rank > 1) AS property_definition_duplicate_rows,
      (SELECT COUNT(*)::bigint FROM property_schedules p WHERE EXISTS (SELECT 1 FROM schedule_rows specific WHERE specific.property_id = p.property_id AND specific.category = p.category AND specific.definition_key = p.definition_key AND specific.scope_type IN ('tenant', 'unit') AND specific.active IS DISTINCT FROM FALSE)) AS property_definition_overridden_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits) AS deposit_row_count,
      (SELECT COUNT(*)::bigint FROM deposit_sources) AS deposit_source_row_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM rent_ops_security_deposits WHERE source_system IS NOT NULL AND source_id IS NOT NULL) AS deposit_distinct_target_identity_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM deposit_sources) AS deposit_distinct_source_identity_count,
      (SELECT COALESCE(SUM(row_count - 1), 0)::bigint FROM deposit_target_duplicates) AS deposit_duplicate_identity_rows,
      (SELECT COUNT(*)::bigint FROM deposit_sources src WHERE NOT EXISTS (SELECT 1 FROM rent_ops_security_deposits d WHERE d.source_system = src.source_system AND d.source_id = src.source_id)) AS deposit_missing_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE d.source_system IS NOT NULL AND d.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deposit_sources src WHERE src.source_system = d.source_system AND src.source_id = d.source_id)) AS deposit_unexpected_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE d.tenancy_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM rent_ops_tenancies t WHERE t.id = d.tenancy_id AND t.property_id = d.property_id AND t.primary_person_id = d.person_id AND (d.unit_id IS NULL OR d.unit_id = t.unit_id)))) AS deposit_tenancy_reference_violation_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE d.unit_id IS NULL) AS deposit_unknown_unit_count,
      (SELECT COALESCE(SUM(COALESCE(source_balance_cents, amount_held_cents)) FILTER (WHERE unit_id IS NULL), 0)::bigint FROM rent_ops_security_deposits) AS deposit_unknown_unit_amount_cents,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE d.received_on IS NULL OR d.received_on_knowledge = 'unknown') AS deposit_unknown_receipt_date_count,
      (SELECT COALESCE(SUM(COALESCE(source_balance_cents, amount_held_cents)) FILTER (WHERE received_on IS NULL OR received_on_knowledge = 'unknown'), 0)::bigint FROM rent_ops_security_deposits) AS deposit_unknown_receipt_amount_cents,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE d.received_on IS NOT NULL AND d.received_on_knowledge = 'source') AS deposit_known_receipt_date_count,
      (SELECT COALESCE(SUM(COALESCE(source_balance_cents, amount_held_cents)) FILTER (WHERE received_on IS NOT NULL AND received_on_knowledge = 'source'), 0)::bigint FROM rent_ops_security_deposits) AS deposit_known_receipt_amount_cents,
      (SELECT COUNT(*)::bigint FROM rent_ops_security_deposits d WHERE (d.received_on IS NULL AND d.received_on_knowledge IS DISTINCT FROM 'unknown') OR (d.received_on IS NOT NULL AND d.received_on_knowledge IS DISTINCT FROM 'source')) AS deposit_date_knowledge_violation_rows,
      (SELECT COUNT(*)::bigint FROM held_deposits) AS held_deposit_row_count,
      (SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE type = 'security'), 0)::bigint FROM held_deposits) AS held_security_deposit_cents,
      (SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE type = 'refundable_pet'), 0)::bigint FROM held_deposits) AS held_refundable_pet_deposit_cents,
      (SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE type = 'other_refundable'), 0)::bigint FROM held_deposits) AS held_other_refundable_deposit_cents,
      (SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE received_on IS NULL), 0)::bigint FROM held_deposits) AS held_unknown_receipt_included_cents,
      (SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE received_on IS NOT NULL AND received_on > $1::date), 0)::bigint FROM rent_ops_security_deposits) AS future_known_receipt_excluded_cents,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_contracts) AS hap_contract_row_count,
      (SELECT COUNT(*)::bigint FROM hap_contract_sources) AS hap_contract_source_row_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM rent_ops_subsidy_contracts WHERE source_system IS NOT NULL AND source_id IS NOT NULL) AS hap_contract_distinct_target_identity_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM hap_contract_sources) AS hap_contract_distinct_source_identity_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants) AS hap_tenant_row_count,
      (SELECT COUNT(*)::bigint FROM hap_tenant_sources) AS hap_tenant_source_row_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM rent_ops_subsidy_tenants WHERE source_system IS NOT NULL AND source_id IS NOT NULL) AS hap_tenant_distinct_target_identity_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM hap_tenant_sources) AS hap_tenant_distinct_source_identity_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments) AS hap_payment_row_count,
      (SELECT COUNT(*)::bigint FROM hap_payment_sources) AS hap_payment_source_row_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM rent_ops_subsidy_payments WHERE source_system IS NOT NULL AND source_id IS NOT NULL) AS hap_payment_distinct_target_identity_count,
      (SELECT COUNT(DISTINCT (source_system, source_id))::bigint FROM hap_payment_sources) AS hap_payment_distinct_source_identity_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_contracts WHERE status IS NOT NULL AND status_knowledge = 'source') AS hap_contract_known_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_contracts WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_contract_unknown_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants WHERE status IS NOT NULL AND status_knowledge = 'source') AS hap_tenant_known_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_tenant_unknown_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE status IS NOT NULL AND status_knowledge = 'source') AS hap_payment_known_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE status IS NULL OR status_knowledge IS DISTINCT FROM 'source') AS hap_payment_unknown_status_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants WHERE effective_from IS NOT NULL AND effective_from_knowledge = 'source' AND effective_to IS NOT NULL AND effective_to_knowledge = 'source') AS hap_tenant_known_date_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants WHERE effective_from IS NULL OR effective_from_knowledge IS DISTINCT FROM 'source' OR effective_to IS NULL OR effective_to_knowledge IS DISTINCT FROM 'source') AS hap_tenant_unknown_date_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE payment_on IS NOT NULL AND payment_on_knowledge = 'source') AS hap_payment_known_date_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE payment_on IS NULL OR payment_on_knowledge IS DISTINCT FROM 'source') AS hap_payment_unknown_date_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE payment_link_knowledge = 'exact' AND payment_transaction_id IS NOT NULL) AS hap_payment_direct_link_count,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments WHERE payment_transaction_id IS NULL OR payment_link_knowledge IS DISTINCT FROM 'exact') AS hap_payment_unmatched_count,
      (SELECT COUNT(*)::bigint FROM hap_contract_sources src WHERE NOT EXISTS (SELECT 1 FROM rent_ops_subsidy_contracts c WHERE c.source_system = src.source_system AND c.source_id = src.source_id)) AS hap_contract_missing_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_contracts c WHERE c.source_system IS NOT NULL AND c.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hap_contract_sources src WHERE src.source_system = c.source_system AND src.source_id = c.source_id)) AS hap_contract_unexpected_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM hap_tenant_sources src WHERE NOT EXISTS (SELECT 1 FROM rent_ops_subsidy_tenants t WHERE t.source_system = src.source_system AND t.source_id = src.source_id)) AS hap_tenant_missing_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_tenants t WHERE t.source_system IS NOT NULL AND t.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hap_tenant_sources src WHERE src.source_system = t.source_system AND src.source_id = t.source_id)) AS hap_tenant_unexpected_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM hap_payment_sources src WHERE NOT EXISTS (SELECT 1 FROM rent_ops_subsidy_payments p WHERE p.source_system = src.source_system AND p.source_id = src.source_id)) AS hap_payment_missing_target_identity_rows,
      (SELECT COUNT(*)::bigint FROM rent_ops_subsidy_payments p WHERE p.source_system IS NOT NULL AND p.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hap_payment_sources src WHERE src.source_system = p.source_system AND src.source_id = p.source_id)) AS hap_payment_unexpected_target_identity_rows
    ) AS fidelity
  `,
});

export interface DatabaseAuditCounts {
  properties: number;
  units: number;
  people: number;
  applications: number;
  applicationHouseholdMembers: number;
  applicationRequirements: number;
  tenancies: number;
  householdMemberships: number;
  leaseTerms: number;
  recurringSchedules: number;
  ledgerTransactions: number;
  paymentAllocations: number;
  securityDeposits: number;
  subsidyContracts: number;
  /** Exact `/SubsidyTenants` source-class row count. */
  subsidyTenants?: number;
  /** Exact `/SubsidyPayments` source-class row count. */
  subsidyPayments?: number;
  documents: number;
  activityEvents: number;
  sourceRecords: number;
  importRuns: number;
  prospects?: number;
  applicationHistory?: number;
  applicationInterests?: number;
  applicationParticipants?: number;
  applicationRequirementOccurrences?: number;
  applicationTemplateDefinitions?: number;
  applicationTemplateSections?: number;
  applicationTemplateFields?: number;
  applicationAnswerOccurrences?: number;
  applicationHistoryDocuments?: number;
  applicationHistoryActivities?: number;
  applicationHistoryBlockers?: number;
  applicationHistoryAggregates?: number;
}

export interface DatabaseAuditTotals {
  chargesCents: number;
  paymentsCents: number;
  creditsCents: number;
  /** Authoritative raw signed ledger control using domain sign semantics. */
  netLedgerCents: number;
  /** Compatibility alias; it must equal netLedgerCents, not a second balance formula. */
  netLedgerBalanceCents: number;
  allocationsCents: number;
  depositsCents: number;
  hapAgencyObligationCents: number;
  hapTenantObligationCents: number;
  /** Sum of known `/SubsidyTenants` amounts; unknown amounts are excluded. */
  hapSubsidyTenantCents?: number;
  /** Sum of known `/SubsidyPayments` amounts; unknown amounts are excluded. */
  hapSubsidyPaymentCents?: number;
  hapSubsidyTenantKnownAmountCount?: number;
  hapSubsidyTenantUnknownAmountCount?: number;
  hapSubsidyPaymentKnownAmountCount?: number;
  hapSubsidyPaymentUnknownAmountCount?: number;
}

export interface DatabaseTargetInspection {
  redactedFingerprint: string;
  migrationVersion: number;
  migrationChecksum: string;
  requiredTables: number;
  migrationChecksums?: Readonly<Record<number, string>>;
  migrationChainValid?: boolean;
}

export interface DatabaseAuditReportParity {
  rentRollRows: number;
  currentOccupiedUnits: number;
  futurePreleasedUnits: number;
  vacantUnits: number;
  activeHapContracts: number;
  hapAgencyCents: number;
  hapTenantCents: number;
  /** Child-payment receipt controls, independent of ledger allocations. */
  hapReceiptCount?: number;
  hapKnownReceiptCount?: number;
  hapUnknownReceiptCount?: number;
  hapReceiptCents?: number;
  hapExpectedAgencyCents?: number;
  hapReceivedAgencyCents?: number;
  hapVarianceCents?: number;
  effectiveBaseRentCents: number;
  effectiveRecurringFeesCents: number;
}

export interface DatabaseAuditPropertyControl {
  propertyKey: string;
  unitCount: number;
  currentOccupiedUnits: number;
  futurePreleasedUnits: number;
  chargeCount: number;
  paymentCount: number;
  creditCount: number;
  chargesCents: number;
  paymentsCents: number;
  creditsCents: number;
  allocationsCents: number;
  depositsCents: number;
  activeHapContracts: number;
  hapAgencyCents: number;
  hapTenantCents: number;
}

/** Aggregate-only v8 schedule controls.  `propertyKey` is always a one-way
 * hash, with the literal `portfolio` reserved for the portfolio aggregate. */
export interface DatabaseAuditFinancialReportControl {
  propertyKey: string;
  sourceRowCount: number;
  knownCount: number;
  knownCents: number;
  uncertainCount: number;
  uncertainCents: number;
  unassignedCount: number;
  unassignedCents: number;
  notApplicableCount: number;
  notApplicableCents: number;
  suppressedCount: number;
  suppressedCents: number;
  endedCount: number;
  endedCents: number;
  inactiveCount: number;
  inactiveCents: number;
  futureCount: number;
  futureCents: number;
  unknownAmountCount: number;
  unknownAmountCents: number;
  invalidCount: number;
  invalidCents: number;
  propertyOnceCount: number;
  propertyOnceCents: number;
  formerTenancyLeakageCount: number;
}

export type DatabaseAuditFinancialReportPortfolio = DatabaseAuditFinancialReportControl;

export interface DatabaseAuditExpectedFinancialReport {
  portfolio?: Partial<Omit<DatabaseAuditFinancialReportControl, "propertyKey">>;
  perProperty?: readonly DatabaseAuditExpectedFinancialReportProperty[];
}

export interface DatabaseAuditExpectedFinancialReportProperty extends Partial<Omit<DatabaseAuditFinancialReportControl, "propertyKey">> {
  propertyId: string;
}

export interface DatabaseAuditExpected {
  counts?: Partial<DatabaseAuditCounts>;
  totalsCents?: Partial<DatabaseAuditTotals>;
  sourceRecords?: readonly RentOpsSourceRecord[];
  /**
   * Expected lossless RM archive metadata. The expected records are supplied
   * by the approved export artifact; only their checksums/identities are used
   * for parity. The audit result never returns those identities.
   */
  restrictedSourcePayloads?: DatabaseAuditExpectedRestrictedPayloads;
  restrictedSourceBinaries?: DatabaseAuditExpectedRestrictedBinaries;
  reportParity?: Partial<DatabaseAuditReportParity>;
  perProperty?: readonly DatabaseAuditExpectedProperty[];
  /** Independent v8 scheduled-income aggregates, if supplied by the source
   * control artifact.  The existing deposit/HAP/restricted expectations stay
   * separate and unchanged. */
  financialReport?: DatabaseAuditExpectedFinancialReport;
  /** Alias accepted for callers that name the control after the SQL key. */
  financialReportV8?: DatabaseAuditExpectedFinancialReport;
  /** Independent v2 recurring/deposit/source-target controls. */
  fidelityControls?: Readonly<Record<string, number>>;
}

export interface DatabaseAuditRestrictedVersion {
  system: string;
  sourceCollection: string;
  sourceId: string;
  checksumSha256: string;
}

export interface DatabaseAuditExpectedRestrictedPayloads {
  records?: readonly DatabaseAuditRestrictedVersion[];
  rowCount?: number;
  distinctSourceCount?: number;
  distinctVersionCount?: number;
  checksumDigestSha256?: string;
  versionDigestSha256?: string;
}

export interface DatabaseAuditRestrictedBinaryDescriptor extends DatabaseAuditRestrictedVersion {
  sizeBytes: number;
  contentType?: string | null;
  verificationStatus: string;
}

export interface DatabaseAuditExpectedRestrictedBinaries {
  records?: readonly DatabaseAuditRestrictedBinaryDescriptor[];
  rowCount?: number;
  distinctSourceCount?: number;
  distinctVersionCount?: number;
  verifiedCount?: number;
  missingCount?: number;
  mismatchCount?: number;
  invalidStatusCount?: number;
  invalidChecksumCount?: number;
  checksumDigestSha256?: string;
  versionDigestSha256?: string;
  descriptorDigestSha256?: string;
}

export interface DatabaseAuditExpectedProperty {
  propertyId: string;
  unitCount?: number;
  currentOccupiedUnits?: number;
  futurePreleasedUnits?: number;
  chargeCount?: number;
  paymentCount?: number;
  creditCount?: number;
  chargesCents?: number;
  paymentsCents?: number;
  creditsCents?: number;
  allocationsCents?: number;
  depositsCents?: number;
  activeHapContracts?: number;
  hapAgencyCents?: number;
  hapTenantCents?: number;
}

export interface DatabaseAuditControl<T> {
  actual: T;
  expected?: T;
  checked: boolean;
  passed: boolean;
}

export interface DatabaseAuditViolations {
  total: number;
  checks: Record<string, number>;
}

export interface DatabaseAuditSourceParity {
  checked: boolean;
  passed: boolean;
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  unexpectedCount: number;
  changedCount: number;
  duplicateExpectedCount: number;
  digestExpected?: string;
  digestActual: string;
}

/**
 * Redacted parity/integrity result for a restricted source table. Counts and
 * digests are safe to report; source identifiers are deliberately absent.
 */
export interface DatabaseAuditRestrictedSourceParity {
  checked: boolean;
  passed: boolean;
  expectedCount?: number;
  actualCount: number;
  expectedDistinctSourceCount?: number;
  actualDistinctSourceCount: number;
  expectedDistinctVersionCount?: number;
  actualDistinctVersionCount: number;
  missingCount: number;
  unexpectedCount: number;
  changedCount: number;
  duplicateVersionRows: number;
  conflictingSourceCount: number;
  invalidIdentityCount: number;
  invalidChecksumCount: number;
  duplicateExpectedCount: number;
  checksumDigestExpected?: string;
  checksumDigestActual: string;
  versionDigestExpected?: string;
  versionDigestActual: string;
}

export interface DatabaseAuditRestrictedBinaryParity extends DatabaseAuditRestrictedSourceParity {
  expectedVerifiedCount?: number;
  actualVerifiedCount: number;
  expectedMissingCount?: number;
  actualMissingCount: number;
  expectedMismatchCount?: number;
  actualMismatchCount: number;
  expectedInvalidStatusCount?: number;
  actualInvalidStatusCount: number;
  expectedInvalidChecksumCount?: number;
  descriptorDigestExpected?: string;
  descriptorDigestActual: string;
}

export interface DatabaseAuditResult {
  asOfDate: string;
  passed: boolean;
  blockingReasons: string[];
  counts: DatabaseAuditCounts;
  countControls: Partial<Record<keyof DatabaseAuditCounts, DatabaseAuditControl<number>>>;
  totalsCents: DatabaseAuditTotals;
  totalControls: Partial<Record<keyof DatabaseAuditTotals, DatabaseAuditControl<number>>>;
  orphanChecks: DatabaseAuditViolations;
  allocationChecks: DatabaseAuditViolations;
  ledgerChecks: DatabaseAuditViolations;
  duplicateChecks: DatabaseAuditViolations;
  dateChecks: DatabaseAuditViolations;
  perProperty: DatabaseAuditPropertyControl[];
  reportParity: DatabaseAuditReportParity;
  reportControls: Partial<Record<keyof DatabaseAuditReportParity, DatabaseAuditControl<number>>>;
  financialReport: DatabaseAuditFinancialReportControl[];
  fidelityControls: Record<string, number>;
  rawSourceHashParity: DatabaseAuditSourceParity;
  restrictedSourcePayloadParity: DatabaseAuditRestrictedSourceParity;
  restrictedSourceBinaryParity: DatabaseAuditRestrictedBinaryParity;
}

export class DatabaseAuditError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Rent Operations database audit failed: ${reasons.join(", ")}`);
    this.name = "DatabaseAuditError";
    this.reasons = reasons;
  }
}

const COUNT_KEYS: (keyof DatabaseAuditCounts)[] = [
  "properties", "units", "people", "applications", "applicationHouseholdMembers", "applicationRequirements", "tenancies", "householdMemberships", "leaseTerms", "recurringSchedules", "ledgerTransactions", "paymentAllocations", "securityDeposits", "subsidyContracts", "subsidyTenants", "subsidyPayments", "documents", "activityEvents", "prospects", "applicationHistory", "applicationInterests", "applicationParticipants", "applicationRequirementOccurrences", "applicationTemplateDefinitions", "applicationTemplateSections", "applicationTemplateFields", "applicationAnswerOccurrences", "applicationHistoryDocuments", "applicationHistoryActivities", "applicationHistoryBlockers", "applicationHistoryAggregates", "sourceRecords", "importRuns",
];
const TOTAL_KEYS: (keyof DatabaseAuditTotals)[] = ["chargesCents", "paymentsCents", "creditsCents", "netLedgerCents", "netLedgerBalanceCents", "allocationsCents", "depositsCents", "hapAgencyObligationCents", "hapTenantObligationCents", "hapSubsidyTenantCents", "hapSubsidyPaymentCents", "hapSubsidyTenantKnownAmountCount", "hapSubsidyTenantUnknownAmountCount", "hapSubsidyPaymentKnownAmountCount", "hapSubsidyPaymentUnknownAmountCount"];
const REPORT_KEYS: (keyof DatabaseAuditReportParity)[] = ["rentRollRows", "currentOccupiedUnits", "futurePreleasedUnits", "vacantUnits", "activeHapContracts", "hapAgencyCents", "hapTenantCents", "hapReceiptCount", "hapKnownReceiptCount", "hapUnknownReceiptCount", "hapReceiptCents", "hapExpectedAgencyCents", "hapReceivedAgencyCents", "hapVarianceCents", "effectiveBaseRentCents", "effectiveRecurringFeesCents"];
const FIDELITY_VIOLATION_KEYS = [
  "schedule_duplicate_identity_rows", "schedule_missing_target_identity_rows", "schedule_unexpected_target_identity_rows",
  "schedule_scope_violation_rows", "schedule_tenant_reference_violation_rows", "schedule_property_shape_violation_rows", "schedule_unit_shape_violation_rows",
  "schedule_date_knowledge_violation_rows", "schedule_unknown_open_start_boundary_violation_rows", "schedule_former_tenant_leakage_rows",
  "property_definition_duplicate_rows", "deposit_duplicate_identity_rows", "deposit_missing_target_identity_rows", "deposit_unexpected_target_identity_rows",
  "deposit_tenancy_reference_violation_rows", "deposit_date_knowledge_violation_rows",
  "hap_subsidy_tenant_orphan_rows", "hap_subsidy_payment_orphan_rows", "hap_subsidy_tenant_exact_link_rows", "hap_subsidy_payment_exact_contract_link_rows", "hap_subsidy_payment_link_rows",
  "hap_subsidy_tenant_duplicate_identity_rows", "hap_subsidy_payment_duplicate_identity_rows",
  "hap_contract_missing_target_identity_rows", "hap_contract_unexpected_target_identity_rows", "hap_tenant_missing_target_identity_rows", "hap_tenant_unexpected_target_identity_rows", "hap_payment_missing_target_identity_rows", "hap_payment_unexpected_target_identity_rows",
  "hap_subsidy_contract_scope_violation_rows", "hap_subsidy_tenant_scope_violation_rows", "hap_subsidy_payment_scope_violation_rows",
  "hap_subsidy_tenant_date_conflict_rows", "hap_subsidy_payment_date_conflict_rows",
  "hap_subsidy_contract_status_unknown_rows", "hap_subsidy_tenant_status_unknown_rows", "hap_subsidy_payment_status_unknown_rows",
] as const;

function integerValue(value: unknown, reason: string): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new DatabaseAuditError([reason]);
  return number;
}

function signedIntegerValue(value: unknown, reason: string): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new DatabaseAuditError([reason]);
  return number;
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function targetFingerprint(row: Record<string, unknown>): string {
  const direct = row.redacted_fingerprint ?? row.redactedFingerprint ?? row.fingerprint ?? row.target_fingerprint;
  if (typeof direct === "string" && /^[a-f0-9]{16}$/.test(direct)) return direct;
  const stable = Object.fromEntries(Object.entries(row).filter(([key]) => /database|server|user|identity|fingerprint/i.test(key)).sort(([left], [right]) => left.localeCompare(right)));
  return hashIdentifier(JSON.stringify(stable));
}

/** Read-only target identity and applied-schema inspection for the importer gate. */
export async function inspectDatabaseTarget(executor: RentOpsQueryExecutor): Promise<DatabaseTargetInspection> {
  try {
    const identity = await executor.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.targetIdentity);
    const schema = await executor.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.schemaMeta);
    const tables = await executor.query<{ table_name?: string }>(DATABASE_AUDIT_SQL.schema, [Array.from(RENT_OPS_AUDIT_REQUIRED_TABLES)]);
    const migrationRows = schema.rows
      .map((row) => ({ version: Number(row.version ?? 0), checksum: String(row.checksum_sha256 ?? "") }))
      .filter((row) => Number.isInteger(row.version) && row.version > 0)
      .sort((left, right) => left.version - right.version);
    const migrationChecksums = Object.fromEntries(migrationRows.map((row) => [row.version, row.checksum]));
    const migrationVersion = migrationRows.at(-1)?.version ?? 0;
    const migrationChecksum = migrationRows.at(-1)?.checksum ?? "";
    const migrationChainValid = Array.from({ length: RENT_OPS_SCHEMA_VERSION }, (_, index) => index + 1).every((version) => migrationChecksums[version] === rentOpsMigrationChecksumForVersion(version));
    return {
      redactedFingerprint: targetFingerprint(identity.rows[0] ?? {}),
      migrationVersion,
      migrationChecksum,
      requiredTables: new Set(tables.rows.map((table) => String(table.table_name ?? ""))).size,
      migrationChecksums,
      migrationChainValid,
    };
  } catch {
    throw new DatabaseAuditError(["target_inspection_failed"]);
  }
}

function canonicalSource(system: string, entityType: string, sourceId: string, checksum: string, targetId: string): string {
  return [system, entityType, sourceId, checksum, targetId].map((value) => `${value.length}:${value}`).join("|");
}

function sourceKey(system: string, entityType: string, sourceId: string): string {
  return `${system}\u0000${entityType}\u0000${sourceId}`;
}

function sourceRowsDigest(rows: readonly string[]): string {
  const sorted = rows.slice().sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

function compareControls<T extends number>(actual: T, expected: T | undefined): DatabaseAuditControl<T> {
  return { actual, expected, checked: expected !== undefined, passed: expected === undefined || actual === expected };
}

function violationSummary(row: Record<string, unknown>): DatabaseAuditViolations {
  const checks: Record<string, number> = {};
  let total = 0;
  Object.keys(row).forEach((key) => {
    const value = integerValue(row[key], "audit_count_invalid");
    checks[key] = value;
    total += value;
  });
  return { total, checks };
}

function invariantSummary(rows: readonly Record<string, unknown>[], reason: string): DatabaseAuditViolations {
  // Both invariant statements are aggregate SELECTs and must return exactly
  // one row.  Treat an absent/malformed row as an audit failure rather than
  // interpreting it as a clean database.
  if (rows.length !== 1 || !rows[0] || Array.isArray(rows[0]) || Object.keys(rows[0]).length === 0) throw new DatabaseAuditError([reason]);
  return violationSummary(rows[0]);
}

function mapCounts(rows: readonly Record<string, unknown>[]): DatabaseAuditCounts {
  const values: Record<string, number> = {};
  rows.forEach((row) => { values[String(row.metric)] = integerValue(row.value, "audit_count_invalid"); });
  const counts = {} as DatabaseAuditCounts;
  COUNT_KEYS.forEach((key) => { counts[key] = values[key] ?? 0; });
  return counts;
}

function mapTotals(row: Record<string, unknown>): DatabaseAuditTotals {
  return {
    chargesCents: integerValue(row.charges_cents, "audit_money_invalid"),
    paymentsCents: integerValue(row.payments_cents, "audit_money_invalid"),
    creditsCents: integerValue(row.credits_cents, "audit_money_invalid"),
    netLedgerCents: signedIntegerValue(row.net_ledger_cents, "audit_money_invalid"),
    netLedgerBalanceCents: signedIntegerValue(row.net_ledger_balance_cents ?? row.net_ledger_cents, "audit_money_invalid"),
    allocationsCents: integerValue(row.allocations_cents, "audit_money_invalid"),
    depositsCents: integerValue(row.deposits_cents, "audit_money_invalid"),
    hapAgencyObligationCents: integerValue(row.hap_agency_obligation_cents, "audit_money_invalid"),
    hapTenantObligationCents: integerValue(row.hap_tenant_obligation_cents, "audit_money_invalid"),
    hapSubsidyTenantCents: integerValue(row.hap_subsidy_tenant_cents, "audit_money_invalid"),
    hapSubsidyPaymentCents: integerValue(row.hap_subsidy_payment_cents, "audit_money_invalid"),
    hapSubsidyTenantKnownAmountCount: integerValue(row.hap_subsidy_tenant_known_amount_count, "audit_count_invalid"),
    hapSubsidyTenantUnknownAmountCount: integerValue(row.hap_subsidy_tenant_unknown_amount_count, "audit_count_invalid"),
    hapSubsidyPaymentKnownAmountCount: integerValue(row.hap_subsidy_payment_known_amount_count, "audit_count_invalid"),
    hapSubsidyPaymentUnknownAmountCount: integerValue(row.hap_subsidy_payment_unknown_amount_count, "audit_count_invalid"),
  };
}

function mapReportParity(row: Record<string, unknown>): DatabaseAuditReportParity {
  return {
    rentRollRows: integerValue(row.rent_roll_rows, "audit_report_invalid"),
    currentOccupiedUnits: integerValue(row.current_occupied_units, "audit_report_invalid"),
    futurePreleasedUnits: integerValue(row.future_preleased_units, "audit_report_invalid"),
    vacantUnits: integerValue(row.vacant_units, "audit_report_invalid"),
    activeHapContracts: integerValue(row.active_hap_contracts, "audit_report_invalid"),
    hapAgencyCents: integerValue(row.hap_agency_cents, "audit_report_invalid"),
    hapTenantCents: integerValue(row.hap_tenant_cents, "audit_report_invalid"),
    hapReceiptCount: integerValue(row.hap_receipt_count, "audit_report_invalid"),
    hapKnownReceiptCount: integerValue(row.hap_known_receipt_count, "audit_report_invalid"),
    hapUnknownReceiptCount: integerValue(row.hap_unknown_receipt_count, "audit_report_invalid"),
    hapReceiptCents: integerValue(row.hap_receipt_cents, "audit_report_invalid"),
    hapExpectedAgencyCents: integerValue(row.hap_expected_agency_cents, "audit_report_invalid"),
    hapReceivedAgencyCents: integerValue(row.hap_received_agency_cents ?? row.hap_receipt_cents, "audit_report_invalid"),
    hapVarianceCents: signedIntegerValue(row.hap_variance_cents, "audit_report_invalid"),
    effectiveBaseRentCents: integerValue(row.effective_base_rent_cents, "audit_report_invalid"),
    effectiveRecurringFeesCents: integerValue(row.effective_recurring_fees_cents, "audit_report_invalid"),
  };
}

function mapFidelityControls(row: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) result[key] = integerValue(value, "audit_fidelity_invalid");
  return result;
}

function mapProperty(row: Record<string, unknown>): DatabaseAuditPropertyControl {
  return {
    propertyKey: hashIdentifier(String(row.property_id)),
    unitCount: integerValue(row.unit_count, "audit_property_invalid"),
    currentOccupiedUnits: integerValue(row.current_occupied_units, "audit_property_invalid"),
    futurePreleasedUnits: integerValue(row.future_preleased_units, "audit_property_invalid"),
    chargeCount: integerValue(row.charge_count, "audit_property_invalid"),
    paymentCount: integerValue(row.payment_count, "audit_property_invalid"),
    creditCount: integerValue(row.credit_count, "audit_property_invalid"),
    chargesCents: integerValue(row.charges_cents, "audit_property_invalid"),
    paymentsCents: integerValue(row.payments_cents, "audit_property_invalid"),
    creditsCents: integerValue(row.credits_cents, "audit_property_invalid"),
    allocationsCents: integerValue(row.allocations_cents, "audit_property_invalid"),
    depositsCents: integerValue(row.deposits_cents, "audit_property_invalid"),
    activeHapContracts: integerValue(row.active_hap_contracts, "audit_property_invalid"),
    hapAgencyCents: integerValue(row.hap_agency_cents, "audit_property_invalid"),
    hapTenantCents: integerValue(row.hap_tenant_cents, "audit_property_invalid"),
  };
}

function mapFinancialReport(row: Record<string, unknown>): DatabaseAuditFinancialReportControl {
  const propertyId = row.property_id == null ? "portfolio" : hashIdentifier(String(row.property_id));
  return {
    propertyKey: propertyId,
    sourceRowCount: integerValue(row.source_row_count, "audit_financial_report_invalid"),
    knownCount: integerValue(row.known_count, "audit_financial_report_invalid"),
    knownCents: integerValue(row.known_cents, "audit_financial_report_invalid"),
    uncertainCount: integerValue(row.uncertain_count, "audit_financial_report_invalid"),
    uncertainCents: integerValue(row.uncertain_cents, "audit_financial_report_invalid"),
    unassignedCount: integerValue(row.unassigned_count, "audit_financial_report_invalid"),
    unassignedCents: integerValue(row.unassigned_cents, "audit_financial_report_invalid"),
    notApplicableCount: integerValue(row.not_applicable_count, "audit_financial_report_invalid"),
    notApplicableCents: integerValue(row.not_applicable_cents, "audit_financial_report_invalid"),
    suppressedCount: integerValue(row.suppressed_count, "audit_financial_report_invalid"),
    suppressedCents: integerValue(row.suppressed_cents, "audit_financial_report_invalid"),
    endedCount: integerValue(row.ended_count, "audit_financial_report_invalid"),
    endedCents: integerValue(row.ended_cents, "audit_financial_report_invalid"),
    inactiveCount: integerValue(row.inactive_count, "audit_financial_report_invalid"),
    inactiveCents: integerValue(row.inactive_cents, "audit_financial_report_invalid"),
    futureCount: integerValue(row.future_count, "audit_financial_report_invalid"),
    futureCents: integerValue(row.future_cents, "audit_financial_report_invalid"),
    unknownAmountCount: integerValue(row.unknown_amount_count, "audit_financial_report_invalid"),
    unknownAmountCents: integerValue(row.unknown_amount_cents, "audit_financial_report_invalid"),
    invalidCount: integerValue(row.invalid_count, "audit_financial_report_invalid"),
    invalidCents: integerValue(row.invalid_cents, "audit_financial_report_invalid"),
    propertyOnceCount: integerValue(row.property_once_count, "audit_financial_report_invalid"),
    propertyOnceCents: integerValue(row.property_once_cents, "audit_financial_report_invalid"),
    formerTenancyLeakageCount: integerValue(row.former_tenancy_leakage_count, "audit_financial_report_invalid"),
  };
}

function sourceParity(expected: readonly RentOpsSourceRecord[] | undefined, rows: readonly Record<string, unknown>[]): DatabaseAuditSourceParity {
  const actualCanonical: string[] = [];
  const actualByKey = new Map<string, string>();
  let actualDuplicates = 0;
  rows.forEach((row) => {
    const system = String(row.system ?? "");
    const entityType = String(row.entity_type ?? "");
    const sourceId = String(row.source_id ?? "");
    const checksum = String(row.checksum ?? "");
    const targetId = String(row.target_id ?? "");
    const key = sourceKey(system, entityType, sourceId);
    const canonical = canonicalSource(system, entityType, sourceId, checksum, targetId);
    actualCanonical.push(canonical);
    if (actualByKey.has(key)) actualDuplicates += 1;
    else actualByKey.set(key, canonical);
  });
  const digestActual = sourceRowsDigest(actualCanonical);
  if (!expected) {
    return { checked: false, passed: false, expectedCount: 0, actualCount: rows.length, missingCount: 0, unexpectedCount: 0, changedCount: 0, duplicateExpectedCount: 0, digestActual };
  }
  const expectedCanonical: string[] = [];
  const expectedByKey = new Map<string, string>();
  let duplicateExpectedCount = 0;
  expected.forEach((record) => {
    const canonical = canonicalSource(record.system, record.entityType, record.sourceId, record.checksum ?? "", record.targetId);
    expectedCanonical.push(canonical);
    const key = sourceKey(record.system, record.entityType, record.sourceId);
    if (expectedByKey.has(key)) duplicateExpectedCount += 1;
    else expectedByKey.set(key, canonical);
  });
  let missingCount = 0;
  let changedCount = 0;
  expectedByKey.forEach((canonical, key) => {
    const actual = actualByKey.get(key);
    if (!actual) missingCount += 1;
    else if (actual !== canonical) changedCount += 1;
  });
  let unexpectedCount = 0;
  actualByKey.forEach((_canonical, key) => { if (!expectedByKey.has(key)) unexpectedCount += 1; });
  const digestExpected = sourceRowsDigest(expectedCanonical);
  const passed = missingCount === 0 && unexpectedCount === 0 && changedCount === 0 && duplicateExpectedCount === 0 && actualDuplicates === 0 && expected.length === rows.length;
  return { checked: true, passed, expectedCount: expected.length, actualCount: rows.length, missingCount, unexpectedCount, changedCount, duplicateExpectedCount: duplicateExpectedCount + actualDuplicates, digestExpected, digestActual };
}

interface RestrictedMetadataRow {
  system: string;
  sourceCollection: string;
  sourceId: string;
  checksumSha256: string;
  sizeBytes?: number;
  contentType?: string | null;
  verificationStatus?: string;
}

function restrictedText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === undefined || value === null ? "" : String(value);
}

function restrictedMetadataRow(row: Record<string, unknown>, binary: boolean): RestrictedMetadataRow {
  const result: RestrictedMetadataRow = {
    system: restrictedText(row, "system"),
    sourceCollection: restrictedText(row, "source_collection"),
    sourceId: restrictedText(row, "source_id"),
    checksumSha256: restrictedText(row, "checksum_sha256").toLowerCase(),
  };
  if (binary) {
    const rawSize = row.size_bytes;
    result.sizeBytes = typeof rawSize === "bigint" ? Number(rawSize) : Number(rawSize);
    result.contentType = row.content_type === null || row.content_type === undefined ? null : String(row.content_type);
    result.verificationStatus = restrictedText(row, "verification_status");
  }
  return result;
}

function restrictedSourceKey(row: Pick<RestrictedMetadataRow, "system" | "sourceCollection" | "sourceId">): string {
  return sourceKey(row.system, row.sourceCollection, row.sourceId);
}

function restrictedVersionKey(row: Pick<RestrictedMetadataRow, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return `${restrictedSourceKey(row)}\u0000${row.checksumSha256}`;
}

function restrictedVersionCanonical(row: Pick<RestrictedMetadataRow, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return [row.system, row.sourceCollection, row.sourceId, row.checksumSha256].map((value) => `${value.length}:${value}`).join("|");
}

function restrictedDescriptorCanonical(row: RestrictedMetadataRow): string {
  return [
    restrictedVersionCanonical(row),
    String(row.sizeBytes ?? ""),
    row.contentType ?? "",
    row.verificationStatus ?? "",
  ].map((value) => `${value.length}:${value}`).join("|");
}

function expectedRestrictedRow(value: DatabaseAuditRestrictedVersion | DatabaseAuditRestrictedBinaryDescriptor, binary: boolean): RestrictedMetadataRow {
  const row: RestrictedMetadataRow = {
    system: String(value.system ?? ""),
    sourceCollection: String(value.sourceCollection ?? ""),
    sourceId: String(value.sourceId ?? ""),
    checksumSha256: String(value.checksumSha256 ?? "").toLowerCase(),
  };
  if (binary) {
    const descriptor = value as DatabaseAuditRestrictedBinaryDescriptor;
    row.sizeBytes = Number(descriptor.sizeBytes);
    row.contentType = descriptor.contentType === undefined ? null : descriptor.contentType;
    row.verificationStatus = String(descriptor.verificationStatus ?? "");
  }
  return row;
}

function restrictedSourceParity(
  expected: DatabaseAuditExpectedRestrictedPayloads | DatabaseAuditExpectedRestrictedBinaries | undefined,
  inputRows: readonly Record<string, unknown>[],
  binary: boolean,
): DatabaseAuditRestrictedSourceParity | DatabaseAuditRestrictedBinaryParity {
  const rows = inputRows.map((row) => restrictedMetadataRow(row, binary));
  const actualVersions = new Map<string, RestrictedMetadataRow>();
  const actualVersionRows = new Map<string, number>();
  const actualChecksums: string[] = [];
  const actualVersionCanonicals: string[] = [];
  const actualSources = new Map<string, Set<string>>();
  let invalidIdentityCount = 0;
  let invalidChecksumCount = 0;
  for (const row of rows) {
    if (!row.system || !row.sourceCollection || !row.sourceId) invalidIdentityCount += 1;
    if (!/^[a-f0-9]{64}$/.test(row.checksumSha256)) invalidChecksumCount += 1;
    const source = restrictedSourceKey(row);
    const version = restrictedVersionKey(row);
    actualSources.set(source, actualSources.get(source) ?? new Set<string>());
    actualSources.get(source)?.add(row.checksumSha256);
    actualVersionRows.set(version, (actualVersionRows.get(version) ?? 0) + 1);
    if (!actualVersions.has(version)) {
      actualVersions.set(version, row);
      actualVersionCanonicals.push(restrictedVersionCanonical(row));
    }
    actualChecksums.push(row.checksumSha256);
  }
  let duplicateVersionRows = 0;
  Array.from(actualVersionRows.values()).forEach((count) => { duplicateVersionRows += Math.max(0, count - 1); });
  const conflictingSourceCount = Array.from(actualSources.values()).filter((checksums) => checksums.size > 1).length;
  const checksumDigestActual = sourceRowsDigest(actualChecksums);
  const versionDigestActual = sourceRowsDigest(actualVersionCanonicals);
  const expectedRows = expected?.records?.map((row) => expectedRestrictedRow(row, binary));
  const expectedVersions = new Map<string, RestrictedMetadataRow>();
  const expectedSources = new Map<string, Set<string>>();
  let duplicateExpectedCount = 0;
  let missingCount = 0;
  let unexpectedCount = 0;
  let changedCount = 0;
  let checksumDigestExpected: string | undefined;
  let versionDigestExpected: string | undefined;
  if (expectedRows) {
    const expectedChecksums: string[] = [];
    const expectedVersionCanonicals: string[] = [];
    for (const row of expectedRows) {
      const source = restrictedSourceKey(row);
      const version = restrictedVersionKey(row);
      expectedSources.set(source, expectedSources.get(source) ?? new Set<string>());
      expectedSources.get(source)?.add(row.checksumSha256);
      expectedChecksums.push(row.checksumSha256);
      if (expectedVersions.has(version)) duplicateExpectedCount += 1;
      else {
        expectedVersions.set(version, row);
        expectedVersionCanonicals.push(restrictedVersionCanonical(row));
      }
    }
    Array.from(expectedVersions.keys()).forEach((version) => { if (!actualVersions.has(version)) missingCount += 1; });
    Array.from(actualVersions.keys()).forEach((version) => { if (!expectedVersions.has(version)) unexpectedCount += 1; });
    Array.from(expectedSources.entries()).forEach(([source, expectedChecksumsForSource]) => {
      const actualChecksumsForSource = actualSources.get(source);
      if (actualChecksumsForSource && actualChecksumsForSource.size !== expectedChecksumsForSource.size) changedCount += 1;
      else if (actualChecksumsForSource && Array.from(actualChecksumsForSource).some((checksum) => !expectedChecksumsForSource.has(checksum))) changedCount += 1;
    });
    checksumDigestExpected = sourceRowsDigest(expectedChecksums);
    versionDigestExpected = sourceRowsDigest(expectedVersionCanonicals);
  }
  const expectedCount = expected?.rowCount ?? expectedRows?.length;
  const expectedDistinctSourceCount = expected?.distinctSourceCount ?? (expectedRows ? expectedSources.size : undefined);
  const expectedDistinctVersionCount = expected?.distinctVersionCount ?? (expectedRows ? expectedVersions.size : undefined);
  checksumDigestExpected = expected?.checksumDigestSha256 ?? checksumDigestExpected;
  versionDigestExpected = expected?.versionDigestSha256 ?? versionDigestExpected;
  const checked = expected !== undefined;
  const parityPassed = !checked || (
    (expectedCount === undefined || expectedCount === rows.length)
    && (expectedDistinctSourceCount === undefined || expectedDistinctSourceCount === actualSources.size)
    && (expectedDistinctVersionCount === undefined || expectedDistinctVersionCount === actualVersions.size)
    && (expected?.checksumDigestSha256 === undefined || expected.checksumDigestSha256 === checksumDigestActual)
    && (expected?.versionDigestSha256 === undefined || expected.versionDigestSha256 === versionDigestActual)
    && missingCount === 0
    && unexpectedCount === 0
    && changedCount === 0
    && duplicateExpectedCount === 0
  );
  const base = {
    checked,
    passed: parityPassed && invalidIdentityCount === 0 && invalidChecksumCount === 0 && duplicateVersionRows === 0 && conflictingSourceCount === 0,
    expectedCount,
    actualCount: rows.length,
    expectedDistinctSourceCount,
    actualDistinctSourceCount: actualSources.size,
    expectedDistinctVersionCount,
    actualDistinctVersionCount: actualVersions.size,
    missingCount,
    unexpectedCount,
    changedCount,
    duplicateVersionRows,
    conflictingSourceCount,
    invalidIdentityCount,
    invalidChecksumCount,
    duplicateExpectedCount,
    checksumDigestExpected,
    checksumDigestActual,
    versionDigestExpected,
    versionDigestActual,
  } satisfies DatabaseAuditRestrictedSourceParity;
  if (!binary) return base;
  const expectedBinary = expected as DatabaseAuditExpectedRestrictedBinaries | undefined;
  const verifiedStatuses = new Set(["verified", "missing", "mismatch"]);
  const actualVerifiedCount = rows.filter((row) => row.verificationStatus === "verified").length;
  const actualMissingCount = rows.filter((row) => row.verificationStatus === "missing").length;
  const actualMismatchCount = rows.filter((row) => row.verificationStatus === "mismatch").length;
  const actualInvalidStatusCount = rows.filter((row) => !verifiedStatuses.has(row.verificationStatus ?? "")).length;
  const actualInvalidSizeCount = rows.filter((row) => row.sizeBytes === undefined || !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes ?? -1) < 0).length;
  const descriptorDigestActual = sourceRowsDigest(rows.map(restrictedDescriptorCanonical));
  const expectedDescriptorRows = expectedRows as RestrictedMetadataRow[] | undefined;
  const descriptorDigestExpected = expectedBinary?.descriptorDigestSha256 ?? (expectedDescriptorRows ? sourceRowsDigest(expectedDescriptorRows.map(restrictedDescriptorCanonical)) : undefined);
  const binaryExpectedValuesPass = !expectedBinary || (
    (expectedBinary.verifiedCount === undefined || expectedBinary.verifiedCount === actualVerifiedCount)
    && (expectedBinary.missingCount === undefined || expectedBinary.missingCount === actualMissingCount)
    && (expectedBinary.mismatchCount === undefined || expectedBinary.mismatchCount === actualMismatchCount)
    && (expectedBinary.invalidStatusCount === undefined || expectedBinary.invalidStatusCount === actualInvalidStatusCount)
    && (expectedBinary.invalidChecksumCount === undefined || expectedBinary.invalidChecksumCount === invalidChecksumCount)
    && (descriptorDigestExpected === undefined || descriptorDigestExpected === descriptorDigestActual)
  );
  return {
    ...base,
    passed: base.passed && binaryExpectedValuesPass && actualInvalidStatusCount === 0 && actualInvalidSizeCount === 0,
    expectedVerifiedCount: expectedBinary?.verifiedCount,
    actualVerifiedCount,
    expectedMissingCount: expectedBinary?.missingCount,
    actualMissingCount,
    expectedMismatchCount: expectedBinary?.mismatchCount,
    actualMismatchCount,
    expectedInvalidStatusCount: expectedBinary?.invalidStatusCount,
    actualInvalidStatusCount,
    expectedInvalidChecksumCount: expectedBinary?.invalidChecksumCount,
    descriptorDigestExpected,
    descriptorDigestActual,
  };
}

async function runAuditQueries(executor: RentOpsQueryExecutor, asOfDate: string): Promise<{
  counts: DatabaseAuditCounts;
  totals: DatabaseAuditTotals;
  orphans: DatabaseAuditViolations;
  allocations: DatabaseAuditViolations;
  ledger: DatabaseAuditViolations;
  duplicates: DatabaseAuditViolations;
  dates: DatabaseAuditViolations;
  properties: DatabaseAuditPropertyControl[];
  report: DatabaseAuditReportParity;
  financialReport: DatabaseAuditFinancialReportControl[];
  fidelity: Record<string, number>;
  sourceRows: Record<string, unknown>[];
  restrictedSourcePayloadRows: Record<string, unknown>[];
  restrictedSourceBinaryRows: Record<string, unknown>[];
}> {
  const [countResult, totalsResult, orphanResult, allocationResult, ledgerResult, duplicateResult, dateResult, propertyResult, sourceResult, sourcePayloadResult, sourceBinaryResult, reportResult, financialReportResult, fidelityResult] = await Promise.all([
    executor.query(DATABASE_AUDIT_SQL.counts),
    executor.query(DATABASE_AUDIT_SQL.totals),
    executor.query(DATABASE_AUDIT_SQL.orphans),
    executor.query(DATABASE_AUDIT_SQL.allocationInvariants),
    executor.query(DATABASE_AUDIT_SQL.ledgerInvariants),
    executor.query(DATABASE_AUDIT_SQL.duplicates),
    executor.query(DATABASE_AUDIT_SQL.dates),
    executor.query(DATABASE_AUDIT_SQL.propertyControls, [asOfDate]),
    executor.query(DATABASE_AUDIT_SQL.sourceRecords),
    executor.query(DATABASE_AUDIT_SQL.sourcePayloadMetadata),
    executor.query(DATABASE_AUDIT_SQL.sourceBinaryMetadata),
    executor.query(DATABASE_AUDIT_SQL.reportParity, [asOfDate]),
    executor.query(DATABASE_AUDIT_SQL.financialReportV8, [asOfDate]),
    executor.query(DATABASE_AUDIT_SQL.fidelityControls, [asOfDate]),
  ]);
  return {
    counts: mapCounts(countResult.rows),
    totals: mapTotals(totalsResult.rows[0] ?? {}),
    orphans: violationSummary( (orphanResult.rows[0] ?? {}) as Record<string, unknown>),
    allocations: invariantSummary(allocationResult.rows as Record<string, unknown>[], "allocation_invariant_query_invalid"),
    ledger: invariantSummary(ledgerResult.rows as Record<string, unknown>[], "ledger_invariant_query_invalid"),
    duplicates: violationSummary((duplicateResult.rows[0] ?? {}) as Record<string, unknown>),
    dates: violationSummary((dateResult.rows[0] ?? {}) as Record<string, unknown>),
    properties: propertyResult.rows.map((row) => mapProperty(row as Record<string, unknown>)),
    report: mapReportParity((reportResult.rows[0] ?? {}) as Record<string, unknown>),
    financialReport: financialReportResult.rows.map((row) => mapFinancialReport(row as Record<string, unknown>)),
    fidelity: mapFidelityControls((fidelityResult.rows[0] ?? {}) as Record<string, unknown>),
    sourceRows: sourceResult.rows as Record<string, unknown>[],
    restrictedSourcePayloadRows: sourcePayloadResult.rows as Record<string, unknown>[],
    restrictedSourceBinaryRows: sourceBinaryResult.rows as Record<string, unknown>[],
  };
}

function controlReasons<T extends number>(prefix: string, controls: Partial<Record<string, DatabaseAuditControl<T>>>): string[] {
  const reasons: string[] = [];
  Object.keys(controls).forEach((key) => { if (!controls[key]?.passed) reasons.push(`${prefix}_${key}_mismatch`); });
  return reasons;
}

const FINANCIAL_REPORT_FIELDS: (keyof Omit<DatabaseAuditFinancialReportControl, "propertyKey">)[] = [
  "sourceRowCount", "knownCount", "knownCents", "uncertainCount", "uncertainCents", "unassignedCount", "unassignedCents",
  "notApplicableCount", "notApplicableCents",
  "suppressedCount", "suppressedCents", "endedCount", "endedCents", "inactiveCount", "inactiveCents", "futureCount", "futureCents",
  "unknownAmountCount", "unknownAmountCents", "invalidCount", "invalidCents", "propertyOnceCount", "propertyOnceCents", "formerTenancyLeakageCount",
];

function financialReportFieldReason(prefix: string, field: string): string[] {
  const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return [`${prefix}_${field}_mismatch`, `${prefix}_${snake}_mismatch`];
}

function compareFinancialReportControls(
  actual: readonly DatabaseAuditFinancialReportControl[],
  expected: DatabaseAuditExpectedFinancialReport | undefined,
): { controls: DatabaseAuditFinancialReportControl[]; reasons: string[] } {
  const reasons: string[] = [];
  const actualByKey = new Map(actual.map((row) => [row.propertyKey, row]));
  const portfolio = actualByKey.get("portfolio");
  if (expected?.portfolio) {
    if (!portfolio) reasons.push("financial_report_portfolio_missing");
    else {
      for (const field of FINANCIAL_REPORT_FIELDS) {
        const expectedValue = expected.portfolio[field];
        if (expectedValue !== undefined && portfolio[field] !== expectedValue) reasons.push(...financialReportFieldReason("financial_report_portfolio", field));
      }
    }
  }
  if (expected?.perProperty) {
    const expectedKeys = new Set<string>();
    for (const expectedProperty of expected.perProperty) {
      const key = hashIdentifier(expectedProperty.propertyId);
      expectedKeys.add(key);
      const row = actualByKey.get(key);
      if (!row) { reasons.push("financial_report_property_missing"); continue; }
      for (const field of FINANCIAL_REPORT_FIELDS) {
        const expectedValue = expectedProperty[field];
        if (expectedValue !== undefined && row[field] !== expectedValue) reasons.push(...financialReportFieldReason("financial_report_property", field));
      }
    }
    actual.filter((row) => row.propertyKey !== "portfolio").forEach((row) => {
      if (!expectedKeys.has(row.propertyKey)) reasons.push("financial_report_property_unexpected");
    });
  }
  for (const row of actual) {
    // unknownAmountCount is a diagnostic that may overlap any semantic
    // bucket; it is not an exclusive conservation bucket.
    const bucketCount = row.knownCount + row.uncertainCount + row.unassignedCount + row.notApplicableCount + row.suppressedCount
      + row.endedCount + row.inactiveCount + row.futureCount + row.invalidCount;
    if (bucketCount !== row.sourceRowCount) reasons.push("financial_report_bucket_conservation_failed");
    if (row.formerTenancyLeakageCount > 0) reasons.push("financial_report_former_tenancy_leakage");
  }
  return { controls: actual.slice(), reasons: Array.from(new Set(reasons)) };
}

function comparePropertyControls(actual: readonly DatabaseAuditPropertyControl[], expected: readonly DatabaseAuditExpectedProperty[] | undefined): { controls: DatabaseAuditPropertyControl[]; reasons: string[] } {
  if (!expected) return { controls: actual.slice(), reasons: ["per_property_controls_not_supplied"] };
  const actualByKey = new Map(actual.map((row) => [row.propertyKey, row]));
  const reasons: string[] = [];
  expected.forEach((expectedProperty) => {
    const key = hashIdentifier(expectedProperty.propertyId);
    const row = actualByKey.get(key);
    if (!row) { reasons.push("per_property_missing"); return; }
    const expectedValues: Partial<Record<keyof DatabaseAuditPropertyControl, number>> = {
      unitCount: expectedProperty.unitCount,
      currentOccupiedUnits: expectedProperty.currentOccupiedUnits,
      futurePreleasedUnits: expectedProperty.futurePreleasedUnits,
      chargeCount: expectedProperty.chargeCount,
      paymentCount: expectedProperty.paymentCount,
      creditCount: expectedProperty.creditCount,
      chargesCents: expectedProperty.chargesCents,
      paymentsCents: expectedProperty.paymentsCents,
      creditsCents: expectedProperty.creditsCents,
      allocationsCents: expectedProperty.allocationsCents,
      depositsCents: expectedProperty.depositsCents,
      activeHapContracts: expectedProperty.activeHapContracts,
      hapAgencyCents: expectedProperty.hapAgencyCents,
      hapTenantCents: expectedProperty.hapTenantCents,
    };
    Object.keys(expectedValues).forEach((field) => {
      const expectedValue = expectedValues[field as keyof DatabaseAuditPropertyControl];
      if (expectedValue !== undefined && row[field as keyof DatabaseAuditPropertyControl] !== expectedValue) reasons.push("per_property_value_mismatch");
    });
  });
  const expectedKeys = new Set(expected.map((row) => hashIdentifier(row.propertyId)));
  actual.forEach((row) => { if (!expectedKeys.has(row.propertyKey)) reasons.push("per_property_unexpected"); });
  return { controls: actual.slice(), reasons: Array.from(new Set(reasons)) };
}

/**
 * Runs a coherent read-only audit. By default expected controls are required;
 * callers may explicitly set requireExpectedControls to false for an
 * observational count/control read, which must not be mistaken for source
 * reconciliation proof.
 */
export async function runDatabaseAudit(
  executor: RentOpsQueryExecutor,
  options: { asOfDate: string; expected?: DatabaseAuditExpected; requireExpectedControls?: boolean } ,
): Promise<DatabaseAuditResult> {
  const asOfDate = options.asOfDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new DatabaseAuditError(["audit_as_of_date_invalid"]);
  const execute = async (readExecutor: RentOpsQueryExecutor): Promise<DatabaseAuditResult> => {
    let schemaResult: { rows: { table_name: string }[] };
    try {
      schemaResult = await readExecutor.query<{ table_name: string }>(DATABASE_AUDIT_SQL.schema, [Array.from(RENT_OPS_AUDIT_REQUIRED_TABLES)]);
    } catch {
      throw new DatabaseAuditError(["required_schema_missing"]);
    }
    const found = new Set(schemaResult.rows.map((row) => row.table_name));
    const missing = RENT_OPS_AUDIT_REQUIRED_TABLES.filter((tableName) => !found.has(tableName));
    if (missing.length > 0) throw new DatabaseAuditError(["required_schema_missing"]);
    let actual: Awaited<ReturnType<typeof runAuditQueries>>;
    try {
      actual = await runAuditQueries(readExecutor, asOfDate);
    } catch (error) {
      if (error instanceof DatabaseAuditError) throw error;
      throw new DatabaseAuditError(["audit_query_failed"]);
    }
    const expected = options.expected;
    const countControls: Partial<Record<keyof DatabaseAuditCounts, DatabaseAuditControl<number>>> = {};
    COUNT_KEYS.forEach((key) => { countControls[key] = compareControls(actual.counts[key] ?? 0, expected?.counts?.[key]); });
    const totalControls: Partial<Record<keyof DatabaseAuditTotals, DatabaseAuditControl<number>>> = {};
    TOTAL_KEYS.forEach((key) => { totalControls[key] = compareControls(actual.totals[key] ?? 0, expected?.totalsCents?.[key]); });
    const reportControls: Partial<Record<keyof DatabaseAuditReportParity, DatabaseAuditControl<number>>> = {};
    REPORT_KEYS.forEach((key) => { reportControls[key] = compareControls(actual.report[key] ?? 0, expected?.reportParity?.[key]); });
    const financialReportComparison = compareFinancialReportControls(actual.financialReport, expected?.financialReport ?? expected?.financialReportV8);
    const fidelityExpectedReasons: string[] = [];
    for (const [key, expectedValue] of Object.entries(expected?.fidelityControls ?? {})) {
      if (actual.fidelity[key] !== expectedValue) fidelityExpectedReasons.push(`fidelity_${key}_mismatch`);
    }
    const fidelityViolationReasons = FIDELITY_VIOLATION_KEYS.filter((key) => (actual.fidelity[key] ?? 0) > 0).map((key) => `fidelity_${key}`);
    const sourceParityResult = sourceParity(expected?.sourceRecords, actual.sourceRows);
    const restrictedSourcePayloadParity = restrictedSourceParity(expected?.restrictedSourcePayloads, actual.restrictedSourcePayloadRows, false) as DatabaseAuditRestrictedSourceParity;
    const restrictedSourceBinaryParity = restrictedSourceParity(expected?.restrictedSourceBinaries, actual.restrictedSourceBinaryRows, true) as DatabaseAuditRestrictedBinaryParity;
    const propertyComparison = comparePropertyControls(actual.properties, expected?.perProperty);
    const requireExpected = options.requireExpectedControls !== false;
    const blockingReasons: string[] = [];
    blockingReasons.push(...controlReasons("count", countControls as Partial<Record<string, DatabaseAuditControl<number>>>));
    blockingReasons.push(...controlReasons("total", totalControls as Partial<Record<string, DatabaseAuditControl<number>>>));
    blockingReasons.push(...controlReasons("report", reportControls as Partial<Record<string, DatabaseAuditControl<number>>>));
    blockingReasons.push(...financialReportComparison.reasons);
    blockingReasons.push(...fidelityExpectedReasons, ...fidelityViolationReasons);
    if (actual.orphans.total > 0) blockingReasons.push("orphans_present");
    if (actual.allocations.total > 0) blockingReasons.push("allocation_invariants_failed");
    if (actual.ledger.total > 0) blockingReasons.push("ledger_invariants_failed");
    if (actual.duplicates.total > 0) blockingReasons.push("duplicates_present");
    if (actual.dates.total > 0) blockingReasons.push("date_conflicts_present");
    if (!sourceParityResult.passed) blockingReasons.push("raw_source_hash_parity_failed");
    if (!restrictedSourcePayloadParity.passed) blockingReasons.push("restricted_source_payload_integrity_or_parity_failed");
    if (!restrictedSourceBinaryParity.passed) blockingReasons.push("restricted_source_binary_integrity_or_parity_failed");
    if (propertyComparison.reasons.length > 0) blockingReasons.push(...propertyComparison.reasons);
    if (requireExpected && !expected?.counts) blockingReasons.push("expected_counts_not_supplied");
    if (requireExpected && !expected?.totalsCents) blockingReasons.push("expected_totals_not_supplied");
    if (requireExpected && !expected?.sourceRecords) blockingReasons.push("expected_source_records_not_supplied");
    if (requireExpected && !expected?.restrictedSourcePayloads) blockingReasons.push("expected_restricted_source_payloads_not_supplied");
    if (requireExpected && !expected?.restrictedSourceBinaries) blockingReasons.push("expected_restricted_source_binaries_not_supplied");
    if (requireExpected && !expected?.reportParity) blockingReasons.push("expected_report_parity_not_supplied");
    if (requireExpected && !expected?.perProperty) blockingReasons.push("expected_per_property_not_supplied");
    return {
      asOfDate,
      passed: blockingReasons.length === 0,
      blockingReasons: Array.from(new Set(blockingReasons)),
      counts: actual.counts,
      countControls,
      totalsCents: actual.totals,
      totalControls,
      orphanChecks: actual.orphans,
      allocationChecks: actual.allocations,
      ledgerChecks: actual.ledger,
      duplicateChecks: actual.duplicates,
      dateChecks: actual.dates,
      perProperty: propertyComparison.controls,
      reportParity: actual.report,
      reportControls,
      financialReport: financialReportComparison.controls,
      fidelityControls: actual.fidelity,
      rawSourceHashParity: sourceParityResult,
      restrictedSourcePayloadParity,
      restrictedSourceBinaryParity,
    };
  };
  try {
    if (executor.transaction) return await executor.transaction((readExecutor) => execute(readExecutor), { readOnly: true });
    return await execute(executor);
  } catch (error) {
    if (error instanceof DatabaseAuditError) throw error;
    throw new DatabaseAuditError(["audit_query_failed"]);
  }
}
