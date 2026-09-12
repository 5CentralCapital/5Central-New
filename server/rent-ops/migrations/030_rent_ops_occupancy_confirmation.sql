-- A dated observation establishes occupancy from observation onward, not move-in history.
ALTER TABLE rent_ops_tenancies ADD COLUMN occupancy_confirmed_on date;
ALTER TABLE rent_ops_tenancies ADD COLUMN occupancy_confirmation_knowledge text;
ALTER TABLE rent_ops_tenancies ADD CONSTRAINT rent_ops_occupancy_confirmation_check CHECK (
  (occupancy_confirmed_on IS NULL AND occupancy_confirmation_knowledge IS NULL)
  OR (occupancy_confirmed_on IS NOT NULL AND occupancy_confirmation_knowledge = 'manual') IS TRUE
);
ALTER TABLE rent_ops_tenancies ADD COLUMN operational_end_confirmed_on date;
ALTER TABLE rent_ops_tenancies ADD COLUMN operational_end_confirmation_knowledge text;
ALTER TABLE rent_ops_tenancies ADD CONSTRAINT rent_ops_operational_end_confirmation_check CHECK (
  (operational_end_confirmed_on IS NULL AND operational_end_confirmation_knowledge IS NULL)
  OR (operational_end_confirmed_on IS NOT NULL AND operational_end_confirmation_knowledge = 'manual') IS TRUE
);
ALTER TABLE rent_ops_units ADD COLUMN vacancy_confirmed_on date;
ALTER TABLE rent_ops_units ADD COLUMN vacancy_confirmation_knowledge text;
ALTER TABLE rent_ops_units ADD CONSTRAINT rent_ops_vacancy_confirmation_check CHECK (
  (vacancy_confirmed_on IS NULL AND vacancy_confirmation_knowledge IS NULL)
  OR (vacancy_confirmed_on IS NOT NULL AND vacancy_confirmation_knowledge = 'manual') IS TRUE
);
DROP INDEX rent_ops_tenancies_current_notice_unit_unique;
CREATE UNIQUE INDEX rent_ops_tenancies_current_notice_unit_unique ON rent_ops_tenancies(unit_id)
  WHERE status IN ('current', 'notice') AND operational_end_confirmed_on IS NULL;
DO $$
DECLARE prior_check text;
DECLARE updated_check text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior_check FROM pg_constraint
    WHERE conrelid = 'rent_ops_record_changes'::regclass AND conname = 'rent_ops_record_changes_changed_fields_check';
  IF prior_check IS NULL THEN RAISE EXCEPTION 'record change field guard missing'; END IF;
  updated_check := replace(prior_check, '''actualMoveOutOn''::text', '''vacancyConfirmedOn''::text, ''operationalEndConfirmedOn''::text, ''actualMoveOutOn''::text');
  IF updated_check = prior_check THEN RAISE EXCEPTION 'actual departure audit field guard missing'; END IF;
  ALTER TABLE rent_ops_record_changes DROP CONSTRAINT rent_ops_record_changes_changed_fields_check;
  EXECUTE 'ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_changed_fields_check ' || updated_check;
END $$;
-- Keep account identity and credentials immutable during an explicitly audited
-- same-person operational tenancy transfer; existing sessions must expire.
CREATE OR REPLACE FUNCTION rent_ops_guard_tenant_account_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'rent_ops_tenant_account_identity_is_immutable';
  END IF;
  IF NEW.tenancy_id IS DISTINCT FROM OLD.tenancy_id THEN
    IF NEW.session_version <> OLD.session_version + 1
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.activation_token_hash IS DISTINCT FROM OLD.activation_token_hash
       OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.last_login_at IS DISTINCT FROM OLD.last_login_at
       OR NOT EXISTS (
         SELECT 1 FROM rent_ops_tenancies prior
         JOIN rent_ops_tenancies next ON next.id = NEW.tenancy_id
         JOIN rent_ops_units prior_unit ON prior_unit.id = prior.unit_id AND prior_unit.property_id = prior.property_id
         JOIN rent_ops_units next_unit ON next_unit.id = next.unit_id AND next_unit.property_id = next.property_id
         JOIN rent_ops_activity_events audit ON audit.person_id = NEW.person_id AND audit.tenancy_id = NEW.tenancy_id
         WHERE prior.id = OLD.tenancy_id
           AND prior.primary_person_id = NEW.person_id AND next.primary_person_id = NEW.person_id
           AND prior.property_id = next.property_id AND prior.unit_id <> next.unit_id
           AND prior.operational_end_confirmation_knowledge = 'manual'
           AND prior.operational_end_confirmed_on <= (NEW.updated_at AT TIME ZONE 'America/New_York')::date
           AND next.status = 'current' AND next.status_knowledge = 'manual'
           AND next.occupancy_confirmation_knowledge = 'manual'
           AND next.occupancy_confirmed_on = prior.operational_end_confirmed_on
           AND next.operational_end_confirmed_on IS NULL
           AND prior.primary_person_link_knowledge IN ('exact','manual')
           AND next.primary_person_link_knowledge IN ('exact','manual')
           AND prior.property_link_knowledge IN ('exact','manual') AND next.property_link_knowledge IN ('exact','manual')
           AND prior.unit_link_knowledge IN ('exact','manual') AND next.unit_link_knowledge IN ('exact','manual')
           AND prior_unit.property_link_knowledge IN ('exact','manual') AND next_unit.property_link_knowledge IN ('exact','manual')
           AND audit.type = 'system' AND length(btrim(audit.actor)) > 0 AND audit.occurred_at = NEW.updated_at
           AND audit.metadata->>'action' = 'tenant_account_tenancy_transfer'
           AND audit.metadata->>'accountId' = NEW.id
           AND audit.metadata->>'personId' = NEW.person_id
           AND audit.metadata->>'oldTenancyId' = OLD.tenancy_id
           AND audit.metadata->>'newTenancyId' = NEW.tenancy_id
           AND audit.metadata->>'expectedSessionVersion' = OLD.session_version::text
       ) THEN
      RAISE EXCEPTION 'rent_ops_tenant_account_identity_is_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (30, '__RENT_OPS_V30_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=30 AND checksum_sha256='__RENT_OPS_V30_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v30_post_insert_checksum_guard;
