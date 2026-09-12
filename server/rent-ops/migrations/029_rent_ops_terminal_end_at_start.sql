-- Preserve all lineage guards; only terminal END may equal its direct predecessor start.
CREATE OR REPLACE FUNCTION rent_ops_guard_v8_schedule_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor rent_ops_recurring_charge_schedules%ROWTYPE;
  root_schedule rent_ops_recurring_charge_schedules%ROWTYPE;
BEGIN
  IF NEW.version_action = 'root' THEN
    IF NEW.lineage_root_id IS DISTINCT FROM NEW.id OR NEW.supersedes_id IS NOT NULL
       OR NEW.lineage_root_origin NOT IN ('artifact','manual')
       OR NEW.version_origin NOT IN ('artifact','manual') THEN
      RAISE EXCEPTION 'rent_ops_v8_root_incoherent';
    END IF;
    IF NEW.version_origin = 'artifact'
       AND (NEW.lineage_root_origin <> 'artifact' OR NEW.source_system IS NULL OR NEW.source_id IS NULL
         OR length(btrim(NEW.source_system)) = 0 OR length(btrim(NEW.source_id)) = 0) THEN
      RAISE EXCEPTION 'rent_ops_v8_artifact_root_provenance_required';
    END IF;
    IF NEW.version_origin = 'manual'
       AND (NEW.lineage_root_origin <> 'manual' OR NEW.source_system IS NOT NULL OR NEW.source_id IS NOT NULL) THEN
      RAISE EXCEPTION 'rent_ops_v8_manual_root_provenance_forbidden';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version_action NOT IN ('replace', 'end') OR NEW.version_origin <> 'manual' OR NEW.source_system IS NOT NULL OR NEW.source_id IS NOT NULL OR NEW.supersedes_id IS NULL OR NEW.effective_from IS NULL OR NEW.effective_from_knowledge <> 'manual' THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_predecessor_required';
  END IF;
  SELECT * INTO predecessor
  FROM rent_ops_recurring_charge_schedules
  WHERE id = NEW.supersedes_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_predecessor_missing';
  END IF;
  IF predecessor.version_action = 'end' THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_after_terminal_predecessor';
  END IF;
  SELECT * INTO root_schedule
  FROM rent_ops_recurring_charge_schedules
  WHERE id = NEW.lineage_root_id;
  IF NOT FOUND OR root_schedule.lineage_root_id IS DISTINCT FROM root_schedule.id THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_root_missing';
  END IF;
  IF root_schedule.source_artifact_sha256 IS DISTINCT FROM NEW.source_artifact_sha256
     OR root_schedule.artifact_observation_on IS DISTINCT FROM NEW.artifact_observation_on
     OR root_schedule.lineage_root_origin IS DISTINCT FROM NEW.lineage_root_origin THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_artifact_boundary_mismatch';
  END IF;
  IF predecessor.lineage_root_id IS DISTINCT FROM NEW.lineage_root_id
     OR (predecessor.effective_to IS NOT NULL AND NEW.effective_from > predecessor.effective_to)
     OR (predecessor.effective_from IS NOT NULL AND (NEW.effective_from < predecessor.effective_from OR (NEW.effective_from = predecessor.effective_from AND NEW.version_action <> 'end')))
     OR (NEW.effective_from = predecessor.effective_from AND NEW.version_action = 'end' AND root_schedule.lineage_root_origin = 'artifact'
       AND (root_schedule.artifact_observation_on IS NULL OR NEW.effective_from < root_schedule.artifact_observation_on))
     OR (predecessor.effective_from IS NULL AND (predecessor.effective_from_knowledge IS DISTINCT FROM 'unknown_open_start'
       OR NEW.effective_from_knowledge NOT IN ('source','manual')
       OR (root_schedule.lineage_root_origin = 'artifact'
         AND (root_schedule.artifact_observation_on IS NULL
           OR NEW.effective_from < root_schedule.artifact_observation_on
           OR NEW.source_artifact_sha256 IS NULL)))) THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_lineage_boundary_invalid';
  END IF;
  IF predecessor.scope_type IS DISTINCT FROM NEW.scope_type
     OR predecessor.scope_id IS DISTINCT FROM NEW.scope_id
     OR predecessor.scope_type_knowledge IS DISTINCT FROM NEW.scope_type_knowledge
     OR predecessor.scope_link_knowledge IS DISTINCT FROM NEW.scope_link_knowledge
     OR predecessor.tenancy_id IS DISTINCT FROM NEW.tenancy_id
     OR predecessor.person_id IS DISTINCT FROM NEW.person_id
     OR predecessor.property_id IS DISTINCT FROM NEW.property_id
     OR predecessor.unit_id IS DISTINCT FROM NEW.unit_id
     OR predecessor.charge_definition_id IS DISTINCT FROM NEW.charge_definition_id
     OR predecessor.charge_definition_key IS DISTINCT FROM NEW.charge_definition_key
     OR predecessor.charge_definition_knowledge IS DISTINCT FROM NEW.charge_definition_knowledge
     OR predecessor.charge_definition_link_knowledge IS DISTINCT FROM NEW.charge_definition_link_knowledge
     OR predecessor.category IS DISTINCT FROM NEW.category
     OR predecessor.category_knowledge IS DISTINCT FROM NEW.category_knowledge
     OR predecessor.description IS DISTINCT FROM NEW.description
     OR predecessor.description_knowledge IS DISTINCT FROM NEW.description_knowledge
     OR predecessor.source_confidence IS DISTINCT FROM NEW.source_confidence
     OR predecessor.source_artifact_sha256 IS DISTINCT FROM NEW.source_artifact_sha256
     OR predecessor.artifact_observation_on IS DISTINCT FROM NEW.artifact_observation_on
     OR predecessor.lineage_root_origin IS DISTINCT FROM NEW.lineage_root_origin
     OR predecessor.lineage_root_id IS DISTINCT FROM NEW.lineage_root_id THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_immutable_field_mutation';
  END IF;
  IF NEW.record_revision IS DISTINCT FROM predecessor.record_revision + 1 THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_revision_invalid';
  END IF;
  IF NEW.version_action = 'replace'
     AND (predecessor.effective_to IS DISTINCT FROM NEW.effective_to
       OR predecessor.active IS DISTINCT FROM NEW.active
       OR predecessor.active_knowledge IS DISTINCT FROM NEW.active_knowledge) THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_immutable_field_mutation';
  END IF;
  IF NEW.version_action = 'end'
     AND (NEW.amount_cents IS NOT NULL
       OR NEW.amount_knowledge IS DISTINCT FROM 'unknown'
       OR NEW.active IS DISTINCT FROM false
       OR NEW.active_knowledge IS DISTINCT FROM 'manual'
       OR NEW.effective_to IS DISTINCT FROM NEW.effective_from) THEN
    RAISE EXCEPTION 'rent_ops_v8_end_successor_terminal_fields_invalid';
  END IF;
  RETURN NEW;
END;
$$;
INSERT INTO rent_ops_schema_migrations(version,checksum_sha256) VALUES(29,'__RENT_OPS_V29_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=29 AND checksum_sha256='__RENT_OPS_V29_CHECKSUM__') THEN 1 ELSE 0 END;
