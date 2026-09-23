import { z } from "zod";
import {
  centsFromBigInt,
  centsSchema,
  centsToBigInt,
  currencyCodeSchema,
  isoDateSchema,
  type IsoDate,
  type MoneyCents,
} from "../company";
import { financialSettlementStateSchema, financialSourceReferenceSchema } from "../accounting/source";
import {
  projectFinanceCoverageSchema,
  type ProjectChangeOrder,
  type ProjectCommitment,
  type ProjectDrawRequest,
  type ProjectFinanceActual,
  type ProjectFinanceCoverage,
  type ProjectPunchItem,
  type ProjectPurchaseOrder,
} from "./execution-contracts";

/**
 * Canonical project cost read model. Every project view (overview, budgets,
 * commitments, draws, reports, MCP) reads these figures from one pure
 * calculation so the same project never shows two different totals.
 *
 * Economic facts are counted once:
 *   - a commitment is exposure, not a cost;
 *   - a linked QBO bill line is the incurred cost and reduces the remaining
 *     commitment by the same amount;
 *   - a bill payment only changes how much of the incurred cost is paid.
 * Approved time labor is an estimate until a posted payroll line is linked to
 * the same timesheets; the posted amount then replaces the estimate.
 */

const ZERO = BigInt(0);
const cents = centsSchema;
const nullableCents = centsSchema.nullable();

export const PROJECT_ETC_OVERRIDE_VENDOR = "system:etc_override" as const;
export const PROJECT_RESERVED_VENDOR_PREFIX = "system:" as const;

export const projectCostCompletenessSchema = z.enum(["complete", "partial", "unavailable"]);
export type ProjectCostCompleteness = z.infer<typeof projectCostCompletenessSchema>;

export const projectCostSummarySchema = z.object({
  currency: currencyCodeSchema,
  asOf: isoDateSchema,
  actualCoverage: projectFinanceCoverageSchema,
  /** complete only when QBO coverage is complete and all approved labor is priced. */
  completeness: projectCostCompletenessSchema,
  hasApprovedBudget: z.boolean(),
  originalBudgetCents: cents,
  approvedChangeCents: cents,
  revisedBudgetCents: cents,
  committedCents: cents,
  incurred: z.object({
    /** Verified QBO actual. A partial mirror returns the known subtotal; unavailable returns null. */
    verifiedActualCents: nullableCents,
    laborEstimatedCents: cents,
    laborPostedCents: cents,
    unpricedLaborEntries: z.number().int().nonnegative(),
    totalCents: nullableCents,
  }).strict(),
  paid: z.object({
    cents: nullableCents,
    knownCents: cents,
    coverage: projectCostCompletenessSchema,
  }).strict(),
  remainingCommitmentCents: nullableCents,
  costToCompleteCents: nullableCents,
  forecastFinalCostCents: nullableCents,
  varianceCents: nullableCents,
  draftCostCents: cents,
}).strict();
export type ProjectCostSummary = z.infer<typeof projectCostSummarySchema>;

export const projectCostLineSchema = z.object({
  key: z.string().min(1).max(80),
  scopeItemId: z.string().uuid().nullable(),
  description: z.string().min(1).max(300),
  originalBudgetCents: cents,
  revisedBudgetCents: cents,
  committedCents: cents,
  incurredCents: nullableCents,
  laborCents: cents,
  remainingCommitmentCents: nullableCents,
  etcOverride: z.object({ id: z.string().uuid(), amountCents: cents, reason: z.string().min(1).max(300) }).strict().nullable(),
  costToCompleteCents: nullableCents,
  forecastFinalCostCents: nullableCents,
  varianceCents: nullableCents,
}).strict();
export type ProjectCostLine = z.infer<typeof projectCostLineSchema>;

export const projectCommitmentLedgerSchema = z.object({
  commitmentId: z.string().uuid(),
  description: z.string().min(1).max(300),
  vendorId: z.string().uuid().nullable(),
  status: z.string().min(1).max(40),
  scopeItemId: z.string().uuid().nullable(),
  committedCents: cents,
  purchaseOrderCents: cents,
  receivedCents: cents,
  partialReceiptCount: z.number().int().nonnegative(),
  invoicedCents: nullableCents,
  paidCents: nullableCents,
  remainingCents: nullableCents,
  receipts: z.array(z.object({
    purchaseOrderId: z.string().uuid(),
    poNumber: z.string().min(1).max(80),
    status: z.string().min(1).max(40),
    amountCents: cents,
    issuedOn: isoDateSchema.nullable(),
    receivedOn: isoDateSchema.nullable(),
  }).strict()).max(1_000),
  invoices: z.array(z.object({
    bindingId: z.string().uuid(),
    source: financialSourceReferenceSchema,
    transactionType: z.string().max(120).nullable(),
    description: z.string().min(1).max(300),
    amountCents: cents,
    postedOn: isoDateSchema,
    settlementState: financialSettlementStateSchema,
    paidCents: nullableCents,
  }).strict()).max(1_000),
}).strict();
export type ProjectCommitmentLedger = z.infer<typeof projectCommitmentLedgerSchema>;

export const projectRetainageRowSchema = z.object({
  drawRequestId: z.string().uuid(),
  requestNo: z.number().int().positive(),
  status: z.string().min(1).max(40),
  periodTo: isoDateSchema,
  openingCents: cents,
  withheldCents: cents,
  releasedCents: cents,
  closingCents: cents,
}).strict();
export type ProjectRetainageRow = z.infer<typeof projectRetainageRowSchema>;

export const projectRetainageSchema = z.object({
  rows: z.array(projectRetainageRowSchema).max(1_000),
  withheldCents: cents,
  releasedCents: cents,
  outstandingCents: cents,
  /** Draft or submitted draws are pending and excluded from the payable rollforward. */
  pendingWithheldCents: cents,
}).strict();
export type ProjectRetainage = z.infer<typeof projectRetainageSchema>;

export const PROJECT_SCHEDULE_RISK_STATES = ["on_track", "at_risk", "late", "unknown"] as const;
export const projectScheduleRiskSchema = z.object({
  status: z.enum(PROJECT_SCHEDULE_RISK_STATES),
  targetOn: isoDateSchema.nullable(),
  projectedFinishOn: isoDateSchema.nullable(),
  lateTaskIds: z.array(z.string().uuid()).max(10_000),
  /** Open tasks whose dependencies push them past their own due date. */
  dependencyRiskTaskIds: z.array(z.string().uuid()).max(10_000),
  openTaskCount: z.number().int().nonnegative(),
}).strict();
export type ProjectScheduleRisk = z.infer<typeof projectScheduleRiskSchema>;

export const PROJECT_CLOSEOUT_KEYS = ["commitments_invoiced", "retainage_released", "punch_items_closed", "final_draw_paid", "lien_waivers_linked", "tasks_complete"] as const;
export type ProjectCloseoutKey = (typeof PROJECT_CLOSEOUT_KEYS)[number];
export const projectCloseoutItemSchema = z.object({
  key: z.enum(PROJECT_CLOSEOUT_KEYS),
  label: z.string().min(1).max(120),
  status: z.enum(["complete", "open", "not_applicable", "unknown"]),
  detail: z.string().min(1).max(300),
}).strict();
export const projectCloseoutSchema = z.object({
  ready: z.boolean(),
  items: z.array(projectCloseoutItemSchema).max(20),
}).strict();
export type ProjectCloseout = z.infer<typeof projectCloseoutSchema>;

export const projectCostReportSchema = z.object({
  projectId: z.string().uuid(),
  summary: projectCostSummarySchema,
  lines: z.array(projectCostLineSchema).max(10_001),
  commitments: z.array(projectCommitmentLedgerSchema).max(10_000),
  retainage: projectRetainageSchema,
  schedule: projectScheduleRiskSchema,
  closeout: projectCloseoutSchema,
  warnings: z.array(z.string().min(1).max(300)).max(100),
}).strict();
export type ProjectCostReport = z.infer<typeof projectCostReportSchema>;

/** Draft ETC override: an explicit cost-to-complete for one scope line with a reason. */
export interface ProjectEtcOverrideInput {
  readonly id: string;
  readonly scopeItemId: string;
  readonly amountCents: MoneyCents | string;
  readonly reason: string;
}

export interface ProjectLaborInputRow {
  readonly timesheetId: string;
  /** Scope line resolved from the jobcode cost code, or null when unassigned. */
  readonly scopeItemId: string | null;
  readonly currency: string | null;
  /** Estimated labor from an approved timesheet and a mapped rate; null when unpriced. */
  readonly estimatedCents: MoneyCents | string | null;
  /** Posted payroll linked to this timesheet; replaces the estimate when present. */
  readonly postedCents: MoneyCents | string | null;
}

export interface ProjectCostTaskInput {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly completedOn: string | null;
  readonly dependencyTaskIds: readonly string[];
}

export interface ProjectCostBudgetVersionInput {
  readonly versionNo: number;
  readonly status: "draft" | "approved" | "superseded";
  readonly totalEstimatedCents: MoneyCents | string;
  readonly lines: readonly { readonly scopeItemId: string | null; readonly description: string; readonly estimatedCents: MoneyCents | string }[];
}

export interface ProjectCostReportInput {
  readonly projectId: string;
  readonly currency: string;
  readonly asOf: IsoDate | string;
  readonly targetOn: string | null;
  readonly scopeItems: readonly { readonly id: string; readonly description: string; readonly estimatedCents: MoneyCents | string }[];
  readonly budgetVersions: readonly ProjectCostBudgetVersionInput[];
  readonly draftCostCents: MoneyCents | string;
  readonly etcOverrides: readonly ProjectEtcOverrideInput[];
  readonly commitments: readonly ProjectCommitment[];
  readonly bids: readonly { readonly id: string; readonly scopeItemId: string | null }[];
  readonly changeOrders: readonly ProjectChangeOrder[];
  readonly purchaseOrders: readonly ProjectPurchaseOrder[];
  readonly draws: readonly ProjectDrawRequest[];
  readonly punchItems: readonly ProjectPunchItem[];
  readonly tasks: readonly ProjectCostTaskInput[];
  readonly actuals: readonly ProjectFinanceActual[];
  readonly actualCoverage: ProjectFinanceCoverage;
  readonly labor: readonly ProjectLaborInputRow[];
  readonly lienWaiverDocumentCount: number;
}

const UNASSIGNED_KEY = "unassigned";

function big(value: MoneyCents | string): bigint {
  return centsToBigInt(value);
}

function max(...values: bigint[]): bigint {
  return values.reduce((result, value) => (value > result ? value : result));
}

function out(value: bigint): MoneyCents {
  return centsFromBigInt(value);
}

function orNull(value: bigint | null): MoneyCents | null {
  return value === null ? null : centsFromBigInt(value);
}

interface LineAccumulator {
  key: string;
  scopeItemId: string | null;
  description: string;
  original: bigint;
  revised: bigint;
  committed: bigint;
  actual: bigint;
  labor: bigint;
  remainingCommitment: bigint;
}

/** Paid portion of one allocated actual. Unknown settlement returns null. */
export function paidPortionCents(actual: Pick<ProjectFinanceActual, "amountCents" | "settlement" | "lineAmountCents">): bigint | null {
  const settlement = actual.settlement;
  if (!settlement) return null;
  const allocated = big(actual.amountCents);
  if (settlement.state === "unsettled") return ZERO;
  if (settlement.state !== "settled" || settlement.settledAmountCents === null) return null;
  const settled = big(settlement.settledAmountCents);
  const line = actual.lineAmountCents === undefined ? null : big(actual.lineAmountCents);
  if (line === null || line <= ZERO) return settled >= allocated ? allocated : null;
  if (settled >= line) return allocated;
  // A partially paid bill line is paid pro rata across its allocations,
  // rounded toward zero so the paid portion never overstates cash.
  const negative = allocated < ZERO;
  const absolute = negative ? -allocated : allocated;
  const portion = (absolute * settled) / line;
  return negative ? -portion : portion;
}

function effectiveBudgets(versions: readonly ProjectCostBudgetVersionInput[]) {
  const sealed = versions.filter((version) => version.status === "approved" || version.status === "superseded").sort((left, right) => left.versionNo - right.versionNo);
  return { first: sealed[0], last: sealed.at(-1) };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayDistance(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const CLOSED_TASK_STATES = new Set(["completed", "cancelled"]);

/**
 * Forward pass over the acyclic task graph. A task cannot finish before its
 * own due date, before today when it is still open and late, or before its
 * dependencies finish plus its own planned duration.
 */
export function calculateScheduleRisk(tasks: readonly ProjectCostTaskInput[], asOf: string, targetOn: string | null): ProjectScheduleRisk {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const projected = new Map<string, string | null>();
  const visiting = new Set<string>();
  const projectedEnd = (task: ProjectCostTaskInput): string | null => {
    if (projected.has(task.id)) return projected.get(task.id) ?? null;
    if (visiting.has(task.id)) return task.dueOn; // defensive: the command layer rejects cycles
    visiting.add(task.id);
    let result: string | null;
    if (task.status === "completed") result = task.completedOn ?? task.dueOn;
    else if (task.status === "cancelled") result = null;
    else {
      const duration = task.startsOn && task.dueOn ? Math.max(0, dayDistance(task.startsOn, task.dueOn)) : 0;
      let earliestEnd = task.dueOn;
      for (const dependencyId of task.dependencyTaskIds) {
        const dependency = byId.get(dependencyId);
        if (!dependency) continue;
        const dependencyEnd = projectedEnd(dependency);
        if (dependencyEnd === null) continue;
        const candidate = addDays(dependencyEnd, duration);
        if (earliestEnd === null || candidate > earliestEnd) earliestEnd = candidate;
      }
      if (earliestEnd !== null && earliestEnd < asOf && task.dueOn !== null && task.dueOn < asOf) earliestEnd = asOf;
      result = earliestEnd;
    }
    visiting.delete(task.id);
    projected.set(task.id, result);
    return result;
  };
  const open = tasks.filter((task) => !CLOSED_TASK_STATES.has(task.status));
  const lateTaskIds = open.filter((task) => task.dueOn !== null && task.dueOn < asOf).map((task) => task.id);
  const dependencyRiskTaskIds = open.filter((task) => {
    const end = projectedEnd(task);
    return task.dueOn !== null && end !== null && end > task.dueOn && !(task.dueOn < asOf);
  }).map((task) => task.id);
  const ends = tasks.map((task) => projectedEnd(task)).filter((value): value is string => value !== null);
  const projectedFinishOn = ends.length ? ends.reduce((result, value) => (value > result ? value : result)) : null;
  let status: ProjectScheduleRisk["status"];
  if (!tasks.length || (projectedFinishOn === null && targetOn === null)) status = "unknown";
  else if (lateTaskIds.length > 0 || (targetOn !== null && projectedFinishOn !== null && projectedFinishOn > targetOn)) status = "late";
  else if (dependencyRiskTaskIds.length > 0) status = "at_risk";
  else status = "on_track";
  return projectScheduleRiskSchema.parse({ status, targetOn, projectedFinishOn, lateTaskIds, dependencyRiskTaskIds, openTaskCount: open.length });
}

const DRAW_EFFECTIVE_STATES = new Set(["approved", "paid"]);
const DRAW_PENDING_STATES = new Set(["draft", "submitted"]);

/**
 * Retainage payable rollforward. Each approved or paid draw withholds the
 * retainage on its items. Per source, gross requests beyond the source's
 * eligible amount can only be a release of previously withheld retainage
 * (commands cap net requests at eligibility), so the released amount is the
 * growth of max(0, gross − eligible) across that source.
 */
export function calculateRetainageRollforward(draws: readonly ProjectDrawRequest[]): ProjectRetainage {
  const ordered = [...draws].sort((left, right) => left.requestNo - right.requestNo);
  const gross = new Map<string, bigint>();
  const eligible = new Map<string, bigint>();
  const released = new Map<string, bigint>();
  const rows: ProjectRetainageRow[] = [];
  let outstanding = ZERO;
  let totalWithheld = ZERO;
  let totalReleased = ZERO;
  let pending = ZERO;
  for (const draw of ordered) {
    if (DRAW_PENDING_STATES.has(draw.status)) {
      for (const item of draw.items) pending += big(item.retainageCents);
      continue;
    }
    if (!DRAW_EFFECTIVE_STATES.has(draw.status)) continue;
    const opening = outstanding;
    let withheld = ZERO;
    let releasedThisDraw = ZERO;
    for (const item of draw.items) {
      const key = `${item.sourceType}:${item.sourceId}`;
      withheld += big(item.retainageCents);
      const nextGross = (gross.get(key) ?? ZERO) + big(item.requestedCents);
      gross.set(key, nextGross);
      const sourceEligible = max(eligible.get(key) ?? ZERO, big(item.eligibleCents));
      eligible.set(key, sourceEligible);
      const cumulativeRelease = max(ZERO, nextGross - sourceEligible);
      releasedThisDraw += cumulativeRelease - (released.get(key) ?? ZERO);
      released.set(key, cumulativeRelease);
    }
    outstanding = opening + withheld - releasedThisDraw;
    totalWithheld += withheld;
    totalReleased += releasedThisDraw;
    rows.push({ drawRequestId: draw.id, requestNo: draw.requestNo, status: draw.status, periodTo: draw.periodTo, openingCents: out(opening), withheldCents: out(withheld), releasedCents: out(releasedThisDraw), closingCents: out(outstanding) });
  }
  return projectRetainageSchema.parse({ rows, withheldCents: out(totalWithheld), releasedCents: out(totalReleased), outstandingCents: out(outstanding), pendingWithheldCents: out(pending) });
}

export function calculateProjectCostReport(input: ProjectCostReportInput): ProjectCostReport {
  const currency = currencyCodeSchema.parse(input.currency);
  const asOf = isoDateSchema.parse(input.asOf);
  const coverage = projectFinanceCoverageSchema.parse(input.actualCoverage);
  const warnings: string[] = [];
  const scopeById = new Map(input.scopeItems.map((item) => [item.id, item]));
  const knownScope = new Map<string, string>(input.scopeItems.map((item) => [item.id, item.description]));
  for (const version of input.budgetVersions) for (const budgetLine of version.lines) if (budgetLine.scopeItemId !== null && !knownScope.has(budgetLine.scopeItemId)) knownScope.set(budgetLine.scopeItemId, budgetLine.description);
  const bidScope = new Map(input.bids.map((bid) => [bid.id, bid.scopeItemId]));
  const commitmentScope = new Map<string, string | null>();
  for (const commitment of input.commitments) {
    if (commitment.currency !== currency) throw new Error("Commitment currency does not match project currency");
    if (big(commitment.originalCents) + big(commitment.approvedChangeCents) !== big(commitment.committedCents)) throw new Error("Commitment total does not equal original plus approved changes");
    const scopeItemId = commitment.bidId ? bidScope.get(commitment.bidId) ?? null : null;
    commitmentScope.set(commitment.id, scopeItemId && knownScope.has(scopeItemId) ? scopeItemId : null);
  }

  const lines = new Map<string, LineAccumulator>();
  const lineFor = (scopeItemId: string | null): LineAccumulator => {
    const known = scopeItemId !== null && knownScope.has(scopeItemId);
    const key = known ? scopeItemId! : UNASSIGNED_KEY;
    let line = lines.get(key);
    if (!line) {
      line = { key, scopeItemId: known ? scopeItemId : null, description: known ? knownScope.get(scopeItemId!)! : "Unassigned and approved changes", original: ZERO, revised: ZERO, committed: ZERO, actual: ZERO, labor: ZERO, remainingCommitment: ZERO };
      lines.set(key, line);
    }
    return line;
  };
  for (const item of input.scopeItems) lineFor(item.id);

  // Budgets: original is the first sealed approval; revised is the latest
  // approval plus approved change orders not yet incorporated into a version.
  const { first, last } = effectiveBudgets(input.budgetVersions);
  const hasApprovedBudget = Boolean(last);
  if (!hasApprovedBudget) warnings.push("No approved budget; cost-to-complete uses remaining commitments only.");
  if (first) for (const budgetLine of first.lines) lineFor(budgetLine.scopeItemId).original += big(budgetLine.estimatedCents);
  if (last) for (const budgetLine of last.lines) lineFor(budgetLine.scopeItemId).revised += big(budgetLine.estimatedCents);
  const originalBudget = first ? big(first.totalEstimatedCents) : ZERO;
  let revisedBudget = last ? big(last.totalEstimatedCents) : originalBudget;
  for (const change of input.changeOrders) {
    if (change.currency !== currency) throw new Error("Change order currency does not match project currency");
    if (change.status !== "approved" || change.includedInBudgetVersionId !== null) continue;
    const scopeItemId = change.commitmentId ? commitmentScope.get(change.commitmentId) ?? null : null;
    lineFor(scopeItemId).revised += big(change.amountCents);
    revisedBudget += big(change.amountCents);
  }

  // Commitments are exposure; only approved and closed commitments count.
  const activeCommitments = input.commitments.filter((commitment) => commitment.status === "approved" || commitment.status === "closed");
  let committed = ZERO;
  for (const commitment of activeCommitments) {
    committed += big(commitment.committedCents);
    lineFor(commitmentScope.get(commitment.id) ?? null).committed += big(commitment.committedCents);
  }

  // Verified actuals. Unavailable coverage contributes nothing and withholds totals.
  const actuals = coverage === "unavailable" ? [] : input.actuals;
  let verifiedActual = ZERO;
  const linkedByCommitment = new Map<string, bigint>();
  let paidKnown = ZERO;
  let paidUnknown = false;
  for (const actual of actuals) {
    if (actual.currency !== currency) throw new Error("QBO actual currency does not match project currency");
    const amount = big(actual.amountCents);
    verifiedActual += amount;
    const scopeItemId = actual.scopeItemId && knownScope.has(actual.scopeItemId) ? actual.scopeItemId : actual.commitmentId ? commitmentScope.get(actual.commitmentId) ?? null : null;
    lineFor(scopeItemId).actual += amount;
    if (actual.commitmentId) linkedByCommitment.set(actual.commitmentId, (linkedByCommitment.get(actual.commitmentId) ?? ZERO) + amount);
    const paid = paidPortionCents(actual);
    if (paid === null) paidUnknown = true;
    else paidKnown += paid;
  }

  // Labor: posted payroll replaces the estimate for the same timesheet.
  let laborEstimated = ZERO;
  let laborPosted = ZERO;
  let unpriced = 0;
  for (const row of input.labor) {
    if (row.postedCents !== null) {
      if (row.currency !== null && row.currency !== currency) { warnings.push("Labor in another currency was excluded."); continue; }
      laborPosted += big(row.postedCents);
      lineFor(row.scopeItemId).labor += big(row.postedCents);
    } else if (row.estimatedCents !== null) {
      if (row.currency !== null && row.currency !== currency) { warnings.push("Labor in another currency was excluded."); continue; }
      laborEstimated += big(row.estimatedCents);
      lineFor(row.scopeItemId).labor += big(row.estimatedCents);
    } else {
      unpriced += 1;
    }
  }
  if (unpriced > 0) warnings.push(`${unpriced} approved time ${unpriced === 1 ? "entry has" : "entries have"} no labor rate.`);

  // Remaining commitment: a closed commitment can no longer be billed.
  for (const commitment of activeCommitments) {
    const remaining = commitment.status === "closed" ? ZERO : max(ZERO, big(commitment.committedCents) - (linkedByCommitment.get(commitment.id) ?? ZERO));
    lineFor(commitmentScope.get(commitment.id) ?? null).remainingCommitment += remaining;
  }

  const overridesByScope = new Map(input.etcOverrides.map((override) => [override.scopeItemId, override]));
  const exposureKnown = coverage === "complete";
  let costToComplete = ZERO;
  let remainingCommitmentTotal = ZERO;
  const outputLines: ProjectCostLine[] = [];
  const orderedLines = Array.from(lines.values()).sort((left, right) => (left.key === UNASSIGNED_KEY ? 1 : right.key === UNASSIGNED_KEY ? -1 : left.description.localeCompare(right.description) || left.key.localeCompare(right.key)));
  for (const line of orderedLines) {
    const incurred = line.actual + line.labor;
    const override = line.scopeItemId ? overridesByScope.get(line.scopeItemId) : undefined;
    const lineCtc = override ? big(override.amountCents) : max(ZERO, line.revised - incurred, line.remainingCommitment);
    costToComplete += lineCtc;
    remainingCommitmentTotal += line.remainingCommitment;
    const isEmpty = line.key === UNASSIGNED_KEY && line.original === ZERO && line.revised === ZERO && line.committed === ZERO && line.actual === ZERO && line.labor === ZERO;
    if (isEmpty) continue;
    outputLines.push(projectCostLineSchema.parse({
      key: line.key,
      scopeItemId: line.scopeItemId,
      description: line.description.slice(0, 300),
      originalBudgetCents: out(line.original),
      revisedBudgetCents: out(line.revised),
      committedCents: out(line.committed),
      incurredCents: coverage === "unavailable" ? null : out(incurred),
      laborCents: out(line.labor),
      remainingCommitmentCents: exposureKnown ? out(line.remainingCommitment) : null,
      etcOverride: override ? { id: override.id, amountCents: out(big(override.amountCents)), reason: override.reason } : null,
      costToCompleteCents: exposureKnown ? out(lineCtc) : null,
      forecastFinalCostCents: exposureKnown ? out(incurred + lineCtc) : null,
      varianceCents: exposureKnown ? out(line.revised - incurred - lineCtc) : null,
    }));
  }
  for (const override of input.etcOverrides) if (!scopeById.has(override.scopeItemId)) warnings.push("An ETC override points to an archived scope line and was ignored.");

  const verifiedActualCents = coverage === "unavailable" ? null : verifiedActual;
  const totalIncurred = verifiedActualCents === null ? null : verifiedActualCents + laborEstimated + laborPosted;
  const forecast = exposureKnown && totalIncurred !== null ? totalIncurred + costToComplete : null;
  if (coverage === "partial") warnings.push("QuickBooks coverage is partial; forecast figures are withheld.");
  if (coverage === "unavailable") warnings.push("QuickBooks actuals are unavailable; incurred and forecast figures are withheld.");
  const laborHasPaidUnknown = laborEstimated + laborPosted > ZERO;
  const paidCoverage: ProjectCostCompleteness = coverage === "unavailable" ? "unavailable" : coverage === "partial" || paidUnknown || laborHasPaidUnknown ? "partial" : "complete";
  const completeness: ProjectCostCompleteness = coverage === "unavailable" ? "unavailable" : coverage === "partial" || unpriced > 0 ? "partial" : "complete";

  const commitmentLedger = calculateCommitmentLedger(input, actuals, commitmentScope, coverage);
  const retainage = calculateRetainageRollforward(input.draws);
  const schedule = calculateScheduleRisk(input.tasks, asOf, input.targetOn);
  const closeout = calculateCloseout(input, commitmentLedger, retainage, coverage);

  return projectCostReportSchema.parse({
    projectId: input.projectId,
    summary: {
      currency,
      asOf,
      actualCoverage: coverage,
      completeness,
      hasApprovedBudget,
      originalBudgetCents: out(originalBudget),
      approvedChangeCents: out(revisedBudget - originalBudget),
      revisedBudgetCents: out(revisedBudget),
      committedCents: out(committed),
      incurred: {
        verifiedActualCents: orNull(verifiedActualCents),
        laborEstimatedCents: out(laborEstimated),
        laborPostedCents: out(laborPosted),
        unpricedLaborEntries: unpriced,
        totalCents: orNull(totalIncurred),
      },
      paid: { cents: paidCoverage === "complete" ? out(paidKnown) : null, knownCents: out(paidKnown), coverage: paidCoverage },
      remainingCommitmentCents: exposureKnown ? out(remainingCommitmentTotal) : null,
      costToCompleteCents: exposureKnown ? out(costToComplete) : null,
      forecastFinalCostCents: orNull(forecast),
      varianceCents: forecast === null ? null : out(revisedBudget - forecast),
      draftCostCents: out(big(input.draftCostCents)),
    },
    lines: outputLines,
    commitments: commitmentLedger,
    retainage,
    schedule,
    closeout,
    warnings: Array.from(new Set(warnings)).slice(0, 100),
  });
}

function calculateCommitmentLedger(
  input: ProjectCostReportInput,
  actuals: readonly ProjectFinanceActual[],
  commitmentScope: ReadonlyMap<string, string | null>,
  coverage: ProjectFinanceCoverage,
): ProjectCommitmentLedger[] {
  return input.commitments.filter((commitment) => commitment.status !== "void").map((commitment) => {
    const orders = input.purchaseOrders.filter((order) => order.commitmentId === commitment.id && order.status !== "cancelled");
    const invoices = actuals.filter((actual) => actual.commitmentId === commitment.id);
    const invoiced = invoices.reduce((total, actual) => total + big(actual.amountCents), ZERO);
    let paid: bigint | null = ZERO;
    for (const invoice of invoices) {
      const portion = paidPortionCents(invoice);
      paid = paid === null || portion === null ? null : paid + portion;
    }
    const known = coverage !== "unavailable";
    const complete = coverage === "complete";
    return projectCommitmentLedgerSchema.parse({
      commitmentId: commitment.id,
      description: commitment.description,
      vendorId: commitment.vendorId,
      status: commitment.status,
      scopeItemId: commitmentScope.get(commitment.id) ?? null,
      committedCents: commitment.committedCents,
      purchaseOrderCents: out(orders.reduce((total, order) => total + big(order.amountCents), ZERO)),
      receivedCents: out(orders.filter((order) => order.status === "received").reduce((total, order) => total + big(order.amountCents), ZERO)),
      partialReceiptCount: orders.filter((order) => order.status === "partially_received").length,
      invoicedCents: known ? out(invoiced) : null,
      paidCents: known && paid !== null && complete ? out(paid) : null,
      remainingCents: complete ? out(commitment.status === "closed" ? ZERO : max(ZERO, big(commitment.committedCents) - invoiced)) : null,
      receipts: orders.map((order) => ({ purchaseOrderId: order.id, poNumber: order.poNumber, status: order.status, amountCents: order.amountCents, issuedOn: order.issuedOn ?? null, receivedOn: order.receivedOn ?? null })),
      invoices: invoices.map((invoice) => ({
        bindingId: invoice.id,
        source: invoice.source,
        transactionType: invoice.transactionType ?? null,
        description: invoice.description,
        amountCents: invoice.amountCents,
        postedOn: invoice.postedOn,
        settlementState: invoice.settlement?.state ?? "unknown",
        paidCents: orNull(paidPortionCents(invoice)),
      })),
    });
  });
}

function calculateCloseout(
  input: ProjectCostReportInput,
  ledger: readonly ProjectCommitmentLedger[],
  retainage: ProjectRetainage,
  coverage: ProjectFinanceCoverage,
): ProjectCloseout {
  const items: z.infer<typeof projectCloseoutItemSchema>[] = [];
  const active = ledger.filter((row) => row.status === "approved" || row.status === "closed");
  if (!active.length) items.push({ key: "commitments_invoiced", label: "Commitments invoiced", status: "not_applicable", detail: "No approved commitments." });
  else if (coverage !== "complete") items.push({ key: "commitments_invoiced", label: "Commitments invoiced", status: "unknown", detail: "QuickBooks coverage is incomplete." });
  else {
    const open = active.filter((row) => row.status !== "closed" && row.invoicedCents !== null && big(row.invoicedCents) < big(row.committedCents));
    items.push({ key: "commitments_invoiced", label: "Commitments invoiced", status: open.length ? "open" : "complete", detail: open.length ? `${open.length} of ${active.length} commitments not fully invoiced.` : `${active.length} commitments invoiced or closed.` });
  }
  const withheld = big(retainage.withheldCents);
  items.push(withheld === ZERO
    ? { key: "retainage_released", label: "Retainage released", status: "not_applicable", detail: "No retainage withheld." }
    : { key: "retainage_released", label: "Retainage released", status: big(retainage.outstandingCents) === ZERO ? "complete" : "open", detail: big(retainage.outstandingCents) === ZERO ? "All withheld retainage released." : "Retainage is still withheld." });
  const punch = input.punchItems;
  const openPunch = punch.filter((item) => item.status !== "complete" && item.status !== "waived");
  items.push(!punch.length
    ? { key: "punch_items_closed", label: "Punch items closed", status: "not_applicable", detail: "No punch items." }
    : { key: "punch_items_closed", label: "Punch items closed", status: openPunch.length ? "open" : "complete", detail: openPunch.length ? `${openPunch.length} of ${punch.length} punch items open.` : `${punch.length} punch items closed.` });
  const draws = [...input.draws].filter((draw) => draw.status !== "void" && draw.status !== "rejected").sort((left, right) => right.requestNo - left.requestNo);
  items.push(!draws.length
    ? { key: "final_draw_paid", label: "Final draw paid", status: "not_applicable", detail: "No draw requests." }
    : { key: "final_draw_paid", label: "Final draw paid", status: draws.every((draw) => draw.status === "paid") ? "complete" : "open", detail: draws.every((draw) => draw.status === "paid") ? `Draw #${draws[0]!.requestNo} paid.` : `Draw #${draws.find((draw) => draw.status !== "paid")!.requestNo} is ${draws.find((draw) => draw.status !== "paid")!.status}.` });
  const vendors = new Set(active.map((row) => row.vendorId).filter((value): value is string => value !== null));
  items.push(!vendors.size
    ? { key: "lien_waivers_linked", label: "Lien waivers linked", status: "not_applicable", detail: "No committed vendors." }
    : { key: "lien_waivers_linked", label: "Lien waivers linked", status: input.lienWaiverDocumentCount >= vendors.size ? "complete" : "open", detail: `${input.lienWaiverDocumentCount} lien waiver${input.lienWaiverDocumentCount === 1 ? "" : "s"} for ${vendors.size} vendor${vendors.size === 1 ? "" : "s"}.` });
  const openTasks = input.tasks.filter((task) => !CLOSED_TASK_STATES.has(task.status));
  items.push(!input.tasks.length
    ? { key: "tasks_complete", label: "Tasks complete", status: "not_applicable", detail: "No tasks." }
    : { key: "tasks_complete", label: "Tasks complete", status: openTasks.length ? "open" : "complete", detail: openTasks.length ? `${openTasks.length} of ${input.tasks.length} tasks open.` : `${input.tasks.length} tasks closed.` });
  return projectCloseoutSchema.parse({ ready: items.every((item) => item.status === "complete" || item.status === "not_applicable"), items });
}
