import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  companyDocumentCreateInputSchema,
  companyDocumentCommandPayloadSchemas,
  COMPANY_DOCUMENT_COMMAND_KINDS,
  companyDocumentKindSchema,
  companyDocumentLinkSchema,
  companyDocumentMetadataPatchSchema,
  companyDocumentPageSchema,
  companyDocumentPreparedUploadSchema,
  companyDocumentScopeFilterSchema,
  companyDocumentSchema,
  companyDocumentSourceSchema,
  type CompanyDocumentCommandKind,
  type CompanyDocumentCommandPayload,
  type CompanyDocument,
  type CompanyDocumentContext,
  type CompanyDocumentCreateInput,
  type CompanyDocumentDownload,
  type CompanyDocumentKind,
  type CompanyDocumentLink,
  type CompanyDocumentMetadataPatch,
  type CompanyDocumentPage,
  type CompanyDocumentPreparedUpload,
  type CompanyDocumentScopeFilter,
} from "../../shared/company-documents";
import { companyDocumentContextSchema } from "../../shared/company-documents";
import { authenticatedPrincipalIdSchema, commandEnvelopeSchema, legalEntityIdSchema, propertyReferenceIdSchema, recordReferenceIdSchema, revisionSchema, documentReferenceIdSchema, type CommandEnvelope, type CompanyScope, type DocumentReferenceId, type OperationReceipt } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { prepareVerifiedImportedDocument } from "../rent-ops/services/service";
import type { ContentAddressedObjectStore, StorageVersionOptions } from "../rent-ops/storage";
import type { RentOpsDocumentObjectBinding } from "../../shared/rent-ops-contracts";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import type { AuthenticatedPrincipal, CommandAuthorizationPolicy, TransportAttestation } from "../company/authorization";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";

export interface CompanyDocumentAuthorization {
  authorizeRead(executor: RentOpsQueryExecutor, context: CompanyDocumentContext): Promise<void>;
  authorizeWrite(executor: RentOpsQueryExecutor, context: CompanyDocumentContext): Promise<void>;
}

export interface CompanyDocumentLegacyBridge {
  /**
   * The investor schema still references rent_ops_documents. The bridge is
   * injected by the root integration, so this module never writes a second
   * unverified document row or imports a central route.
   */
  registerVerifiedDocument?(input: {
    readonly executor: RentOpsQueryExecutor;
    readonly document: CompanyDocument;
    readonly binding: RentOpsDocumentObjectBinding;
    readonly legacyDocumentId: string;
  }): Promise<void>;
}

export interface CompanyDocumentServiceOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly documentStorage: ContentAddressedObjectStore;
  /** Required server-side actor/grant checks. The port never defaults to open access. */
  readonly authorization: CompanyDocumentAuthorization;
  readonly legacyBridge?: CompanyDocumentLegacyBridge;
  readonly now?: () => Date;
  /** Authenticated actor used to bind a staged upload to its creator. */
  readonly actorId?: string;
  /** When called from runCompanyCommand, the executor is already transaction-bound. */
  readonly transactionBound?: boolean;
}

export interface CompanyDocumentPort {
  /** Verify and stage source bytes before a command transaction commits metadata. */
  prepare(input: CompanyDocumentCreateInput, binary: { readonly bytes: Uint8Array; readonly fileName: string; readonly declaredContentType: string }): Promise<CompanyDocumentPreparedUpload>;
  create(input: CompanyDocumentCreateInput, binary: { readonly bytes: Uint8Array; readonly fileName: string; readonly declaredContentType: string }): Promise<CompanyDocument>;
  /** Commit a previously verified immutable object inside the caller's transaction. */
  commitPrepared(prepared: CompanyDocumentPreparedUpload): Promise<CompanyDocument>;
  /** Consume a server-owned stage; the optional input must match staged metadata exactly. */
  commitStaged(stageId: string, input?: CompanyDocumentCreateInput): Promise<CompanyDocument>;
  get(documentId: string, scope: CompanyScope): Promise<CompanyDocument>;
  list(filter: CompanyDocumentScopeFilter): Promise<CompanyDocumentPage>;
  updateMetadata(input: CompanyDocumentMetadataPatch, scope: CompanyScope): Promise<CompanyDocument>;
  archive(documentId: string, expectedRevision: number, scope: CompanyScope): Promise<CompanyDocument>;
  link(documentId: string, link: CompanyDocumentLink, scope: CompanyScope, expectedRevision: number): Promise<CompanyDocument>;
  openDownload(documentId: string, scope: CompanyScope): Promise<CompanyDocumentDownload>;
}

export class CompanyDocumentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CompanyDocumentError";
  }
}

function nowIso(now: () => Date): string {
  const value = now().toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new CompanyDocumentError("clock_invalid", "The server clock is unavailable.");
  return value;
}

function sourceBindingId(organizationId: string, checksumSha256: string, context: CompanyDocumentContext): string {
  return `company-document:${createHash("sha256").update(JSON.stringify({ organizationId, checksumSha256, context })).digest("hex")}`;
}

function importRunId(organizationId: string, checksumSha256: string, context: CompanyDocumentContext): string {
  return `company-document-upload:${createHash("sha256").update(JSON.stringify({ organizationId, checksumSha256, context })).digest("hex")}`;
}

function documentId(organizationId: string, checksumSha256: string, context: CompanyDocumentContext): string {
  return `company-document:${createHash("sha256").update(JSON.stringify({ organizationId, checksumSha256, context })).digest("hex")}`;
}

function uploadStageId(organizationId: string, actorId: string, documentIdValue: string): string {
  return `company-document-stage:${createHash("sha256").update(JSON.stringify({ organizationId, actorId, documentId: documentIdValue })).digest("hex")}`;
}

function operationalDate(now: () => Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now());
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new CompanyDocumentError("cursor_invalid", "The document page cursor is invalid.");
  }
}

function cursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

function rowString(row: Record<string, unknown>, key: string, nullable = false): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new CompanyDocumentError("row_invalid", `Document row is missing ${key}.`);
  }
  if (typeof value !== "string" || value.length === 0) throw new CompanyDocumentError("row_invalid", `Document row has invalid ${key}.`);
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new CompanyDocumentError("row_invalid", `Document row has invalid ${key}.`);
  return number;
}

function rowJson(row: Record<string, unknown>, key: string): unknown {
  const value = row[key];
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { throw new CompanyDocumentError("row_invalid", `Document row has invalid ${key}.`); }
  }
  return value;
}

function rowTimestamp(value: unknown, key: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    const parsed = new Date(value);
    return parsed.toISOString();
  }
  throw new CompanyDocumentError("row_invalid", `Document row has invalid ${key}.`);
}

function rowDate(value: unknown, key: string, nullable = false): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new CompanyDocumentError("row_invalid", `Document row is missing ${key}.`);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  throw new CompanyDocumentError("row_invalid", `Document row has invalid ${key}.`);
}

function sourceFromRow(row: Record<string, unknown>): CompanyDocument["source"] {
  return companyDocumentSourceSchema.parse({
    fileName: row.file_name,
    declaredContentType: row.declared_content_type,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    backend: row.backend,
    logicalKey: row.logical_key,
    ...(row.immutable_generation ? { immutableGeneration: row.immutable_generation } : {}),
    ...(row.immutable_version ? { immutableVersion: row.immutable_version } : {}),
    verifiedAt: rowTimestamp(row.verified_at, "verified_at"),
  });
}

function contextFromRow(row: Record<string, unknown>): CompanyDocumentContext {
  return companyDocumentContextSchema.parse({
    organizationId: String(row.organization_id),
    ...(row.legal_entity_id ? { legalEntityId: String(row.legal_entity_id) } : {}),
    ...(row.property_id ? { propertyId: String(row.property_id) } : {}),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    ...(row.investor_contract_id ? { investorContractId: String(row.investor_contract_id) } : {}),
    ...(row.investor_contract_version_id ? { investorContractVersionId: String(row.investor_contract_version_id) } : {}),
  });
}

function documentFromRows(row: Record<string, unknown>, links: readonly Record<string, unknown>[]): CompanyDocument {
  const context = contextFromRow(row);
  const linksParsed = links.map((link) => companyDocumentLinkSchema.parse({
    kind: link.link_kind,
    id: link.linked_id,
    label: link.linked_label,
    ...(link.linked_version_id ? { versionId: link.linked_version_id } : {}),
  }));
  return companyDocumentSchema.parse({
    id: documentReferenceIdSchema.parse(row.id),
    context,
    kind: companyDocumentKindSchema.parse(row.kind),
    state: row.state,
    title: row.title,
    description: row.description ?? null,
    documentDate: rowDate(row.document_date, "document_date", true),
    tags: Array.isArray(row.tags) ? row.tags : typeof row.tags === "string" ? row.tags.replace(/[{}]/g, "").split(",").filter(Boolean) : [],
    source: sourceFromRow(row),
    links: linksParsed,
    recordRevision: rowNumber(row, "record_revision"),
    uploadedAt: rowTimestamp(row.uploaded_at, "uploaded_at"),
    updatedAt: rowTimestamp(row.updated_at, "updated_at"),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : rowTimestamp(row.archived_at, "archived_at"),
  });
}

function linkRows(documentId: string, links: readonly CompanyDocumentLink[]): Array<readonly unknown[]> {
  return links.map((link) => [documentId, link.kind, link.id, link.label, link.versionId ?? ""]);
}

async function replaceLinks(executor: RentOpsQueryExecutor, documentId: string, links: readonly CompanyDocumentLink[]): Promise<void> {
  await executor.query("DELETE FROM company_document_links WHERE document_id = $1", [documentId]);
  for (const [id, kind, linkedId, label, versionId] of linkRows(documentId, links)) {
    await executor.query(
      "INSERT INTO company_document_links (document_id, link_kind, linked_id, linked_label, linked_version_id) VALUES ($1,$2,$3,$4,$5)",
    [id, kind, linkedId, label, versionId],
    );
  }
}

async function readLinks(executor: RentOpsQueryExecutor, documentId: string): Promise<Record<string, unknown>[]> {
  return (await executor.query<Record<string, unknown>>(
    "SELECT link_kind, linked_id, linked_label, linked_version_id FROM company_document_links WHERE document_id = $1 ORDER BY link_kind, linked_id",
    [documentId],
  )).rows;
}

async function assertScopeRelationships(executor: RentOpsQueryExecutor, context: CompanyDocumentContext, asOfDate: string): Promise<void> {
  const organization = await executor.query("SELECT id FROM company_organizations WHERE id = $1 AND archived_at IS NULL", [context.organizationId]);
  if (organization.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The document company scope is unavailable.");
  if (context.legalEntityId) {
    const entity = await executor.query("SELECT id FROM company_legal_entities WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [context.organizationId, context.legalEntityId]);
    if (entity.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The document legal entity is unavailable.");
  }
  if (context.propertyId && context.legalEntityId) {
    const property = await executor.query(
      `SELECT property_id FROM company_property_entity_periods
        WHERE organization_id = $1 AND legal_entity_id = $2 AND property_id = $3
          AND effective_from <= $4 AND (effective_until IS NULL OR effective_until > $4)
        LIMIT 1`,
      [context.organizationId, context.legalEntityId, context.propertyId, asOfDate],
    );
    if (property.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The document property is not assigned to the selected legal entity.");
  }
  if (context.projectId) {
    const project = await executor.query("SELECT id FROM company_projects WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [context.organizationId, context.projectId]);
    if (project.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The document project is unavailable.");
  }
  if (context.investorContractId) {
    const contract = await executor.query("SELECT id FROM company_investor_contracts WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [context.organizationId, context.investorContractId]);
    if (contract.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The investor contract is unavailable.");
  }
  if (context.investorContractVersionId && context.investorContractId) {
    const version = await executor.query("SELECT id FROM company_investor_contract_versions WHERE organization_id = $1 AND contract_id = $2 AND id = $3", [context.organizationId, context.investorContractId, context.investorContractVersionId]);
    if (version.rows.length !== 1) throw new CompanyDocumentError("scope_not_found", "The investor contract version is unavailable.");
  }
}

type LinkAuthorization = (executor: RentOpsQueryExecutor, context: CompanyDocumentContext) => Promise<void>;

function assertLinkMatchesDocumentContext(documentContext: CompanyDocumentContext, linkContext: CompanyDocumentContext, link: CompanyDocumentLink): void {
  if (documentContext.legalEntityId !== undefined && linkContext.legalEntityId !== documentContext.legalEntityId) {
    throw new CompanyDocumentError("link_scope_invalid", `The ${link.kind} link is outside the document legal entity.`);
  }
  if (documentContext.propertyId !== undefined && linkContext.propertyId !== documentContext.propertyId) {
    throw new CompanyDocumentError("link_scope_invalid", `The ${link.kind} link is outside the document property.`);
  }
  if (documentContext.projectId !== undefined && link.kind === "project" && link.id !== documentContext.projectId) {
    throw new CompanyDocumentError("link_scope_invalid", "The project link is outside the document project.");
  }
  if (documentContext.investorContractId !== undefined && (link.kind === "investor_contract" || link.kind === "investor_contract_version") && link.id !== documentContext.investorContractId) {
    throw new CompanyDocumentError("link_scope_invalid", "The investor contract link is outside the document contract.");
  }
  if (documentContext.investorContractVersionId !== undefined && link.kind === "investor_contract_version" && link.versionId !== documentContext.investorContractVersionId) {
    throw new CompanyDocumentError("link_scope_invalid", "The investor contract version link is outside the document version.");
  }
}

async function assertLinkRelationships(
  executor: RentOpsQueryExecutor,
  documentContext: CompanyDocumentContext,
  links: readonly CompanyDocumentLink[],
  asOfDate: string,
  authorize?: LinkAuthorization,
): Promise<void> {
  const organizationId = documentContext.organizationId;
  for (const link of links) {
    let linkContext: CompanyDocumentContext = { organizationId };
    if (link.kind === "organization") {
      const result = await executor.query("SELECT id FROM company_organizations WHERE id = $1 AND archived_at IS NULL", [organizationId]);
      if (!result.rows.some(row => String((row as Record<string, unknown>).id) === link.id)) throw new CompanyDocumentError("link_scope_invalid", "The document organization link is outside the selected company.");
    } else if (link.kind === "legal_entity") {
      const result = await executor.query("SELECT id FROM company_legal_entities WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [organizationId, link.id]);
      if (result.rows.length !== 1) throw new CompanyDocumentError("link_scope_invalid", "The document legal entity link is outside the selected company.");
      linkContext = { organizationId, legalEntityId: legalEntityIdSchema.parse(link.id) };
    } else if (link.kind === "property") {
      const result = await executor.query("SELECT property_id, legal_entity_id FROM company_property_entity_periods WHERE organization_id = $1 AND property_id = $2 AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3) LIMIT 1", [organizationId, link.id, asOfDate]);
      if (result.rows.length !== 1) throw new CompanyDocumentError("link_scope_invalid", "The document property link is outside the selected company.");
      const row = result.rows[0] as Record<string, unknown>;
      linkContext = { organizationId, legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), propertyId: propertyReferenceIdSchema.parse(row.property_id) };
    } else if (link.kind === "project") {
      const result = await executor.query("SELECT id, legal_entity_id, property_id FROM company_projects WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [organizationId, link.id]);
      if (result.rows.length !== 1) throw new CompanyDocumentError("link_scope_invalid", "The document project link is outside the selected company.");
      const row = result.rows[0] as Record<string, unknown>;
      linkContext = { organizationId, legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), propertyId: propertyReferenceIdSchema.parse(row.property_id) };
    } else if (link.kind === "investor_contract") {
      const result = await executor.query("SELECT c.id, i.legal_entity_id FROM company_investor_contracts c JOIN company_investor_instruments i ON i.organization_id = c.organization_id AND i.id = c.instrument_id WHERE c.organization_id = $1 AND c.id = $2 AND c.archived_at IS NULL AND i.archived_at IS NULL", [organizationId, link.id]);
      if (result.rows.length !== 1) throw new CompanyDocumentError("link_scope_invalid", "The document investor contract link is outside the selected company.");
      const row = result.rows[0] as Record<string, unknown>;
      linkContext = { organizationId, legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), investorContractId: recordReferenceIdSchema.parse(link.id) };
    } else {
      const contractId = link.id;
      const versionId = link.versionId;
      const result = await executor.query(
        "SELECT v.id, v.contract_id, i.legal_entity_id FROM company_investor_contract_versions v JOIN company_investor_contracts c ON c.organization_id = v.organization_id AND c.id = v.contract_id JOIN company_investor_instruments i ON i.organization_id = c.organization_id AND i.id = c.instrument_id WHERE v.organization_id = $1 AND v.contract_id = $2 AND v.id = $3 AND c.archived_at IS NULL AND i.archived_at IS NULL",
        [organizationId, contractId, versionId],
      );
      if (result.rows.length !== 1) throw new CompanyDocumentError("link_scope_invalid", "The document investor contract version link is outside the selected company.");
      const row = result.rows[0] as Record<string, unknown>;
      linkContext = { organizationId, legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), investorContractId: recordReferenceIdSchema.parse(contractId), investorContractVersionId: recordReferenceIdSchema.parse(versionId) };
    }
    assertLinkMatchesDocumentContext(documentContext, linkContext, link);
    if (authorize) await authorize(executor, linkContext);
  }
}

function assertContextMatchesScope(context: CompanyDocumentContext, scope: CompanyScope & Partial<Pick<CompanyDocumentScopeFilter, "projectId" | "investorContractId">>): void {
  if (context.organizationId !== scope.organizationId) throw new CompanyDocumentError("forbidden", "The document is outside the requested company.");
  if (scope.legalEntityId && context.legalEntityId !== scope.legalEntityId) throw new CompanyDocumentError("forbidden", "The document is outside the requested legal entity.");
  if (scope.propertyId && context.propertyId !== scope.propertyId) throw new CompanyDocumentError("forbidden", "The document is outside the requested property.");
  if (scope.projectId && context.projectId !== scope.projectId) throw new CompanyDocumentError("forbidden", "The document is outside the requested project.");
  if (scope.investorContractId && context.investorContractId !== scope.investorContractId) throw new CompanyDocumentError("forbidden", "The document is outside the requested investor contract.");
}

export function createCompanyDocumentPort(options: CompanyDocumentServiceOptions): CompanyDocumentPort {
  const now = options.now ?? (() => new Date());
  const asOfDate = () => operationalDate(now);
  const query = options.executor;
  if (!options.authorization?.authorizeRead || !options.authorization.authorizeWrite) {
    throw new CompanyDocumentError("authorization_unconfigured", "Company document access checks are required.");
  }

  const withTransaction = async <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> => {
    if (options.transactionBound) return work(query);
    if (typeof query.transaction !== "function") throw new CompanyDocumentError("atomic_transaction_required", "Company document changes require an atomic database transaction.");
    return query.transaction(work, { readOnly: false });
  };

  const withReadTransaction = async <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> => {
    if (options.transactionBound) return work(query);
    if (typeof query.transaction !== "function") throw new CompanyDocumentError("atomic_transaction_required", "Company document reads require a transaction boundary.");
    return query.transaction(work, { readOnly: true });
  };

  async function readOne(executor: RentOpsQueryExecutor, documentId: string): Promise<CompanyDocument> {
    const id = documentReferenceIdSchema.parse(documentId);
    const result = await executor.query<Record<string, unknown>>(
      `SELECT id, organization_id, legal_entity_id, property_id, project_id,
              investor_contract_id, investor_contract_version_id, kind, state,
              title, description, document_date, tags, file_name,
              declared_content_type, size_bytes, checksum_sha256, backend,
              logical_key, immutable_generation, immutable_version, verified_at,
              record_revision, uploaded_at, updated_at, archived_at
         FROM company_documents WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new CompanyDocumentError("not_found", "The company document was not found.");
    return documentFromRows(row, await readLinks(executor, id));
  }

  async function commitPrepared(preparedInput: CompanyDocumentPreparedUpload): Promise<CompanyDocument> {
    const prepared = companyDocumentPreparedUploadSchema.parse(preparedInput);
    const actorId = options.actorId === undefined ? undefined : authenticatedPrincipalIdSchema.parse(options.actorId);
    if (actorId === undefined) throw new CompanyDocumentError("staging_actor_required", "A server-authenticated actor is required to consume a staged company document.");
    if (prepared.actorId !== actorId) throw new CompanyDocumentError("forbidden", "The staged company document belongs to a different authenticated actor.");
    const version: StorageVersionOptions = {
      ...(prepared.binding.immutableGeneration ? { immutableGeneration: prepared.binding.immutableGeneration } : {}),
      ...(prepared.binding.immutableVersion ? { immutableVersion: prepared.binding.immutableVersion } : {}),
    };
    let verified: Awaited<ReturnType<ContentAddressedObjectStore["verify"]>>;
    try {
      verified = await options.documentStorage.verify(prepared.document.source.logicalKey, {
        ...version,
        expectedChecksumSha256: prepared.document.source.checksumSha256,
        expectedSizeBytes: prepared.document.source.sizeBytes,
      });
    } catch {
      throw new CompanyDocumentError("integrity_failed", "The staged company document could not be verified.");
    }
    if (verified.backend !== prepared.document.source.backend || verified.logicalKey !== prepared.document.source.logicalKey || verified.verificationState !== "verified" || verified.checksumSha256 !== prepared.document.source.checksumSha256 || verified.sizeBytes !== prepared.document.source.sizeBytes) {
      throw new CompanyDocumentError("integrity_failed", "The staged company document changed and requires review.");
    }
    const persisted = await withTransaction(async (executor) => {
      await options.authorization.authorizeWrite(executor, prepared.document.context);
      await assertScopeRelationships(executor, prepared.document.context, asOfDate());
      await assertLinkRelationships(executor, prepared.document.context, prepared.document.links, asOfDate(), options.authorization.authorizeWrite.bind(options.authorization));
      const stageRows = await executor.query<Record<string, unknown>>(
        `SELECT stage_id, actor_id, organization_id, state, prepared_document, prepared_binding
           FROM company_document_upload_stages
          WHERE stage_id = $1 AND organization_id = $2 AND actor_id = $3
          FOR UPDATE`,
        [prepared.stageId, prepared.document.context.organizationId, actorId],
      );
      const stageRow = stageRows.rows[0];
      if (!stageRow) throw new CompanyDocumentError("forbidden", "The staged company document is unavailable to this actor.");
      if (stageRow.state !== "staged" && stageRow.state !== "committed") throw new CompanyDocumentError("stage_invalid", "The staged company document is no longer available.");
      const staged = companyDocumentPreparedUploadSchema.parse({
        stageId: stageRow.stage_id,
        actorId: stageRow.actor_id,
        document: rowJson(stageRow, "prepared_document"),
        binding: rowJson(stageRow, "prepared_binding"),
      });
      if (staged.document.id !== prepared.document.id || staged.document.source.checksumSha256 !== prepared.document.source.checksumSha256 || staged.document.source.logicalKey !== prepared.document.source.logicalKey || JSON.stringify(staged.document.context) !== JSON.stringify(prepared.document.context) || JSON.stringify(staged.document.links) !== JSON.stringify(prepared.document.links) || staged.document.title !== prepared.document.title || staged.document.kind !== prepared.document.kind) {
        throw new CompanyDocumentError("duplicate_source", "The staged source metadata does not match this command.");
      }
      const existingRows = await executor.query<Record<string, unknown>>("SELECT id FROM company_documents WHERE id = $1", [prepared.document.id]);
      if (existingRows.rows.length === 1) {
        const existing = await readOne(executor, prepared.document.id);
        const sameMetadata = existing.source.checksumSha256 === prepared.document.source.checksumSha256
          && JSON.stringify(existing.context) === JSON.stringify(prepared.document.context)
          && JSON.stringify(existing.links) === JSON.stringify(prepared.document.links)
          && existing.title === prepared.document.title
          && existing.description === prepared.document.description
          && existing.documentDate === prepared.document.documentDate
          && JSON.stringify(existing.tags) === JSON.stringify(prepared.document.tags)
          && existing.kind === prepared.document.kind;
        if (sameMetadata && existing.state === "verified") {
          if (stageRow.state === "staged") await executor.query("UPDATE company_document_upload_stages SET state='committed', consumed_at=$1 WHERE stage_id=$2 AND state='staged'", [nowIso(now), prepared.stageId]);
          return existing;
        }
        throw new CompanyDocumentError("duplicate_source", "This verified source is already registered with different metadata.");
      }
      await executor.query(
        `INSERT INTO company_documents
          (id, organization_id, legal_entity_id, property_id, project_id,
           investor_contract_id, investor_contract_version_id, kind, state,
           title, description, document_date, tags, file_name,
           declared_content_type, size_bytes, checksum_sha256, backend,
           logical_key, immutable_generation, immutable_version, verified_at,
           record_revision, uploaded_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [prepared.document.id, prepared.document.context.organizationId, prepared.document.context.legalEntityId ?? null, prepared.document.context.propertyId ?? null, prepared.document.context.projectId ?? null, prepared.document.context.investorContractId ?? null, prepared.document.context.investorContractVersionId ?? null, prepared.document.kind, prepared.document.state, prepared.document.title, prepared.document.description, prepared.document.documentDate, prepared.document.tags, prepared.document.source.fileName, prepared.document.source.declaredContentType, prepared.document.source.sizeBytes, prepared.document.source.checksumSha256, prepared.document.source.backend, prepared.document.source.logicalKey, prepared.document.source.immutableGeneration ?? null, prepared.document.source.immutableVersion ?? null, prepared.document.source.verifiedAt, prepared.document.recordRevision, prepared.document.uploadedAt, prepared.document.updatedAt],
      );
      await replaceLinks(executor, prepared.document.id, prepared.document.links);
      await options.legacyBridge?.registerVerifiedDocument?.({ executor, document: prepared.document, binding: prepared.binding, legacyDocumentId: prepared.document.id });
      await executor.query("UPDATE company_document_upload_stages SET state='committed', consumed_at=$1 WHERE stage_id=$2 AND state='staged'", [nowIso(now), prepared.stageId]);
      return prepared.document;
    });
    return persisted;
  }

  async function prepare(input: CompanyDocumentCreateInput, binary: { readonly bytes: Uint8Array; readonly fileName: string; readonly declaredContentType: string }): Promise<CompanyDocumentPreparedUpload> {
    const parsed = companyDocumentCreateInputSchema.parse(input);
    const actorId = options.actorId === undefined ? undefined : authenticatedPrincipalIdSchema.parse(options.actorId);
    if (actorId === undefined) throw new CompanyDocumentError("staging_actor_required", "A server-authenticated actor is required to stage a company document.");
    if (typeof binary.fileName !== "string" || binary.fileName.trim().length < 1 || binary.fileName.length > 240 || /[\u0000-\u001f\u007f]/.test(binary.fileName)) throw new CompanyDocumentError("file_invalid", "A valid source filename is required.");
    if (typeof binary.declaredContentType !== "string" || binary.declaredContentType.trim().length < 1 || binary.declaredContentType.length > 120 || /[\u0000-\u001f\u007f]/.test(binary.declaredContentType)) throw new CompanyDocumentError("file_invalid", "A valid content type is required.");
    if (!(binary.bytes instanceof Uint8Array) || binary.bytes.byteLength < 1) throw new CompanyDocumentError("file_invalid", "A non-empty verified file is required.");
    if (binary.bytes.byteLength > 50 * 1024 * 1024) throw new CompanyDocumentError("file_too_large", "Company documents are limited to 50 MB.");
    await withReadTransaction(async (executor) => {
      await options.authorization.authorizeWrite(executor, parsed.context);
      await assertScopeRelationships(executor, parsed.context, asOfDate());
      await assertLinkRelationships(executor, parsed.context, parsed.links, asOfDate(), options.authorization.authorizeWrite.bind(options.authorization));
    });
    const checksum = createHash("sha256").update(binary.bytes).digest("hex");
    const documentRecordId = documentId(parsed.context.organizationId, checksum, parsed.context);
    const prepared = await prepareVerifiedImportedDocument(options.documentStorage, {
      documentId: documentRecordId,
      type: "other",
      fileName: binary.fileName,
      // The existing verified importer accepts octet-stream for spreadsheet
      // and office files. The declared type is retained in our relational row.
      mimeType: "application/octet-stream",
      bytes: binary.bytes,
      sizeBytes: binary.bytes.byteLength,
      checksumSha256: checksum,
      sourceBinaryBinding: {
        bindingId: sourceBindingId(parsed.context.organizationId, checksum, parsed.context),
        importRunId: importRunId(parsed.context.organizationId, checksum, parsed.context),
        sourceSystem: "company_documents",
        sourceCollection: "uploads",
        sourceIdHash: checksum,
      },
    });
    const recordedAt = nowIso(now);
    const source = companyDocumentSourceSchema.parse({
      fileName: binary.fileName,
      declaredContentType: binary.declaredContentType,
      sizeBytes: prepared.document.sizeBytes,
      checksumSha256: prepared.binding.checksumSha256,
      backend: prepared.binding.backend,
      logicalKey: prepared.binding.logicalKey,
      ...(prepared.binding.immutableGeneration ? { immutableGeneration: prepared.binding.immutableGeneration } : {}),
      ...(prepared.binding.immutableVersion ? { immutableVersion: prepared.binding.immutableVersion } : {}),
      verifiedAt: prepared.binding.verifiedAt,
    });
    const document = companyDocumentSchema.parse({
      id: documentRecordId,
      context: parsed.context,
      kind: parsed.kind,
      state: "verified",
      title: parsed.title,
      description: parsed.description ?? null,
      documentDate: parsed.documentDate ?? null,
      tags: parsed.tags,
      source,
      links: parsed.links,
      recordRevision: 1,
      uploadedAt: recordedAt,
      updatedAt: recordedAt,
      archivedAt: null,
    });
    const staged = companyDocumentPreparedUploadSchema.parse({ stageId: uploadStageId(parsed.context.organizationId, actorId, document.id), actorId, document, binding: prepared.binding });
    await withTransaction(async (executor) => {
      await options.authorization.authorizeWrite(executor, parsed.context);
      await assertScopeRelationships(executor, parsed.context, asOfDate());
      await assertLinkRelationships(executor, parsed.context, parsed.links, asOfDate(), options.authorization.authorizeWrite.bind(options.authorization));
      const existingRows = await executor.query<Record<string, unknown>>(
        "SELECT state, prepared_document, prepared_binding, actor_id FROM company_document_upload_stages WHERE stage_id=$1 AND organization_id=$2 AND actor_id=$3 FOR UPDATE",
        [staged.stageId, parsed.context.organizationId, actorId],
      );
      if (existingRows.rows.length === 1) {
        const existing = existingRows.rows[0]!;
        const existingPrepared = companyDocumentPreparedUploadSchema.parse({ stageId: staged.stageId, actorId: existing.actor_id, document: rowJson(existing, "prepared_document"), binding: rowJson(existing, "prepared_binding") });
        if (existingPrepared.document.source.checksumSha256 !== staged.document.source.checksumSha256 || existingPrepared.document.title !== staged.document.title || existingPrepared.document.kind !== staged.document.kind || JSON.stringify(existingPrepared.document.context) !== JSON.stringify(staged.document.context)) throw new CompanyDocumentError("duplicate_source", "This source is already staged with different metadata.");
        return;
      }
      await executor.query(
        `INSERT INTO company_document_upload_stages
          (stage_id, organization_id, actor_id, document_id, checksum_sha256, logical_key, size_bytes,
           immutable_generation, immutable_version, prepared_document, prepared_binding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
        [staged.stageId, parsed.context.organizationId, actorId, staged.document.id, staged.document.source.checksumSha256, staged.document.source.logicalKey, staged.document.source.sizeBytes, staged.document.source.immutableGeneration ?? null, staged.document.source.immutableVersion ?? null, JSON.stringify(staged.document), JSON.stringify(staged.binding)],
      );
    });
    return staged;
  }

  async function create(input: CompanyDocumentCreateInput, binary: { readonly bytes: Uint8Array; readonly fileName: string; readonly declaredContentType: string }): Promise<CompanyDocument> {
    return commitPrepared(await prepare(input, binary));
  }

  async function commitStaged(stageId: string, input?: CompanyDocumentCreateInput): Promise<CompanyDocument> {
    const actorId = options.actorId === undefined ? undefined : authenticatedPrincipalIdSchema.parse(options.actorId);
    if (actorId === undefined) throw new CompanyDocumentError("staging_actor_required", "A server-authenticated actor is required to consume a staged company document.");
    const parsedStageId = recordReferenceIdSchema.parse(stageId);
    const prepared = await withReadTransaction(async (executor) => {
      const rows = await executor.query<Record<string, unknown>>(
        "SELECT stage_id, actor_id, prepared_document, prepared_binding FROM company_document_upload_stages WHERE stage_id=$1 AND actor_id=$2",
        [parsedStageId, actorId],
      );
      const row = rows.rows[0];
      if (!row) throw new CompanyDocumentError("forbidden", "The staged company document is unavailable to this actor.");
      const prepared = companyDocumentPreparedUploadSchema.parse({ stageId: row.stage_id, actorId: row.actor_id, document: rowJson(row, "prepared_document"), binding: rowJson(row, "prepared_binding") });
      if (input !== undefined) {
        const parsed = companyDocumentCreateInputSchema.parse(input);
        const same = JSON.stringify(parsed.context) === JSON.stringify(prepared.document.context)
          && parsed.kind === prepared.document.kind
          && parsed.title === prepared.document.title
          && (parsed.description ?? null) === prepared.document.description
          && (parsed.documentDate ?? null) === prepared.document.documentDate
          && JSON.stringify(parsed.tags) === JSON.stringify(prepared.document.tags)
        && JSON.stringify(parsed.links) === JSON.stringify(prepared.document.links);
        if (!same) throw new CompanyDocumentError("duplicate_source", "The staged source is bound to different metadata.");
      }
      return prepared;
    });
    return commitPrepared(prepared);
  }

  async function get(documentId: string, scope: CompanyScope): Promise<CompanyDocument> {
    return withReadTransaction(async (executor) => {
      const document = await readOne(executor, documentId);
      assertContextMatchesScope(document.context, scope);
      await options.authorization.authorizeRead(executor, document.context);
      await assertLinkRelationships(executor, document.context, document.links, asOfDate(), options.authorization.authorizeRead.bind(options.authorization));
      return document;
    });
  }

  async function list(filter: CompanyDocumentScopeFilter): Promise<CompanyDocumentPage> {
    const parsedFilter = companyDocumentScopeFilterSchema.parse(filter);
    const limit = Math.min(Math.max(parsedFilter.limit ?? 50, 1), 100);
    const pageCursor = safeCursor(parsedFilter.cursor);
    const values: unknown[] = [parsedFilter.organizationId];
    const clauses = ["d.organization_id = $1", "d.state <> 'archived'"];
    if (parsedFilter.legalEntityId) { values.push(parsedFilter.legalEntityId); clauses.push(`d.legal_entity_id = $${values.length}`); }
    if (parsedFilter.propertyId) { values.push(parsedFilter.propertyId); clauses.push(`d.property_id = $${values.length}`); }
    if (parsedFilter.projectId) { values.push(parsedFilter.projectId); clauses.push(`d.project_id = $${values.length}`); }
    if (parsedFilter.kind) { values.push(companyDocumentKindSchema.parse(parsedFilter.kind)); clauses.push(`d.kind = $${values.length}`); }
    if (parsedFilter.investorContractId) { values.push(parsedFilter.investorContractId); clauses.push(`d.investor_contract_id = $${values.length}`); }
    if (pageCursor) { values.push(pageCursor.updatedAt, pageCursor.id); clauses.push(`(d.updated_at, d.id) < ($${values.length - 1}, $${values.length})`); }
    values.push(limit + 1);
    return withReadTransaction(async (executor) => {
      await options.authorization.authorizeRead(executor, parsedFilter);
      const rows = (await executor.query<Record<string, unknown>>(
        `SELECT d.id, d.organization_id, d.legal_entity_id, d.property_id, d.project_id,
              d.investor_contract_id, d.investor_contract_version_id, d.kind, d.state,
              d.title, d.description, d.document_date, d.tags, d.file_name,
              d.declared_content_type, d.size_bytes, d.checksum_sha256, d.backend,
              d.logical_key, d.immutable_generation, d.immutable_version, d.verified_at,
              d.record_revision, d.uploaded_at, d.updated_at, d.archived_at
           FROM company_documents d WHERE ${clauses.join(" AND ")}
           ORDER BY d.updated_at DESC, d.id DESC LIMIT $${values.length}`,
        values,
      )).rows;
      const pageRows = rows.slice(0, limit);
      const items: CompanyDocument[] = [];
      for (const row of pageRows) {
        const document = documentFromRows(row, await readLinks(executor, rowString(row, "id")!));
        assertContextMatchesScope(document.context, parsedFilter);
        try {
          await options.authorization.authorizeRead(executor, document.context);
          await assertLinkRelationships(executor, document.context, document.links, asOfDate(), options.authorization.authorizeRead.bind(options.authorization));
          items.push(document);
        } catch (error) {
          if (error instanceof CompanyDocumentError && error.code === "forbidden") continue;
          if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "forbidden") continue;
          throw error;
        }
      }
      const nextCursor = rows.length > limit && pageRows.length > 0 ? cursor(rowTimestamp(pageRows.at(-1)!.updated_at, "updated_at"), rowString(pageRows.at(-1)!, "id")!) : null;
      return companyDocumentPageSchema.parse({ items, nextCursor });
    });
  }

  async function updateMetadata(input: CompanyDocumentMetadataPatch, scope: CompanyScope): Promise<CompanyDocument> {
    const parsed = companyDocumentMetadataPatchSchema.parse(input);
    return withTransaction(async (executor) => {
      const current = await readOne(executor, parsed.documentId);
      assertContextMatchesScope(current.context, scope);
      await options.authorization.authorizeWrite(executor, current.context);
      if (current.recordRevision !== parsed.expectedRevision) throw new CompanyDocumentError("revision_conflict", "The document changed while it was being edited.");
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => { fields.push(`${column} = $${values.length + 1}`); values.push(value); };
      if (parsed.title !== undefined) set("title", parsed.title);
      if (parsed.description !== undefined) set("description", parsed.description);
      if (parsed.documentDate !== undefined) set("document_date", parsed.documentDate);
      if (parsed.tags !== undefined) set("tags", parsed.tags);
      if (fields.length === 0 && parsed.links === undefined) throw new CompanyDocumentError("metadata_empty", "At least one metadata field is required.");
      if (parsed.links !== undefined) await assertLinkRelationships(executor, current.context, parsed.links, asOfDate(), options.authorization.authorizeWrite.bind(options.authorization));
      const nextRevision = current.recordRevision + 1;
      fields.push(`record_revision = $${values.length + 1}`, `updated_at = $${values.length + 2}`);
      values.push(nextRevision, nowIso(now), current.id, parsed.expectedRevision);
      const updated = await executor.query(`UPDATE company_documents SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND record_revision = $${values.length} AND state <> 'archived' RETURNING id`, values);
      if (updated.rows.length !== 1) throw new CompanyDocumentError("revision_conflict", "The document changed while it was being edited.");
      if (parsed.links !== undefined) await replaceLinks(executor, current.id, parsed.links);
      return readOne(executor, current.id);
    });
  }

  async function archive(documentId: string, expectedRevision: number, scope: CompanyScope): Promise<CompanyDocument> {
    return withTransaction(async (executor) => {
      const current = await readOne(executor, documentId);
      assertContextMatchesScope(current.context, scope);
      await options.authorization.authorizeWrite(executor, current.context);
      if (current.recordRevision !== expectedRevision) throw new CompanyDocumentError("revision_conflict", "The document changed while it was being archived.");
      const updated = await executor.query("UPDATE company_documents SET state='archived', archived_at=$1, updated_at=$1, record_revision=record_revision+1 WHERE id=$2 AND record_revision=$3 AND state <> 'archived' RETURNING id", [nowIso(now), current.id, expectedRevision]);
      if (updated.rows.length !== 1) throw new CompanyDocumentError("revision_conflict", "The document changed while it was being archived.");
      return readOne(executor, current.id);
    });
  }

  async function link(documentId: string, linkInput: CompanyDocumentLink, scope: CompanyScope, expectedRevision: number): Promise<CompanyDocument> {
    const linkValue = companyDocumentLinkSchema.parse(linkInput);
    const current = await get(documentId, scope);
    if (current.recordRevision !== revisionSchema.parse(expectedRevision)) throw new CompanyDocumentError("revision_conflict", "The document changed while it was being linked.");
    const links = current.links.some((link) => link.kind === linkValue.kind && link.id === linkValue.id && link.versionId === linkValue.versionId)
      ? current.links
      : [...current.links, linkValue];
    return updateMetadata({ documentId: current.id, expectedRevision: current.recordRevision, links }, scope);
  }

  async function openDownload(documentId: string, scope: CompanyScope): Promise<CompanyDocumentDownload> {
    const document = await get(documentId, scope);
    if (document.state !== "verified") throw new CompanyDocumentError("unavailable", "The document is not available for download.");
    const version: StorageVersionOptions = {
      ...(document.source.immutableGeneration ? { immutableGeneration: document.source.immutableGeneration } : {}),
      ...(document.source.immutableVersion ? { immutableVersion: document.source.immutableVersion } : {}),
    };
    const opened = await options.documentStorage.openVerified(document.source.logicalKey, {
      ...version,
      expectedChecksumSha256: document.source.checksumSha256,
      expectedSizeBytes: document.source.sizeBytes,
    });
    if (opened.verification.checksumSha256 !== document.source.checksumSha256 || opened.verification.sizeBytes !== document.source.sizeBytes) {
      throw new CompanyDocumentError("integrity_failed", "The verified document object changed and requires review.");
    }
    return { document, stream: opened.stream as unknown as Readable, contentType: document.source.declaredContentType, fileName: document.source.fileName };
  }

  return { prepare, create, commitPrepared, commitStaged, get, list, updateMetadata, archive, link, openDownload };
}

export const createCompanyDocumentsService = createCompanyDocumentPort;

const COMPANY_DOCUMENT_WRITE_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager"] as const;

export const COMPANY_DOCUMENT_COMMAND_POLICIES: Readonly<Record<CompanyDocumentCommandKind, CommandAuthorizationPolicy>> = Object.freeze(
  Object.fromEntries(COMPANY_DOCUMENT_COMMAND_KINDS.map((commandKind) => [commandKind, { commandKind, allowedRoles: COMPANY_DOCUMENT_WRITE_ROLES }])) as unknown as Record<CompanyDocumentCommandKind, CommandAuthorizationPolicy>,
);

export interface CompanyDocumentCommandOptions extends Omit<CompanyDocumentServiceOptions, "executor" | "transactionBound"> {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

type AnyCompanyDocumentEnvelope = CommandEnvelope<Record<string, unknown>>;

function commandScopeMatchesDocument(scope: CompanyScope, context: CompanyDocumentContext): boolean {
  return scope.organizationId === context.organizationId
    && (scope.legalEntityId === undefined || scope.legalEntityId === context.legalEntityId)
    && (scope.propertyId === undefined || scope.propertyId === context.propertyId);
}

function commandResult(document: CompanyDocument, message: string): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [recordReferenceIdSchema.parse(document.id)],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(document.id), revision: revisionSchema.parse(document.recordRevision) }],
    validationOutcomes: [{ code: "company_document.saved", severity: "info", message }],
  };
}

function rethrowDocumentCommandError(error: unknown): never {
  if (error instanceof CompanyDocumentError) {
    if (error.code === "revision_conflict") throw new ConflictCommandError(error.message, { reason: "revision_conflict" });
    if (error.code === "forbidden") throw new ConflictCommandError(error.message, { reason: "scope_conflict" });
    throw new ValidationCommandError(error.message, { reason: error.code });
  }
  throw error;
}

/**
 * Execute an ordinary company-document mutation through the shared durable
 * command runner. Source bytes are staged by `service.prepare` first; the
 * commit and receipt share the command transaction and replay never reruns
 * the document handler.
 */
export async function executeCompanyDocumentCommand(
  executor: RentOpsQueryExecutor,
  kind: CompanyDocumentCommandKind,
  rawEnvelope: unknown,
  options: CompanyDocumentCommandOptions,
): Promise<OperationReceipt> {
  const payloadSchema = companyDocumentCommandPayloadSchemas[kind];
  let envelope: AnyCompanyDocumentEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyCompanyDocumentEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw new ValidationCommandError("Company document command payload failed validation", { reason: "invalid_company_document_command_payload" });
    throw error;
  }
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: COMPANY_DOCUMENT_COMMAND_POLICIES[kind],
    handler: async (context) => {
      const service = createCompanyDocumentPort({ ...options, executor: context.executor, transactionBound: true });
      const payload = context.envelope.payload as CompanyDocumentCommandPayload;
      try {
        let document: CompanyDocument;
        if (kind === "company_document.create" && payload.action === "create") {
          if (!commandScopeMatchesDocument(context.envelope.scope, payload.input.context)) throw new CompanyDocumentError("forbidden", "The command scope does not match the staged document metadata.");
          document = await service.commitStaged(payload.stageId, payload.input);
          return commandResult(document, "Company document created and verified.");
        }
        if (kind === "company_document.update" && payload.action === "update") {
          if (context.envelope.expectedRevision !== undefined && context.envelope.expectedRevision !== payload.patch.expectedRevision) throw new CompanyDocumentError("revision_conflict", "The command revision does not match the metadata patch.");
          document = await service.updateMetadata(payload.patch, context.envelope.scope);
          return commandResult(document, "Company document metadata updated.");
        }
        if (kind === "company_document.archive" && payload.action === "archive") {
          if (context.envelope.expectedRevision === undefined) throw new CompanyDocumentError("revision_conflict", "Archiving a company document requires an expected revision.");
          document = await service.archive(payload.documentId, context.envelope.expectedRevision, context.envelope.scope);
          return commandResult(document, "Company document archived.");
        }
        if (kind === "company_document.link" && payload.action === "link") {
          if (context.envelope.expectedRevision !== undefined && context.envelope.expectedRevision !== payload.expectedRevision) throw new CompanyDocumentError("revision_conflict", "The command revision does not match the link patch.");
          document = await service.link(payload.documentId, payload.link, context.envelope.scope, payload.expectedRevision);
          return commandResult(document, "Company document link saved.");
        }
        throw new ValidationCommandError("Company document command kind and payload do not match", { reason: "command_kind_payload_mismatch" });
      } catch (error) {
        return rethrowDocumentCommandError(error);
      }
    },
  });
}

export const runCompanyDocumentCommand = executeCompanyDocumentCommand;
