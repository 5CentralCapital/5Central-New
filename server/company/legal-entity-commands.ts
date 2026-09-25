import {
  commandEnvelopeSchema,
  newLegalEntityId,
  recordReferenceIdSchema,
  revisionSchema,
  type CommandEnvelope,
  type OperationReceipt,
} from "../../shared/company";
import {
  LEGAL_ENTITY_COMMAND_KINDS,
  legalEntityCommandPayloadSchemas,
  legalEntityCreatePayloadSchema,
  type LegalEntityCommandKind,
  type LegalEntityCreatePayload,
} from "../../shared/company/legal-entity-contracts";
import {
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

type AnyLegalEntityCommandEnvelope = CommandEnvelope<Record<string, unknown>>;

export interface LegalEntityCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export const LEGAL_ENTITY_COMMAND_POLICIES: Readonly<Record<LegalEntityCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "legal_entity.create": {
    commandKind: "legal_entity.create",
    allowedRoles: ["owner", "admin"],
    requiredScope: "organization",
  },
});

async function handleCreateLegalEntity(context: CommandHandlerContext<LegalEntityCreatePayload>): Promise<CommandHandlerResult> {
  const payload = legalEntityCreatePayloadSchema.parse(context.envelope.payload);
  const { organizationId, legalEntityId, propertyId } = context.envelope.scope;
  if (legalEntityId !== undefined || propertyId !== undefined) {
    throw new ValidationCommandError("Legal entity creation requires organization scope", { reason: "legal_entity_scope_required" });
  }

  // Lock the organization row so two command transactions cannot both pass the
  // normalized-name check before inserting a new active entity.
  const organization = await context.executor.query<{ id: unknown }>(
    `SELECT id FROM company_organizations WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [organizationId],
  );
  if (organization.rows.length !== 1) {
    throw new ValidationCommandError("Company organization is not available", { reason: "organization_not_found" });
  }
  const duplicate = await context.executor.query<{ id: unknown }>(
    `SELECT id
       FROM company_legal_entities
      WHERE organization_id = $1
        AND archived_at IS NULL
        AND lower(btrim(name)) = lower(btrim($2))
      LIMIT 1`,
    [organizationId, payload.name],
  );
  if (duplicate.rows.length !== 0) {
    throw new ConflictCommandError("An active legal entity with this normalized name already exists", { reason: "legal_entity_name_conflict" });
  }

  const id = newLegalEntityId();
  const inserted = await context.executor.query(
    `INSERT INTO company_legal_entities (id, organization_id, name, entity_type, currency)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [id, organizationId, payload.name, payload.entityType, payload.currency],
  );
  if (inserted.rows.length !== 1) {
    throw new ConflictCommandError("Legal entity could not be created", { reason: "legal_entity_create_conflict" });
  }
  return {
    state: "saved_in_rops",
    affectedRecordIds: [recordReferenceIdSchema.parse(id)],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(id), revision: revisionSchema.parse(1) }],
    validationOutcomes: [{
      code: "legal_entity.saved_in_rops",
      severity: "info",
      message: "Legal entity saved in 5Central Ops; no grants or provider connection were created",
    }],
  };
}

const handlers = { "legal_entity.create": handleCreateLegalEntity } as const;

export async function executeLegalEntityCommand(
  executor: RentOpsQueryExecutor,
  kind: LegalEntityCommandKind,
  rawEnvelope: unknown,
  options: LegalEntityCommandExecutionOptions,
): Promise<OperationReceipt> {
  if (!LEGAL_ENTITY_COMMAND_KINDS.includes(kind)) {
    throw new ValidationCommandError("Legal entity command kind is unsupported", { reason: "unsupported_legal_entity_command" });
  }
  const payloadSchema = legalEntityCommandPayloadSchemas[kind];
  let envelope: AnyLegalEntityCommandEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyLegalEntityCommandEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      throw new ValidationCommandError("Legal entity command payload failed validation", { reason: "invalid_legal_entity_command_payload" });
    }
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: LEGAL_ENTITY_COMMAND_POLICIES[kind],
    handler,
  });
}
