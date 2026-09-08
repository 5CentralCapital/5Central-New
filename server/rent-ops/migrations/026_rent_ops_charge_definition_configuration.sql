ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN billing_frequency text;
ALTER TABLE rent_ops_recurring_charge_schedules ADD CONSTRAINT rent_ops_schedule_billing_frequency_check CHECK (billing_frequency IS NULL OR (billing_frequency='monthly' AND version_origin='manual'));
ALTER TABLE rent_ops_record_changes DROP CONSTRAINT rent_ops_record_changes_revision_check;
ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_revision_check CHECK (revision > 1 OR (revision = 1 AND entity_type IN ('recurring_schedule','charge_definition','person')));
-- Operator labels and availability are configuration. Category and source
-- provenance remain immutable. Apply after the schema-25 source import.
ALTER TABLE rent_ops_record_changes DROP CONSTRAINT rent_ops_record_changes_entity_type_check;
ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_entity_type_check CHECK (entity_type IN ('property','unit','person','household_membership','tenancy','lease_term','security_deposit','subsidy_contract','application','document','activity','recurring_schedule','charge_definition'));
DO $$
DECLARE prior_check text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior_check FROM pg_constraint WHERE conrelid='rent_ops_record_changes'::regclass AND conname='rent_ops_record_changes_changed_fields_check';
  prior_check := replace(prior_check, 'ARRAY[', 'ARRAY[''billingFrequency''::text,''phoneMethods''::text,');
  IF prior_check IS NULL THEN RAISE EXCEPTION 'record change field guard missing'; END IF;
  EXECUTE 'ALTER TABLE rent_ops_record_changes DROP CONSTRAINT rent_ops_record_changes_changed_fields_check';
  EXECUTE 'ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_changed_fields_check CHECK ((entity_type = ''charge_definition'' AND cardinality(changed_fields) BETWEEN 1 AND 3 AND changed_fields <@ ARRAY[''displayName'',''active'',''category'']::text[]) OR (entity_type <> ''charge_definition'' AND ' || substring(prior_check FROM 7) || '))';
END $$;
CREATE OR REPLACE FUNCTION rent_ops_validate_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sorted_fields text[];
  distinct_count integer;
  target_table text;
  target_revision integer;
BEGIN
  SELECT ARRAY_AGG(field ORDER BY field), COUNT(DISTINCT field)
    INTO sorted_fields, distinct_count
    FROM unnest(NEW.changed_fields) AS field;
  IF NEW.changed_fields IS DISTINCT FROM sorted_fields THEN
    RAISE EXCEPTION 'rent_ops_record_changes.changed_fields must be sorted';
  END IF;
  IF distinct_count <> cardinality(NEW.changed_fields) THEN
    RAISE EXCEPTION 'rent_ops_record_changes.changed_fields must be unique';
  END IF;
  target_table := CASE NEW.entity_type
    WHEN 'charge_definition' THEN 'rent_ops_charge_definitions'
    WHEN 'property' THEN 'rent_ops_properties'
    WHEN 'unit' THEN 'rent_ops_units'
    WHEN 'person' THEN 'rent_ops_people'
    WHEN 'household_membership' THEN 'rent_ops_household_memberships'
    WHEN 'tenancy' THEN 'rent_ops_tenancies'
    WHEN 'lease_term' THEN 'rent_ops_lease_terms'
    WHEN 'security_deposit' THEN 'rent_ops_security_deposits'
    WHEN 'subsidy_contract' THEN 'rent_ops_subsidy_contracts'
    WHEN 'application' THEN 'rent_ops_applications'
    WHEN 'document' THEN 'rent_ops_documents'
    WHEN 'activity' THEN 'rent_ops_activity_events'
    WHEN 'recurring_schedule' THEN 'rent_ops_recurring_charge_schedules'
  END;
  EXECUTE format('SELECT record_revision FROM %I WHERE id = $1', target_table) INTO target_revision USING NEW.target_id;
  IF target_revision IS NULL OR target_revision <> NEW.revision THEN
    RAISE EXCEPTION 'rent_ops_record_changes revision does not match target row';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rent_ops_guard_charge_definition_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'charge_definition_delete_forbidden'; END IF;
  IF (to_jsonb(NEW) - ARRAY['display_name','display_name_knowledge','active','active_knowledge','record_revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['display_name','display_name_knowledge','active','active_knowledge','record_revision','updated_at']) THEN RAISE EXCEPTION 'charge_definition_identity_and_category_immutable'; END IF;
  IF NEW.record_revision <> OLD.record_revision + 1 THEN RAISE EXCEPTION 'charge_definition_revision_required'; END IF;
  IF NEW.display_name IS DISTINCT FROM OLD.display_name AND (NEW.display_name IS NULL OR length(trim(NEW.display_name))=0 OR NEW.display_name_knowledge <> 'manual') THEN RAISE EXCEPTION 'charge_definition_manual_name_required'; END IF;
  IF NEW.active IS DISTINCT FROM OLD.active AND (NEW.active IS NULL OR NEW.active_knowledge <> 'manual') THEN RAISE EXCEPTION 'charge_definition_manual_active_required'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER rent_ops_charge_definitions_immutable_guard ON rent_ops_charge_definitions;
CREATE TRIGGER rent_ops_charge_definitions_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_charge_definitions FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_charge_definition_configuration();
CREATE OR REPLACE FUNCTION rent_ops_require_charge_definition_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rent_ops_record_changes WHERE entity_type='charge_definition' AND target_id=NEW.id AND revision=NEW.record_revision AND origin='admin' AND actor_subject IS NOT NULL) THEN RAISE EXCEPTION 'charge_definition_audit_required'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rent_ops_charge_definition_audit AFTER UPDATE ON rent_ops_charge_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rent_ops_require_charge_definition_audit();
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (26, '__RENT_OPS_V26_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=26 AND checksum_sha256='__RENT_OPS_V26_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v26_post_insert_checksum_guard;
