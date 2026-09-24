import {
  commandEnvelopeSchema,
  newPropertyId,
  newRecordId,
  recordReferenceIdSchema,
  revisionSchema,
  type CommandEnvelope,
  type OperationReceipt,
} from "../../shared/company";
import {
  PROPERTY_COMMAND_KINDS,
  propertyCommandPayloadSchemas,
  propertyPlanConvertPayloadSchema,
  propertySetupPayloadSchema,
  type PropertyCommandKind,
  type PropertyPlanConvertPayload,
  type PropertySetupPayload,
} from "../../shared/company/property-contracts";
import {
  authorizeCommand,
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "./authorization";
import {
  runCompanyCommand,
  type CommandHandlerContext,
  type CommandHandlerResult,
} from "./commands/runner";
import { ConflictCommandError, ValidationCommandError } from "./commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

type AnyPropertyCommandEnvelope = CommandEnvelope<Record<string, unknown>>;

export interface PropertyCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

const PROPERTY_SETUP_ROLES = ["owner", "admin", "operations_pm"] as const;

export const PROPERTY_COMMAND_POLICIES: Readonly<Record<PropertyCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "property.setup": {
    commandKind: "property.setup",
    allowedRoles: PROPERTY_SETUP_ROLES,
    requiredScope: "legal_entity",
  },
  "property.plan.convert": {
    commandKind: "property.plan.convert",
    allowedRoles: PROPERTY_SETUP_ROLES,
    requiredScope: "legal_entity",
  },
});

function savedResult(propertyId: string, associationId: string, associationType: "legal" | "planned"): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [propertyId, associationId],
    resultingRevisions: [
      { recordId: recordReferenceIdSchema.parse(propertyId), revision: revisionSchema.parse(1) },
      { recordId: recordReferenceIdSchema.parse(associationId), revision: revisionSchema.parse(1) },
    ],
    validationOutcomes: [{
      code: associationType === "legal" ? "property.saved_in_rops" : "property.plan.saved_in_rops",
      severity: "info",
      message: associationType === "legal"
        ? "Property and legal-entity mapping saved in R-ops"
        : "Property and planned project association saved in R-ops",
    }],
  };
}

function ensureLegalEntityScope(context: CommandHandlerContext<unknown>): string {
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (legalEntityId === undefined) {
    throw new ValidationCommandError("Property setup requires a legal entity scope", { reason: "property_entity_scope_required" });
  }
  return legalEntityId;
}

async function handlePropertySetup(context: CommandHandlerContext<PropertySetupPayload>): Promise<CommandHandlerResult> {
  const payload = propertySetupPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = ensureLegalEntityScope(context as unknown as CommandHandlerContext<unknown>);
  const organizationId = context.envelope.scope.organizationId;

  const owner = await context.executor.query<{ currency: unknown }>(
    `SELECT le.currency
       FROM company_legal_entities le
       JOIN company_organizations o ON o.id = le.organization_id
      WHERE le.organization_id = $1 AND le.id = $2
        AND le.archived_at IS NULL AND o.archived_at IS NULL`,
    [organizationId, legalEntityId],
  );
  if (owner.rows.length !== 1) {
    throw new ValidationCommandError("Legal entity is not available for property setup", { reason: "property_entity_not_found" });
  }

  const duplicate = await context.executor.query<{ id: unknown }>(
    `SELECT id FROM rent_ops_properties WHERE slug = $1`,
    [payload.slug],
  );
  if (duplicate.rows.length > 0) {
    throw new ConflictCommandError("A property with this slug already exists", { reason: "property_slug_conflict" });
  }

  const propertyId = newPropertyId();
  const associationId = newRecordId();
  const inserted = await context.executor.query(
    `INSERT INTO rent_ops_properties
       (id, name, slug, address_line1, address_line2, city, state, postal_code,
        property_type, state_status, operating_contact,
        name_knowledge, address_knowledge, property_type_knowledge,
        state_knowledge, operating_contact_knowledge)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual','manual','manual','manual',$12)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [
      propertyId,
      payload.name,
      payload.slug,
      payload.address.line1,
      payload.address.line2 ?? null,
      payload.address.city,
      payload.address.state,
      payload.address.postalCode,
      payload.propertyType,
      payload.state,
      payload.operatingContact ?? null,
      payload.operatingContact === undefined ? null : "manual",
    ],
  );
  if (inserted.rows.length !== 1) {
    throw new ConflictCommandError("A property with this slug already exists", { reason: "property_slug_conflict" });
  }
  if (payload.associationType === "legal") {
    await context.executor.query(
      `INSERT INTO company_property_entity_periods
         (id, organization_id, legal_entity_id, property_id, effective_from)
       VALUES ($1,$2,$3,$4,$5::date)`,
      [associationId, organizationId, legalEntityId, propertyId, payload.effectiveFrom],
    );
  } else {
    await context.executor.query(
      `INSERT INTO company_project_property_plans
         (id, organization_id, legal_entity_id, property_id, assignment_start_on, status, notes)
       VALUES ($1,$2,$3,$4,$5::date,'planned',$6)`,
      [associationId, organizationId, legalEntityId, propertyId, payload.assignmentStartOn, payload.notes ?? null],
    );
  }
  return savedResult(propertyId, associationId, payload.associationType);
}

async function handlePropertyPlanConvert(context: CommandHandlerContext<PropertyPlanConvertPayload>): Promise<CommandHandlerResult> {
  const payload = propertyPlanConvertPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = ensureLegalEntityScope(context as unknown as CommandHandlerContext<unknown>);
  const organizationId = context.envelope.scope.organizationId;
  const owner = await context.executor.query<{ currency: unknown }>(
    `SELECT le.currency
       FROM company_legal_entities le
       JOIN company_organizations o ON o.id = le.organization_id
      WHERE le.organization_id = $1 AND le.id = $2
        AND le.archived_at IS NULL AND o.archived_at IS NULL`,
    [organizationId, legalEntityId],
  );
  if (owner.rows.length !== 1) {
    throw new ValidationCommandError("Legal entity is not available for property plan conversion", { reason: "property_entity_not_found" });
  }

  const plan = await context.executor.query<{ property_id: unknown; status: unknown; record_revision: unknown }>(
    `SELECT property_id, status, record_revision
       FROM company_project_property_plans
      WHERE organization_id = $1 AND id = $2 AND legal_entity_id = $3
      FOR UPDATE`,
    [organizationId, payload.planId, legalEntityId],
  );
  const planRow = plan.rows[0];
  if (!planRow) throw new ValidationCommandError("Planned property association was not found in the requested scope", { reason: "property_plan_not_found" });
  const propertyId = String(planRow.property_id);
  if (context.envelope.scope.propertyId !== undefined && context.envelope.scope.propertyId !== propertyId) {
    throw new ValidationCommandError("Planned property is outside the requested scope", { reason: "property_plan_property_scope" });
  }
  if (String(planRow.status) !== "planned") {
    throw new ConflictCommandError("Only a planned property association can be converted", { reason: "property_plan_not_planned" });
  }

  const property = await context.executor.query(
    `SELECT 1 FROM rent_ops_properties WHERE id = $1 AND state_status <> 'archived'`,
    [propertyId],
  );
  if (property.rows.length !== 1) throw new ValidationCommandError("Archived or missing properties cannot be converted", { reason: "property_plan_property_unavailable" });

  const existingMapping = await context.executor.query(
    `SELECT 1 FROM company_property_entity_periods WHERE organization_id = $1 AND property_id = $2 LIMIT 1`,
    [organizationId, propertyId],
  );
  if (existingMapping.rows.length !== 0) {
    throw new ConflictCommandError("Property already has a legal-entity period", { reason: "property_plan_mapping_exists" });
  }

  const mappingId = newRecordId();
  await context.executor.query(
    `INSERT INTO company_property_entity_periods
       (id, organization_id, legal_entity_id, property_id, effective_from)
     VALUES ($1,$2,$3,$4,$5::date)`,
    [mappingId, organizationId, legalEntityId, propertyId, payload.effectiveFrom],
  );
  const converted = await context.executor.query<{ record_revision: unknown }>(
    `UPDATE company_project_property_plans
        SET status = 'converted', record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND legal_entity_id = $3 AND status = 'planned'
      RETURNING record_revision`,
    [organizationId, payload.planId, legalEntityId],
  );
  if (converted.rows.length !== 1) throw new ConflictCommandError("Planned property association changed while it was being converted", { reason: "property_plan_revision_conflict" });
  const revisionValue = converted.rows[0]?.record_revision;
  const revision = revisionSchema.parse(typeof revisionValue === "string" ? Number(revisionValue) : revisionValue);
  return {
    state: "saved_in_rops",
    affectedRecordIds: [payload.planId, mappingId],
    resultingRevisions: [
      { recordId: recordReferenceIdSchema.parse(payload.planId), revision },
      { recordId: recordReferenceIdSchema.parse(mappingId), revision: revisionSchema.parse(1) },
    ],
    validationOutcomes: [{ code: "property.plan.converted", severity: "info", message: "Legal-entity mapping saved from the supplied date and planned association converted" }],
  };
}

const handlers = {
  "property.setup": handlePropertySetup,
  "property.plan.convert": handlePropertyPlanConvert,
} as const;

export async function executePropertyCommand(
  executor: RentOpsQueryExecutor,
  kind: PropertyCommandKind,
  rawEnvelope: unknown,
  options: PropertyCommandExecutionOptions,
): Promise<OperationReceipt> {
  if (!PROPERTY_COMMAND_KINDS.includes(kind)) {
    throw new ValidationCommandError("Property command kind is unsupported", { reason: "unsupported_property_command" });
  }
  const payloadSchema = propertyCommandPayloadSchemas[kind];
  let envelope: AnyPropertyCommandEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyPropertyCommandEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      throw new ValidationCommandError("Property command payload failed validation", { reason: "invalid_property_command_payload" });
    }
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: PROPERTY_COMMAND_POLICIES[kind],
    handler,
  });
}

export const runPropertyCommand = executePropertyCommand;
