SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version=31 AND checksum_sha256='__RENT_OPS_V31_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_commands_predecessor_guard;

CREATE TABLE company_access_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  role text NOT NULL CHECK (role IN ('owner','admin','finance','operations_pm','project_manager','restricted_vendor','read_only_reviewer')),
  legal_entity_id uuid,
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id,id),
  CHECK (property_id IS NULL OR legal_entity_id IS NOT NULL)
);
CREATE UNIQUE INDEX company_active_grant_identity ON company_access_grants (
  organization_id, actor_id, role, coalesce(legal_entity_id::text,''), coalesce(property_id,'')
) WHERE revoked_at IS NULL;
CREATE INDEX company_access_grants_actor ON company_access_grants (actor_id, organization_id) WHERE revoked_at IS NULL;

CREATE TABLE company_command_receipts (
  operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid,
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  channel text NOT NULL CHECK (channel IN ('web','mac','codex_mcp')),
  command_kind varchar(120) NOT NULL CHECK (command_kind ~ '^[a-z][a-z0-9_.-]*$'),
  idempotency_key varchar(255) NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  payload_sha256 varchar(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,operation_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id,id),
  CHECK ((receipt IS NULL AND completed_at IS NULL)
    OR (receipt IS NOT NULL AND completed_at IS NOT NULL AND jsonb_typeof(receipt)='object'))
);

CREATE TABLE company_outbox (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  operation_id uuid NOT NULL,
  event_key varchar(255) NOT NULL CHECK (length(btrim(event_key)) > 0),
  topic varchar(120) NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.-]*$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  payload_sha256 varchar(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  UNIQUE (organization_id,event_key),
  FOREIGN KEY (organization_id,operation_id) REFERENCES company_command_receipts(organization_id,operation_id)
);
CREATE INDEX company_outbox_ready ON company_outbox (available_at,created_at,id) WHERE dispatched_at IS NULL;

CREATE FUNCTION company_guard_command_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'company_command_history_delete_forbidden' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='company_command_receipts' THEN
    IF OLD.receipt IS NOT NULL OR (to_jsonb(NEW)-'receipt'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'receipt'-'completed_at') THEN
      RAISE EXCEPTION 'company_command_history_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='company_outbox' THEN
    IF (to_jsonb(NEW)-'dispatched_at'-'available_at') IS DISTINCT FROM (to_jsonb(OLD)-'dispatched_at'-'available_at')
      OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at) THEN
      RAISE EXCEPTION 'company_outbox_event_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'company_access_grant_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_receipt_history BEFORE UPDATE OR DELETE ON company_command_receipts
FOR EACH ROW EXECUTE FUNCTION company_guard_command_history();
CREATE TRIGGER company_outbox_history BEFORE UPDATE OR DELETE ON company_outbox
FOR EACH ROW EXECUTE FUNCTION company_guard_command_history();
CREATE TRIGGER company_grant_history BEFORE UPDATE OR DELETE ON company_access_grants
FOR EACH ROW EXECUTE FUNCTION company_guard_command_history();

INSERT INTO rent_ops_schema_migrations(version,checksum_sha256) VALUES (32,'__RENT_OPS_V32_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version=32 AND checksum_sha256='__RENT_OPS_V32_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_commands_checksum_guard;
