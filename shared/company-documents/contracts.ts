import { z } from "zod";
import {
  companyScopeSchema,
  currencyCodeSchema,
  documentReferenceIdSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  authenticatedPrincipalIdSchema,
  revisionSchema,
  type CompanyScope,
  type DocumentReferenceId,
  type IsoDate,
  type IsoTimestamp,
  type PropertyReferenceId,
  type RecordReferenceId,
} from "../company";
import type { CommandEnvelope } from "../company";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Text contains a control character");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const COMPANY_DOCUMENT_KINDS = [
  "contract",
  "loan",
  "insurance",
  "investor_agreement",
  "project_estimate",
  "project_invoice",
  "tax",
  "formation",
  "policy",
  "other",
] as const;
export type CompanyDocumentKind = (typeof COMPANY_DOCUMENT_KINDS)[number];
export const companyDocumentKindSchema = z.enum(COMPANY_DOCUMENT_KINDS);

export const COMPANY_DOCUMENT_STATES = ["verified", "archived"] as const;
export type CompanyDocumentState = (typeof COMPANY_DOCUMENT_STATES)[number];
export const companyDocumentStateSchema = z.enum(COMPANY_DOCUMENT_STATES);

export const COMPANY_DOCUMENT_LINK_KINDS = [
  "organization",
  "legal_entity",
  "property",
  "project",
  "investor_contract",
  "investor_contract_version",
] as const;
export type CompanyDocumentLinkKind = (typeof COMPANY_DOCUMENT_LINK_KINDS)[number];
export const companyDocumentLinkKindSchema = z.enum(COMPANY_DOCUMENT_LINK_KINDS);

export const companyDocumentContextSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  projectId: recordReferenceIdSchema.optional(),
  investorContractId: recordReferenceIdSchema.optional(),
  investorContractVersionId: recordReferenceIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.propertyId !== undefined && value.legalEntityId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["legalEntityId"], message: "A property document link requires a legal entity" });
  }
  if (value.investorContractVersionId !== undefined && value.investorContractId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["investorContractId"], message: "A contract version requires its contract" });
  }
});
export type CompanyDocumentContext = z.infer<typeof companyDocumentContextSchema>;

export const companyDocumentSourceSchema = z.object({
  fileName: text(240),
  declaredContentType: text(120),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backend: text(120),
  logicalKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  immutableGeneration: text(256).optional(),
  immutableVersion: text(256).optional(),
  verifiedAt: isoTimestampSchema,
}).strict().refine((value) => value.immutableGeneration !== undefined || value.immutableVersion !== undefined, {
  message: "A verified company document requires an immutable object version",
}).refine((value) => value.logicalKey === `sha256:${value.checksumSha256}`, {
  path: ["logicalKey"],
  message: "The object key must match the checksum",
});
export type CompanyDocumentSource = z.infer<typeof companyDocumentSourceSchema>;

export const companyDocumentLinkSchema = z.object({
  kind: companyDocumentLinkKindSchema,
  id: recordReferenceIdSchema,
  label: text(240),
  versionId: recordReferenceIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "investor_contract_version" && value.versionId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["versionId"], message: "A contract version link requires its version identity" });
  }
});
export type CompanyDocumentLink = z.infer<typeof companyDocumentLinkSchema>;

export const companyDocumentSchema = z.object({
  id: documentReferenceIdSchema,
  context: companyDocumentContextSchema,
  kind: companyDocumentKindSchema,
  state: companyDocumentStateSchema,
  title: text(240),
  description: optionalText(4_000),
  documentDate: isoDateSchema.nullable(),
  tags: z.array(text(80)).max(50),
  source: companyDocumentSourceSchema,
  links: z.array(companyDocumentLinkSchema).max(20),
  recordRevision: revisionSchema,
  uploadedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "archived" && value.archivedAt === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["archivedAt"], message: "Archived documents require archivedAt" });
  if (value.state === "verified" && value.archivedAt !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["archivedAt"], message: "Verified documents cannot have archivedAt" });
});
export type CompanyDocument = z.infer<typeof companyDocumentSchema>;

export const companyDocumentCreateInputSchema = z.object({
  context: companyDocumentContextSchema,
  kind: companyDocumentKindSchema,
  title: text(240),
  description: optionalText(4_000),
  documentDate: isoDateSchema.nullable().optional(),
  tags: z.array(text(80)).max(50).default([]),
  links: z.array(companyDocumentLinkSchema).max(20).default([]),
}).strict();
export type CompanyDocumentCreateInput = z.infer<typeof companyDocumentCreateInputSchema>;

export const companyDocumentMetadataPatchSchema = z.object({
  documentId: documentReferenceIdSchema,
  expectedRevision: revisionSchema,
  title: text(240).optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  documentDate: isoDateSchema.nullable().optional(),
  tags: z.array(text(80)).max(50).optional(),
  links: z.array(companyDocumentLinkSchema).max(20).optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length <= 2) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one metadata field is required" });
});
export type CompanyDocumentMetadataPatch = z.infer<typeof companyDocumentMetadataPatchSchema>;

export const companyDocumentPageSchema = z.object({
  items: z.array(companyDocumentSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();
export type CompanyDocumentPage = z.infer<typeof companyDocumentPageSchema>;

export interface CompanyDocumentDownload {
  readonly document: CompanyDocument;
  readonly stream: NodeJS.ReadableStream;
  readonly contentType: string;
  readonly fileName: string;
}

export interface CompanyDocumentScopeFilter extends CompanyScope {
  readonly propertyId?: PropertyReferenceId;
  readonly projectId?: RecordReferenceId;
  readonly kind?: CompanyDocumentKind;
  readonly investorContractId?: RecordReferenceId;
  readonly cursor?: string;
  readonly limit?: number;
}

export const companyDocumentScopeFilterSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  projectId: recordReferenceIdSchema.optional(),
  kind: companyDocumentKindSchema.optional(),
  investorContractId: recordReferenceIdSchema.optional(),
  cursor: z.string().max(4_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.propertyId !== undefined && value.legalEntityId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["legalEntityId"], message: "Property scope requires its legal entity" });
  }
});

export const companyDocumentPreparedBindingSchema = z.object({
  documentId: documentReferenceIdSchema,
  bindingKind: z.literal("import"),
  sourceBinaryId: text(255),
  importRunId: text(255),
  sourceSystem: text(120),
  sourceCollection: text(160),
  backend: text(120),
  logicalKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  immutableGeneration: text(256).optional(),
  immutableVersion: text(256).optional(),
  verifiedAt: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.logicalKey !== `sha256:${value.checksumSha256}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["logicalKey"], message: "The binding key must match its checksum" });
  }
  if (value.immutableGeneration === undefined && value.immutableVersion === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A prepared company document requires an immutable object version" });
  }
});
export type CompanyDocumentPreparedBinding = z.infer<typeof companyDocumentPreparedBindingSchema>;

export const companyDocumentPreparedUploadSchema = z.object({
  stageId: recordReferenceIdSchema,
  actorId: authenticatedPrincipalIdSchema,
  document: companyDocumentSchema,
  binding: companyDocumentPreparedBindingSchema,
}).strict().superRefine((value, context) => {
  if (value.document.id !== value.binding.documentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["binding", "documentId"], message: "The prepared binding must target the document" });
  if (value.document.source.checksumSha256 !== value.binding.checksumSha256 || value.document.source.sizeBytes !== value.binding.sizeBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["binding"], message: "The prepared binding must match the verified source" });
  }
});
export type CompanyDocumentPreparedUpload = z.infer<typeof companyDocumentPreparedUploadSchema>;

export const COMPANY_DOCUMENT_COMMAND_KINDS = [
  "company_document.create",
  "company_document.update",
  "company_document.archive",
  "company_document.link",
] as const;
export type CompanyDocumentCommandKind = (typeof COMPANY_DOCUMENT_COMMAND_KINDS)[number];

const companyDocumentCreateCommandPayloadSchema = z.object({
  action: z.literal("create"),
  stageId: recordReferenceIdSchema,
  input: companyDocumentCreateInputSchema,
}).strict();
const companyDocumentUpdateCommandPayloadSchema = z.object({
  action: z.literal("update"),
  patch: companyDocumentMetadataPatchSchema,
}).strict();
const companyDocumentArchiveCommandPayloadSchema = z.object({
  action: z.literal("archive"),
  documentId: documentReferenceIdSchema,
}).strict();
const companyDocumentLinkCommandPayloadSchema = z.object({
  action: z.literal("link"),
  documentId: documentReferenceIdSchema,
  expectedRevision: revisionSchema,
  link: companyDocumentLinkSchema,
}).strict();

export const companyDocumentCommandPayloadSchemas = {
  "company_document.create": companyDocumentCreateCommandPayloadSchema,
  "company_document.update": companyDocumentUpdateCommandPayloadSchema,
  "company_document.archive": companyDocumentArchiveCommandPayloadSchema,
  "company_document.link": companyDocumentLinkCommandPayloadSchema,
} as const;
export type CompanyDocumentCommandPayload =
  | z.output<typeof companyDocumentCreateCommandPayloadSchema>
  | z.output<typeof companyDocumentUpdateCommandPayloadSchema>
  | z.output<typeof companyDocumentArchiveCommandPayloadSchema>
  | z.output<typeof companyDocumentLinkCommandPayloadSchema>;

export type CompanyDocumentCommandEnvelope = CommandEnvelope<CompanyDocumentCommandPayload>;

export type CompanyDocumentId = DocumentReferenceId;
export type CompanyDocumentDate = IsoDate;
export type CompanyDocumentRecordedAt = IsoTimestamp;
export type CompanyDocumentCurrency = z.infer<typeof currencyCodeSchema>;
