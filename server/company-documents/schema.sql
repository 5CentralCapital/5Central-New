-- Candidate company document schema. Root integration registers this after
-- company foundation and the investor/project schemas. It is never applied
-- by application startup.

CREATE TABLE company_documents (
  id varchar(160) PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid,
  property_id varchar(160),
  project_id uuid,
  investor_contract_id uuid,
  investor_contract_version_id uuid,
  kind text NOT NULL CHECK (kind IN ('contract','loan','insurance','investor_agreement','project_estimate','project_invoice','tax','formation','policy','other')),
  state text NOT NULL CHECK (state IN ('verified','archived')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  description text,
  document_date date,
  tags text[] NOT NULL DEFAULT '{}',
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 240),
  declared_content_type text NOT NULL CHECK (length(btrim(declared_content_type)) BETWEEN 1 AND 120),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  backend text NOT NULL CHECK (length(btrim(backend)) > 0),
  logical_key text NOT NULL CHECK (logical_key = 'sha256:' || checksum_sha256),
  immutable_generation text,
  immutable_version text,
  verified_at timestamptz NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (property_id) REFERENCES rent_ops_properties(id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, investor_contract_id)
    REFERENCES company_investor_contracts(organization_id, id),
  FOREIGN KEY (organization_id, investor_contract_id, investor_contract_version_id)
    REFERENCES company_investor_contract_versions(organization_id, contract_id, id),
  CHECK (immutable_generation IS NOT NULL OR immutable_version IS NOT NULL),
  CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
  CHECK (property_id IS NULL OR legal_entity_id IS NOT NULL),
  CHECK (investor_contract_version_id IS NULL OR investor_contract_id IS NOT NULL),
  UNIQUE (organization_id, id)
);

CREATE INDEX company_documents_scope_updated
  ON company_documents (organization_id, legal_entity_id, property_id, updated_at DESC, id DESC)
  WHERE state <> 'archived';
CREATE INDEX company_documents_contract
  ON company_documents (organization_id, investor_contract_id, investor_contract_version_id)
  WHERE state <> 'archived';
CREATE INDEX company_documents_content
  ON company_documents (organization_id, checksum_sha256);

CREATE TABLE company_document_links (
  document_id varchar(160) NOT NULL REFERENCES company_documents(id),
  link_kind text NOT NULL CHECK (link_kind IN ('organization','legal_entity','property','project','investor_contract','investor_contract_version')),
  linked_id varchar(160) NOT NULL CHECK (length(btrim(linked_id)) > 0),
  linked_label text NOT NULL CHECK (length(btrim(linked_label)) BETWEEN 1 AND 240),
  linked_version_id varchar(160) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, link_kind, linked_id, linked_version_id)
);
CREATE INDEX company_document_links_target
  ON company_document_links (link_kind, linked_id, document_id);

-- A staged upload is the server-owned handoff between verified bytes and the
-- durable company command. It is bound to the authenticated actor, company
-- context, checksum, and immutable object version; callers never manufacture
-- a prepared binding from a raw document ID.
CREATE TABLE company_document_upload_stages (
  stage_id varchar(160) PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  document_id varchar(160) NOT NULL,
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  logical_key text NOT NULL CHECK (logical_key = 'sha256:' || checksum_sha256),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  immutable_generation text,
  immutable_version text,
  prepared_document jsonb NOT NULL,
  prepared_binding jsonb NOT NULL,
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','committed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (organization_id, actor_id, stage_id),
  UNIQUE (organization_id, actor_id, document_id),
  CHECK (immutable_generation IS NOT NULL OR immutable_version IS NOT NULL),
  CHECK ((state = 'committed') = (consumed_at IS NOT NULL))
);
CREATE INDEX company_document_upload_stages_actor
  ON company_document_upload_stages (organization_id, actor_id, state, created_at DESC);

CREATE FUNCTION company_guard_document_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_document_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.investor_contract_id IS DISTINCT FROM OLD.investor_contract_id
      OR NEW.investor_contract_version_id IS DISTINCT FROM OLD.investor_contract_version_id
      OR NEW.file_name IS DISTINCT FROM OLD.file_name
      OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
      OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
      OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
      OR NEW.backend IS DISTINCT FROM OLD.backend
      OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
      OR NEW.immutable_generation IS DISTINCT FROM OLD.immutable_generation
      OR NEW.immutable_version IS DISTINCT FROM OLD.immutable_version
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    ) THEN
    RAISE EXCEPTION 'company_document_verified_source_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_documents_source_guard
  BEFORE UPDATE OR DELETE ON company_documents
  FOR EACH ROW EXECUTE FUNCTION company_guard_document_source();
