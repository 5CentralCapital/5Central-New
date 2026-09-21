-- Additive company foundation. Existing rental IDs and financial history stay intact.
-- Dates use [effective_from, effective_until): the end date is exclusive.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 30 AND checksum_sha256 = '__RENT_OPS_V30_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_foundation_predecessor_guard;

CREATE TABLE company_organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE company_legal_entities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  entity_type text NOT NULL CHECK (entity_type IN ('llc','corporation','partnership','individual','other','unknown')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id)
);
CREATE INDEX company_legal_entities_org_name ON company_legal_entities (organization_id, lower(name), id);

CREATE TABLE company_contacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  kind text NOT NULL CHECK (kind IN ('person','organization')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  rent_ops_person_id varchar(160) REFERENCES rent_ops_people(id),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, rent_ops_person_id),
  CHECK (rent_ops_person_id IS NULL OR kind = 'person')
);
CREATE INDEX company_contacts_org_name ON company_contacts (organization_id, lower(display_name), id);

CREATE TABLE company_contact_roles (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  contact_id uuid NOT NULL,
  legal_entity_id uuid,
  role text NOT NULL CHECK (role IN ('owner','investor','vendor','employee','tenant','property_manager','lender','agency','professional')),
  effective_from date NOT NULL,
  effective_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  FOREIGN KEY (organization_id, contact_id) REFERENCES company_contacts(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE UNIQUE INDEX company_contact_roles_identity ON company_contact_roles (
  organization_id, contact_id, role, coalesce(legal_entity_id::text, ''), effective_from
);

-- This selects the property's legal accounting entity over time. Beneficial
-- investor ownership is a separate domain and may have multiple members.
CREATE TABLE company_property_entity_periods (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  effective_from date NOT NULL,
  effective_until date,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX company_property_entity_lookup ON company_property_entity_periods (property_id, effective_from, effective_until);
CREATE INDEX company_entity_property_lookup ON company_property_entity_periods (organization_id, legal_entity_id, property_id);

CREATE FUNCTION company_guard_property_entity_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A no-op UPDATE creates a tuple fence even for the first assignment.
  -- Unlike SELECT FOR UPDATE alone, this forces a stale REPEATABLE READ
  -- transaction to retry instead of checking overlap against an old snapshot.
  UPDATE rent_ops_properties SET record_revision = record_revision WHERE id = NEW.property_id;
  IF EXISTS (
    SELECT 1 FROM company_property_entity_periods existing
    WHERE existing.property_id = NEW.property_id AND existing.id <> NEW.id
      AND daterange(existing.effective_from, existing.effective_until, '[)')
          && daterange(NEW.effective_from, NEW.effective_until, '[)')
  ) THEN
    RAISE EXCEPTION 'company_property_entity_period_overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_property_entity_period_guard
BEFORE INSERT OR UPDATE ON company_property_entity_periods
FOR EACH ROW EXECUTE FUNCTION company_guard_property_entity_period();

CREATE TABLE company_external_identities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid,
  provider text NOT NULL CHECK (provider IN ('qbo','rent_manager_archive','mra','plaid','ramp','airtable','workbook')),
  source_scope text NOT NULL CHECK (length(btrim(source_scope)) BETWEEN 1 AND 200),
  record_kind text NOT NULL CHECK (length(btrim(record_kind)) BETWEEN 1 AND 80),
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 200),
  local_kind text NOT NULL CHECK (length(btrim(local_kind)) BETWEEN 1 AND 80),
  local_id varchar(160) NOT NULL CHECK (length(btrim(local_id)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  UNIQUE (organization_id, provider, source_scope, record_kind, external_id),
  CHECK (provider <> 'qbo' OR legal_entity_id IS NOT NULL)
);
CREATE INDEX company_external_identity_local ON company_external_identities (organization_id, local_kind, local_id);

CREATE FUNCTION company_guard_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_identity_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR to_jsonb(NEW)->'organization_id' IS DISTINCT FROM to_jsonb(OLD)->'organization_id'
    OR TG_TABLE_NAME = 'company_external_identities' THEN
    RAISE EXCEPTION 'company_identity_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_property_entity_periods' AND (
    to_jsonb(NEW)->'property_id' IS DISTINCT FROM to_jsonb(OLD)->'property_id'
    OR to_jsonb(NEW)->'legal_entity_id' IS DISTINCT FROM to_jsonb(OLD)->'legal_entity_id'
  ) THEN
    RAISE EXCEPTION 'company_property_entity_identity_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_organization_identity BEFORE UPDATE OR DELETE ON company_organizations
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();
CREATE TRIGGER company_legal_entity_identity BEFORE UPDATE OR DELETE ON company_legal_entities
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();
CREATE TRIGGER company_contact_identity BEFORE UPDATE OR DELETE ON company_contacts
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();
CREATE TRIGGER company_contact_role_identity BEFORE UPDATE OR DELETE ON company_contact_roles
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();
CREATE TRIGGER company_property_period_identity BEFORE UPDATE OR DELETE ON company_property_entity_periods
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();
CREATE TRIGGER company_external_identity BEFORE UPDATE OR DELETE ON company_external_identities
FOR EACH ROW EXECUTE FUNCTION company_guard_identity();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (31, '__RENT_OPS_V31_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 31 AND checksum_sha256 = '__RENT_OPS_V31_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_foundation_checksum_guard;
