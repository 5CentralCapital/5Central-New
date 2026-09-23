import { centsFromBigInt } from "../../shared/company";
import type { ReportDrilldown, ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, rowMatchesSearch, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine, ReportingEngineProbeResult } from "./registry";

export const OWNER_STATEMENT_REPORT_IDS = ["rental-owner-statement", "rental-owner-ending-balances"] as const;
export type OwnerStatementReportId = (typeof OWNER_STATEMENT_REPORT_IDS)[number];

export const PM_SETTLEMENT_LINE_KINDS = ["rent_receipt", "subsidy_receipt", "deposit_receipt", "other_receipt", "pm_fee", "pm_expense", "other_deduction", "owner_remittance"] as const;
export type PmSettlementLineKind = (typeof PM_SETTLEMENT_LINE_KINDS)[number];

export interface PmSettlementLineRecord {
  readonly lineNumber: number;
  readonly kind: PmSettlementLineKind;
  readonly description: string;
  readonly amountCents: string;
  readonly occurredOn: string | null;
  readonly unitId: string | null;
  readonly tenancyId: string | null;
}

/** One property-manager settlement (gross-to-net) as recorded by accounting. */
export interface PmSettlementRecord {
  readonly id: string;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly propertyName: string | null;
  readonly managerName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly openingHeldCents: string;
  readonly grossCollectionsCents: string;
  readonly pmFeesCents: string;
  readonly pmExpensesCents: string;
  readonly otherDeductionsCents: string;
  readonly ownerRemittanceCents: string;
  readonly closingHeldCents: string;
  readonly state: "draft" | "reconciled" | "exception";
  readonly exceptionReason: string | null;
  readonly bankSettledOn: string | null;
  readonly lines: readonly PmSettlementLineRecord[];
}

export interface PmSettlementReadResult {
  readonly settlements: readonly PmSettlementRecord[];
  readonly coverage: { readonly state: ReportSourceCoverage["state"]; readonly evidence: ReportSourceCoverage["evidence"]; readonly watermark?: string | null; readonly reason?: string | null };
}

export interface PmSettlementReadPort {
  /** Settlements whose period ends on or before `through` and (when given) ends on or after `from`. */
  read(input: { readonly context: ReportingEngineContext; readonly from: string | null; readonly through: string }): Promise<PmSettlementReadResult>;
  /** Organization-level presence check for the catalog. */
  hasSettlements?(organizationId: string): Promise<boolean>;
}

const RECEIPT_KINDS = new Set<PmSettlementLineKind>(["rent_receipt", "subsidy_receipt", "deposit_receipt", "other_receipt"]);
const big = (value: string): bigint => BigInt(value);

/** opening + gross − fees − expenses − other − remittance = closing */
export function settlementIdentityHolds(settlement: Pick<PmSettlementRecord, "openingHeldCents" | "grossCollectionsCents" | "pmFeesCents" | "pmExpensesCents" | "otherDeductionsCents" | "ownerRemittanceCents" | "closingHeldCents">): boolean {
  return big(settlement.openingHeldCents) + big(settlement.grossCollectionsCents) - big(settlement.pmFeesCents) - big(settlement.pmExpensesCents) - big(settlement.otherDeductionsCents) - big(settlement.ownerRemittanceCents) === big(settlement.closingHeldCents);
}

/** Sums of line kinds must tie to the settlement header when lines exist. */
export function settlementLinesTie(settlement: PmSettlementRecord): boolean {
  if (!settlement.lines.length) return true;
  const sum = (kinds: (kind: PmSettlementLineKind) => boolean) => settlement.lines.filter(line => kinds(line.kind)).reduce((total, line) => total + big(line.amountCents), BigInt(0));
  return sum(kind => RECEIPT_KINDS.has(kind)) === big(settlement.grossCollectionsCents)
    && sum(kind => kind === "pm_fee") === big(settlement.pmFeesCents)
    && sum(kind => kind === "pm_expense") === big(settlement.pmExpensesCents)
    && sum(kind => kind === "other_deduction") === big(settlement.otherDeductionsCents)
    && sum(kind => kind === "owner_remittance") === big(settlement.ownerRemittanceCents);
}

function chainKey(settlement: PmSettlementRecord): string { return `${settlement.legalEntityId}:${settlement.propertyId}:${settlement.managerName}:${settlement.currency}`; }

function total(key: string, amount: bigint, currency: string, state: ReportTotal["state"]): ReportTotal {
  return { key, amountCents: centsFromBigInt(amount), currency: currency as ReportTotal["currency"], state };
}

function scoped(context: ReportingEngineContext, settlements: readonly PmSettlementRecord[]): PmSettlementRecord[] {
  const scope = context.request.scope;
  return settlements.filter(item => (!scope.legalEntityIds.length || scope.legalEntityIds.includes(item.legalEntityId as typeof scope.legalEntityIds[number]))
    && (!scope.propertyIds.length || scope.propertyIds.includes(item.propertyId as typeof scope.propertyIds[number]))
    && rowMatchesSearch({ propertyName: item.propertyName, managerName: item.managerName }, context.request.filters.search));
}

/**
 * Owner statements and ending balances from recorded PM settlements. Gross
 * collections, PM fees, PM expenses, other deductions and owner remittances
 * are separate measures; each settlement must satisfy
 * opening + gross − fees − expenses − other − remittance = closing, and each
 * manager chain must carry its closing balance into the next opening balance.
 */
export function createOwnerStatementReportingEngine(read: PmSettlementReadPort): ReportingEngine {
  const probeCache = new Map<string, Promise<ReportingEngineProbeResult>>();
  const probe = (organizationId: string): Promise<ReportingEngineProbeResult> => {
    const cached = probeCache.get(organizationId);
    if (cached) return cached;
    const created = read.hasSettlements!(organizationId).then(found => found
      ? { status: "available" as const }
      : { status: "missing_data" as const, reason: "No property-manager settlements are recorded yet.", dependency: "pm_settlements" });
    probeCache.set(organizationId, created);
    return created;
  };
  return {
    key: "combined.owner-statements",
    reportIds: [...OWNER_STATEMENT_REPORT_IDS],
    ready: true,
    ...(read.hasSettlements ? { probe: ({ organizationId }: { organizationId: string }) => probe(organizationId) } : {}),
    async run(context): Promise<ReportingEngineResult> {
      const reportId = context.definition.id as OwnerStatementReportId;
      const bounds = periodBounds(context);
      const through = bounds.through;
      if (!through) throw new ReportingError("report_validation", "Choose a report date.", 400);
      const source = await read.read({ context, from: reportId === "rental-owner-statement" ? bounds.from : null, through });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", source.coverage.reason ?? "Property-manager settlements are unavailable.", 409, { dependency: "pm_settlements" });
      const settlements = scoped(context, source.settlements).sort((left, right) => chainKey(left).localeCompare(chainKey(right)) || left.periodStart.localeCompare(right.periodStart));
      const missing: ReportMissingData[] = [];
      for (const settlement of settlements) {
        if (!settlementIdentityHolds(settlement)) missing.push({ code: "pm_settlement_identity_failed", state: "partial", message: `The ${settlement.managerName} settlement for ${settlement.periodStart} to ${settlement.periodEnd} does not reconcile opening, activity and closing balances.`, scope: settlement.id });
        if (!settlementLinesTie(settlement)) missing.push({ code: "pm_settlement_lines_do_not_tie", state: "partial", message: `Line detail for the ${settlement.managerName} settlement ending ${settlement.periodEnd} does not tie to its totals.`, scope: settlement.id });
        if (settlement.state === "exception") missing.push({ code: "pm_settlement_exception", state: "partial", message: `${settlement.managerName} settlement ending ${settlement.periodEnd} is an exception: ${settlement.exceptionReason ?? "reason not recorded"}.`, scope: settlement.id });
        if (settlement.state === "draft") missing.push({ code: "pm_settlement_draft", state: "partial", message: `${settlement.managerName} settlement ending ${settlement.periodEnd} is not reconciled yet.`, scope: settlement.id });
      }
      const chains = new Map<string, PmSettlementRecord[]>();
      for (const settlement of settlements) chains.set(chainKey(settlement), [...(chains.get(chainKey(settlement)) ?? []), settlement]);
      for (const chain of Array.from(chains.values())) for (let index = 1; index < chain.length; index += 1) {
        const previous = chain[index - 1]!;
        const next = chain[index]!;
        if (big(previous.closingHeldCents) !== big(next.openingHeldCents)) missing.push({ code: "pm_settlement_chain_break", state: "partial", message: `${next.managerName} opening balance on ${next.periodStart} does not equal the prior closing balance on ${previous.periodEnd}.`, scope: next.id });
        if (previous.periodEnd >= next.periodStart) missing.push({ code: "pm_settlement_periods_overlap", state: "partial", message: `${next.managerName} settlements ending ${previous.periodEnd} and starting ${next.periodStart} overlap.`, scope: next.id });
      }
      const currencies = Array.from(new Set(settlements.map(item => item.currency)));
      const incomplete = missing.length > 0;
      if (reportId === "rental-owner-ending-balances") {
        const latest = Array.from(chains.values()).map(chain => chain.at(-1)!);
        if (!latest.length) throw new ReportingError("report_unavailable", "No property-manager settlements end on or before the report date for this scope.", 409, { dependency: "pm_settlements" });
        const records = latest.map(item => ({ settlementId: item.id, propertyId: item.propertyId, propertyName: item.propertyName, managerName: item.managerName, balanceThrough: item.periodEnd, closingHeldCents: item.closingHeldCents, currency: item.currency, state: item.state, daysSinceStatement: Math.max(0, Math.round((Date.parse(`${through}T00:00:00Z`) - Date.parse(`${item.periodEnd}T00:00:00Z`)) / 86_400_000)) }));
        const stale = records.filter(record => record.balanceThrough < through);
        if (stale.length) missing.push({ code: "pm_balance_before_report_date", state: "partial", message: `${stale.length} balance${stale.length === 1 ? " is" : "s are"} known only through an earlier statement date.`, count: stale.length });
        const totals = currencies.length === 1 ? [total("closing_held", latest.reduce((sum, item) => sum + big(item.closingHeldCents), BigInt(0)), currencies[0]!, incomplete || stale.length ? "partial" : "complete")] : [];
        const result = resultFromRecords(context, records, { source: "pm_settlements", basis: "mixed", missingData: missing, totals, rowId: (_record, _index, values) => `owner-balance:${String(values.settlementId)}`, columns: reportColumns([
          { id: "propertyName", label: "Property", type: "text" }, { id: "managerName", label: "Property manager", type: "text" }, { id: "balanceThrough", label: "Statement through", type: "date" },
          { id: "closingHeldCents", label: "Held by manager", type: "money" }, { id: "state", label: "State", type: "status" }, { id: "daysSinceStatement", label: "Days since statement", type: "integer" },
        ]) });
        return { ...result, coverage: [sourceCoverage(context, { source: "pm_settlements", state: incomplete ? "partial" : source.coverage.state, evidence: source.coverage.evidence, basis: "mixed", watermark: source.coverage.watermark ?? null, rowCount: result.rows.length, reason: source.coverage.reason ?? null })] };
      }
      const inRange = settlements.filter(item => !bounds.from || item.periodStart >= bounds.from);
      const straddling = settlements.filter(item => bounds.from && item.periodStart < bounds.from && item.periodEnd >= bounds.from);
      if (straddling.length) missing.push({ code: "pm_settlement_straddles_period", state: "partial", message: `${straddling.length} settlement${straddling.length === 1 ? " starts" : "s start"} before the report period and ${straddling.length === 1 ? "is" : "are"} excluded.`, count: straddling.length });
      if (!inRange.length) throw new ReportingError("report_unavailable", "No property-manager settlements fall within the selected period and scope.", 409, { dependency: "pm_settlements" });
      const records = inRange.map(item => ({
        settlementId: item.id, propertyId: item.propertyId, propertyName: item.propertyName, managerName: item.managerName, periodStart: item.periodStart, periodEnd: item.periodEnd,
        openingHeldCents: item.openingHeldCents, grossCollectionsCents: item.grossCollectionsCents, pmFeesCents: item.pmFeesCents, pmExpensesCents: item.pmExpensesCents,
        otherDeductionsCents: item.otherDeductionsCents, ownerRemittanceCents: item.ownerRemittanceCents, closingHeldCents: item.closingHeldCents, currency: item.currency,
        reconciles: settlementIdentityHolds(item) && settlementLinesTie(item), state: item.state, bankSettledOn: item.bankSettledOn,
      }));
      const drilldowns: ReportDrilldown[] = inRange.filter(item => item.lines.length).map(item => ({ rowId: `owner-statement:${item.id}`, items: item.lines.map(line => ({ id: `${item.id}:${line.lineNumber}`, kind: "line" as const, values: { kind: line.kind, description: line.description, amountCents: line.amountCents, occurredOn: line.occurredOn, unitId: line.unitId } })), nextCursor: null, coverage: [], missingData: [] }));
      const totals: ReportTotal[] = [];
      if (currencies.length === 1) {
        const currency = currencies[0]!;
        const state: ReportTotal["state"] = missing.length ? "partial" : "complete";
        const sum = (field: keyof Pick<PmSettlementRecord, "grossCollectionsCents" | "pmFeesCents" | "pmExpensesCents" | "otherDeductionsCents" | "ownerRemittanceCents">) => inRange.reduce((acc, item) => acc + big(item[field]), BigInt(0));
        const chainsInRange = new Map<string, PmSettlementRecord[]>();
        for (const item of inRange) chainsInRange.set(chainKey(item), [...(chainsInRange.get(chainKey(item)) ?? []), item]);
        const opening = Array.from(chainsInRange.values()).reduce((acc, chain) => acc + big(chain[0]!.openingHeldCents), BigInt(0));
        const closing = Array.from(chainsInRange.values()).reduce((acc, chain) => acc + big(chain.at(-1)!.closingHeldCents), BigInt(0));
        totals.push(total("opening_held", opening, currency, state), total("gross_collections", sum("grossCollectionsCents"), currency, state), total("pm_fees", sum("pmFeesCents"), currency, state), total("pm_expenses", sum("pmExpensesCents"), currency, state), total("other_deductions", sum("otherDeductionsCents"), currency, state), total("owner_remittance", sum("ownerRemittanceCents"), currency, state), total("closing_held", closing, currency, state));
      } else missing.push({ code: "pm_settlement_multiple_currencies", state: "partial", message: "Settlements use more than one currency, so no single total is shown." });
      const result = resultFromRecords(context, records, { source: "pm_settlements", basis: "mixed", missingData: missing, totals, drilldowns, rowId: (_record, _index, values) => `owner-statement:${String(values.settlementId)}`, columns: reportColumns([
        { id: "propertyName", label: "Property", type: "text" }, { id: "managerName", label: "Property manager", type: "text" }, { id: "periodStart", label: "From", type: "date" }, { id: "periodEnd", label: "Through", type: "date" },
        { id: "openingHeldCents", label: "Opening held", type: "money" }, { id: "grossCollectionsCents", label: "Gross collections", type: "money" }, { id: "pmFeesCents", label: "PM fees", type: "money" },
        { id: "pmExpensesCents", label: "PM expenses", type: "money" }, { id: "otherDeductionsCents", label: "Other deductions", type: "money" }, { id: "ownerRemittanceCents", label: "Owner remittance", type: "money" },
        { id: "closingHeldCents", label: "Closing held", type: "money" }, { id: "reconciles", label: "Reconciles", type: "boolean" }, { id: "state", label: "State", type: "status" },
      ]) });
      return { ...result, coverage: [sourceCoverage(context, { source: "pm_settlements", state: missing.length ? "partial" : source.coverage.state, evidence: source.coverage.evidence, basis: "mixed", watermark: source.coverage.watermark ?? null, rowCount: result.rows.length, reason: source.coverage.reason ?? null })] };
    },
  };
}
