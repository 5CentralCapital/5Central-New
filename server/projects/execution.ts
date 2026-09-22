import {
  centsFromBigInt,
  centsToBigInt,
  currencyCodeSchema,
  type CompanyScope,
  type IsoDate,
  type LegalEntityId,
  type MoneyCents,
  type OperationReceipt,
} from "../../shared/company";
import {
  projectExecutionReadQuerySchema,
  projectExecutionTotalsSchema,
  projectFinanceActualSchema,
  projectFinanceCoverageSchema,
  type ProjectAssignment,
  type ProjectAssigneeOption,
  type ProjectBid,
  type ProjectChangeOrder,
  type ProjectCommitment,
  type ProjectDrawRequest,
  type ProjectExecutionCommandKind,
  type ProjectExecutionDetail,
  type ProjectExecutionTotals,
  type ProjectFinanceActual,
  type ProjectFinanceBindingRecord,
  type ProjectFinanceCoverage,
  type ProjectFinanceReadPort,
  type ProjectInspection,
  type ProjectMilestone,
  type ProjectPunchItem,
  type ProjectPurchaseOrder,
  type ProjectTemplate,
  projectIdSchema,
} from "../../shared/projects";
import type { AuthenticatedPrincipal } from "../company/authorization";
import type { ProjectExecutionCommandOptions } from "./execution-commands";
import {
  financialSourceScopeKey,
  type FinancialProviderCostContextPort,
  type FinancialSourceCoverage,
  type FinancialSourceLineResolution,
  type FinancialSourceReadPort,
  type FinancialSourceReference,
  type FinancialSourceScope,
} from "../../shared/accounting/source";

export interface ProjectExecutionBudgetSnapshot {
  readonly versionNo: number;
  readonly status: "approved" | "superseded";
  readonly totalEstimatedCents: MoneyCents;
}

export interface ProjectExecutionSnapshot {
  readonly projectId: string;
  readonly scope: CompanyScope;
  readonly currency: string;
  readonly budgets: readonly ProjectExecutionBudgetSnapshot[];
  readonly assignments: readonly ProjectAssignment[];
  readonly milestones: readonly ProjectMilestone[];
  readonly inspections: readonly ProjectInspection[];
  readonly punchItems: readonly ProjectPunchItem[];
  readonly vendors: readonly ProjectExecutionDetail["vendors"][number][];
  readonly bids: readonly ProjectBid[];
  readonly commitments: readonly ProjectCommitment[];
  readonly changeOrders: readonly ProjectChangeOrder[];
  readonly purchaseOrders: readonly ProjectPurchaseOrder[];
  readonly drawRequests: readonly ProjectDrawRequest[];
  readonly templates: readonly ProjectTemplate[];
  readonly assigneeOptions: readonly ProjectAssigneeOption[];
}

export interface ProjectExecutionSnapshotSource {
  read(input: { scope: CompanyScope; projectId: string; asOf?: IsoDate }): Promise<ProjectExecutionSnapshot>;
}

export interface ProjectExecutionCommandSource {
  execute(kind: ProjectExecutionCommandKind, envelope: unknown, access: ProjectExecutionCommandOptions): Promise<OperationReceipt>;
}

export interface ProjectExecutionPort {
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; projectId: string; asOf?: IsoDate }): Promise<ProjectExecutionDetail>;
  execute(kind: ProjectExecutionCommandKind, envelope: unknown, access: ProjectExecutionCommandOptions): Promise<OperationReceipt>;
}

export type ProjectExecutionAdapterAccess = ProjectExecutionCommandOptions;

export interface ProjectFinanceBindingSource {
  listProjectBindings(input: { organizationId: string; projectId: string; asOf?: IsoDate }): Promise<readonly ProjectFinanceBindingRecord[]>;
}

export interface ProjectFinanceActualReadResult {
  readonly coverage: ProjectFinanceCoverage;
  readonly actuals: readonly ProjectFinanceActual[];
}

function mergeFinanceCoverage(statuses: readonly FinancialSourceCoverage[], hasUnresolvedBinding: boolean): ProjectFinanceCoverage {
  if (statuses.length === 0) return "unavailable";
  if (statuses.some((coverage) => coverage.status === "unavailable" || coverage.evidence === "unverified")) return "unavailable";
  if (hasUnresolvedBinding || statuses.some((coverage) => coverage.status === "partial")) return "partial";
  return "complete";
}

function sourceScope(reference: FinancialSourceReference): FinancialSourceScope {
  return {
    provider: reference.provider,
    organizationId: reference.organizationId,
    legalEntityId: reference.legalEntityId,
    environment: reference.environment,
    realmId: reference.realmId,
  };
}

function exactSourceKey(reference: FinancialSourceReference): string {
  return [
    financialSourceScopeKey(sourceScope(reference)),
    reference.objectType,
    reference.objectId,
    reference.lineId ?? "*",
    reference.version,
  ].join("\u0000");
}

const PROJECT_COST_CLASSIFICATIONS = new Set(["expense", "cogs", "capitalized_cost"]);

async function isEligibleProjectCostLine(
  costContext: FinancialProviderCostContextPort,
  line: FinancialSourceLineResolution,
): Promise<boolean> {
  // A debit, outgoing flow, or provider line role alone is insufficient:
  // transfers, principal, and bill-payment clearing lines can all look like
  // costs at the transaction level. The finance mirror must also verify the
  // current source identity and the provider Account classification.
  if (line.flow !== "outgoing" || (line.lineRole !== "expense" && line.lineRole !== "payable")) return false;
  const context = await costContext.readCostContext({
    scope: sourceScope(line.source),
    objectType: line.source.objectType,
    objectId: line.source.objectId,
    lineId: line.source.lineId ?? undefined,
  });
  return context !== null
    && exactSourceKey(context.source) === exactSourceKey(line.source)
    && context.accountObjectId === line.accountObjectId
    && context.amountCents === line.amountCents
    && context.currency === line.currency
    && context.postedOn === line.postedOn
    && context.postingState === "posted"
    && context.eligible
    && PROJECT_COST_CLASSIFICATIONS.has(context.classification);
}

/**
 * Resolve project bindings through the shared accounting mirror. Every actual
 * keeps the full QBO source identity and provider version. A missing or
 * unverified source line is omitted; callers receive coverage separately so
 * the UI can show unavailable/partial instead of turning it into zero.
 */
export async function resolveProjectFinanceActuals(
  source: FinancialSourceReadPort,
  bindings: ProjectFinanceBindingSource,
  costContext: FinancialProviderCostContextPort,
  input: { organizationId: string; projectId: string; asOf?: IsoDate },
): Promise<ProjectFinanceActualReadResult> {
  const bindingRows = await bindings.listProjectBindings(input);
  const scopes = new Map<string, FinancialSourceScope>();
  for (const binding of bindingRows) scopes.set(financialSourceScopeKey(sourceScope(binding.source)), sourceScope(binding.source));
  const coverages = await Promise.all(Array.from(scopes.values()).map((scope) => source.readCoverage(scope)));
  let hasUnresolvedBinding = bindingRows.some((binding) => binding.bindingStatus !== "verified" || !binding.eligible);
  const results = await Promise.all(bindingRows.map(async (binding) => {
    if (binding.bindingStatus !== "verified" || !binding.eligible) return null;
    const resolved = await source.resolveLine({
      scope: sourceScope(binding.source),
      objectType: binding.source.objectType,
      objectId: binding.source.objectId,
      lineId: binding.source.lineId ?? undefined,
      // Verify a current line, then compare its provider version with the
      // binding. A binding that points at an older QBO revision is stale and
      // must reduce coverage instead of silently showing historical money.
    });
    if (!resolved || resolved.postingState !== "posted" || resolved.postedOn === null || !(await isEligibleProjectCostLine(costContext, resolved))) {
      hasUnresolvedBinding = true;
      return null;
    }
    if (input.asOf !== undefined && resolved.postedOn > input.asOf) return null;
    const expectedSource = exactSourceKey(binding.source);
    if (exactSourceKey(resolved.source) !== expectedSource) {
      hasUnresolvedBinding = true;
      return null;
    }
    const allocated = centsToBigInt(binding.allocatedCents);
    if (allocated > centsToBigInt(resolved.amountCents)) {
      hasUnresolvedBinding = true;
      return null;
    }
    const signedAmount = resolved.direction === "debit" ? allocated : -allocated;
    return projectFinanceActualSchema.parse({
      id: binding.id,
      projectId: binding.projectId,
      commitmentId: binding.commitmentId,
      scopeItemId: binding.scopeItemId,
      source: resolved.source,
      description: resolved.description ?? `${resolved.source.objectType} ${resolved.source.objectId}`,
      amountCents: centsFromBigInt(signedAmount),
      currency: resolved.currency,
      postedOn: resolved.postedOn,
      sourceRevision: resolved.source.version,
    });
  }));
  return { coverage: mergeFinanceCoverage(coverages, hasUnresolvedBinding), actuals: results.filter((value): value is ProjectFinanceActual => value !== null) };
}

/** Build the project-facing port over the canonical finance read port. */
export function createProjectFinanceReadPort(
  source: FinancialSourceReadPort,
  bindings: ProjectFinanceBindingSource,
  costContext: FinancialProviderCostContextPort,
): ProjectFinanceReadPort {
  return {
    async getProjectActuals(input) {
      return resolveProjectFinanceActuals(source, bindings, costContext, input);
    },
  };
}

function sum(values: readonly (MoneyCents | string)[]): bigint {
  let result = BigInt(0);
  for (const value of values) result += centsToBigInt(value);
  return result;
}

function maxZero(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}

function earliestBudget(budgets: readonly ProjectExecutionBudgetSnapshot[]): ProjectExecutionBudgetSnapshot | undefined {
  return [...budgets].sort((a, b) => a.versionNo - b.versionNo)[0];
}

function latestBudget(budgets: readonly ProjectExecutionBudgetSnapshot[]): ProjectExecutionBudgetSnapshot | undefined {
  return [...budgets].sort((a, b) => b.versionNo - a.versionNo)[0];
}

/**
 * Calculate exposure from distinct economic facts. A budget version is a
 * snapshot. An approved change order is added only until it is incorporated
 * into a later budget snapshot. A PO is a document for a commitment and is
 * therefore never added to commitments a second time. QBO actuals reduce the
 * outstanding portion of a linked commitment; the actual itself is counted
 * once in actuals.
 */
export function calculateProjectExecutionTotals(input: {
  currency: string;
  budgets: readonly ProjectExecutionBudgetSnapshot[];
  commitments: readonly ProjectCommitment[];
  changeOrders: readonly ProjectChangeOrder[];
  actuals: readonly ProjectFinanceActual[];
  actualCoverage: ProjectFinanceCoverage;
}): ProjectExecutionTotals {
  const currency = currencyCodeSchema.parse(input.currency);
  for (const budget of input.budgets) {
    if (budget.totalEstimatedCents === undefined) throw new Error("Budget snapshot has no exact total");
  }
  for (const commitment of input.commitments) {
    if (commitment.currency !== currency) throw new Error("Commitment currency does not match project currency");
    const expected = centsToBigInt(commitment.originalCents) + centsToBigInt(commitment.approvedChangeCents);
    if (expected !== centsToBigInt(commitment.committedCents)) throw new Error("Commitment total does not equal original plus approved changes");
  }
  for (const changeOrder of input.changeOrders) {
    if (changeOrder.currency !== currency) throw new Error("Change order currency does not match project currency");
  }
  const first = earliestBudget(input.budgets);
  const last = latestBudget(input.budgets);
  const originalBudget = first ? centsToBigInt(first.totalEstimatedCents) : BigInt(0);
  const unincorporatedApprovedChanges = sum(input.changeOrders
    .filter((changeOrder) => changeOrder.status === "approved" && changeOrder.includedInBudgetVersionId === null)
    .map((changeOrder) => changeOrder.amountCents));
  const revisedBudget = (last ? centsToBigInt(last.totalEstimatedCents) : originalBudget) + unincorporatedApprovedChanges;
  const grossCommitment = sum(input.commitments
    .filter((commitment) => commitment.status === "approved" || commitment.status === "closed")
    .map((commitment) => commitment.committedCents));

  const coverage = projectFinanceCoverageSchema.parse(input.actualCoverage);
  const actuals = coverage === "unavailable" ? [] : input.actuals.map((actual) => projectFinanceActualSchema.parse(actual));
  for (const actual of actuals) {
    if (actual.currency !== currency) throw new Error("QBO actual currency does not match project currency");
  }
  const actualTotal = sum(actuals.map((actual) => actual.amountCents));
  const linkedActualByCommitment = new Map<string, bigint>();
  for (const actual of actuals) {
    if (!actual.commitmentId) continue;
    linkedActualByCommitment.set(actual.commitmentId, (linkedActualByCommitment.get(actual.commitmentId) ?? BigInt(0)) + centsToBigInt(actual.amountCents));
  }

  const actualCents = coverage === "unavailable" ? null : centsFromBigInt(actualTotal);
  const linkedActualCents = coverage === "unavailable"
    ? null
    : centsFromBigInt(Array.from(linkedActualByCommitment.values()).reduce((total, value) => total + value, BigInt(0)));
  // A partial mirror is useful evidence but does not establish a complete
  // remaining balance. Keep its amount visible while withholding the derived
  // exposure that would otherwise look authoritative.
  const unspentCommitment = coverage === "complete"
    ? input.commitments
      .filter((commitment) => commitment.status === "approved" || commitment.status === "closed")
      .reduce((total, commitment) => total + maxZero(centsToBigInt(commitment.committedCents) - (linkedActualByCommitment.get(commitment.id) ?? BigInt(0))), BigInt(0))
    : null;
  const remaining = coverage === "complete" && unspentCommitment !== null
    ? revisedBudget - actualTotal - unspentCommitment
    : null;
  return projectExecutionTotalsSchema.parse({
    currency,
    originalBudgetCents: centsFromBigInt(originalBudget),
    revisedBudgetCents: centsFromBigInt(revisedBudget),
    commitmentCents: centsFromBigInt(grossCommitment),
    linkedActualCents,
    actualCents,
    unspentCommitmentCents: unspentCommitment === null ? null : centsFromBigInt(unspentCommitment),
    remainingCents: remaining === null ? null : centsFromBigInt(remaining),
    actualCoverage: coverage,
  });
}

export class ProjectExecutionReadService {
  constructor(
    private readonly source: ProjectExecutionSnapshotSource,
    private readonly finance: ProjectFinanceReadPort,
  ) {}

  async get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; projectId: string; asOf?: IsoDate }): Promise<ProjectExecutionDetail> {
    // The parent project read service owns authorization for its own detail.
    // This service still requires the authenticated principal so root adapters
    // cannot accidentally expose a transport that has no actor context.
    if (!principal.actorId) throw new Error("Project execution reads require an authenticated actor");
    const query = projectExecutionReadQuerySchema.parse({ scope: { ...input.scope, projectId: input.projectId }, asOf: input.asOf });
    const snapshot = await this.source.read({ scope: query.scope, projectId: query.scope.projectId, asOf: query.asOf });
    const projectId = projectIdSchema.parse(snapshot.projectId);
    if (projectId !== query.scope.projectId) throw new Error("Project execution source returned a different project");
    const legalEntityId = query.scope.legalEntityId as LegalEntityId;
    const scope: CompanyScope = {
      organizationId: query.scope.organizationId,
      legalEntityId: query.scope.legalEntityId,
      ...(query.scope.propertyId === undefined ? {} : { propertyId: query.scope.propertyId }),
    };
    const financeResult = await this.finance.getProjectActuals({ organizationId: query.scope.organizationId, legalEntityId, projectId, asOf: query.asOf });
    const actuals = financeResult.actuals;
    const totals = calculateProjectExecutionTotals({
      currency: snapshot.currency,
      budgets: snapshot.budgets,
      commitments: snapshot.commitments,
      changeOrders: snapshot.changeOrders,
      actuals,
      actualCoverage: financeResult.coverage,
    });
    return {
      projectId,
      scope,
      totals,
      templates: snapshot.templates,
      assigneeOptions: snapshot.assigneeOptions,
      assignments: snapshot.assignments,
      milestones: snapshot.milestones,
      inspections: snapshot.inspections,
      punchItems: snapshot.punchItems,
      vendors: snapshot.vendors,
      bids: snapshot.bids,
      commitments: snapshot.commitments,
      changeOrders: snapshot.changeOrders,
      purchaseOrders: snapshot.purchaseOrders,
      drawRequests: snapshot.drawRequests,
      financeActuals: [...actuals],
    };
  }
}

/**
 * Small transport-neutral adapters for the existing company HTTP and MCP
 * ports. Root wiring can pass the same adapter to either registration layer;
 * there is no second mutation implementation and no provider write here.
 */
export function createProjectExecutionAdapter(
  reads: ProjectExecutionReadService,
  commands: ProjectExecutionCommandSource,
): ProjectExecutionPort {
  return {
    get: (principal, input) => reads.get(principal, input),
    execute: (kind, envelope, access) => commands.execute(kind, envelope, access),
  };
}

export function createProjectExecutionHttpAdapter(port: ProjectExecutionPort): ProjectExecutionPort {
  return port;
}

export function createProjectExecutionMcpAdapter(port: ProjectExecutionPort): ProjectExecutionPort {
  return port;
}
