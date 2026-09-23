import { centsFromBigInt, centsToBigInt } from "../../shared/company";
import type { ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine, ReportingEngineProbeResult } from "./registry";

export const COMBINED_FINANCIAL_REPORT_IDS = [
  "balance-sheet-by-fund-type",
  "balance-sheet-consolidated",
  "budget-vs-actual",
  "general-ledger-consolidated",
  "income-statement-by-unit",
  "income-statement-consolidated",
  "trial-balance-consolidated",
  "portfolio-financials",
  "property-t12",
  "accounts-receivable",
  "accounts-payable",
  "cash-position",
] as const;
export type CombinedFinancialReportId = (typeof COMBINED_FINANCIAL_REPORT_IDS)[number];
/** Property statements have their own engine (property-statement-engine.ts):
 * they combine rental collections, PM gross-to-net settlements and mapped
 * book actuals, which a ledger line reader alone cannot prove. */

/** One normalized line from the accounting mirror. A line is retained with
 * its provider identity; aggregation never invents a property/unit/fund link. */
export interface FinancialReportingLine {
  readonly id: string;
  readonly legalEntityId: string;
  readonly propertyId?: string | null;
  readonly unitId?: string | null;
  readonly accountId: string;
  readonly accountName?: string | null;
  readonly date: string;
  readonly month?: string | null;
  readonly amountCents: string;
  readonly currency: string;
  readonly category?: string | null;
  readonly fundType?: string | null;
  readonly sourceId: string;
  readonly sourceRealmId?: string | null;
  /** Realm-local account IDs are only merged when this approved identity is present. */
  readonly canonicalAccountId?: string | null;
  /** Applied by the adapter for a dated ownership policy. A version label
   * without this line-level share is not sufficient for consolidation. */
  readonly ownershipBps?: number | null;
  /** Applied by the adapter for the selected translation version. */
  readonly translatedAmountCents?: string | null;
  readonly translatedCurrency?: string | null;
  readonly statement?: "balance_sheet" | "income_statement" | "general_ledger" | "trial_balance" | "accounts_receivable" | "accounts_payable";
  readonly basis: "cash" | "accrual";
}

export interface FinancialReportingBudgetLine {
  readonly id: string;
  readonly legalEntityId: string;
  readonly propertyId?: string | null;
  readonly unitId?: string | null;
  readonly accountId: string;
  readonly period: string;
  readonly budgetCents: string;
  readonly currency: string;
  readonly sourceId: string;
  readonly sourceRealmId?: string | null;
  /** Realm-local IDs are never merged across entities unless this canonical
   * mapping identity is present. */
  readonly canonicalAccountId?: string | null;
}

export interface FinancialReportingBankBalance {
  readonly accountId: string;
  readonly legalEntityId: string;
  readonly balanceCents: string;
  readonly currency: string;
  readonly asOfDate: string;
  readonly sourceId: string;
}

export interface FinancialReportingElimination {
  readonly accountId: string;
  readonly canonicalAccountId?: string | null;
  readonly entityId: string;
  readonly sourceRealmId?: string | null;
  readonly amountCents: string;
  readonly currency: string;
  readonly sourceId: string;
}

export interface CombinedFinancialReadResult {
  readonly lines: readonly FinancialReportingLine[];
  readonly budgetLines?: readonly FinancialReportingBudgetLine[];
  readonly bankBalances?: readonly FinancialReportingBankBalance[];
  readonly eliminations?: readonly FinancialReportingElimination[];
  readonly eliminationVersion?: string | null;
  readonly accountMappingVersion?: string | null;
  readonly fundMappingVersion?: string | null;
  readonly propertyMappingVersion?: string | null;
  readonly unitAllocationVersion?: string | null;
  readonly ownershipMappingVersion?: string | null;
  readonly translationVersion?: string | null;
  /**
   * Property attribution evidence. `attributedPropertyIds` are properties
   * whose lines are fully attributed (the sole property of a covered entity
   * for the whole period); `unknownPropertyIds` are properties mapped to an
   * entity that returned lines without a property, so their actuals by
   * property are unknown. Lines without a property are dropped from a
   * property-filtered read and counted in `unattributedLineCount`.
   */
  readonly propertyAttribution?: {
    readonly attributedPropertyIds: readonly string[];
    readonly unknownPropertyIds: readonly string[];
    readonly unattributedLineCount: number;
  };
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

export interface CombinedFinancialReadPort {
  /** Optional catalog check: connection, mirror coverage and approved mappings. */
  probe?(input: { readonly organizationId: string; readonly reportId: CombinedFinancialReportId }): Promise<ReportingEngineProbeResult>;
  read(input: { readonly context: ReportingEngineContext; readonly reportId: CombinedFinancialReportId; readonly legalEntityIds: readonly string[]; readonly propertyIds: readonly string[]; readonly unitIds: readonly string[]; readonly accountIds: readonly string[] }): Promise<CombinedFinancialReadResult>;
}

function inPeriod(date: string, context: ReportingEngineContext): boolean {
  const bounds = periodBounds(context);
  return (!bounds.from || date >= bounds.from) && (!bounds.through || date <= bounds.through);
}

function scopeLines(context: ReportingEngineContext, reportId: CombinedFinancialReportId, lines: readonly FinancialReportingLine[]): FinancialReportingLine[] {
  const scope = context.request.scope;
  const selectedUnits = Array.isArray(context.request.filters.unitIds) ? context.request.filters.unitIds.filter((value): value is string => typeof value === "string") : [];
  const cumulative = new Set<CombinedFinancialReportId>(["balance-sheet-by-fund-type", "balance-sheet-consolidated", "trial-balance-consolidated", "accounts-receivable", "accounts-payable", "cash-position"]);
  const bounds = periodBounds(context);
  return lines.filter(line => {
    const dateSelected = cumulative.has(reportId)
      ? (!bounds.through || lineDate(line) <= bounds.through)
      : inPeriod(lineDate(line), context);
    return (!scope.legalEntityIds.length || scope.legalEntityIds.includes(line.legalEntityId as typeof scope.legalEntityIds[number])) && (!scope.propertyIds.length || (line.propertyId !== null && line.propertyId !== undefined && scope.propertyIds.includes(line.propertyId as typeof scope.propertyIds[number]))) && (!scope.unitIds.length || (line.unitId !== null && line.unitId !== undefined && scope.unitIds.includes(line.unitId as typeof scope.unitIds[number]))) && (!selectedUnits.length || (typeof line.unitId === "string" && selectedUnits.includes(line.unitId))) && dateSelected;
  });
}

function lineDate(line: FinancialReportingLine): string { return line.date; }

function aggregate(lines: readonly FinancialReportingLine[], key: (line: FinancialReportingLine) => string, dimensions: (line: FinancialReportingLine) => Record<string, unknown>): unknown[] {
  const groups = new Map<string, { amount: bigint; values: Record<string, unknown>; currency: string }>();
  for (const line of lines) {
    const group = groups.get(key(line));
    if (group) group.amount += centsToBigInt(line.amountCents);
    else groups.set(key(line), { amount: centsToBigInt(line.amountCents), values: dimensions(line), currency: line.currency });
  }
  return Array.from(groups.values()).map(group => ({ ...group.values, amountCents: centsFromBigInt(group.amount), currency: group.currency }));
}

function missing(code: string, message: string, state: ReportMissingData["state"] = "unavailable"): ReportMissingData { return { code, state, message }; }

function coverage(context: ReportingEngineContext, source: CombinedFinancialReadResult, rows: number): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, { source: "quickbooks_mirror_and_company_mappings", state: source.coverage.state, evidence: source.coverage.evidence, basis: context.request.basis, watermark: source.coverage.watermark ?? null, coveredFrom: bounds.from, coveredThrough: bounds.through, rowCount: rows, reason: source.coverage.reason ?? "Financial lines retain provider identity and are grouped only after explicit scope and allocation mappings are present." });
}

function requireConsolidation(context: ReportingEngineContext): NonNullable<ReportingEngineContext["request"]["consolidation"]> {
  const consolidation = context.request.consolidation;
  if (!consolidation) throw new ReportingError("report_validation", "Consolidated reports require explicit entity, currency, ownership, elimination, and translation policies.", 400);
  return consolidation;
}

function statementFor(reportId: CombinedFinancialReportId): FinancialReportingLine["statement"] | null {
  if (reportId.startsWith("balance-sheet")) return "balance_sheet";
  if (reportId.startsWith("income-statement") || reportId === "portfolio-financials" || reportId === "property-t12" || reportId === "budget-vs-actual") return "income_statement";
  if (reportId.startsWith("general-ledger")) return "general_ledger";
  if (reportId.startsWith("trial-balance")) return "trial_balance";
  if (reportId === "accounts-receivable") return "accounts_receivable";
  if (reportId === "accounts-payable") return "accounts_payable";
  return null;
}

function accountKey(line: FinancialReportingLine, _consolidated: boolean): string {
  const identity = line.canonicalAccountId ?? `${line.sourceRealmId ?? line.legalEntityId}:${line.accountId}`;
  return `${identity}:${line.currency}`;
}

function budgetPeriodInScope(period: string, context: ReportingEngineContext): boolean {
  const bounds = periodBounds(context);
  const month = period.length === 7 ? period : period.slice(0, 7);
  return (!bounds.from || month >= bounds.from.slice(0, 7)) && (!bounds.through || month <= bounds.through.slice(0, 7));
}

function budgetAccountKey(line: FinancialReportingBudgetLine): string {
  const identity = line.canonicalAccountId ?? `${line.sourceRealmId ?? line.legalEntityId}:${line.accountId}`;
  return `${identity}:${line.currency}`;
}

function consolidationLineKey(line: { readonly accountId: string; readonly canonicalAccountId?: string | null; readonly sourceRealmId?: string | null; readonly legalEntityId: string; readonly currency: string }): string {
  const identity = line.canonicalAccountId ?? `${line.sourceRealmId ?? line.legalEntityId}:${line.accountId}`;
  return `${identity}:${line.currency}`;
}

function roundedShare(amount: bigint, ownershipBps: number): bigint {
  const numerator = amount * BigInt(ownershipBps);
  const denominator = BigInt(10_000);
  const sign = numerator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const absolute = numerator < BigInt(0) ? -numerator : numerator;
  return sign * ((absolute + denominator / BigInt(2)) / denominator);
}

function effectiveConsolidationLine(
  line: FinancialReportingLine,
  policy: NonNullable<ReportingEngineContext["request"]["consolidation"]>,
): FinancialReportingLine {
  let amountCents = line.amountCents;
  let currency = line.currency;
  if (policy.translationPolicy === "approved_rates") {
    if (line.translatedAmountCents === null || line.translatedAmountCents === undefined || line.translatedCurrency !== policy.currency) {
      throw new ReportingError("report_unavailable", "The selected translation version did not provide a translated amount for every financial line.", 409, { dependency: policy.translationVersion ?? "approved_translation_rates" });
    }
    amountCents = line.translatedAmountCents;
    currency = line.translatedCurrency;
  } else if (line.currency !== policy.currency) {
    throw new ReportingError("report_unavailable", "Consolidation without translation cannot combine lines outside the requested currency.", 409, { dependency: "approved_translation_rates" });
  }
  if (policy.ownershipPolicy !== "full_control") {
    if (!Number.isSafeInteger(line.ownershipBps) || line.ownershipBps! < 0 || line.ownershipBps! > 10_000) {
      throw new ReportingError("report_unavailable", "The selected ownership policy did not provide a dated ownership share for every financial line.", 409, { dependency: "approved_ownership_mapping" });
    }
    amountCents = centsFromBigInt(roundedShare(centsToBigInt(amountCents), line.ownershipBps!));
  }
  return { ...line, amountCents, currency, translatedAmountCents: null, translatedCurrency: null };
}

function sumField(rows: readonly Record<string, unknown>[], field: string): bigint | null {
  let sum = BigInt(0);
  for (const row of rows) {
    const value = row[field];
    if (typeof value !== "string") return null;
    sum += centsToBigInt(value);
  }
  return sum;
}

/** Report totals are exact sums of the displayed rows, per single currency. */
function combinedTotals(reportId: CombinedFinancialReportId, rows: readonly Record<string, unknown>[], partial: boolean): ReportTotal[] {
  const currencies = Array.from(new Set(rows.map(row => row.currency).filter((value): value is string => typeof value === "string")));
  if (currencies.length !== 1) return [];
  const currency = currencies[0] as ReportTotal["currency"];
  const make = (key: string, amount: bigint | null): ReportTotal => ({ key, amountCents: amount === null ? null : centsFromBigInt(amount), currency, state: amount === null ? "unknown" : partial ? "partial" : "complete" });
  if (reportId === "budget-vs-actual") return [make("budget", sumField(rows, "budgetCents")), make("actual", sumField(rows, "actualCents")), make("variance", sumField(rows, "varianceCents"))];
  if (reportId === "income-statement-consolidated") {
    // Income and expense carry natural signs; the net is income less expense.
    const income = sumField(rows.filter(row => row.category === "income"), "consolidatedAmountCents");
    const expenses = sumField(rows.filter(row => row.category === "expense"), "consolidatedAmountCents");
    return [make("eliminations", sumField(rows, "eliminatedAmountCents")), make("consolidated_income", income), make("consolidated_expenses", expenses), make("consolidated_net_income", income === null || expenses === null ? null : income - expenses)];
  }
  if (reportId.endsWith("-consolidated")) return [make("source_amount", sumField(rows, "amountCents")), make("eliminations", sumField(rows, "eliminatedAmountCents")), make("consolidated_amount", sumField(rows, "consolidatedAmountCents"))];
  if (reportId === "cash-position") return [make("cash_balance", sumField(rows, "balanceCents"))];
  if (reportId === "accounts-payable") return [make("open_payables", sumField(rows, "amountCents"))];
  if (reportId === "accounts-receivable") return [make("open_receivables", sumField(rows, "amountCents"))];
  const income = sumField(rows.filter(row => row.category === "income"), "amountCents");
  const expense = sumField(rows.filter(row => row.category === "expense"), "amountCents");
  if (["income-statement-by-unit", "portfolio-financials", "property-t12"].includes(reportId) && rows.some(row => row.category === "income" || row.category === "expense")) {
    return [make("income", income), make("expenses", expense), make("net_operating_income", income === null || expense === null ? null : income - expense)];
  }
  return [make("total", sumField(rows, "amountCents"))];
}

export function createCombinedFinancialReportingEngine(read: CombinedFinancialReadPort): ReportingEngine {
  return {
    key: "combined.financial",
    reportIds: [...COMBINED_FINANCIAL_REPORT_IDS],
    ready: true,
    ...(read.probe ? { probe: ({ organizationId, reportId }: { organizationId: string; reportId: string }) => read.probe!({ organizationId, reportId: reportId as CombinedFinancialReportId }) } : {}),
    async run(context): Promise<ReportingEngineResult> {
      const reportId = context.definition.id as CombinedFinancialReportId;
      const filterUnits = Array.isArray(context.request.filters.unitIds) ? context.request.filters.unitIds.filter((value): value is string => typeof value === "string") : [];
      const source = await read.read({ context, reportId, legalEntityIds: context.request.scope.legalEntityIds.map(String), propertyIds: context.request.scope.propertyIds.map(String), unitIds: Array.from(new Set([...context.request.scope.unitIds.map(String), ...filterUnits])), accountIds: Array.isArray(context.request.filters.accountIds) ? context.request.filters.accountIds.filter((value): value is string => typeof value === "string") : [] });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", source.coverage.reason ?? "The accounting mirror is unavailable for the requested entity scope.", 409, { dependency: "quickbooks_accounting_mirror" });
      const lines = scopeLines(context, reportId, source.lines);
      const missingData: ReportMissingData[] = [];
      let rows: unknown[] = [];
      const expectedStatement = statementFor(reportId);
      if (expectedStatement && !lines.length) throw new ReportingError("report_unavailable", `The accounting mirror returned no ${expectedStatement} rows for the selected scope and period.`, 409, { dependency: "verified_statement_semantics" });
      const wrongStatement = expectedStatement ? lines.filter(line => line.statement !== expectedStatement) : [];
      if (wrongStatement.length) throw new ReportingError("report_unavailable", `The accounting mirror did not provide ${expectedStatement} semantics for ${reportId}.`, 409, { dependency: "verified_statement_semantics" });
      if (expectedStatement && lines.some(line => !line.statement)) throw new ReportingError("report_unavailable", `The accounting mirror did not prove statement semantics for ${reportId}.`, 409, { dependency: "verified_statement_semantics" });
      if (context.request.currency && lines.some(line => line.currency !== context.request.currency) && !(reportId.endsWith("-consolidated") && context.request.consolidation?.translationPolicy === "approved_rates")) throw new ReportingError("report_unavailable", "Financial lines include a currency outside the requested report currency, but no translated amount is present in the source.", 409, { dependency: source.translationVersion ?? "approved_translation_rates" });
      if (lines.some(line => line.basis !== context.request.basis) && reportId !== "cash-position") throw new ReportingError("report_unavailable", "The accounting mirror returned lines on a different accounting basis than requested.", 409, { dependency: "verified_accounting_basis" });
      if (lines.some(line => !line.canonicalAccountId) && reportId.endsWith("-consolidated")) throw new ReportingError("report_unavailable", "Consolidated financial reports require a canonical account mapping; realm-local account IDs cannot be merged.", 409, { dependency: source.accountMappingVersion ?? "approved_account_mapping" });
      if (reportId.endsWith("-consolidated")) {
        const policy = requireConsolidation(context);
        if (policy.eliminationPolicy === "approved_version" && !source.eliminations) throw new ReportingError("report_unavailable", "The selected elimination version is not available in the accounting mirror.", 409, { dependency: policy.eliminationVersion ?? "approved_elimination_version" });
        if (policy.ownershipPolicy !== "full_control" && !source.ownershipMappingVersion) throw new ReportingError("report_unavailable", "The selected ownership policy has no approved dated ownership mapping.", 409, { dependency: "approved_ownership_mapping" });
        if (policy.translationPolicy === "approved_rates" && !source.translationVersion) throw new ReportingError("report_unavailable", "The selected translation policy has no approved dated translation version.", 409, { dependency: "approved_translation_rates" });
        if (!source.accountMappingVersion) throw new ReportingError("report_unavailable", "Consolidated reports require a dated approved account mapping version.", 409, { dependency: "approved_account_mapping" });
        const selectedEntities = new Set<string>(policy.entityIds.map(String));
        if (lines.some(line => !selectedEntities.has(String(line.legalEntityId)))) throw new ReportingError("report_unavailable", "The accounting mirror returned a line outside the explicitly selected consolidation entities.", 409, { dependency: "consolidation_entity_scope" });
        if (policy.eliminationPolicy === "approved_version" && source.eliminationVersion !== policy.eliminationVersion) throw new ReportingError("report_unavailable", "The accounting mirror returned a different elimination version than the one selected for this report.", 409, { dependency: policy.eliminationVersion ?? "approved_elimination_version" });
        const eliminationByAccount = new Map<string, bigint>();
        if (policy.eliminationPolicy === "approved_version") {
          for (const item of source.eliminations ?? []) {
            if (!selectedEntities.has(String(item.entityId)) || item.currency !== policy.currency) throw new ReportingError("report_unavailable", "The accounting mirror returned an elimination outside the selected entity set or report currency.", 409, { dependency: policy.eliminationVersion ?? "approved_elimination_version" });
            const key = consolidationLineKey({ accountId: item.accountId, canonicalAccountId: item.canonicalAccountId, sourceRealmId: item.sourceRealmId, legalEntityId: item.entityId, currency: item.currency });
            eliminationByAccount.set(key, (eliminationByAccount.get(key) ?? BigInt(0)) + centsToBigInt(item.amountCents));
          }
        }
        const effectiveLines = lines.map(line => effectiveConsolidationLine(line, policy));
        const lineKeys = new Set(effectiveLines.map(line => consolidationLineKey(line)));
        rows = aggregate(effectiveLines, line => consolidationLineKey(line), line => ({ consolidationKey: consolidationLineKey(line), accountId: line.canonicalAccountId ?? line.accountId, accountName: line.accountName ?? null, category: line.category ?? null, sourceRealmId: line.sourceRealmId ?? null, entityCount: new Set(effectiveLines.filter(item => consolidationLineKey(item) === consolidationLineKey(line)).map(item => item.legalEntityId)).size, eliminationVersion: policy.eliminationPolicy === "approved_version" ? policy.eliminationVersion ?? null : null, eliminationPolicy: policy.eliminationPolicy })).map(row => {
          const value = row as { consolidationKey: string; accountId: string; amountCents: string; currency: string; sourceRealmId: string | null };
          const key = value.consolidationKey;
          const adjustment = eliminationByAccount.get(key) ?? BigInt(0);
          const sourceAmount = centsToBigInt(value.amountCents);
          return { ...(row as Record<string, unknown>), eliminatedAmountCents: policy.eliminationPolicy === "approved_version" ? centsFromBigInt(adjustment) : "0", consolidatedAmountCents: centsFromBigInt(sourceAmount + adjustment) };
        });
        if (policy.eliminationPolicy === "approved_version") {
          for (const [key, adjustment] of Array.from(eliminationByAccount.entries())) if (!lineKeys.has(key)) {
            const [identity, currency] = key.split(/:(?=[^:]+$)/);
            // An elimination on an account with no source line keeps its own
            // row; its category comes from the mapped lines when known.
            rows.push({ accountId: identity ?? key, accountName: null, category: null, sourceRealmId: null, entityCount: 0, amountCents: "0", currency, eliminationVersion: policy.eliminationVersion ?? null, eliminationPolicy: policy.eliminationPolicy, eliminatedAmountCents: centsFromBigInt(adjustment), consolidatedAmountCents: centsFromBigInt(adjustment) });
          }
        }
        if (policy.eliminationPolicy === "none") missingData.push(missing("elimination_policy_none", "The consolidated result excludes eliminations because the selected policy is none.", "partial"));
      } else if (reportId === "balance-sheet-by-fund-type") {
        if (!source.fundMappingVersion) throw new ReportingError("report_unavailable", "Balance sheet by fund type requires an approved fund mapping version.", 409, { dependency: "approved_fund_mapping" });
        const withoutFund = lines.filter(line => !line.fundType);
        if (withoutFund.length) missingData.push(missing("fund_mapping_missing", "Some balance-sheet lines have no approved fund-type mapping.", "partial"));
        rows = aggregate(lines.filter(line => line.fundType), line => `${line.fundType}:${accountKey(line, false)}`, line => ({ fundType: line.fundType, accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null }));
      } else if (reportId === "budget-vs-actual") {
        if (!source.budgetLines) throw new ReportingError("report_unavailable", "No approved budget version is available for the selected period.", 409, { dependency: "approved_budget_version" });
        const actual = new Map<string, { amount: bigint; line: FinancialReportingLine }>();
        for (const line of lines) { const key = `${accountKey(line, false)}:${line.propertyId ?? ""}:${line.unitId ?? ""}:${line.month ?? line.date.slice(0, 7)}`; const current = actual.get(key); actual.set(key, { amount: (current?.amount ?? BigInt(0)) + centsToBigInt(line.amountCents), line }); }
        const budgetGroups = new Map<string, { amount: bigint; line: FinancialReportingBudgetLine; ids: string[] }>();
        for (const line of source.budgetLines) {
          if (!budgetPeriodInScope(line.period, context)) continue;
          if (context.request.scope.legalEntityIds.length && !context.request.scope.legalEntityIds.includes(line.legalEntityId as typeof context.request.scope.legalEntityIds[number])) continue;
          if (context.request.scope.propertyIds.length && (!line.propertyId || !context.request.scope.propertyIds.includes(line.propertyId as typeof context.request.scope.propertyIds[number]))) continue;
          if (context.request.scope.unitIds.length && (!line.unitId || !context.request.scope.unitIds.includes(line.unitId as typeof context.request.scope.unitIds[number]))) continue;
          if (Array.isArray(context.request.filters.accountIds) && context.request.filters.accountIds.length && !context.request.filters.accountIds.includes(line.accountId)) continue;
          const key = `${budgetAccountKey(line)}:${line.propertyId ?? ""}:${line.unitId ?? ""}:${line.period}`;
          const current = budgetGroups.get(key);
          if (current) { current.amount += centsToBigInt(line.budgetCents); current.ids.push(line.id); }
          else budgetGroups.set(key, { amount: centsToBigInt(line.budgetCents), line, ids: [line.id] });
        }
        rows = Array.from(budgetGroups.values()).map(({ amount, line: budget, ids }) => {
          const actualKey = `${budgetAccountKey(budget)}:${budget.propertyId ?? ""}:${budget.unitId ?? ""}:${budget.period}`;
          const actualLine = actual.get(actualKey);
          if (!actualLine) missingData.push(missing("actual_line_missing", `No actual accounting line was found for budget period ${budget.period}.`, "partial"));
          return { budgetId: ids.join(","), accountId: budget.accountId, propertyId: budget.propertyId ?? null, unitId: budget.unitId ?? null, period: budget.period, budgetCents: centsFromBigInt(amount), actualCents: actualLine ? centsFromBigInt(actualLine.amount) : null, varianceCents: actualLine ? centsFromBigInt(actualLine.amount - amount) : null, currency: budget.currency };
        });
      } else if (reportId === "income-statement-by-unit") {
        if (!source.unitAllocationVersion) throw new ReportingError("report_unavailable", "Income statement by unit requires an approved dated unit allocation version.", 409, { dependency: "approved_allocation_version" });
        const unallocated = lines.filter(line => !line.unitId);
        if (unallocated.length) missingData.push(missing("unit_allocation_missing", "Some income lines have no approved unit allocation.", "partial"));
        rows = aggregate(lines.filter(line => line.unitId), line => `${line.unitId}:${accountKey(line, false)}`, line => ({ unitId: line.unitId, accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null, propertyId: line.propertyId ?? null, category: line.category ?? null }));
      } else if (reportId === "portfolio-financials") {
        if (!source.propertyMappingVersion) throw new ReportingError("report_unavailable", "Property financial reports require an approved dated property allocation version.", 409, { dependency: "effective_property_entity_mapping" });
        const unallocated = lines.filter(line => !line.propertyId);
        if (unallocated.length) missingData.push(missing("property_allocation_missing", "Some financial lines have no verified dated property mapping.", "partial"));
        // Lines without a dated property mapping stay in an explicit
        // unallocated bucket instead of being spread across properties.
        rows = aggregate(lines, line => `${line.propertyId ?? "unallocated"}:${accountKey(line, false)}`, line => ({ propertyId: line.propertyId ?? null, propertyLabel: line.propertyId ?? "Unallocated", accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null, category: line.category ?? null }));
      } else if (reportId === "property-t12") {
        if (!source.propertyMappingVersion) throw new ReportingError("report_unavailable", "Property T12 requires an approved dated property mapping version.", 409, { dependency: "effective_property_entity_mapping" });
        const unallocated = lines.filter(line => !line.propertyId);
        if (unallocated.length || source.propertyAttribution?.unattributedLineCount) missingData.push(missing("property_allocation_missing", "Some T12 lines have no verified dated property mapping.", "partial"));
        rows = aggregate(lines.filter(line => line.propertyId), line => `${line.propertyId}:${accountKey(line, false)}:${line.month ?? line.date.slice(0, 7)}`, line => ({ propertyId: line.propertyId, accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null, month: line.month ?? line.date.slice(0, 7), category: line.category ?? null }));
      } else if (reportId === "accounts-receivable") {
        const receivable = lines.filter(line => line.category === "accounts_receivable" || line.category === "receivable");
        if (!receivable.length && lines.length) missingData.push(missing("receivable_classification_missing", "The accounting mirror returned lines without an approved receivable classification.", "partial"));
        rows = aggregate(receivable, line => `${line.legalEntityId}:${line.propertyId ?? ""}:${accountKey(line, false)}`, line => ({ legalEntityId: line.legalEntityId, propertyId: line.propertyId ?? null, accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null }));
      } else if (reportId === "accounts-payable") {
        const payable = lines.filter(line => line.category === "accounts_payable" || line.category === "payable");
        if (!payable.length && lines.length) missingData.push(missing("payable_classification_missing", "The accounting mirror returned lines without an approved payable classification.", "partial"));
        rows = aggregate(payable, line => `${line.legalEntityId}:${line.propertyId ?? ""}:${accountKey(line, false)}`, line => ({ legalEntityId: line.legalEntityId, propertyId: line.propertyId ?? null, accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null }));
      } else if (reportId === "cash-position") {
        if (!source.bankBalances) throw new ReportingError("report_unavailable", "Bank observations are not available for cash position.", 409, { dependency: "bank_observations" });
        rows = source.bankBalances.map(balance => ({ accountId: balance.accountId, legalEntityId: balance.legalEntityId, asOfDate: balance.asOfDate, balanceCents: balance.balanceCents, currency: balance.currency, sourceId: balance.sourceId }));
      } else {
        rows = aggregate(lines, line => accountKey(line, false), line => ({ accountId: line.canonicalAccountId ?? line.accountId, sourceRealmId: line.sourceRealmId ?? null, accountName: line.accountName ?? null, legalEntityId: line.legalEntityId, category: line.category ?? null }));
      }
      const columns = reportId === "budget-vs-actual"
        ? reportColumns([{ id: "accountId", label: "Account", type: "text" }, { id: "propertyId", label: "Property", type: "text" }, { id: "unitId", label: "Unit", type: "text" }, { id: "period", label: "Period", type: "date" }, { id: "budgetCents", label: "Budget", type: "money" }, { id: "actualCents", label: "Actual", type: "money" }, { id: "varianceCents", label: "Variance", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
        : reportId.endsWith("-consolidated")
          ? reportColumns([{ id: "accountName", label: "Account", type: "text" }, { id: "entityCount", label: "Entities", type: "integer" }, { id: "amountCents", label: "Source amount", type: "money" }, { id: "eliminatedAmountCents", label: "Eliminations", type: "money" }, { id: "consolidatedAmountCents", label: "Consolidated amount", type: "money" }, { id: "currency", label: "Currency", type: "text" }, { id: "eliminationPolicy", label: "Elimination policy", type: "status" }])
        : reportId === "balance-sheet-by-fund-type"
          ? reportColumns([{ id: "fundType", label: "Fund type", type: "text" }, { id: "accountName", label: "Account", type: "text" }, { id: "amountCents", label: "Balance", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
          : reportId === "income-statement-by-unit"
            ? reportColumns([{ id: "propertyId", label: "Property", type: "text" }, { id: "unitId", label: "Unit", type: "text" }, { id: "accountName", label: "Account", type: "text" }, { id: "category", label: "Category", type: "status" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
            : reportId === "property-t12"
              ? reportColumns([{ id: "propertyId", label: "Property", type: "text" }, { id: "month", label: "Month", type: "month" }, { id: "accountName", label: "Account", type: "text" }, { id: "category", label: "Category", type: "status" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
              : reportId === "portfolio-financials"
                ? reportColumns([{ id: "propertyLabel", label: "Property", type: "text" }, { id: "accountName", label: "Account", type: "text" }, { id: "category", label: "Category", type: "status" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
                : reportId === "cash-position"
                  ? reportColumns([{ id: "legalEntityId", label: "Legal entity", type: "text" }, { id: "asOfDate", label: "As of", type: "date" }, { id: "balanceCents", label: "Balance", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
                  : reportColumns([{ id: "legalEntityId", label: "Legal entity", type: "text" }, { id: "accountName", label: "Account", type: "text" }, { id: "category", label: "Category", type: "status" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "currency", label: "Currency", type: "text" }]);
      const result = resultFromRecords(context, rows, { source: "quickbooks_mirror_and_company_mappings", basis: context.request.basis, missingData, columns, totals: combinedTotals(reportId, rows as Record<string, unknown>[], missingData.length > 0 || source.coverage.state !== "complete") });
      return { ...result, coverage: [coverage(context, source, result.rows.length)] };
    },
  };
}

export function createUnavailableCombinedFinancialEngine(reason = "No accounting mirror and mapping reader is registered."): ReportingEngine {
  return { key: "combined.financial", reportIds: [...COMBINED_FINANCIAL_REPORT_IDS], ready: false, reason, async run() { throw new ReportingError("report_unavailable", reason, 409, { dependency: "verified_quickbooks_books" }); } };
}
