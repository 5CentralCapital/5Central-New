import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  centsFromBigInt,
  centsToLegacyNumber,
  centsToBigInt,
  commandEnvelopeSchema,
  createOperationReceipt,
  documentReferenceIdSchema,
  isoTimestampSchema,
  newRecordId,
  revisionSchema,
  type CommandEnvelope,
  type CompanyScope,
  type IsoTimestamp,
  type MoneyCents,
  type OperationReceipt,
  type RecordReferenceId,
} from "../../shared/company";
import type { IsoDate } from "../../shared/company";
import type { RentOpsLedgerTransaction, RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import { MRA_INGESTION_POLICY, assertAuthorizedCommand, type AuthenticatedPrincipal, type TransportAttestation } from "../company/authorization";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import {
  intakeAccountOutcomeSchema,
  intakeAmountTotalsSchema,
  intakeLineRecordSchema,
  intakeReconciliationSchema,
  intakeSourceObjectSchema,
  mraMappingSchema,
  mraPacketCandidateSchema,
  mraPacketRecordSchema,
  projectCostCandidateSchema,
  projectCostPreviewSchema,
  scopeForIntake,
  type IntakeAccountOutcome,
  type IntakeAmountTotals,
  type IntakeLineOutcome,
  type IntakeLineRecord,
  type IntakePacketState,
  type IntakeReconciliation,
  type IntakeSourceObject,
  type MraMapping,
  type MraPacketCandidate,
  type MraPacketRecord,
  type ProjectCostCandidate,
  type ProjectCostPreview,
  type ProjectDraftCostCommandInput,
} from "../../shared/intake";
import {
  companyDocumentSourceSchema,
} from "../../shared/company-documents";
import type { ContentAddressedObjectStore } from "../rent-ops/storage";
import { prepareVerifiedImportedDocument } from "../rent-ops/services/service";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { parseMraSource, type MraSourceAdapter } from "./source-adapters";
import { SqlIntakeStore, type IntakeStore } from "./store";

export interface TenantAccountApplyContext {
  readonly executor: RentOpsQueryExecutor;
  readonly packet: MraPacketRecord;
  readonly sourceLine: IntakeLineRecord;
  readonly idempotencyKey: string;
  /** Root injects a transaction-bound PostgresRentOpsRepository-backed service. */
  readonly rentOpsService?: unknown;
}

export interface TenantAccountApplyResult {
  readonly affectedRecordIds: readonly RecordReferenceId[];
  readonly appliedCents: MoneyCents;
  readonly eventKey?: string;
}

export interface TenantAccountApplyPort {
  applyLine(context: TenantAccountApplyContext): Promise<TenantAccountApplyResult>;
}

interface RentOpsTenantAccountCommandService {
  snapshot(): Promise<RentOpsSnapshot>;
  recordManualPayment(input: {
    id: string;
    tenancyId: string;
    amountCents: number;
    postedOn: string;
    paymentMethod: "ach" | "cash" | "check" | "money_order" | "zelle" | "other";
    description: string;
    category: "base_rent" | "recurring_fee" | "one_time_fee" | "unapplied_cash" | "other";
    allocations: readonly { chargeTransactionId: string; amountCents: number }[];
    autoAllocate?: boolean;
  }, context: { actorSubject: string; occurredAt: string }): Promise<{ payment: { id: string; amountCents: number | null } }>;
  saveLedgerTransaction(transaction: RentOpsLedgerTransaction): Promise<RentOpsLedgerTransaction>;
}

export interface TenantAccountApplyAdapterOptions {
  /** Server-attested actor; never supplied by the packet or its extracted text. */
  readonly actorSubject: string;
  readonly now?: () => Date;
}

function tenantAccountCommandService(value: unknown): RentOpsTenantAccountCommandService {
  if (!value || typeof value !== "object") throw packetError("rent_ops_service_unconfigured", "The transaction-bound Rent Operations service is unavailable.");
  const candidate = value as Partial<RentOpsTenantAccountCommandService>;
  if (typeof candidate.snapshot !== "function" || typeof candidate.recordManualPayment !== "function" || typeof candidate.saveLedgerTransaction !== "function") {
    throw packetError("rent_ops_service_unconfigured", "The transaction-bound Rent Operations service is unavailable.");
  }
  return candidate as RentOpsTenantAccountCommandService;
}

function mraLedgerCategory(line: IntakeLineRecord): RentOpsLedgerTransaction["category"] {
  switch (line.category) {
    case "rent": return "base_rent";
    case "hap": return "subsidy";
    case "deposit": return "security_deposit";
    case "fee": return "one_time_fee";
    case "credit": return "unapplied_cash";
    case "refund": return "other";
    case "adjustment": return "other";
    case "other": return "other";
    case "unknown": return null;
  }
}

function mraPaymentCategory(line: IntakeLineRecord): "base_rent" | "recurring_fee" | "one_time_fee" | "unapplied_cash" | "other" {
  switch (line.category) {
    case "rent": return "base_rent";
    case "fee": return "one_time_fee";
    case "credit": return "unapplied_cash";
    case "refund":
    case "adjustment":
    case "other": return "other";
    default: throw packetError("mra_category_requires_review", `MRA category ${line.category} requires the typed ledger path.`);
  }
}

function mraPayer(line: IntakeLineRecord): NonNullable<RentOpsLedgerTransaction["payer"]> {
  if (line.payer === "tenant") return "tenant";
  if (line.payer === "hap") return "agency";
  throw packetError("mra_payer_requires_review", `MRA payer ${line.payer} cannot be represented by the legacy tenant ledger without losing custody meaning.`);
}

function lineRequiresSemanticReview(line: Pick<IntakeLineRecord, "transactionKind" | "direction">): boolean {
  return line.transactionKind !== "payment" || line.direction !== "inflow";
}

function heldOutcome(line: Pick<IntakeLineRecord, "outcome">): boolean {
  return line.outcome === "held_missing_identity" || line.outcome === "held_ambiguous_identity" || line.outcome === "held_unsupported";
}

function assertMappingScope(line: IntakeLineRecord, mapping: MraMapping, snapshot: RentOpsSnapshot, requestedScope: CompanyScope): { tenancy?: RentOpsSnapshot["tenancies"][number]; unit?: RentOpsSnapshot["units"][number] } {
  const tenancyId = mapping.tenancyId ?? (mapping.localTargetKind === "tenant_account" ? mapping.localTargetId : undefined);
  const tenancy = tenancyId ? snapshot.tenancies.find(row => row.id === tenancyId) : undefined;
  const unit = tenancy ? snapshot.units.find(row => row.id === tenancy.unitId) : mapping.localTargetKind === "unit_account" ? snapshot.units.find(row => row.id === mapping.localTargetId) : undefined;
  const actualPropertyId = unit?.propertyId ?? tenancy?.propertyId;
  const mappedPropertyId = mapping.propertyId ?? (mapping.localTargetKind === "property_account" ? mapping.localTargetId : undefined);
  if (requestedScope.propertyId && (actualPropertyId ?? mappedPropertyId) !== requestedScope.propertyId) throw packetError("mra_mapping_scope_mismatch", "The mapped tenancy, unit, or property is outside the packet property scope.");
  if (mappedPropertyId && actualPropertyId && mappedPropertyId !== actualPropertyId) throw packetError("mra_mapping_scope_mismatch", "The mapped property does not match the selected tenancy or unit.");
  if (mapping.localTargetKind === "tenant_account" && !tenancy) throw packetError("mra_tenancy_required", "The selected tenant account does not resolve to an exact tenancy.");
  if (mapping.localTargetKind === "unit_account" && !unit) throw packetError("mra_unit_required", "The selected unit account does not resolve to an exact unit.");
  if (line.propertySourceId && !actualPropertyId && !mappedPropertyId && requestedScope.propertyId === undefined) throw packetError("mra_mapping_scope_mismatch", "A source property identity requires an explicit reviewed local property mapping.");
  return { tenancy, unit };
}

function mraPaymentId(packet: MraPacketRecord, line: IntakeLineRecord): string {
  return `mra-payment:${createHash("sha256").update(`${packet.id}\u0000${line.sourceLineKey}`).digest("hex")}`;
}

/**
 * Default apply adapter for the existing Rent Operations command surface.
 * Rent and fee lines with an exact tenancy use recordManualPayment (and its
 * idempotent auto-allocation); HAP, deposit, and other typed lines use the
 * transaction-bound ledger command so their payer/category survives. The
 * adapter deliberately holds unsupported custody states instead of mapping
 * PM-custodian or bank-settled money to a tenant or owner.
 */
export function createTenantAccountApplyPort(options: TenantAccountApplyAdapterOptions): TenantAccountApplyPort {
  if (!options.actorSubject.trim()) throw new Error("A server actor is required for MRA account apply.");
  const now = options.now ?? (() => new Date());
  return {
    async applyLine(context) {
      const service = tenantAccountCommandService(context.rentOpsService);
      const mapping = context.sourceLine.mapping;
      if (!mapping || mapping.outcome !== "exact" || !mapping.localTargetId) throw packetError("mra_mapping_required", "An exact local target is required before applying an MRA line.");
      if (lineRequiresSemanticReview(context.sourceLine)) throw packetError("mra_semantic_requires_review", "Only a reviewed incoming payment source line can update a tenant account.");
      const amountCents = centsToLegacyNumber(context.sourceLine.amountCents);
      if (amountCents <= 0) throw packetError("mra_amount_invalid", "MRA account apply requires a positive line amount.");
      const actorContext = { actorSubject: options.actorSubject, occurredAt: now().toISOString() };
      const payer = mraPayer(context.sourceLine);
      const category = mraLedgerCategory(context.sourceLine);
      if (!category) throw packetError("mra_category_requires_review", "An unknown MRA category cannot be posted to a tenant account.");
      const snapshot = await service.snapshot();
      const scoped = assertMappingScope(context.sourceLine, mapping, snapshot, context.packet.scope);
      const tenancy = scoped.tenancy;
      const unit = scoped.unit;
      const propertyId = mapping.propertyId ?? unit?.propertyId ?? tenancy?.propertyId ?? (mapping.localTargetKind === "property_account" ? mapping.localTargetId : undefined);
      if (!propertyId) throw packetError("mra_property_required", "An exact property or tenant account is required before apply.");
      if (context.sourceLine.payer === "hap") throw packetError("mra_hap_allocation_requires_review", "HAP receipts require a compatible subsidy allocation command before they can be applied.");
      if (payer === "tenant" && (category === "base_rent" || category === "one_time_fee" || category === "other" || category === "unapplied_cash") && tenancy) {
        const saved = await service.recordManualPayment({
          id: mraPaymentId(context.packet, context.sourceLine),
          tenancyId: tenancy.id,
          amountCents,
          postedOn: context.sourceLine.postedOn,
          paymentMethod: "other",
          description: context.sourceLine.description ?? `MRA ${context.sourceLine.category}`,
          category: mraPaymentCategory(context.sourceLine),
          allocations: [],
          autoAllocate: true,
        }, actorContext);
        return { affectedRecordIds: [saved.payment.id as RecordReferenceId], appliedCents: context.sourceLine.amountCents, eventKey: `mra:${context.packet.id}:${context.sourceLine.sourceLineKey}` };
      }
      const transaction: RentOpsLedgerTransaction = {
        id: mraPaymentId(context.packet, context.sourceLine),
        propertyId,
        unitId: unit?.id ?? (mapping.localTargetKind === "unit_account" ? mapping.localTargetId : null),
        tenancyId: tenancy?.id ?? null,
        personId: mapping.personId ?? tenancy?.primaryPersonId ?? null,
        kind: "payment",
        category,
        categoryKnowledge: "manual",
        status: "posted",
        amountCents,
        postedOn: context.sourceLine.postedOn as IsoDate,
        dueOn: context.sourceLine.dueOn ?? null,
        paymentMethod: "other",
        paymentMethodKnowledge: "manual",
        description: context.sourceLine.description ?? `MRA ${context.sourceLine.category}`,
        payer,
        payerKnowledge: "manual",
        propertyLinkKnowledge: "manual",
        unitLinkKnowledge: unit || mapping.localTargetKind === "unit_account" ? "manual" : "unknown",
        tenancyLinkKnowledge: tenancy ? "manual" : "unknown",
        personLinkKnowledge: mapping.personId || tenancy?.primaryPersonId ? "manual" : "unknown",
        amountKnowledge: "known",
        postedOnKnowledge: "manual",
        dueOnKnowledge: context.sourceLine.dueOn ? "manual" : "unknown",
        descriptionKnowledge: "manual",
        statusKnowledge: "manual",
        chargeDefinitionId: null,
        chargeDefinitionLinkKnowledge: "unknown",
      };
      const saved = await service.saveLedgerTransaction(transaction);
      return { affectedRecordIds: [saved.id as RecordReferenceId], appliedCents: context.sourceLine.amountCents, eventKey: `mra:${context.packet.id}:${context.sourceLine.sourceLineKey}` };
    },
  };
}

export interface IntakeRentOpsFactory {
  (executor: RentOpsQueryExecutor): unknown;
}

export interface ProjectCostDeduplicationPort {
  findBySourceLine(input: { readonly organizationId: string; readonly sourceLineKey: string }): Promise<{ readonly draftCostId: string } | undefined>;
}

export interface IntakeServiceOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly documentStorage?: ContentAddressedObjectStore;
  readonly store?: IntakeStore;
  readonly now?: () => Date;
  readonly sourceAdapters?: readonly MraSourceAdapter[];
  readonly rentOpsFactory?: IntakeRentOpsFactory;
  readonly tenantAccountWriter?: TenantAccountApplyPort;
  readonly projectCostDeduplication?: ProjectCostDeduplicationPort;
  /** Internal root-command seam: the supplied executor already owns a SQL transaction. */
  readonly transactionBound?: boolean;
}

export interface MraCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly transport: TransportAttestation;
}

export interface MraPacketStageInput {
  readonly scope: CompanyScope;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
  readonly documentId?: string;
}

export interface MraPacketApplyResult {
  readonly packet: MraPacketRecord;
  readonly appliedLineCount: number;
  readonly failedLineCount: number;
  readonly heldLineCount: number;
  readonly affectedRecordIds: readonly RecordReferenceId[];
  readonly validationOutcomes: readonly { readonly code: string; readonly message: string; readonly lineKey?: string }[];
}

export const mraIngestionActionSchema = z.object({
  action: z.enum(["map", "preview", "apply"]),
  packetId: z.string().min(1).max(160),
  mappings: z.array(mraMappingSchema).max(100_000).optional(),
}).strict();
export type MraIngestionAction = z.infer<typeof mraIngestionActionSchema>;

function isoNow(clock: () => Date): IsoTimestamp {
  return isoTimestampSchema.parse(clock().toISOString());
}

function packetError(code: string, message: string): Error {
  return new ValidationCommandError(message, { reason: code });
}

function addCents(map: Map<string, bigint>, currency: string, value: string): void {
  map.set(currency, (map.get(currency) ?? BigInt(0)) + centsToBigInt(value));
}

function sumByCurrency(lines: readonly IntakeLineRecord[], predicate: (line: IntakeLineRecord) => boolean): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const line of lines) if (predicate(line)) addCents(result, line.currency, line.amountCents);
  return result;
}

function totalRows(input: Map<string, bigint>, matched: Map<string, bigint>, held: Map<string, bigint>, duplicate: Map<string, bigint>, overlap: Map<string, bigint>, applied: Map<string, bigint>): IntakeAmountTotals[] {
  const currencies = new Set<string>([...Array.from(input.keys()), ...Array.from(matched.keys()), ...Array.from(held.keys()), ...Array.from(duplicate.keys()), ...Array.from(overlap.keys()), ...Array.from(applied.keys())]);
  return Array.from(currencies).sort().map((currency) => intakeAmountTotalsSchema.parse({ currency, inputCents: centsFromBigInt(input.get(currency) ?? BigInt(0)), matchedCents: centsFromBigInt(matched.get(currency) ?? BigInt(0)), heldCents: centsFromBigInt(held.get(currency) ?? BigInt(0)), duplicateCents: centsFromBigInt(duplicate.get(currency) ?? BigInt(0)), overlapCents: centsFromBigInt(overlap.get(currency) ?? BigInt(0)), appliedCents: centsFromBigInt(applied.get(currency) ?? BigInt(0)) }));
}

function accountOutcomes(lines: readonly IntakeLineRecord[]): IntakeAccountOutcome[] {
  const grouped = new Map<string, IntakeLineRecord[]>();
  for (const line of lines) {
    const group = grouped.get(line.sourceAccountId) ?? [];
    group.push(line);
    grouped.set(line.sourceAccountId, group);
  }
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([sourceAccountId, accountLines]) => {
    const heldCount = accountLines.filter(heldOutcome).length;
    const appliedCount = accountLines.filter((line) => line.outcome === "applied").length;
    const matchedCount = accountLines.filter((line) => line.outcome === "matched" || line.outcome === "corrected" || line.outcome === "applied").length;
    const state: IntakeAccountOutcome["state"] = heldCount > 0 && appliedCount === 0 ? "held" : appliedCount === accountLines.length ? "applied" : appliedCount > 0 ? "failed" : "ready";
    return intakeAccountOutcomeSchema.parse({ sourceAccountId, sourceAccountName: accountLines[0]?.sourceAccountName ?? null, lineCount: accountLines.length, matchedCount, heldCount, appliedCount, state, message: heldCount > 0 ? "One or more lines require identity review." : null });
  });
}

function reconciliation(lines: readonly IntakeLineRecord[]): IntakeReconciliation {
  const input = sumByCurrency(lines, () => true);
  const matched = sumByCurrency(lines, (line) => line.outcome === "matched" || line.outcome === "corrected" || line.outcome === "applied");
  const held = sumByCurrency(lines, heldOutcome);
  const duplicate = sumByCurrency(lines, (line) => line.outcome === "duplicate");
  const overlap = sumByCurrency(lines, (line) => line.outcome === "overlap");
  const applied = sumByCurrency(lines, (line) => line.outcome === "applied");
  return intakeReconciliationSchema.parse({
    totals: totalRows(input, matched, held, duplicate, overlap, applied),
    accounts: accountOutcomes(lines),
    sourceLineCount: lines.length,
    matchedLineCount: lines.filter((line) => line.outcome === "matched" || line.outcome === "corrected" || line.outcome === "applied").length,
    heldLineCount: lines.filter(heldOutcome).length,
    duplicateLineCount: lines.filter((line) => line.outcome === "duplicate").length,
    overlapLineCount: lines.filter((line) => line.outcome === "overlap").length,
    correctedLineCount: lines.filter((line) => line.outcome === "corrected").length,
    appliedLineCount: lines.filter((line) => line.outcome === "applied").length,
  });
}

function readModel(packet: MraPacketRecord): MraPacketRecord {
  return mraPacketRecordSchema.parse(packet);
}

function updateLine(line: IntakeLineRecord, changes: Partial<IntakeLineRecord>): IntakeLineRecord {
  return intakeLineRecordSchema.parse({ ...line, ...changes });
}

function stateAfterPreview(lines: readonly IntakeLineRecord[]): IntakePacketState {
  const held = lines.some(heldOutcome);
  return held ? "held" : "previewed";
}

function emptyCandidate(message: string): MraPacketCandidate {
  return mraPacketCandidateSchema.parse({ format: "mra.owner_packet.v1", packetRevision: "unparsed", period: { from: "1970-01-01", through: "1970-01-01" }, accounts: [], extractionWarnings: [message] });
}

function assertPacketScope(packet: MraPacketRecord, scope: CompanyScope): void {
  if (packet.scope.organizationId !== scope.organizationId || packet.scope.legalEntityId !== scope.legalEntityId || packet.scope.propertyId !== scope.propertyId) throw packetError("scope_mismatch", "The packet is outside the requested company scope.");
}

function authorize(access: MraCommandAccess, envelope: CommandEnvelope<unknown>): void {
  // The attested object is created by the server adapter. Body fields cannot
  // choose Codex capability or bypass this policy.
  assertAuthorizedCommand(access.principal, access.transport, MRA_INGESTION_POLICY, envelope);
}

export function createIntakeService(options: IntakeServiceOptions) {
  const clock = options.now ?? (() => new Date());
  const store = options.store ?? new SqlIntakeStore(options.executor);

  function serviceForExecutor(executor: RentOpsQueryExecutor) {
    return createIntakeService({ ...options, executor, store: store instanceof SqlIntakeStore ? new SqlIntakeStore(executor) : store, transactionBound: true });
  }

  async function stageInTransaction(input: MraPacketStageInput, executor: RentOpsQueryExecutor): Promise<MraPacketRecord> {
    const scope = scopeForIntake(input.scope);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw packetError("source_bytes_required", "The MRA packet must contain source bytes.");
    if (input.bytes.byteLength > 50 * 1024 * 1024) throw packetError("source_too_large", "The MRA packet is larger than the 50 MB limit.");
    if (!options.documentStorage) throw packetError("document_storage_unconfigured", "The verified private document store is unavailable.");
    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    const existing = await store.findBySource(scope, checksum, executor);
    if (existing) return existing;
    const sourceDocumentId = input.documentId ?? `mra-packet:${randomUUID()}`;
    const prepared = await prepareVerifiedImportedDocument(options.documentStorage, {
      documentId: sourceDocumentId,
      type: "other",
      fileName: input.fileName,
      // MRA owners may send PDF, XLSX or structured exports. The existing
      // verified importer validates the bytes under octet-stream and the
      // declared source type is retained below for parsing and display.
      mimeType: "application/octet-stream",
      bytes: input.bytes,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: checksum,
      sourceBinaryBinding: {
        bindingId: `mra-source:${checksum}`,
        importRunId: `mra-packet:${checksum}`,
        sourceSystem: "mra",
        sourceCollection: "owner_packets",
        sourceIdHash: checksum,
      },
    });
    let candidate: MraPacketCandidate;
    let lines: IntakeLineRecord[] = [];
    let state: IntakePacketState = "staged";
    try {
      candidate = await parseMraSource({ bytes: input.bytes, fileName: input.fileName, declaredContentType: input.declaredContentType }, options.sourceAdapters);
      lines = candidate.accounts.flatMap((account) => account.lines.map((line) => intakeLineRecordSchema.parse({ ...line, providerTransactionId: line.providerTransactionId ?? null, originalSourceIdentity: line.originalSourceIdentity ?? line.providerTransactionId ?? line.sourceLineKey, sourceAccountName: line.sourceAccountName ?? account.sourceAccountName ?? null, mapping: null, outcome: null, outcomeReason: null, correctsSourceLineKey: line.correctsSourceLineKey ?? null, dueOn: line.dueOn ?? null, periodMonth: line.periodMonth ?? null, tenantSourceId: line.tenantSourceId ?? null, tenantDisplayName: line.tenantDisplayName ?? null, propertySourceId: line.propertySourceId ?? null, unitSourceId: line.unitSourceId ?? null, description: line.description ?? null })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "The packet parser is unavailable.";
      candidate = emptyCandidate(message);
      state = "failed";
    }
    const source = intakeSourceObjectSchema.parse({
      documentId: documentReferenceIdSchema.parse(prepared.document.id),
      fileName: input.fileName,
      declaredContentType: input.declaredContentType,
      sizeBytes: prepared.binding.sizeBytes,
      checksumSha256: prepared.binding.checksumSha256,
      backend: prepared.binding.backend,
      logicalKey: prepared.binding.logicalKey,
      ...(prepared.binding.immutableGeneration ? { immutableGeneration: prepared.binding.immutableGeneration } : {}),
      ...(prepared.binding.immutableVersion ? { immutableVersion: prepared.binding.immutableVersion } : {}),
      verifiedAt: isoTimestampSchema.parse(prepared.binding.verifiedAt),
    });
    const now = isoNow(clock);
    const packet = readModel({ id: newRecordId(), scope, state, source, candidate, lines, reconciliation: null, createdAt: now, updatedAt: now, mappedAt: null, previewedAt: null, appliedAt: null, revision: 1 });
    await store.create(packet, executor);
    return packet;
  }

  async function stage(input: MraPacketStageInput, envelope: CommandEnvelope<unknown>, access: MraCommandAccess): Promise<OperationReceipt & { packet?: MraPacketRecord }> {
    authorize(access, envelope);
    const result = await runCompanyCommand(options.executor, {
      envelope,
      principal: access.principal,
      resolvePrincipal: async () => access.principal,
      transport: access.transport,
      policy: MRA_INGESTION_POLICY,
      handler: async (context) => {
        const packet = await stageInTransaction(input, context.executor);
        return { state: "saved_in_rops", affectedRecordIds: [packet.id], resultingRevisions: [{ recordId: packet.id as RecordReferenceId, revision: revisionSchema.parse(packet.revision) }], validationOutcomes: [{ code: packet.state === "failed" ? "intake.parse.held" : "intake.packet.staged", severity: packet.state === "failed" ? "warning" : "info", message: packet.state === "failed" ? "The verified source is retained, but parsing requires review." : "The verified MRA source packet is staged in R-ops." }] } satisfies CommandHandlerResult;
      },
    });
    return result;
  }

  async function getPacket(scope: CompanyScope, packetId: string): Promise<MraPacketRecord> {
    const packet = await store.get(scopeForIntake(scope), packetId);
    if (!packet) throw packetError("packet_not_found", "The MRA packet was not found in the requested scope.");
    return readModel(packet);
  }

  async function mapPacket(scope: CompanyScope, packetId: string, mappings: readonly MraMapping[], access: MraCommandAccess, envelope: CommandEnvelope<unknown>): Promise<MraPacketRecord> {
    authorize(access, envelope);
    const packet = await getPacket(scope, packetId);
    if (packet.state === "applied" || packet.state === "applying") throw packetError("packet_state_invalid", "An applying or applied packet cannot be remapped.");
    const mapByKey = new Map(mappings.map((mapping) => [mapping.sourceLineKey, mraMappingSchema.parse(mapping)]));
    const lines = packet.lines.map((line) => mapByKey.get(line.sourceLineKey) ? updateLine(line, { mapping: mapByKey.get(line.sourceLineKey)! }) : line);
    const now = isoNow(clock);
    const next = readModel({ ...packet, state: "mapped", lines, updatedAt: now, mappedAt: now, revision: revisionSchema.parse(packet.revision + 1) });
    await withTransaction(options.executor, async (executor) => store.save(next, packet.revision, executor), options.transactionBound);
    return next;
  }

  async function previewPacket(scope: CompanyScope, packetId: string, access: MraCommandAccess, envelope: CommandEnvelope<unknown>): Promise<MraPacketRecord> {
    authorize(access, envelope);
    const packet = await getPacket(scope, packetId);
    if (packet.state === "failed") throw packetError("packet_parse_failed", "The source packet could not be parsed; a corrected packet is required.");
    if (packet.state === "applied" || packet.state === "applying") throw packetError("packet_state_invalid", "An applying or applied packet cannot be previewed again.");
    const lines: IntakeLineRecord[] = [];
    for (const line of packet.lines) {
      if (lineRequiresSemanticReview(line)) {
        lines.push(updateLine(line, { outcome: "held_unsupported", outcomeReason: "The source line is not explicitly identified as an incoming payment; no account change is allowed." }));
        continue;
      }
      if (!line.mapping || line.mapping.outcome !== "exact" || !line.mapping.localTargetId || line.mapping.localTargetKind === "unresolved") {
        const reason = line.mapping?.reason ?? "A reviewed local identity is required before apply.";
        lines.push(updateLine(line, { outcome: line.mapping?.outcome === "ambiguous" ? "held_ambiguous_identity" : "held_missing_identity", outcomeReason: reason }));
        continue;
      }
      const previous = await store.findLine(scope, line.sourceLineKey);
      if (previous && previous.packetId !== packet.id) {
        const corrected = line.correctsSourceLineKey === line.sourceLineKey || Boolean(line.correctsSourceLineKey && line.correctsSourceLineKey === previous.sourceRevision);
        lines.push(updateLine(line, { outcome: corrected ? "corrected" : previous.checksumSha256 === packet.source.checksumSha256 ? "duplicate" : "overlap", outcomeReason: corrected ? "This packet explicitly corrects an earlier source observation." : previous.checksumSha256 === packet.source.checksumSha256 ? "This source line was already staged." : "A different packet already claims this source line identity." }));
      } else {
        lines.push(updateLine(line, { outcome: "matched", outcomeReason: null }));
      }
    }
    const now = isoNow(clock);
    const next = readModel({ ...packet, state: stateAfterPreview(lines), lines, reconciliation: reconciliation(lines), updatedAt: now, previewedAt: now, revision: revisionSchema.parse(packet.revision + 1) });
    await withTransaction(options.executor, async (executor) => store.save(next, packet.revision, executor), options.transactionBound);
    return next;
  }

  async function applyPacket(scope: CompanyScope, packetId: string, access: MraCommandAccess, envelope: CommandEnvelope<unknown>): Promise<MraPacketApplyResult> {
    authorize(access, envelope);
    let packet = await getPacket(scope, packetId);
    if (!packet.reconciliation || (packet.state !== "previewed" && packet.state !== "held" && packet.state !== "partially_applied" && packet.state !== "applying")) throw packetError("packet_preview_required", "Preview the packet before applying account changes.");
    if (!options.tenantAccountWriter) throw packetError("tenant_account_writer_unconfigured", "The tenant-account command adapter is not configured; no account changes were made.");
    const applying = readModel({ ...packet, state: "applying", updatedAt: isoNow(clock), revision: revisionSchema.parse(packet.revision + 1) });
    await withTransaction(options.executor, async (executor) => store.save(applying, packet.revision, executor), options.transactionBound);
    packet = applying;
    const affected: RecordReferenceId[] = [];
    const validationOutcomes: Array<{ code: string; message: string; lineKey?: string }> = [];
    const grouped = new Map<string, IntakeLineRecord[]>();
    for (const line of packet.lines) if (line.outcome === "matched" || line.outcome === "corrected" || line.outcome === "apply_failed") {
      const key = line.mapping?.localTargetId;
      if (!key) continue;
      const list = grouped.get(key) ?? [];
      list.push(line);
      grouped.set(key, list);
    }
    let appliedCount = 0;
    let failedCount = 0;
    for (const group of Array.from(grouped.values())) {
      const groupKeys = new Set(group.map((line) => line.sourceLineKey));
      const groupAffected: RecordReferenceId[] = [];
      let groupAppliedCount = 0;
      try {
        await withTransaction(options.executor, async (executor) => {
          const txPacket = await store.get(scopeForIntake(scope), packet.id, executor) ?? packet;
          const rentOpsService = options.rentOpsFactory?.(executor);
          const nextLines = txPacket.lines.map((line) => groupKeys.has(line.sourceLineKey) ? line : line);
          for (const line of group) {
            const result = await options.tenantAccountWriter!.applyLine({ executor, packet: txPacket, sourceLine: line, idempotencyKey: `${envelope.idempotencyKey}:${line.sourceLineKey}`, rentOpsService });
            groupAffected.push(...result.affectedRecordIds);
            groupAppliedCount += 1;
            const index = nextLines.findIndex((candidate) => candidate.sourceLineKey === line.sourceLineKey);
            if (index >= 0) nextLines[index] = updateLine(nextLines[index]!, { outcome: "applied", outcomeReason: null });
          }
          const next = readModel({ ...txPacket, state: "partially_applied", lines: nextLines, reconciliation: reconciliation(nextLines), updatedAt: isoNow(clock), revision: revisionSchema.parse(txPacket.revision + 1) });
          await store.save(next, txPacket.revision, executor);
          packet = next;
        }, options.transactionBound);
        affected.push(...groupAffected);
        appliedCount += groupAppliedCount;
      } catch (error) {
        failedCount += group.length;
        const message = error instanceof Error ? error.message : "Tenant account update failed.";
        validationOutcomes.push({ code: "intake.account.apply_failed", message, lineKey: group[0]?.sourceLineKey });
        const latest = await getPacket(scope, packet.id);
        const failedLines = latest.lines.map((line) => groupKeys.has(line.sourceLineKey) ? updateLine(line, { outcome: "apply_failed", outcomeReason: message }) : line);
        const failed = readModel({ ...latest, state: "partially_applied", lines: failedLines, reconciliation: reconciliation(failedLines), updatedAt: isoNow(clock), revision: revisionSchema.parse(latest.revision + 1) });
        await withTransaction(options.executor, async (executor) => store.save(failed, latest.revision, executor), options.transactionBound);
        packet = failed;
      }
    }
    const finalPacket = readModel({ ...packet, state: failedCount > 0 ? "partially_applied" : packet.lines.some(heldOutcome) ? "held" : "applied", appliedAt: failedCount === 0 ? isoNow(clock) : packet.appliedAt, updatedAt: isoNow(clock), revision: revisionSchema.parse(packet.revision + 1) });
    await withTransaction(options.executor, async (executor) => store.save(finalPacket, packet.revision, executor), options.transactionBound);
    return { packet: finalPacket, appliedLineCount: appliedCount, failedLineCount: failedCount, heldLineCount: finalPacket.lines.filter(heldOutcome).length, affectedRecordIds: Array.from(new Set(affected)), validationOutcomes };
  }

  async function previewProjectCost(candidateInput: ProjectCostCandidate): Promise<ProjectCostPreview> {
    const candidate = projectCostCandidateSchema.parse(candidateInput);
    const duplicate = await options.projectCostDeduplication?.findBySourceLine({ organizationId: candidate.scope.organizationId, sourceLineKey: candidate.sourceLineKey });
    if (duplicate) return projectCostPreviewSchema.parse({ candidate, outcome: "duplicate", reason: `Draft cost ${duplicate.draftCostId} already uses this source line.` });
    return projectCostPreviewSchema.parse({ candidate, outcome: "new_draft", reason: null });
  }

  function buildProjectDraftCostCommand(candidateInput: ProjectCostCandidate, sourceDocumentId: string): ProjectDraftCostCommandInput {
    const candidate = projectCostCandidateSchema.parse(candidateInput);
    return { kind: "project.draft_cost.create", scope: candidate.scope, projectId: candidate.projectId, ...(candidate.scopeItemId ? { scopeItemId: candidate.scopeItemId } : {}), vendorName: candidate.vendorName ?? null, description: candidate.description, amountCents: candidate.amountCents, incurredOn: candidate.incurredOn, sourceLineKey: candidate.sourceLineKey, sourceDocumentId };
  }

  async function runAction(action: MraIngestionAction, access: MraCommandAccess, envelope: CommandEnvelope<unknown>): Promise<MraPacketRecord | MraPacketApplyResult> {
    authorize(access, envelope);
    if (action.action === "map") return mapPacket((envelope.scope), action.packetId, action.mappings ?? [], access, envelope);
    if (action.action === "preview") return previewPacket(envelope.scope, action.packetId, access, envelope);
    return applyPacket(envelope.scope, action.packetId, access, envelope);
  }

  const api = {
    executor: options.executor,
    store,
    stage,
    stageInTransaction,
    getPacket,
    mapPacket,
    previewPacket,
    applyPacket,
    previewProjectCost,
    buildProjectDraftCostCommand,
    runAction,
    serviceForExecutor,
  };
  return api;
}

export type IntakeService = ReturnType<typeof createIntakeService>;

async function withTransaction<T>(executor: RentOpsQueryExecutor, work: (transaction: RentOpsQueryExecutor) => Promise<T>, alreadyBound = false): Promise<T> {
  if (alreadyBound) {
    // Root executes intake inside the durable company command transaction.
    // Account groups still need savepoints so one malformed line rolls back
    // the whole group without aborting unrelated accounts or the command.
    const savepoint = `intake_${randomUUID().replaceAll("-", "")}`;
    await executor.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await work(executor);
      await executor.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await executor.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await executor.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  if (typeof executor.transaction !== "function") throw packetError("atomic_transaction_required", "Intake changes require an atomic SQL transaction.");
  return executor.transaction(work, { readOnly: false });
}

export async function executeMraIngestionCommand(
  executor: RentOpsQueryExecutor,
  kind: "mra_ingestion",
  rawEnvelope: unknown,
  options: {
    readonly principal: AuthenticatedPrincipal;
    readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
    readonly transport: TransportAttestation;
    readonly service: IntakeService;
  },
): Promise<OperationReceipt> {
  const envelope = commandEnvelopeSchema(mraIngestionActionSchema).parse(rawEnvelope) as CommandEnvelope<MraIngestionAction>;
  if (kind !== MRA_INGESTION_POLICY.commandKind) throw new ValidationCommandError("Unsupported MRA command kind", { reason: "invalid_command_kind" });
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: MRA_INGESTION_POLICY,
    handler: async (context) => {
      const action = envelope.payload;
      const access = { principal: context.principal, transport: context.transport };
      const transactionService = options.service.serviceForExecutor(context.executor);
      if (action.action === "map") await transactionService.mapPacket(envelope.scope, action.packetId, action.mappings ?? [], access, envelope);
      else if (action.action === "preview") await transactionService.previewPacket(envelope.scope, action.packetId, access, envelope);
      else await transactionService.applyPacket(envelope.scope, action.packetId, access, envelope);
      return { state: "saved_in_rops", affectedRecordIds: [action.packetId], resultingRevisions: [], validationOutcomes: [{ code: `intake.${action.action}.saved`, severity: "info", message: `MRA ${action.action} result saved in R-ops.` }] };
    },
  });
}
