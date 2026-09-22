-- Candidate schema for dated, provider-Account-scoped accounting purpose
-- evidence. Root assigns the migration number after review; this file is not
-- part of the ordered migration chain until then.

CREATE TABLE accounting_qbo_purpose_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  provider_account_id varchar(200) NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
  purpose text NOT NULL CHECK (purpose IN ('capital_contribution','distribution','principal','interest','expense','rent_receipt')),
  effective_from date NOT NULL,
  effective_to date,
  account_source_version varchar(120) NOT NULL CHECK (length(btrim(account_source_version)) > 0),
  account_type varchar(120) NOT NULL CHECK (length(btrim(account_type)) > 0),
  account_subtype varchar(120),
  review_evidence text NOT NULL CHECK (length(btrim(review_evidence)) BETWEEN 1 AND 1000),
  reviewed_by varchar(200) NOT NULL CHECK (length(btrim(reviewed_by)) > 0),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, provider_account_id, effective_from),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX accounting_qbo_purpose_mappings_lookup
  ON accounting_qbo_purpose_mappings
    (organization_id, legal_entity_id, environment, realm_id, provider_account_id, effective_from DESC);

-- Prevent overlapping effective periods for one scoped provider Account. The
-- advisory lock makes the check serialize concurrent first inserts for the
-- same scope/account even when no existing mapping row can be locked.
CREATE OR REPLACE FUNCTION accounting_qbo_purpose_mapping_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(
    NEW.organization_id::text || ':' || NEW.legal_entity_id::text || ':' ||
    NEW.environment || ':' || NEW.realm_id || ':' || NEW.provider_account_id
  ));
  IF EXISTS (
    SELECT 1
      FROM accounting_qbo_purpose_mappings existing
     WHERE existing.organization_id = NEW.organization_id
       AND existing.legal_entity_id = NEW.legal_entity_id
       AND existing.environment = NEW.environment
       AND existing.realm_id = NEW.realm_id
       AND existing.provider_account_id = NEW.provider_account_id
       AND existing.effective_from < COALESCE(NEW.effective_to, DATE '9999-12-31')
       AND COALESCE(existing.effective_to, DATE '9999-12-31') > NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'accounting purpose mapping periods overlap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_qbo_purpose_mapping_no_overlap_trigger
  BEFORE INSERT ON accounting_qbo_purpose_mappings
  FOR EACH ROW EXECUTE FUNCTION accounting_qbo_purpose_mapping_no_overlap();
