import { z } from "zod";
import {
  authenticatedPrincipalIdSchema,
  documentReferenceIdSchema,
  operationIdSchema,
  organizationIdSchema,
  recordReferenceIdSchema,
  type DocumentReferenceId,
  type OperationId,
  type RecordReferenceId,
} from "./identifiers";
import { isoDateSchema, isoTimestampSchema, nowIsoTimestamp, type IsoDate, type IsoTimestamp } from "./dates";
import { companyScopeSchema, type CompanyScope } from "./scope";
import { revisionSchema, type Revision } from "./revisions";

export const COMMAND_ROLES = [
  "owner",
  "admin",
  "finance",
  "operations_pm",
  "project_manager",
  "restricted_vendor",
  "read_only_reviewer",
  "tenant",
  "applicant",
] as const;
export type CommandRole = (typeof COMMAND_ROLES)[number];

export const commandRoleSchema = z.enum(COMMAND_ROLES);

export const idempotencyKeySchema = z.string()
  .min(1, "Idempotency key is required")
  .max(255, "Idempotency key is too long")
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), "Idempotency key cannot have surrounding whitespace or control characters");

const sourceDocumentIdsSchema = z.array(documentReferenceIdSchema)
  .max(100)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "sourceDocumentIds must be unique" });
    }
  });

/**
 * The user-facing envelope intentionally has no actor field. The strict
 * schema rejects actorId/userId/actor payloads so a model cannot impersonate a
 * principal; the authenticated session is bound by the server below.
 */
export function commandEnvelopeSchema<TPayload extends z.ZodTypeAny>(payloadSchema: TPayload) {
  return z.object({
    operationId: operationIdSchema,
    idempotencyKey: idempotencyKeySchema,
    scope: companyScopeSchema,
    expectedRevision: revisionSchema.optional(),
    effectiveDate: isoDateSchema.optional(),
    sourceDocumentIds: sourceDocumentIdsSchema.optional(),
    payload: payloadSchema,
  }).strict();
}

export interface CommandEnvelope<TPayload> {
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
  readonly scope: CompanyScope;
  readonly expectedRevision?: Revision;
  readonly effectiveDate?: IsoDate;
  readonly sourceDocumentIds?: readonly DocumentReferenceId[];
  readonly payload: TPayload;
  readonly actor?: never;
  readonly actorId?: never;
  readonly userId?: never;
  readonly authenticatedActor?: never;
}

export function parseCommandEnvelope<TPayload extends z.ZodTypeAny>(
  payloadSchema: TPayload,
  input: unknown,
): CommandEnvelope<z.output<TPayload>> {
  return commandEnvelopeSchema(payloadSchema).parse(input) as CommandEnvelope<z.output<TPayload>>;
}

export const authenticatedActorSchema = z.object({
  actorId: authenticatedPrincipalIdSchema,
  organizationId: organizationIdSchema,
  role: commandRoleSchema,
}).strict();

export type AuthenticatedActor = z.infer<typeof authenticatedActorSchema>;

export interface AuthenticatedCommand<TPayload> {
  readonly envelope: CommandEnvelope<TPayload>;
  readonly actor: AuthenticatedActor;
}

export function bindAuthenticatedActor<TPayload>(
  envelope: CommandEnvelope<TPayload>,
  actor: AuthenticatedActor,
): AuthenticatedCommand<TPayload> {
  const parsedActor = authenticatedActorSchema.parse(actor);
  if (parsedActor.organizationId !== envelope.scope.organizationId) {
    throw new Error("Authenticated actor cannot operate outside its organization scope");
  }
  return { envelope, actor: parsedActor };
}

export const OPERATION_STATES = [
  "draft",
  "needs_review",
  "ready",
  "queued",
  "saved_in_rops",
  "posting",
  "synced_to_quickbooks",
  "conflict",
  "failed",
  "reversed",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];
export const operationStateSchema = z.enum(OPERATION_STATES);

export const validationOutcomeSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_.-]*$/, "Validation codes must be stable machine names"),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1).max(2_000),
  path: z.array(z.string().min(1).max(160)).max(32).optional(),
}).strict();

export const resultingRevisionSchema = z.object({
  recordId: recordReferenceIdSchema,
  revision: revisionSchema,
}).strict();

const uniqueRecordIdsSchema = z.array(recordReferenceIdSchema)
  .max(1_000)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "affectedRecordIds must be unique" });
    }
  });

export const operationReceiptSchema = z.object({
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  state: operationStateSchema,
  affectedRecordIds: uniqueRecordIdsSchema,
  resultingRevisions: z.array(resultingRevisionSchema).max(1_000),
  validationOutcomes: z.array(validationOutcomeSchema).max(1_000),
  recordedAt: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  const affectedIds = new Set(value.affectedRecordIds);
  const revisionIds = new Set<string>();
  for (let index = 0; index < value.resultingRevisions.length; index += 1) {
    const result = value.resultingRevisions[index];
    if (!result) continue;
    if (revisionIds.has(result.recordId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultingRevisions", index, "recordId"],
        message: "resultingRevisions must contain one entry per record",
      });
    }
    revisionIds.add(result.recordId);
    if (!affectedIds.has(result.recordId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultingRevisions", index, "recordId"],
        message: "resulting revision must refer to an affected record",
      });
    }
  }
});

export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;
export type ResultingRevision = z.infer<typeof resultingRevisionSchema>;
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;

export interface CreateOperationReceiptOptions {
  readonly state: OperationState;
  readonly affectedRecordIds: readonly (RecordReferenceId | string)[];
  readonly resultingRevisions: readonly ResultingRevision[];
  readonly validationOutcomes: readonly ValidationOutcome[];
  readonly recordedAt?: IsoTimestamp;
}

export function createOperationReceipt<TPayload>(
  envelope: CommandEnvelope<TPayload>,
  options: CreateOperationReceiptOptions,
): OperationReceipt {
  return operationReceiptSchema.parse({
    operationId: envelope.operationId,
    idempotencyKey: envelope.idempotencyKey,
    state: options.state,
    affectedRecordIds: [...options.affectedRecordIds],
    resultingRevisions: [...options.resultingRevisions],
    validationOutcomes: [...options.validationOutcomes],
    recordedAt: options.recordedAt ?? nowIsoTimestamp(),
  });
}

export type CommandRecordedAt = IsoTimestamp;
