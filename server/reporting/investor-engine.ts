import { centsFromBigInt, centsToBigInt } from "../../shared/company";
import type { InvestorDetail } from "../../shared/investors";
import type { ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage, stringArrayFilter } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const INVESTOR_REPORT_IDS = ["investor-owner-activity"] as const;
export type InvestorReportId = (typeof INVESTOR_REPORT_IDS)[number];

export interface InvestorReportingReadResult {
  readonly accounts: readonly InvestorDetail[];
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

export interface InvestorReportingReadPort {
  read(input: { readonly context: ReportingEngineContext; readonly accountIds: readonly string[]; readonly investorIds: readonly string[]; readonly legalEntityIds: readonly string[] }): Promise<InvestorReportingReadResult>;
}

function inPeriod(date: string, context: ReportingEngineContext): boolean {
  const bounds = periodBounds(context);
  return (!bounds.from || date >= bounds.from) && (!bounds.through || date <= bounds.through);
}

function accountMatches(context: ReportingEngineContext, account: InvestorDetail): boolean {
  const scope = context.request.scope;
  if (scope.investorIds.length && !scope.investorIds.includes(String(account.id) as typeof scope.investorIds[number])) return false;
  const selected = stringArrayFilter(context.request.filters.investorIds);
  if (selected.length && !selected.includes(String(account.id))) return false;
  return account.organizationId === scope.organizationId;
}

function coverage(context: ReportingEngineContext, result: InvestorReportingReadResult, rowCount: number): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, {
    source: "company_investor_obligations_and_payments",
    state: result.coverage.state,
    evidence: result.coverage.evidence,
    basis: "mixed",
    watermark: result.coverage.watermark ?? null,
    coveredFrom: bounds.from,
    coveredThrough: bounds.through,
    rowCount,
    reason: result.coverage.reason ?? "Investor records preserve expected, recorded, posted, and settled states; source validity is retained per payment.",
  });
}

type TotalTreatment = "recorded" | "expected" | "review_required" | "reversed";

/** How an activity row counts: recorded payments are totaled per kind,
 * planned/due obligations separately, and unverified or reversed payments
 * are shown but never counted. */
function activityTreatment(status: string, reversedOriginal: boolean): TotalTreatment {
  if (status === "reversed" || reversedOriginal) return "reversed";
  if (status === "review_required") return "review_required";
  if (status === "planned" || status === "due") return "expected";
  return "recorded";
}

function totals(key: string, amount: bigint | null, currency: string | null, state: ReportTotal["state"]): ReportTotal {
  return { key, amountCents: amount === null ? null : centsFromBigInt(amount), currency: currency as ReportTotal["currency"], state };
}

export function createInvestorReportingEngine(read: InvestorReportingReadPort): ReportingEngine {
  return {
    key: "combined.investors",
    reportIds: [...INVESTOR_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const requestedInvestors = Array.from(new Set([...context.request.scope.investorIds.map(String), ...stringArrayFilter(context.request.filters.investorIds)]));
      const statuses = stringArrayFilter(context.request.filters.status);
      const input = await read.read({ context, accountIds: context.request.scope.ownerIds.map(String), investorIds: requestedInvestors, legalEntityIds: context.request.scope.legalEntityIds.map(String) });
      const accounts = input.accounts.filter(account => accountMatches(context, account));
      if (!accounts.length && input.coverage.state === "unavailable") throw new ReportingError("report_unavailable", "Investor reporting data is unavailable for the requested scope.", 409, { dependency: "company_investor_obligations_and_payments" });
      const reportId = context.definition.id as InvestorReportId;
      const rows: unknown[] = [];
      const missing: ReportMissingData[] = [];
      for (const account of accounts) {
        // A reversal is appended as a separate "reversed" correction; the
        // original keeps its status. Both stay visible and neither is counted.
        const reversedPaymentIds = new Set((account.payments ?? []).map(payment => payment.reversesPaymentId).filter((id): id is NonNullable<typeof id> => Boolean(id)).map(String));
        for (const activity of account.activity.filter(item => inPeriod(item.occurredOn, context) && (!statuses.length || statuses.includes(item.status)))) {
          const treatment = activityTreatment(activity.status, activity.paymentId !== null && reversedPaymentIds.has(String(activity.paymentId)));
          rows.push({ investorId: account.id, investorName: account.displayName, activityId: activity.id, occurredOn: activity.occurredOn, kind: activity.kind, status: activity.status, totalTreatment: treatment, amountCents: activity.amountCents, currency: activity.currency, description: activity.description, paymentId: activity.paymentId, instrumentId: activity.instrumentId });
        }
      }
      const typed = rows as { kind: string; totalTreatment: TotalTreatment; amountCents: string; currency: string }[];
      const reviewCount = typed.filter(row => row.totalTreatment === "review_required").length;
      const reversedCount = typed.filter(row => row.totalTreatment === "reversed").length;
      if (reviewCount) missing.push({ code: "investor_activity_review_required", state: "partial", message: `${reviewCount} investor payment${reviewCount === 1 ? " needs" : "s need"} review and ${reviewCount === 1 ? "is" : "are"} excluded from recorded totals.`, count: reviewCount });
      if (reversedCount) missing.push({ code: "investor_activity_reversed", state: "complete", message: `${reversedCount} reversed payment or reversal entr${reversedCount === 1 ? "y is" : "ies are"} shown but excluded from totals.`, count: reversedCount });
      const currencies = Array.from(new Set(typed.map(row => row.currency)));
      const activityTotals: ReportTotal[] = [];
      if (currencies.length === 1) {
        // Contributions come in; distributions, principal and interest go
        // out. Each kind has its own total, and expected (planned/due)
        // amounts are never added to recorded payments.
        const sourceState: ReportTotal["state"] = input.coverage.state === "complete" ? "complete" : "partial";
        for (const kind of Array.from(new Set(typed.map(row => row.kind))).sort()) {
          const ofKind = typed.filter(row => row.kind === kind);
          const sum = (treatment: TotalTreatment) => ofKind.filter(row => row.totalTreatment === treatment).reduce<bigint>((acc, row) => acc + centsToBigInt(row.amountCents), BigInt(0));
          if (ofKind.some(row => row.totalTreatment === "recorded" || row.totalTreatment === "review_required")) activityTotals.push(totals(`${kind}_recorded`, sum("recorded"), currencies[0]!, ofKind.some(row => row.totalTreatment === "review_required") ? "partial" : sourceState));
          if (ofKind.some(row => row.totalTreatment === "expected")) activityTotals.push(totals(`${kind}_expected`, sum("expected"), currencies[0]!, sourceState));
        }
      } else if (currencies.length > 1) missing.push({ code: "investor_activity_multiple_currencies", state: "partial", message: "Activity uses more than one currency, so no totals are shown." });
      const result = resultFromRecords(context, rows, { source: "company_investor_obligations_and_payments", basis: "mixed", missingData: missing, totals: activityTotals, columns: reportColumns([
        { id: "investorName", label: "Investor", type: "text" },
        { id: "occurredOn", label: "Date", type: "date" },
        { id: "kind", label: "Activity", type: "status" },
        { id: "status", label: "Status", type: "status" },
        { id: "totalTreatment", label: "In totals", type: "status" },
        { id: "amountCents", label: "Amount", type: "money" },
        { id: "currency", label: "Currency", type: "text" },
        { id: "description", label: "Description", type: "text" },
      ]) });
      return { ...result, coverage: [coverage(context, input, result.rows.length)] };
    },
  };
}
