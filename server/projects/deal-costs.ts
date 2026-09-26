import { createHash } from "node:crypto";
import {
  assertExpectedRevision,
  centsFromBigInt,
  centsToBigInt,
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  type CommandEnvelope,
  type MoneyCents,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  calculateProjectDealCostReport,
  dealCostLaneSchema,
  dealCostSourceKindSchema,
  dealFundingKindSchema,
  dealReconciliationStateSchema,
  projectDealCostCommandPayloadSchemas,
  projectDealCostIdSchema,
  projectDealCostQuerySchema,
  projectDealCostReportSchema,
  projectDealCostSchema,
  projectDealFundingIdSchema,
  projectDealFundingSchema,
  projectDealSaleForecastIdSchema,
  projectDealSaleForecastSchema,
  PROJECT_DEAL_COST_COMMAND_KINDS,
  type DealCoverageState,
  type DealCostLane,
  type ProjectDealCost,
  type ProjectDealCostCommandKind,
  type ProjectDealCostCommandPayload,
  type ProjectDealCostReport,
  type ProjectDealFunding,
  type ProjectDealSaleForecast,
} from "../../shared/projects";
import { dealSettlementProofSchema } from "../../shared/projects/deal-costs";
import {
  financialSourceCoverageSchema,
  financialSourceLineResolutionSchema,
  financialSourceReferenceSchema,
  financialSourceReferenceKey,
  type FinancialSourceAllocationPort,
  type FinancialProviderCostContextPort,
  type FinancialSourceLineResolution,
  type FinancialSourceReadPort,
  type FinancialSourceReference,
} from "../../shared/accounting/source";
import type { ProjectFinanceReadPort, ProjectFinanceActual } from "../../shared/projects/execution-contracts";
import {
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "../company/authorization";
import {
  runCompanyCommand,
  type CommandHandlerContext,
  type CommandHandlerResult,
} from "../company/commands/runner";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ProjectReadService } from "./service";
import { readCanonicalProjectCostReport } from "./insights";
import {
  assertEntityPropertyUnit,
  assertProjectPropertyAccess,
  assertProjectScope,
  dbCents,
  dbDate,
  dbNullableCents,
  dbNullableDate,
  dbNullableString,
  dbNullableTimestamp,
  dbRevision,
  dbString,
  dbTimestamp,
  resolveEffectiveDate,
} from "./helpers";
import { unavailableProjectFinanceReadPort } from "../../shared/projects";

const DEAL_COST_WRITE_ROLES = ["owner", "admin", "operations_pm", "project_manager", "finance"] as const;

export interface ProjectDealCostFinancePorts {
  readonly source: FinancialSourceReadPort;
  readonly allocations?: FinancialSourceAllocationPort;
  readonly costContext?: FinancialProviderCostContextPort;
}

export interface ProjectDealCostCommandOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
  readonly financeFactory?: (executor: RentOpsQueryExecutor) => ProjectDealCostFinancePorts;
}

export const PROJECT_DEAL_COST_COMMAND_POLICIES: Readonly<Record<ProjectDealCostCommandKind, CommandAuthorizationPolicy>> = Object.freeze(
  Object.fromEntries(PROJECT_DEAL_COST_COMMAND_KINDS.map((commandKind) => [commandKind, {
    commandKind,
    allowedRoles: DEAL_COST_WRITE_ROLES,
  }])) as unknown as Record<ProjectDealCostCommandKind, CommandAuthorizationPolicy>,
);

type AnyDealCostEnvelope = CommandEnvelope<Record<string, unknown>>;
type DealCostCommandContext = CommandHandlerContext<unknown> & { readonly finance?: ProjectDealCostFinancePorts };

function sourceKey(source: FinancialSourceReference): string {
  return financialSourceReferenceKey(source);
}

function sourceReferenceHash(source: FinancialSourceReference): string {
  return createHash("sha256").update(sourceKey(source), "utf8").digest("hex");
}

const QBO_COST_CLASSIFICATIONS = new Set(["expense", "cogs", "capitalized_cost"]);
const QBO_FUNDING_CLASSIFICATIONS = new Set(["bank", "liability", "equity", "income", "other_asset"]);
type QboContextPurpose = "cost" | "funding";

/**
 * Provider context must still describe the exact line being classified. The
 * source mirror is the authority for account, amount, currency and posting
 * date; callers cannot turn an expense line into funding by relabeling it.
 */
async function qboContextIsEligible(
  finance: ProjectDealCostFinancePorts,
  source: FinancialSourceReference,
  line: FinancialSourceLineResolution,
  purpose: QboContextPurpose,
): Promise<boolean> {
  if (!finance.costContext) return false;
  const context = await finance.costContext.readCostContext({
    scope: {
      provider: source.provider,
      organizationId: source.organizationId,
      legalEntityId: source.legalEntityId,
      environment: source.environment,
      realmId: source.realmId,
    },
    objectType: source.objectType,
    objectId: source.objectId,
    lineId: source.lineId ?? undefined,
  });
  if (!context
    || sourceKey(context.source) !== sourceKey(line.source)
    || context.accountObjectId !== line.accountObjectId
    || context.amountCents !== line.amountCents
    || context.currency !== line.currency
    || context.postedOn !== line.postedOn
    || context.postingState !== "posted") return false;
  return purpose === "cost"
    ? context.eligible && QBO_COST_CLASSIFICATIONS.has(context.classification)
    : QBO_FUNDING_CLASSIFICATIONS.has(context.classification);
}

function dbJsonObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationCommandError("Project storage returned invalid settlement proof", { reason: "invalid_deal_cost_settlement_proof", field });
  }
  return value as Record<string, unknown>;
}

function sourceFromRow(row: Record<string, unknown>): FinancialSourceReference | null {
  if (row.source_provider === null || row.source_provider === undefined) return null;
  return financialSourceReferenceSchema.parse({
    provider: dbString(row.source_provider, "source_provider"),
    organizationId: dbString(row.organization_id, "organization_id"),
    legalEntityId: dbString(row.source_legal_entity_id ?? row.legal_entity_id, "source_legal_entity_id"),
    environment: dbString(row.source_environment, "source_environment"),
    realmId: dbString(row.source_realm_id, "source_realm_id"),
    objectType: dbString(row.source_object_type, "source_object_type"),
    objectId: dbString(row.source_object_id, "source_object_id"),
    lineId: dbNullableString(row.source_line_id, "source_line_id"),
    version: dbString(row.source_version, "source_version"),
  });
}

function mapCostRow(row: Record<string, unknown>): ProjectDealCost {
  return projectDealCostSchema.parse({
    id: projectDealCostIdSchema.parse(dbString(row.id, "deal_cost_id")),
    projectId: dbString(row.project_id, "deal_cost_project_id"),
    entryKind: "cost",
    lane: dealCostLaneSchema.parse(dbString(row.lane, "deal_cost_lane")),
    description: dbString(row.description, "deal_cost_description"),
    vendorName: dbNullableString(row.vendor_name, "deal_cost_vendor_name"),
    budgetCents: dbNullableCents(row.budget_cents, "deal_cost_budget_cents"),
    amountCents: dbNullableCents(row.amount_cents, "deal_cost_amount_cents"),
    forecastCents: dbNullableCents(row.forecast_cents, "deal_cost_forecast_cents"),
    paidCents: dbNullableCents(row.paid_cents, "deal_cost_paid_cents"),
    incurredOn: dbNullableDate(row.incurred_on, "deal_cost_incurred_on"),
    paidOn: dbNullableDate(row.paid_on, "deal_cost_paid_on"),
    prepaid: row.prepaid === true,
    sourceKind: dealCostSourceKindSchema.parse(dbString(row.source_kind, "deal_cost_source_kind")),
    reconciliationState: dealReconciliationStateSchema.parse(dbString(row.reconciliation_state, "deal_cost_reconciliation_state")),
    sourceRecordRef: dbNullableString(row.source_record_ref, "deal_cost_source_record_ref"),
    sourceReferenceHash: dbNullableString(row.source_reference_hash, "deal_cost_source_reference_hash"),
    source: sourceFromRow(row),
    settlementProof: row.settlement_proof === null || row.settlement_proof === undefined ? null : dealSettlementProofSchema.parse(dbJsonObject(row.settlement_proof, "settlement_proof")),
    recordRevision: dbRevision(row.record_revision, "deal_cost_record_revision"),
    updatedAt: dbTimestamp(row.updated_at, "deal_cost_updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "deal_cost_archived_at"),
  });
}

function mapFundingRow(row: Record<string, unknown>): ProjectDealFunding {
  return projectDealFundingSchema.parse({
    id: projectDealFundingIdSchema.parse(dbString(row.id, "deal_funding_id")),
    projectId: dbString(row.project_id, "deal_funding_project_id"),
    entryKind: "funding",
    fundingKind: dealFundingKindSchema.parse(dbString(row.funding_kind, "deal_funding_kind")),
    description: dbString(row.description, "deal_funding_description"),
    amountCents: dbCents(row.amount_cents, "deal_funding_amount_cents"),
    fundedOn: dbDate(row.funded_on, "deal_funding_funded_on"),
    sourceKind: dealCostSourceKindSchema.parse(dbString(row.source_kind, "deal_funding_source_kind")),
    reconciliationState: dealReconciliationStateSchema.parse(dbString(row.reconciliation_state, "deal_funding_reconciliation_state")),
    sourceRecordRef: dbNullableString(row.source_record_ref, "deal_funding_source_record_ref"),
    sourceReferenceHash: dbNullableString(row.source_reference_hash, "deal_funding_source_reference_hash"),
    source: sourceFromRow(row),
    settlementProof: row.settlement_proof === null || row.settlement_proof === undefined ? null : dealSettlementProofSchema.parse(dbJsonObject(row.settlement_proof, "settlement_proof")),
    recordRevision: dbRevision(row.record_revision, "deal_funding_record_revision"),
    updatedAt: dbTimestamp(row.updated_at, "deal_funding_updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "deal_funding_archived_at"),
  });
}

function mapSaleForecastRow(row: Record<string, unknown>): ProjectDealSaleForecast {
  return projectDealSaleForecastSchema.parse({
    id: projectDealSaleForecastIdSchema.parse(dbString(row.id, "sale_forecast_id")),
    projectId: dbString(row.project_id, "sale_forecast_project_id"),
    entryKind: "sale_forecast",
    grossProceedsCents: dbCents(row.gross_proceeds_cents, "sale_forecast_gross_proceeds_cents"),
    saleOn: dbNullableDate(row.sale_on, "sale_forecast_sale_on"),
    sourceKind: "estimate",
    reconciliationState: "unreconciled",
    recordRevision: dbRevision(row.record_revision, "sale_forecast_record_revision"),
    updatedAt: dbTimestamp(row.updated_at, "sale_forecast_updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "sale_forecast_archived_at"),
  });
}

const DEAL_LEDGER_SELECT = `
  SELECT d.id, d.organization_id, d.project_id, d.entry_kind, d.lane, d.funding_kind,
         d.description, d.vendor_name, d.budget_cents::text AS budget_cents,
         d.amount_cents::text AS amount_cents, d.forecast_cents::text AS forecast_cents,
         d.paid_cents::text AS paid_cents, d.incurred_on, d.paid_on, d.prepaid,
         d.funded_on, d.gross_proceeds_cents::text AS gross_proceeds_cents, d.sale_on,
         d.source_kind, d.reconciliation_state, d.source_record_ref, d.source_reference_hash,
         d.source_provider, d.source_legal_entity_id, d.source_environment, d.source_realm_id,
         d.source_object_type, d.source_object_id, d.source_line_id, d.source_version,
         d.settlement_proof, d.record_revision, d.updated_at, d.archived_at
    FROM company_project_deal_ledger d
   WHERE d.organization_id = $1 AND d.project_id = $2
   ORDER BY d.updated_at DESC, d.id DESC`;

const DEAL_LEDGER_ROW_SELECT = `
  SELECT d.id, d.organization_id, d.project_id, d.entry_kind, d.lane, d.funding_kind,
         d.description, d.vendor_name, d.budget_cents::text AS budget_cents,
         d.amount_cents::text AS amount_cents, d.forecast_cents::text AS forecast_cents,
         d.paid_cents::text AS paid_cents, d.incurred_on, d.paid_on, d.prepaid,
         d.funded_on, d.gross_proceeds_cents::text AS gross_proceeds_cents, d.sale_on,
         d.source_kind, d.reconciliation_state, d.source_record_ref, d.source_reference_hash,
         d.source_provider, d.source_legal_entity_id, d.source_environment, d.source_realm_id,
         d.source_object_type, d.source_object_id, d.source_line_id, d.source_version,
         d.settlement_proof, d.record_revision, d.updated_at, d.archived_at
    FROM company_project_deal_ledger d
   WHERE d.organization_id = $1 AND d.id = $2 AND d.archived_at IS NULL`;

function mapFinanceActual(actual: ProjectFinanceActual, rehabScopeItemIds: ReadonlySet<string>): ProjectDealCost {
  const settlement = actual.settlement;
  const signedActual = centsToBigInt(actual.amountCents);
  // A negative source amount is a correction/refund, not proof of a positive
  // cash settlement. Keep payment unknown until the refund path has its own
  // evidence model rather than manufacturing a non-negative payment amount.
  const hasSettledPayment = signedActual >= BigInt(0)
    && settlement?.state === "settled"
    && settlement.settledOn !== null
    && settlement.settledAmountCents !== null
    && centsToBigInt(settlement.settledAmountCents) >= BigInt(0);
  const lane = actual.scopeItemId !== null && rehabScopeItemIds.has(String(actual.scopeItemId)) ? "rehab" : "unallocated";
  return projectDealCostSchema.parse({
    id: projectDealCostIdSchema.parse(String(actual.id)),
    projectId: actual.projectId,
    entryKind: "cost",
    lane,
    description: actual.description,
    vendorName: null,
    budgetCents: null,
    amountCents: actual.amountCents,
    forecastCents: null,
    paidCents: hasSettledPayment ? settlement!.settledAmountCents : null,
    incurredOn: actual.postedOn,
    paidOn: hasSettledPayment ? settlement!.settledOn : null,
    prepaid: false,
    sourceKind: "qbo",
    reconciliationState: "qbo_verified",
    sourceRecordRef: null,
    sourceReferenceHash: sourceReferenceHash(actual.source),
    source: actual.source,
    settlementProof: hasSettledPayment ? { kind: "qbo", reference: sourceKey(actual.source), observedOn: settlement!.settledOn!, amountCents: settlement!.settledAmountCents } : null,
    recordRevision: 1,
    updatedAt: `${actual.postedOn}T00:00:00.000Z`,
    archivedAt: null,
  });
}

function mapDraftCost(draft: { id: string; projectId: string; description: string; vendorName: string | null; amountCents: string; incurredOn: string }): ProjectDealCost {
  return projectDealCostSchema.parse({
    id: projectDealCostIdSchema.parse(String(draft.id)),
    projectId: draft.projectId,
    entryKind: "cost",
    lane: "rehab",
    description: draft.description,
    vendorName: draft.vendorName,
    budgetCents: null,
    amountCents: draft.amountCents,
    forecastCents: null,
    paidCents: null,
    incurredOn: draft.incurredOn,
    paidOn: null,
    prepaid: false,
    sourceKind: "operational",
    // Existing rehab draft rows are kept as operational evidence in the
    // projection, but are not silently promoted to verified incurred actuals.
    // A user can reconcile the row explicitly in the deal ledger when the
    // source and purpose have been reviewed. ETC override rows are already
    // excluded by ProjectReadService's userDraftCostPredicate.
    reconciliationState: "unreconciled",
    sourceRecordRef: recordReferenceIdSchema.parse(String(draft.id)),
    sourceReferenceHash: null,
    source: null,
    settlementProof: null,
    recordRevision: 1,
    updatedAt: `${draft.incurredOn}T00:00:00.000Z`,
    archivedAt: null,
  });
}

function applyDealCostAsOf(entry: ProjectDealCost, asOf: string): ProjectDealCost {
  if (entry.paidOn !== null && entry.paidOn > asOf) {
    return { ...entry, paidCents: null, paidOn: null, settlementProof: null };
  }
  return entry;
}

/** Re-read every stored QBO deal identity before allowing it into totals. */
async function storedQboSourceIsCurrent(
  finance: ProjectDealCostFinancePorts | undefined,
  entry: ProjectDealCost | ProjectDealFunding,
  project: { readonly organizationId: string; readonly legalEntityId: string; readonly currency: string },
  asOf: string,
): Promise<boolean> {
  if (entry.sourceKind !== "qbo" || entry.source === null) return false;
  if (!finance?.source || entry.source.organizationId !== project.organizationId || entry.source.legalEntityId !== project.legalEntityId) return false;
  const coverage = financialSourceCoverageSchema.parse(await finance.source.readCoverage({
    provider: entry.source.provider,
    organizationId: entry.source.organizationId as never,
    legalEntityId: entry.source.legalEntityId as never,
    environment: entry.source.environment,
    realmId: entry.source.realmId,
  }));
  if (coverage.status === "unavailable" || coverage.evidence !== "live_provider_readback") return false;
  const resolved = await finance.source.resolveLine({
    scope: {
      provider: entry.source.provider,
      organizationId: entry.source.organizationId as never,
      legalEntityId: entry.source.legalEntityId as never,
      environment: entry.source.environment,
      realmId: entry.source.realmId,
    },
    objectType: entry.source.objectType,
    objectId: entry.source.objectId,
    lineId: entry.source.lineId ?? undefined,
    version: entry.source.version,
  });
  if (!resolved) return false;
  const line = financialSourceLineResolutionSchema.parse(resolved);
  if (sourceKey(line.source) !== sourceKey(entry.source) || line.postingState !== "posted" || line.postedOn === null || line.postedOn > asOf || line.currency !== project.currency) return false;
  if (entry.amountCents === null) return false;
  const signedSourceAmount = line.direction === "credit" ? -centsToBigInt(line.amountCents) : centsToBigInt(line.amountCents);
  const storedAmount = centsToBigInt(entry.amountCents);
  if (storedAmount !== BigInt(0) && (storedAmount < BigInt(0)) !== (signedSourceAmount < BigInt(0))) return false;
  if ((storedAmount < BigInt(0) ? -storedAmount : storedAmount) > centsToBigInt(line.amountCents)) return false;
  return qboContextIsEligible(finance, entry.source, line, entry.entryKind === "cost" ? "cost" : "funding");
}

/** Read projection used by both the browser route and the MCP tool. */
export class ProjectDealCostReadService {
  constructor(
    private readonly executor: RentOpsQueryExecutor,
    private readonly finance: ProjectFinanceReadPort = unavailableProjectFinanceReadPort,
    private readonly sourceFinance?: ProjectDealCostFinancePorts,
  ) {}

  async get(principal: AuthenticatedPrincipal, input: unknown): Promise<ProjectDealCostReport> {
    const query = projectDealCostQuerySchema.parse(input);
    const project = await new ProjectReadService(this.executor, this.finance).get(principal, { scope: query.scope, projectId: query.projectId, asOf: query.asOf });
    const rows = await this.executor.query<Record<string, unknown>>(DEAL_LEDGER_SELECT, [project.organizationId, project.id]);
    const asOf = query.asOf ?? resolveEffectiveDate(undefined);
    const storedCosts = rows.rows
      .filter((row) => String(row.entry_kind) === "cost")
      .map(mapCostRow)
      // Archived and void rows remain in the ledger for audit history, but
      // must not suppress a live source actual or affect coverage.
      .filter((entry) => entry.archivedAt === null && entry.reconciliationState !== "void")
      // Historical reads exclude incurred rows dated after the requested
      // snapshot, while forecast-only rows remain available for planning.
      .filter((entry) => entry.incurredOn === null || entry.incurredOn <= asOf || entry.amountCents === null)
      .map((entry) => applyDealCostAsOf(entry, asOf));
    const storedFunding = rows.rows
      .filter((row) => String(row.entry_kind) === "funding")
      .map(mapFundingRow)
      .filter((entry) => entry.archivedAt === null && entry.reconciliationState !== "void")
      .filter((entry) => entry.fundedOn <= asOf);
    const staleQboEntries = new Set<string>();
    for (const entry of [...storedCosts, ...storedFunding]) {
      if (entry.sourceKind === "qbo" && !(await storedQboSourceIsCurrent(this.sourceFinance, entry, project, asOf))) staleQboEntries.add(String(entry.id));
    }
    const costs = storedCosts.map((entry) => staleQboEntries.has(String(entry.id)) && entry.sourceKind === "qbo"
      ? { ...entry, reconciliationState: "unreconciled" as const }
      : entry);
    const funding = storedFunding.map((entry) => staleQboEntries.has(String(entry.id)) && entry.sourceKind === "qbo"
      ? { ...entry, reconciliationState: "unreconciled" as const }
      : entry);
    const sale = rows.rows.find((row) => String(row.entry_kind) === "sale_forecast" && row.archived_at === null);
    const saleForecast = sale ? mapSaleForecastRow(sale) : null;

    const actualResult = await this.finance.getProjectActuals({
      organizationId: project.organizationId,
      legalEntityId: project.legalEntityId as never,
      projectId: project.id,
      asOf,
    });
    const canonicalRehabReport = await readCanonicalProjectCostReport(this.executor, project, this.finance, asOf, actualResult);
    // Deal classifications and existing rehab finance bindings are separate
    // allocations. A project may legitimately have both (for example, a
    // $60 acquisition classification and a later $40 rehab binding on the
    // same QBO line), so source-key deduplication would undercount the deal.
    const rehabScopeItemIds = new Set(project.scopeItems.filter((item) => item.archivedAt === null).map((item) => String(item.id)));
    const qboCosts = actualResult.actuals.map((actual) => mapFinanceActual(actual, rehabScopeItemIds));
    const draftIds = new Set(costs.flatMap((entry) => entry.sourceRecordRef ? [String(entry.sourceRecordRef)] : []));
    const draftCosts = project.draftCosts
      .filter((draft) => String(draft.incurredOn) <= asOf)
      .filter((draft) => !draftIds.has(String(draft.id)))
      .map((draft) => mapDraftCost({ id: String(draft.id), projectId: String(draft.projectId), description: draft.description, vendorName: draft.vendorName, amountCents: String(draft.amountCents), incurredOn: String(draft.incurredOn) }));
    const allCosts = [...costs, ...draftCosts, ...qboCosts];
    const storedQboCount = costs.filter((entry) => entry.sourceKind === "qbo").length + funding.filter((entry) => entry.sourceKind === "qbo").length;
    const actualAmountBySource = new Map<string, bigint>();
    for (const actual of actualResult.actuals) {
      const amount = centsToBigInt(actual.amountCents);
      actualAmountBySource.set(sourceKey(actual.source), (actualAmountBySource.get(sourceKey(actual.source)) ?? BigInt(0)) + (amount < BigInt(0) ? -amount : amount));
    }
    const unboundStoredQboCount = [...costs, ...funding].filter((entry) => {
      if (entry.sourceKind !== "qbo" || entry.source === null) return false;
      if (entry.amountCents === null) return true;
      const actualAmount = actualAmountBySource.get(sourceKey(entry.source));
      if (actualAmount === undefined) return true;
      const storedAmount = centsToBigInt(entry.amountCents);
      return actualAmount !== (storedAmount < BigInt(0) ? -storedAmount : storedAmount);
    }).length;
    const actualCoverage = actualResult.coverage as DealCoverageState;
    const qboStatus: DealCoverageState = staleQboEntries.size > 0
      ? "partial"
      : unboundStoredQboCount > 0
        ? "partial"
        : storedQboCount > 0
        ? actualCoverage === "complete" ? "complete" : "partial"
        : actualCoverage;
    return projectDealCostReportSchema.parse(calculateProjectDealCostReport({
      projectId: project.id,
      currency: project.currency,
      asOf,
      costs: allCosts,
      funding,
      saleForecast,
      qboStatus,
      // The approved rehab baseline belongs to the existing project budget
      // workflow. Feed it into the deal projection once; do not mirror it as
      // an editable deal-cost row.
      rehabBudgetCents: project.approvedBudgetCents,
      // ETC is likewise derived from the canonical project cost report. ETC
      // override rows stay in that report and never become deal costs.
      rehabRemainingForecastCents: canonicalRehabReport.summary.costToCompleteCents,
    }));
  }
}

function savedRelatedResult(childId: string, childRevision: Revision, projectId: string, projectRevision: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [childId, projectId],
    resultingRevisions: [
      { recordId: recordReferenceIdSchema.parse(childId), revision: childRevision },
      { recordId: recordReferenceIdSchema.parse(projectId), revision: projectRevision },
    ],
    validationOutcomes: [{ code: "project.deal_cost.saved_in_rops", severity: "info", message: "Deal cost record saved in 5Central Ops" }],
  };
}

async function lockProject(context: CommandHandlerContext<unknown>, projectId: string): Promise<Awaited<ReturnType<typeof assertProjectScope>>> {
  await context.executor.query(`UPDATE company_projects SET record_revision = record_revision WHERE organization_id = $1 AND id = $2`, [context.envelope.scope.organizationId, projectId]);
  const project = await assertProjectScope(context.executor, context.envelope.scope, projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  if (project.status === "archived") throw new ConflictCommandError("Archived projects cannot be edited", { reason: "project_archived" });
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId,
    legalEntityId: project.legalEntityId,
    propertyId: project.propertyId,
    unitId: project.unitId,
    effectiveDate: resolveEffectiveDate(context.envelope.effectiveDate),
  });
  await assertProjectPropertyAccess(context.executor, {
    organizationId: context.envelope.scope.organizationId,
    legalEntityId: project.legalEntityId,
    propertyId: project.propertyId,
    unitId: project.unitId,
    status: project.status,
    effectiveDate: resolveEffectiveDate(context.envelope.effectiveDate),
  });
  return project;
}

async function touchProject(context: CommandHandlerContext<unknown>, projectId: string): Promise<Revision> {
  const result = await context.executor.query<{ record_revision: number | string }>(
    `UPDATE company_projects SET record_revision = record_revision + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 RETURNING record_revision`,
    [context.envelope.scope.organizationId, projectId],
  );
  return dbRevision(result.rows[0]?.record_revision ?? 0);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sourceParams(source: FinancialSourceReference | null): Record<string, unknown> {
  return source === null ? {
    source_provider: null, source_legal_entity_id: null, source_environment: null,
    source_realm_id: null, source_object_type: null, source_object_id: null,
    source_line_id: null, source_version: null,
  } : {
    source_provider: source.provider, source_legal_entity_id: source.legalEntityId,
    source_environment: source.environment, source_realm_id: source.realmId,
    source_object_type: source.objectType, source_object_id: source.objectId,
    source_line_id: source.lineId, source_version: source.version,
  };
}

function qboFinance(context: CommandHandlerContext<unknown>): ProjectDealCostFinancePorts {
  const finance = (context as DealCostCommandContext).finance;
  if (!finance?.source) throw new ValidationCommandError("Verified QuickBooks source is unavailable", { reason: "deal_cost_qbo_unavailable" });
  return finance;
}

/** Keep deal classifications on the same QBO company and project scope fence as finance bindings. */
async function assertProjectQboBindingScope(
  context: CommandHandlerContext<unknown>,
  projectId: string,
  project: { readonly legalEntityId: string },
  source: FinancialSourceReference,
): Promise<void> {
  const sourceScope = `qbo:${source.environment}:${source.realmId}`;
  const identities = await context.executor.query<{ source_scope: unknown; verified_environment: unknown; verified_realm_id: unknown }>(
    `SELECT i.source_scope, b.environment AS verified_environment, b.realm_id AS verified_realm_id
       FROM company_external_identities i
       LEFT JOIN accounting_qbo_realm_bindings b
         ON b.organization_id = i.organization_id
        AND b.legal_entity_id = i.legal_entity_id
        AND i.source_scope = 'qbo:' || b.environment || ':' || b.realm_id
      WHERE i.organization_id = $1 AND i.legal_entity_id = $2
        AND i.provider = 'qbo' AND i.local_kind = 'project' AND i.local_id = $3
        AND i.record_kind = 'Project'`,
    [context.envelope.scope.organizationId, project.legalEntityId, projectId],
  );
  if (identities.rows.length > 0) {
    const verifiedMatch = identities.rows.some((row) => String(row.source_scope) === sourceScope
      && String(row.verified_environment) === source.environment
      && String(row.verified_realm_id) === source.realmId);
    if (!verifiedMatch) {
      throw new ValidationCommandError("The QBO source scope does not match the verified native QuickBooks Project identity", { reason: "deal_cost_qbo_scope_mismatch" });
    }
  }
  const existing = await context.executor.query<{ environment: unknown; realm_id: unknown }>(
    `SELECT DISTINCT environment, realm_id FROM company_project_finance_bindings
      WHERE organization_id = $1 AND project_id = $2 AND binding_status <> 'released'`,
    [context.envelope.scope.organizationId, projectId],
  );
  if (existing.rows.some((row) => String(row.environment) !== source.environment || String(row.realm_id) !== source.realmId)) {
    throw new ValidationCommandError("This project already has an unreleased QBO binding in a different environment or realm", { reason: "deal_cost_qbo_scope_mismatch" });
  }
  // Legacy projects may have no finance binding yet. Active deal-ledger rows
  // still establish the project's QBO company fence and must be checked before
  // accepting a source from another environment or realm.
  const existingDeal = await context.executor.query<{ environment: unknown; realm_id: unknown }>(
    `SELECT DISTINCT source_environment AS environment, source_realm_id AS realm_id
       FROM company_project_deal_ledger
      WHERE organization_id = $1 AND project_id = $2
        AND entry_kind IN ('cost', 'funding')
        AND source_kind = 'qbo'
        AND archived_at IS NULL
        AND source_environment IS NOT NULL
        AND source_realm_id IS NOT NULL`,
    [context.envelope.scope.organizationId, projectId],
  );
  if (existingDeal.rows.some((row) => String(row.environment) !== source.environment || String(row.realm_id) !== source.realmId)) {
    throw new ValidationCommandError("This project already has an active deal classification in a different QBO environment or realm", { reason: "deal_cost_qbo_scope_mismatch" });
  }
}

async function verifyQboSource(
  context: CommandHandlerContext<unknown>,
  source: FinancialSourceReference,
  project: { legalEntityId: string; currency: string },
  projectId: string,
  lane: DealCostLane,
  requestedAmount: MoneyCents | null,
  purpose: QboContextPurpose,
): Promise<{ source: FinancialSourceReference; amountCents: MoneyCents; hash: string }> {
  if (source.organizationId !== context.envelope.scope.organizationId || source.legalEntityId !== project.legalEntityId) {
    throw new ValidationCommandError("QBO source is outside the project legal entity", { reason: "deal_cost_qbo_scope_mismatch" });
  }
  if (source.lineId === null) throw new ValidationCommandError("A QBO source line is required", { reason: "deal_cost_qbo_line_required" });
  await assertProjectQboBindingScope(context, projectId, project, source);
  const finance = qboFinance(context);
  const coverage = financialSourceCoverageSchema.parse(await finance.source.readCoverage({ provider: source.provider, organizationId: source.organizationId as never, legalEntityId: source.legalEntityId as never, environment: source.environment, realmId: source.realmId }));
  if (coverage.status === "unavailable" || coverage.evidence !== "live_provider_readback") throw new ValidationCommandError("A live QuickBooks readback is required", { reason: "deal_cost_qbo_unverified" });
  const resolved = await finance.source.resolveLine({ scope: { provider: source.provider, organizationId: source.organizationId as never, legalEntityId: source.legalEntityId as never, environment: source.environment, realmId: source.realmId }, objectType: source.objectType, objectId: source.objectId, lineId: source.lineId, version: source.version });
  if (!resolved) throw new ValidationCommandError("The QBO source line is not available", { reason: "deal_cost_qbo_line_not_found" });
  const line = financialSourceLineResolutionSchema.parse(resolved);
  if (sourceKey(line.source) !== sourceKey(source) || line.postingState !== "posted" || line.postedOn === null || line.postedOn > resolveEffectiveDate(context.envelope.effectiveDate)) {
    throw new ValidationCommandError("The QBO source line is stale or not posted", { reason: "deal_cost_qbo_line_not_posted" });
  }
  if (line.currency !== project.currency) throw new ValidationCommandError("The QBO source currency does not match the project", { reason: "deal_cost_currency_mismatch" });
  if (!finance.costContext) {
    throw new ValidationCommandError("QBO source classification evidence is unavailable", { reason: purpose === "cost" ? "deal_cost_qbo_context_unavailable" : "deal_funding_qbo_context_unavailable" });
  }
  if (!(await qboContextIsEligible(finance, source, line, purpose))) {
    throw new ValidationCommandError("The QBO source account classification is not eligible for this deal entry", { reason: purpose === "cost" ? "deal_cost_qbo_account_ineligible" : "deal_funding_qbo_account_ineligible" });
  }
  const sign = line.direction === "credit" ? BigInt(-1) : BigInt(1);
  const sourceAmount = centsToBigInt(line.amountCents) * sign;
  const amount = requestedAmount === null ? sourceAmount : centsToBigInt(requestedAmount);
  if (requestedAmount !== null && amount !== BigInt(0) && (amount < BigInt(0)) !== (sourceAmount < BigInt(0))) {
    throw new ValidationCommandError("The requested QBO amount has the opposite sign from the source line", { reason: purpose === "cost" ? "deal_cost_qbo_sign_mismatch" : "deal_funding_qbo_sign_mismatch" });
  }
  const absoluteAmount = amount < BigInt(0) ? -amount : amount;
  if (absoluteAmount > centsToBigInt(line.amountCents)) throw new ValidationCommandError("The QBO source allocation exceeds the source line", { reason: "deal_cost_qbo_allocation_exceeded" });
  return { source, amountCents: centsFromBigInt(amount), hash: sourceReferenceHash(source) };
}

async function reserveQboIfNeeded(
  context: CommandHandlerContext<unknown>,
  currency: string,
  source: FinancialSourceReference,
  id: string,
  amountCents: MoneyCents | string,
  consumerKind: "project_deal_cost" | "project_deal_funding",
): Promise<void> {
  const finance = (context as DealCostCommandContext).finance;
  if (!finance?.allocations) throw new ValidationCommandError("QBO source allocation is unavailable", { reason: "deal_cost_qbo_allocation_unavailable" });
  // Rehab bindings and whole-deal classifications are separate consumers of
  // the shared source allocation. The allocator enforces the remaining line
  // balance while allowing a valid split in either creation order.
  const absoluteAmount = centsToBigInt(amountCents) < BigInt(0) ? centsFromBigInt(-centsToBigInt(amountCents)) : centsFromBigInt(centsToBigInt(amountCents));
  await finance.allocations.reserve({ source, consumerKind, consumerId: id, amountCents: absoluteAmount, currency });
}

async function releaseQboIfReserved(
  context: CommandHandlerContext<unknown>,
  projectId: string,
  currency: string,
  source: FinancialSourceReference,
  id: string,
  amountCents: MoneyCents | string,
  consumerKind: "project_deal_cost" | "project_deal_funding",
): Promise<void> {
  const finance = (context as DealCostCommandContext).finance;
  if (!finance?.allocations) throw new ValidationCommandError("QBO source allocation is unavailable", { reason: "deal_cost_qbo_allocation_unavailable" });
  const absoluteAmount = centsToBigInt(amountCents) < BigInt(0) ? centsFromBigInt(-centsToBigInt(amountCents)) : centsFromBigInt(centsToBigInt(amountCents));
  await finance.allocations.release({ source, consumerKind, consumerId: id, amountCents: absoluteAmount, currency });
}

function sourceValue(source: FinancialSourceReference | null): unknown[] {
  const fields = sourceParams(source);
  return [fields.source_provider, fields.source_legal_entity_id, fields.source_environment, fields.source_realm_id, fields.source_object_type, fields.source_object_id, fields.source_line_id, fields.source_version];
}

async function createDealCost(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_cost.create"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_cost.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  const id = newRecordId();
  let source = payload.source;
  let amountCents = payload.amountCents;
  let reconciliationState = payload.reconciliationState;
  let hash = payload.sourceReferenceHash;
  if (payload.lane === "rehab" && payload.sourceKind !== "qbo" && payload.sourceKind !== "operational") throw new ValidationCommandError("Rehab costs are maintained by the existing project cost workflow", { reason: "deal_cost_rehab_existing_workflow" });
  if (payload.sourceKind === "qbo") {
    if (!payload.source) throw new ValidationCommandError("QBO cost requires a source", { reason: "deal_cost_qbo_source_required" });
    const verified = await verifyQboSource(context as unknown as CommandHandlerContext<unknown>, payload.source, project, String(payload.projectId), payload.lane, amountCents, "cost");
    source = verified.source; amountCents = verified.amountCents; reconciliationState = "qbo_verified"; hash = verified.hash;
    await reserveQboIfNeeded(context as unknown as CommandHandlerContext<unknown>, project.currency, source, id, amountCents, "project_deal_cost");
  }
  const sourceColumns = sourceParams(source);
  await context.executor.query(
    `INSERT INTO company_project_deal_ledger
       (id, organization_id, project_id, entry_kind, lane, description, vendor_name,
        budget_cents, amount_cents, forecast_cents, paid_cents, incurred_on, paid_on,
        prepaid, source_kind, reconciliation_state, source_record_ref, source_reference_hash,
        source_provider, source_legal_entity_id, source_environment, source_realm_id,
        source_object_type, source_object_id, source_line_id, source_version, settlement_proof)
     VALUES ($1,$2,$3,'cost',$4,$5,$6,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.lane, payload.description, payload.vendorName,
      payload.budgetCents, amountCents, payload.forecastCents, payload.paidCents, payload.incurredOn, payload.paidOn,
      payload.prepaid, payload.sourceKind, reconciliationState, payload.sourceRecordRef, hash,
      sourceColumns.source_provider, sourceColumns.source_legal_entity_id, sourceColumns.source_environment, sourceColumns.source_realm_id,
      sourceColumns.source_object_type, sourceColumns.source_object_id, sourceColumns.source_line_id, sourceColumns.source_version,
      payload.settlementProof ? JSON.stringify(payload.settlementProof) : null],
  );
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  return savedRelatedResult(id, dbRevision(1), String(payload.projectId), projectRevision);
}

async function loadDealRow(context: CommandHandlerContext<unknown>, id: string): Promise<{ row: Record<string, unknown>; project: Awaited<ReturnType<typeof lockProject>> }> {
  const result = await context.executor.query<Record<string, unknown>>(DEAL_LEDGER_ROW_SELECT, [context.envelope.scope.organizationId, id]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Deal ledger row was not found in the requested company scope", { reason: "deal_cost_not_found" });
  const projectId = dbString(row.project_id, "deal_cost_project_id");
  const project = await lockProject(context, projectId);
  return { row, project };
}

async function updateDealCost(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_cost.update"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_cost.update"].parse(context.envelope.payload);
  const current = await loadDealRow(context as unknown as CommandHandlerContext<unknown>, String(payload.dealCostId));
  if (String(current.row.entry_kind) !== "cost") throw new ValidationCommandError("The selected ledger row is not a cost", { reason: "deal_cost_kind_mismatch" });
  const currentCost = mapCostRow(current.row);
  const nextLane = payload.lane ?? currentCost.lane;
  if (nextLane === "rehab" && payload.sourceKind !== undefined && payload.sourceKind !== "qbo" && payload.sourceKind !== "operational") throw new ValidationCommandError("Rehab costs are maintained by the existing project cost workflow", { reason: "deal_cost_rehab_existing_workflow" });
  const currentIsQbo = currentCost.sourceKind === "qbo";
  if (payload.source !== undefined) {
    const sameManualNull = currentCost.source === null && payload.source === null;
    const sameQboIdentity = currentCost.source !== null && payload.source !== null && sourceKey(currentCost.source) === sourceKey(payload.source);
    if (!sameManualNull && !sameQboIdentity) {
      throw new ValidationCommandError("The QBO source identity is immutable; archive and recreate the classification to change it", { reason: "deal_cost_qbo_identity_immutable" });
    }
  }
  if (currentIsQbo && payload.lane !== undefined && payload.lane !== currentCost.lane) {
    throw new ValidationCommandError("A QBO cost lane is immutable; archive and recreate the classification to change it", { reason: "deal_cost_qbo_identity_immutable" });
  }
  if (currentIsQbo && payload.sourceKind !== undefined && payload.sourceKind !== currentCost.sourceKind) {
    throw new ValidationCommandError("A QBO source classification cannot be changed to another source kind", { reason: "deal_cost_qbo_identity_immutable" });
  }
  if (currentIsQbo && payload.amountCents !== undefined && payload.amountCents !== currentCost.amountCents) {
    throw new ValidationCommandError("A QBO source amount is immutable; archive and recreate the classification to change it", { reason: "deal_cost_qbo_identity_immutable" });
  }
  if (!currentIsQbo && payload.sourceKind === "qbo") {
    throw new ValidationCommandError("Linking a manual row to QBO requires a new source classification", { reason: "deal_cost_qbo_identity_immutable" });
  }
  if (currentIsQbo && currentCost.reconciliationState === "void" && payload.reconciliationState === "qbo_verified") {
    throw new ValidationCommandError("A void QBO classification must be recreated and re-reserved", { reason: "deal_cost_qbo_identity_immutable" });
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (payload.lane !== undefined && (!currentIsQbo || payload.lane !== currentCost.lane)) set("lane", payload.lane);
  if (payload.description !== undefined) set("description", payload.description);
  if (hasOwn(payload, "vendorName")) set("vendor_name", payload.vendorName ?? null);
  if (hasOwn(payload, "budgetCents")) set("budget_cents", payload.budgetCents ?? null);
  if (hasOwn(payload, "amountCents") && (!currentIsQbo || payload.amountCents !== currentCost.amountCents)) set("amount_cents", payload.amountCents ?? null);
  if (hasOwn(payload, "forecastCents")) set("forecast_cents", payload.forecastCents ?? null);
  if (hasOwn(payload, "paidCents")) set("paid_cents", payload.paidCents ?? null);
  if (hasOwn(payload, "incurredOn")) set("incurred_on", payload.incurredOn ?? null);
  if (hasOwn(payload, "paidOn")) set("paid_on", payload.paidOn ?? null);
  if (payload.prepaid !== undefined) set("prepaid", payload.prepaid);
  if (payload.sourceKind !== undefined && (!currentIsQbo || payload.sourceKind !== currentCost.sourceKind)) set("source_kind", payload.sourceKind);
  if (payload.reconciliationState !== undefined) set("reconciliation_state", payload.reconciliationState);
  if (hasOwn(payload, "sourceRecordRef") && (!currentIsQbo || payload.sourceRecordRef !== null)) set("source_record_ref", payload.sourceRecordRef ?? null);
  if (hasOwn(payload, "sourceReferenceHash") && (!currentIsQbo || payload.sourceReferenceHash !== null)) set("source_reference_hash", payload.sourceReferenceHash ?? null);
  if (hasOwn(payload, "settlementProof") && (!currentIsQbo || payload.settlementProof !== null)) set("settlement_proof", payload.settlementProof === null ? null : JSON.stringify(payload.settlementProof));
  if (updates.length === 0) throw new ValidationCommandError("At least one deal cost field is required", { reason: "empty_deal_cost_update" });
  const { dealCostId: _dealCostId, source: _source, ...payloadFields } = payload;
  const merged = projectDealCostSchema.parse({ ...currentCost, ...payloadFields, source: currentCost.source, id: currentCost.id, projectId: currentCost.projectId, entryKind: "cost", recordRevision: currentCost.recordRevision, updatedAt: currentCost.updatedAt, archivedAt: null });
  if (currentIsQbo && currentCost.reconciliationState !== "void" && merged.reconciliationState === "void" && currentCost.source !== null) {
    await releaseQboIfReserved(context as unknown as CommandHandlerContext<unknown>, currentCost.projectId, current.project.currency, currentCost.source, currentCost.id, currentCost.amountCents ?? "0", "project_deal_cost");
  }
  values.push(context.envelope.scope.organizationId, payload.dealCostId, currentCost.recordRevision);
  const result = await context.executor.query<{ record_revision: number | string }>(`UPDATE company_project_deal_ledger SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now() WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length} RETURNING record_revision`, values);
  if (result.rows.length !== 1) throw new ConflictCommandError("Deal cost changed while it was being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, currentCost.projectId);
  return savedRelatedResult(String(payload.dealCostId), dbRevision(result.rows[0]!.record_revision), currentCost.projectId, projectRevision);
}

async function archiveDealCost(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_cost.archive"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_cost.archive"].parse(context.envelope.payload);
  const current = await loadDealRow(context as unknown as CommandHandlerContext<unknown>, String(payload.dealCostId));
  if (String(current.row.entry_kind) !== "cost") throw new ValidationCommandError("The selected ledger row is not a cost", { reason: "deal_cost_kind_mismatch" });
  const currentCost = mapCostRow(current.row);
  const revision = dbRevision(current.row.record_revision, "deal_cost_record_revision");
  if (currentCost.sourceKind === "qbo" && currentCost.source !== null) {
    await releaseQboIfReserved(context as unknown as CommandHandlerContext<unknown>, currentCost.projectId, current.project.currency, currentCost.source, currentCost.id, currentCost.amountCents ?? "0", "project_deal_cost");
  }
  const result = await context.executor.query<{ record_revision: number | string }>(`UPDATE company_project_deal_ledger SET archived_at = now(), updated_at = now(), record_revision = record_revision + 1 WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL RETURNING record_revision`, [context.envelope.scope.organizationId, payload.dealCostId, revision]);
  if (result.rows.length !== 1) throw new ConflictCommandError("Deal cost changed while it was being archived", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, dbString(current.row.project_id, "deal_cost_project_id"));
  return savedRelatedResult(String(payload.dealCostId), dbRevision(result.rows[0]!.record_revision), dbString(current.row.project_id, "deal_cost_project_id"), projectRevision);
}

async function createDealFunding(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_funding.create"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_funding.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  const id = newRecordId();
  let source = payload.source;
  let reconciliationState = payload.reconciliationState;
  let hash = payload.sourceReferenceHash;
  if (payload.sourceKind === "qbo") {
    if (!source) throw new ValidationCommandError("QBO funding requires a source", { reason: "deal_funding_qbo_source_required" });
    const verified = await verifyQboSource(context as unknown as CommandHandlerContext<unknown>, source, project, String(payload.projectId), "financing", payload.amountCents, "funding");
    source = verified.source; reconciliationState = "qbo_verified"; hash = verified.hash;
    await reserveQboIfNeeded(context as unknown as CommandHandlerContext<unknown>, project.currency, source, id, payload.amountCents, "project_deal_funding");
  }
  const sourceColumns = sourceParams(source);
  await context.executor.query(
    `INSERT INTO company_project_deal_ledger
       (id, organization_id, project_id, entry_kind, funding_kind, description, amount_cents, funded_on,
        source_kind, reconciliation_state, source_record_ref, source_reference_hash,
        source_provider, source_legal_entity_id, source_environment, source_realm_id,
        source_object_type, source_object_id, source_line_id, source_version, settlement_proof)
     VALUES ($1,$2,$3,'funding',$4,$5,$6::bigint,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.fundingKind, payload.description, payload.amountCents, payload.fundedOn,
      payload.sourceKind, reconciliationState, payload.sourceRecordRef, hash,
      sourceColumns.source_provider, sourceColumns.source_legal_entity_id, sourceColumns.source_environment, sourceColumns.source_realm_id,
      sourceColumns.source_object_type, sourceColumns.source_object_id, sourceColumns.source_line_id, sourceColumns.source_version,
      payload.settlementProof ? JSON.stringify(payload.settlementProof) : null],
  );
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  return savedRelatedResult(id, dbRevision(1), String(payload.projectId), projectRevision);
}

async function updateDealFunding(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_funding.update"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_funding.update"].parse(context.envelope.payload);
  const current = await loadDealRow(context as unknown as CommandHandlerContext<unknown>, String(payload.dealFundingId));
  if (String(current.row.entry_kind) !== "funding") throw new ValidationCommandError("The selected ledger row is not funding", { reason: "deal_funding_kind_mismatch" });
  const currentFunding = mapFundingRow(current.row);
  const currentIsQbo = currentFunding.sourceKind === "qbo";
  if (payload.source !== undefined) {
    const sameManualNull = currentFunding.source === null && payload.source === null;
    const sameQboIdentity = currentFunding.source !== null && payload.source !== null && sourceKey(currentFunding.source) === sourceKey(payload.source);
    if (!sameManualNull && !sameQboIdentity) {
      throw new ValidationCommandError("The QBO funding source identity is immutable; archive and recreate the classification to change it", { reason: "deal_funding_qbo_identity_immutable" });
    }
  }
  if (currentIsQbo && payload.sourceKind !== undefined && payload.sourceKind !== currentFunding.sourceKind) {
    throw new ValidationCommandError("A QBO funding classification cannot be changed to another source kind", { reason: "deal_funding_qbo_identity_immutable" });
  }
  if (currentIsQbo && payload.amountCents !== undefined && payload.amountCents !== currentFunding.amountCents) {
    throw new ValidationCommandError("A QBO funding amount is immutable; archive and recreate the classification to change it", { reason: "deal_funding_qbo_identity_immutable" });
  }
  if (!currentIsQbo && payload.sourceKind === "qbo") {
    throw new ValidationCommandError("Linking manual funding to QBO requires a new source classification", { reason: "deal_funding_qbo_identity_immutable" });
  }
  if (currentIsQbo && currentFunding.reconciliationState === "void" && payload.reconciliationState === "qbo_verified") {
    throw new ValidationCommandError("A void QBO funding classification must be recreated and re-reserved", { reason: "deal_funding_qbo_identity_immutable" });
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (payload.fundingKind !== undefined) set("funding_kind", payload.fundingKind);
  if (payload.description !== undefined) set("description", payload.description);
  if (payload.amountCents !== undefined && (!currentIsQbo || payload.amountCents !== currentFunding.amountCents)) set("amount_cents", payload.amountCents);
  if (payload.fundedOn !== undefined) set("funded_on", payload.fundedOn);
  if (payload.sourceKind !== undefined && (!currentIsQbo || payload.sourceKind !== currentFunding.sourceKind)) set("source_kind", payload.sourceKind);
  if (payload.reconciliationState !== undefined) set("reconciliation_state", payload.reconciliationState);
  if (hasOwn(payload, "sourceRecordRef") && (!currentIsQbo || payload.sourceRecordRef !== null)) set("source_record_ref", payload.sourceRecordRef ?? null);
  if (hasOwn(payload, "sourceReferenceHash") && (!currentIsQbo || payload.sourceReferenceHash !== null)) set("source_reference_hash", payload.sourceReferenceHash ?? null);
  if (hasOwn(payload, "settlementProof") && (!currentIsQbo || payload.settlementProof !== null)) set("settlement_proof", payload.settlementProof === null ? null : JSON.stringify(payload.settlementProof));
  if (updates.length === 0) throw new ValidationCommandError("At least one deal funding field is required", { reason: "empty_deal_funding_update" });
  const { dealFundingId: _dealFundingId, source: _source, ...payloadFields } = payload;
  const merged = projectDealFundingSchema.parse({ ...currentFunding, ...payloadFields, source: currentFunding.source, id: currentFunding.id, projectId: currentFunding.projectId, entryKind: "funding", recordRevision: currentFunding.recordRevision, updatedAt: currentFunding.updatedAt, archivedAt: null });
  if (currentIsQbo && currentFunding.reconciliationState !== "void" && merged.reconciliationState === "void" && currentFunding.source !== null) {
    await releaseQboIfReserved(context as unknown as CommandHandlerContext<unknown>, currentFunding.projectId, current.project.currency, currentFunding.source, currentFunding.id, currentFunding.amountCents, "project_deal_funding");
  }
  values.push(context.envelope.scope.organizationId, payload.dealFundingId, currentFunding.recordRevision);
  const result = await context.executor.query<{ record_revision: number | string }>(`UPDATE company_project_deal_ledger SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now() WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length} RETURNING record_revision`, values);
  if (result.rows.length !== 1) throw new ConflictCommandError("Deal funding changed while it was being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, currentFunding.projectId);
  return savedRelatedResult(String(payload.dealFundingId), dbRevision(result.rows[0]!.record_revision), currentFunding.projectId, projectRevision);
}

async function archiveDealFunding(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_funding.archive"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_funding.archive"].parse(context.envelope.payload);
  const current = await loadDealRow(context as unknown as CommandHandlerContext<unknown>, String(payload.dealFundingId));
  if (String(current.row.entry_kind) !== "funding") throw new ValidationCommandError("The selected ledger row is not funding", { reason: "deal_funding_kind_mismatch" });
  const currentFunding = mapFundingRow(current.row);
  const revision = dbRevision(current.row.record_revision, "deal_funding_record_revision");
  if (currentFunding.sourceKind === "qbo" && currentFunding.source !== null) {
    await releaseQboIfReserved(context as unknown as CommandHandlerContext<unknown>, currentFunding.projectId, current.project.currency, currentFunding.source, currentFunding.id, currentFunding.amountCents, "project_deal_funding");
  }
  const result = await context.executor.query<{ record_revision: number | string }>(`UPDATE company_project_deal_ledger SET archived_at = now(), updated_at = now(), record_revision = record_revision + 1 WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL RETURNING record_revision`, [context.envelope.scope.organizationId, payload.dealFundingId, revision]);
  if (result.rows.length !== 1) throw new ConflictCommandError("Deal funding changed while it was being archived", { reason: "revision_conflict" });
  const projectId = currentFunding.projectId;
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, projectId);
  return savedRelatedResult(String(payload.dealFundingId), dbRevision(result.rows[0]!.record_revision), projectId, projectRevision);
}

async function setSaleForecast(context: CommandHandlerContext<ProjectDealCostCommandPayload["project.deal_sale_forecast.set"]>): Promise<CommandHandlerResult> {
  const payload = projectDealCostCommandPayloadSchemas["project.deal_sale_forecast.set"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  const current = await context.executor.query<Record<string, unknown>>(`SELECT id, record_revision FROM company_project_deal_ledger WHERE organization_id = $1 AND project_id = $2 AND entry_kind = 'sale_forecast' AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.projectId]);
  let id: string;
  let revision: Revision;
  if (current.rows[0]) {
    id = dbString(current.rows[0].id, "sale_forecast_id");
    revision = dbRevision(current.rows[0].record_revision, "sale_forecast_record_revision");
    const result = await context.executor.query<{ record_revision: number | string }>(`UPDATE company_project_deal_ledger SET gross_proceeds_cents = $1::bigint, sale_on = $2, record_revision = record_revision + 1, updated_at = now() WHERE organization_id = $3 AND id = $4 AND record_revision = $5 RETURNING record_revision`, [payload.grossProceedsCents, payload.saleOn, context.envelope.scope.organizationId, id, revision]);
    if (result.rows.length !== 1) throw new ConflictCommandError("Sale forecast changed while it was being edited", { reason: "revision_conflict" });
    revision = dbRevision(result.rows[0]!.record_revision);
  } else {
    id = newRecordId();
    await context.executor.query(`INSERT INTO company_project_deal_ledger (id, organization_id, project_id, entry_kind, description, gross_proceeds_cents, sale_on, source_kind, reconciliation_state) VALUES ($1,$2,$3,'sale_forecast','Sale proceeds forecast',$4::bigint,$5,'estimate','unreconciled')`, [id, context.envelope.scope.organizationId, payload.projectId, payload.grossProceedsCents, payload.saleOn]);
    revision = dbRevision(1);
  }
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, String(payload.projectId));
  return savedRelatedResult(id, revision, String(payload.projectId), projectRevision);
}

const handlers = {
  "project.deal_cost.create": createDealCost,
  "project.deal_cost.update": updateDealCost,
  "project.deal_cost.archive": archiveDealCost,
  "project.deal_funding.create": createDealFunding,
  "project.deal_funding.update": updateDealFunding,
  "project.deal_funding.archive": archiveDealFunding,
  "project.deal_sale_forecast.set": setSaleForecast,
} as const;

export async function executeProjectDealCostCommand(
  executor: RentOpsQueryExecutor,
  kind: ProjectDealCostCommandKind,
  rawEnvelope: unknown,
  options: ProjectDealCostCommandOptions,
): Promise<OperationReceipt> {
  const payloadSchema = projectDealCostCommandPayloadSchemas[kind];
  let envelope: AnyDealCostEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyDealCostEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw new ValidationCommandError("Deal cost command payload failed validation", { reason: "invalid_deal_cost_command_payload" });
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: PROJECT_DEAL_COST_COMMAND_POLICIES[kind],
    handler: async (context) => {
      const scoped = options.financeFactory ? Object.assign(context, { finance: options.financeFactory(context.executor) }) : context;
      return handler(scoped);
    },
  });
}
