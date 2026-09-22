-- Rent Operations schema v3 is additive. It preserves v1/v2 rows and adds
-- explicit unknown/link knowledge so a source row is never dropped merely
-- because RM omitted a field. The renderer fills all checksum tokens.

SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v2_checksum_guard;

ALTER TABLE rent_ops_properties ALTER COLUMN name DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN address_line1 DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN city DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN state DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN postal_code DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN property_type DROP NOT NULL;
ALTER TABLE rent_ops_properties ALTER COLUMN state_status DROP NOT NULL;
ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS name_knowledge text;
ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS address_knowledge text;
ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS property_type_knowledge text;
ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS state_knowledge text;
ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS operating_contact_knowledge text;

ALTER TABLE rent_ops_units ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE rent_ops_units ALTER COLUMN unit_number DROP NOT NULL;
ALTER TABLE rent_ops_units ALTER COLUMN readiness DROP NOT NULL;
ALTER TABLE rent_ops_units ALTER COLUMN listing DROP NOT NULL;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS unit_number_knowledge text;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS unit_type_knowledge text;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS readiness_knowledge text;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS listing_knowledge text;

ALTER TABLE rent_ops_people ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE rent_ops_people ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS phone_methods jsonb;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS first_name_knowledge text;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS last_name_knowledge text;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS email_knowledge text;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS phone_knowledge text;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS archived_knowledge text;
ALTER TABLE rent_ops_people ALTER COLUMN archived DROP NOT NULL;
ALTER TABLE rent_ops_people ALTER COLUMN archived DROP DEFAULT;

ALTER TABLE rent_ops_tenancies ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE rent_ops_tenancies ALTER COLUMN unit_id DROP NOT NULL;
ALTER TABLE rent_ops_tenancies ALTER COLUMN primary_person_id DROP NOT NULL;
ALTER TABLE rent_ops_tenancies ALTER COLUMN status DROP NOT NULL;
ALTER TABLE rent_ops_tenancies ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS planned_move_in_on date;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS unit_link_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS primary_person_link_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS status_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS planned_move_in_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS actual_move_in_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS notice_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS expected_move_out_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS actual_move_out_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS created_at_knowledge text;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS ended_at_knowledge text;

ALTER TABLE rent_ops_household_memberships ALTER COLUMN role DROP NOT NULL;
ALTER TABLE rent_ops_household_memberships ALTER COLUMN is_financially_responsible DROP NOT NULL;
ALTER TABLE rent_ops_household_memberships ADD COLUMN IF NOT EXISTS account_person_id text REFERENCES rent_ops_people(id);
ALTER TABLE rent_ops_household_memberships ADD COLUMN IF NOT EXISTS role_knowledge text;
ALTER TABLE rent_ops_household_memberships ADD COLUMN IF NOT EXISTS relationship_knowledge text;
ALTER TABLE rent_ops_household_memberships ADD COLUMN IF NOT EXISTS responsibility_knowledge text;

ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS charge_definition_knowledge text;

ALTER TABLE rent_ops_lease_terms ALTER COLUMN tenancy_id DROP NOT NULL;
ALTER TABLE rent_ops_lease_terms ALTER COLUMN status DROP NOT NULL;
ALTER TABLE rent_ops_lease_terms ALTER COLUMN contract_start_on DROP NOT NULL;
ALTER TABLE rent_ops_lease_terms ALTER COLUMN month_to_month DROP NOT NULL;
ALTER TABLE rent_ops_lease_terms ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS tenancy_link_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS status_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS contract_start_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS contract_end_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS signed_on_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS month_to_month_knowledge text;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS created_at_knowledge text;

ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN status DROP NOT NULL;
ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN amount_cents DROP NOT NULL;
ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN posted_on DROP NOT NULL;
ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN description DROP NOT NULL;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS unit_link_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS tenancy_link_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS person_link_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS amount_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS posted_on_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS due_on_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS description_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS status_knowledge text;
ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS allocation_mode text;

ALTER TABLE rent_ops_payment_allocations ALTER COLUMN payment_transaction_id DROP NOT NULL;
ALTER TABLE rent_ops_payment_allocations ALTER COLUMN charge_transaction_id DROP NOT NULL;
ALTER TABLE rent_ops_payment_allocations ALTER COLUMN amount_cents DROP NOT NULL;
ALTER TABLE rent_ops_payment_allocations ALTER COLUMN allocated_on DROP NOT NULL;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS payment_link_knowledge text;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS charge_link_knowledge text;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS amount_knowledge text;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS allocated_on_knowledge text;

ALTER TABLE rent_ops_security_deposits ALTER COLUMN type DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN disposition_status DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS person_link_knowledge text;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS type_knowledge text;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS disposition_status_knowledge text;
ALTER TABLE rent_ops_subsidy_contracts ALTER COLUMN status DROP NOT NULL;
ALTER TABLE rent_ops_subsidy_contracts ADD COLUMN IF NOT EXISTS status_knowledge text;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN description DROP NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN active DROP NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS description_knowledge text;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS active_knowledge text;

ALTER TABLE rent_ops_applications ALTER COLUMN source_type DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN status DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN email DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE rent_ops_applications ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS profile_answers jsonb;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS source_type_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS status_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS email_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS first_name_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS last_name_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS phone_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS unit_link_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS submitted_on_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS certification_accepted_on_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS created_at_knowledge text;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS updated_at_knowledge text;

ALTER TABLE rent_ops_documents ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE rent_ops_documents ALTER COLUMN mime_type DROP NOT NULL;
ALTER TABLE rent_ops_documents ALTER COLUMN storage_key DROP NOT NULL;
ALTER TABLE rent_ops_documents ALTER COLUMN uploaded_at DROP NOT NULL;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS availability text;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS storage_key_knowledge text;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS metadata_size_bytes integer;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS metadata_checksum_sha256 varchar(64);

ALTER TABLE rent_ops_activity_events ALTER COLUMN type DROP NOT NULL;
ALTER TABLE rent_ops_activity_events ALTER COLUMN occurred_at DROP NOT NULL;
ALTER TABLE rent_ops_activity_events ALTER COLUMN actor DROP NOT NULL;
ALTER TABLE rent_ops_activity_events ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS occurred_at_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS actor_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS summary_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS type_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS property_link_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS unit_link_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS person_link_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS tenancy_link_knowledge text;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS application_link_knowledge text;

-- Every source pair is established by the dedicated importer role and then
-- immutable.  Runtime/admin roles can update operational columns, but they
-- cannot forge a pair onto a native row or clear/change an imported pair.
-- Deployment grants INSERT/UPDATE on these source columns only to the
-- environment-specific importer roles; the trigger is a second fail-closed
-- boundary.  These names are the explicit deployment-security contract.
CREATE OR REPLACE FUNCTION rent_ops_guard_source_binding_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source_system IS NULL) <> (NEW.source_id IS NULL) THEN
    RAISE EXCEPTION 'source_system and source_id must be supplied together';
  END IF;
  IF NEW.source_system IS NOT NULL AND current_user NOT IN ('rent_ops_staging_importer', 'rent_ops_production_importer') THEN
    RAISE EXCEPTION 'only the configured Rent Ops importer role may establish imported source binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rent_ops_guard_source_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source_system IS NULL) <> (NEW.source_id IS NULL) THEN
    RAISE EXCEPTION 'source_system and source_id must be supplied together';
  END IF;
  IF OLD.source_system IS NOT NULL OR OLD.source_id IS NOT NULL THEN
    IF NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
      RAISE EXCEPTION 'imported source binding is immutable';
    END IF;
  ELSIF NEW.source_system IS NOT NULL AND current_user NOT IN ('rent_ops_staging_importer', 'rent_ops_production_importer') THEN
    RAISE EXCEPTION 'only the configured Rent Ops importer role may establish imported source binding';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'rent_ops_properties', 'rent_ops_units', 'rent_ops_people',
    'rent_ops_tenancies', 'rent_ops_lease_terms',
    'rent_ops_recurring_charge_schedules', 'rent_ops_ledger_transactions',
    'rent_ops_payment_allocations', 'rent_ops_security_deposits',
    'rent_ops_subsidy_contracts', 'rent_ops_applications',
    'rent_ops_documents', 'rent_ops_activity_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_source_binding_guard', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_source_binding_insert_guard', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_source_binding_insert()', table_name || '_source_binding_insert_guard', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_source_binding()', table_name || '_source_binding_guard', table_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_documents_v3_metadata_state') THEN
    ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_v3_metadata_state
      CHECK (availability IS NULL OR availability IN ('metadata', 'requested', 'unavailable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_ledger_amount_knowledge_check') THEN
    ALTER TABLE rent_ops_ledger_transactions ADD CONSTRAINT rent_ops_ledger_amount_knowledge_check
      CHECK (amount_knowledge IS NULL OR (amount_cents IS NOT NULL AND amount_knowledge = 'known') OR (amount_cents IS NULL AND amount_knowledge = 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_allocation_amount_knowledge_check') THEN
    ALTER TABLE rent_ops_payment_allocations ADD CONSTRAINT rent_ops_allocation_amount_knowledge_check
      CHECK (amount_knowledge IS NULL OR (amount_cents IS NOT NULL AND amount_knowledge = 'known') OR (amount_cents IS NULL AND amount_knowledge = 'unknown'));
  END IF;
END $$;

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (1, '__RENT_OPS_V1_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (2, '__RENT_OPS_V2_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (3, '__RENT_OPS_V3_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v3_post_insert_checksum_guard;
