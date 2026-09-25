import { forecastReportInputVersionPattern, forecastScenarioIdSchema } from "../../shared/forecasting/contracts";
import type { ForecastResultView } from "../../shared/forecasting/result";
import type { ForecastSnapshotMeta } from "../../shared/forecasting/contracts";
import type { ReportPeriod, ReportScope } from "../../shared/reporting";
import { ZodError } from "zod";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ReportingError } from "../reporting/errors";
import type { ForecastDebtLine, ForecastExitLine, ForecastGrowthLine, ForecastReportingReadPort, ForecastReportingReadResult, ForecastWeek } from "../reporting/forecast-engine";
import type { ReportingEngineProbeResult } from "../reporting/registry";
import type { ForecastingPort } from "./port";
import { FORECAST_READ_ROLES, ForecastReadService, operatingToday } from "./service";
import { createForecastSourceReader } from "./sources";

const ZERO = BigInt(0);

/** Exact dollars text ("1234.56") from cents, without floating point. */
export function centsToDollars(cents: string): string {
  const value = BigInt(cents);
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${(absolute / BigInt(100)).toString()}.${(absolute % BigInt(100)).toString().padStart(2, "0")}`;
}

function bpsToFraction(bps: number): string {
  const whole = Math.floor(bps / 10_000);
  return `${whole}.${String(bps % 10_000).padStart(4, "0")}`;
}

/** Inclusive date bounds of a report period (as-of reads one day). */
export interface ForecastReportBounds { readonly from: string; readonly through: string }

export function forecastReportBounds(period: ReportPeriod): ForecastReportBounds | null {
  const monthBounds = (month: string): ForecastReportBounds => {
    const [year, number] = month.split("-").map(Number) as [number, number];
    return { from: `${month}-01`, through: `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, "0")}` };
  };
  if (period.mode === "as_of") return { from: period.asOfDate, through: period.asOfDate };
  if (period.mode === "range") return { from: period.fromDate, through: period.toDate };
  if (period.mode === "month") return monthBounds(period.month);
  if (period.fromDate || period.toDate) return { from: period.fromDate ?? period.toDate!, through: period.toDate ?? period.fromDate! };
  if (period.asOfDate) return { from: period.asOfDate, through: period.asOfDate };
  if (period.month) return monthBounds(period.month);
  return null;
}

const overlaps = (start: string, end: string, bounds: ForecastReportBounds) => end >= bounds.from && start <= bounds.through;

/**
 * Map an immutable snapshot to the report engine's forecast read shape,
 * limited to the report period: the 13 weeks starting with the first week the
 * period touches, the months it overlaps, loans outstanding during it and
 * capital events closing within it.
 */
export function forecastReportRows(meta: ForecastSnapshotMeta, result: ForecastResultView, bounds: ForecastReportBounds | null = null): ForecastReportingReadResult {
  const snapshotRef = `forecast_snapshot:${meta.id}`;
  // Unknown opening cash: balances are relative movements, so they are not reported as cash balances.
  const cashKnown = result.summary.openingCashKnown !== false;
  const firstWeek = bounds ? result.weeks.findIndex(week => overlaps(week.start, week.end, bounds)) : 0;
  const weeks: ForecastWeek[] = (firstWeek < 0 ? [] : result.weeks.slice(firstWeek, firstWeek + 13)).map(week => ({
    weekStart: week.start, inflowsCents: week.inflowsCents, outflowsCents: week.outflowsCents, currency: result.currency,
    openingCashCents: cashKnown ? week.openingCashCents : null, closingCashCents: cashKnown ? week.closingCashCents : null, sourceIds: [snapshotRef],
  }));
  // The actual boundary: known opening balances at the cutoff (unknown items are never zero-filled).
  const actuals = result.opening.items
    .filter(item => item.amountCents !== null && !item.memo && !item.key.startsWith("property:") && !item.key.startsWith("project:"))
    .map(item => ({ date: result.actualsCutoff, category: `opening:${item.key}`, amountCents: item.amountCents!, currency: result.currency, sourceId: item.sourceIds[0] ?? `${snapshotRef}:opening:${item.key}` }));
  const growth: ForecastGrowthLine[] = result.months.filter(month => !bounds || overlaps(month.start, month.end, bounds)).flatMap(month => {
    const lines: ForecastGrowthLine[] = [
      { period: month.start, metric: "Revenue", value: centsToDollars(month.revenueCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Net operating income", value: centsToDollars(month.noiCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Net income", value: centsToDollars(month.netIncomeCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Net change in cash", value: centsToDollars(month.cashFlow.directNetChangeCents), unit: "currency", currency: result.currency },
      ...(cashKnown ? [{ period: month.start, metric: "Closing cash", value: centsToDollars(month.cashFlow.closingCashCents), unit: "currency" as const, currency: result.currency }] : []),
      { period: month.start, metric: "Occupied units", value: String(month.operations.occupiedUnitsAtEnd), unit: "count", currency: null },
    ];
    if (month.operations.occupancyBps !== null) lines.push({ period: month.start, metric: "Occupancy", value: `${Math.floor(month.operations.occupancyBps / 100)}.${String(month.operations.occupancyBps % 100).padStart(2, "0")}`, unit: "percent", currency: null });
    return lines;
  });
  // A loan is refinanced only when a refinance actually pays it off (not merely closes the same day).
  const refinancedBy = new Map(result.capital.refinances.filter(item => !item.excluded).flatMap(refinance => (refinance.payoffLoanIds ?? []).map(loanId => [loanId, refinance] as const)));
  const outstandingDuring = (loan: ForecastResultView["debt"]["loans"][number]) => {
    if (!bounds) return true;
    const start = loan.fundedOn ?? "0000-01-01";
    const end = loan.paidOffOn ?? loan.payments.at(-1)?.date ?? loan.maturityOn;
    return overlaps(start, end, bounds);
  };
  const debt: ForecastDebtLine[] = result.debt.loans.filter(outstandingDuring).map(loan => {
    const payoff = loan.payments.find(row => row.kind === "payoff");
    return {
      debtId: loan.loanId, lender: loan.lender, currency: result.currency,
      currentBalanceCents: loan.origin === "existing" ? loan.openingPrincipalCents : null,
      refinanceBalanceCents: loan.origin === "refinance" ? (loan.payments.find(row => row.kind === "draw")?.principalCents.replace(/^-/, "") ?? null) : refinancedBy.has(loan.loanId) && payoff ? payoff.principalCents : null,
      rate: bpsToFraction(loan.annualRateBps), maturityOn: loan.maturityOn, sourceIds: [snapshotRef],
    };
  });
  const closesWithin = (closeOn: string) => !bounds || (closeOn >= bounds.from && closeOn <= bounds.through);
  const exits: ForecastExitLine[] = [
    ...result.capital.sales.filter(sale => !sale.excluded && closesWithin(sale.closeOn)).map(sale => ({
      scenario: `${result.scenario.name} · ${sale.label}`, propertyId: sale.propertyId, currency: result.currency, valueCents: sale.priceCents,
      debtCents: sale.payoffCents, proceedsCents: sale.netProceedsCents, returnCents: sale.gainCents, sourceIds: [snapshotRef],
    })),
    ...result.capital.refinances.filter(refinance => !refinance.excluded && closesWithin(refinance.closeOn)).map(refinance => ({
      scenario: `${result.scenario.name} · ${refinance.label}`, propertyId: null, currency: result.currency, valueCents: null,
      debtCents: refinance.payoffCents, proceedsCents: refinance.netUsableCents, returnCents: null, sourceIds: [snapshotRef],
    })),
  ];
  const checksPassed = result.checks.every(check => check.passed);
  const reasons = [
    result.completeness === "complete" ? null : `Opening position incomplete: ${result.opening.unknown.join(", ")}`,
    cashKnown ? null : "Opening cash is unknown; cash balances are omitted and cash figures are movements only.",
    checksPassed ? null : "One or more forecast accounting checks failed.",
  ].filter((reason): reason is string => reason !== null);
  return {
    actuals, weeks, growth, debt, exits,
    scenarioId: meta.scenarioId, modelVersion: meta.modelVersion,
    coverage: {
      state: result.completeness === "complete" && checksPassed ? "complete" : "partial",
      evidence: "reproducible_snapshot",
      watermark: meta.createdAt,
      reason: reasons.length ? reasons.join(" ") : null,
    },
  };
}

export interface ForecastReportingReadPortOptions {
  /** Authenticated reader. Required: forecast reports need an organization-wide forecast grant. */
  readonly principal?: AuthenticatedPrincipal;
}

function isPort(value: RentOpsQueryExecutor | ForecastingPort): value is ForecastingPort {
  return typeof (value as ForecastingPort).withReadService === "function";
}

/** Forecasts cover the whole company; any narrower report scope is refused rather than silently ignored. */
function assertCompanyScope(scope: ReportScope): void {
  const narrowed = Object.entries(scope).some(([key, value]) => key !== "organizationId" && Array.isArray(value) && value.length > 0);
  if (narrowed) throw new ReportingError("report_validation", "Forecast reports cover the whole company. Clear entity and property selections.", 400);
}

const NOT_APPROVED = "No approved forecast scenario.";

function mapError(error: unknown): never {
  if (error instanceof ReportingError) throw error;
  if (error instanceof CompanyCommandError) {
    if (error.code === "forbidden") throw new ReportingError("report_forbidden", "Forecast reports require company-wide finance access.", 403);
    if (error.details.reason === "forecast_not_approved") throw new ReportingError("report_unavailable", NOT_APPROVED, 409, { dependency: "approved_forecast_scenario" });
    if (error.details.reason === "forecast_input_not_approved") throw new ReportingError("report_unavailable", error.message, 409, { dependency: "approved_forecast_scenario" });
    throw new ReportingError("report_validation", error.message, 400);
  }
  if (error instanceof ZodError) throw new ReportingError("report_validation", "Forecast scenario or version is invalid.", 400);
  throw error;
}

/**
 * Reporting adapter: cash-forecast-13-week, operating-growth-plan,
 * debt-refinance and exit-scenarios read only a scenario's approved snapshot,
 * for readers with an organization-wide forecast grant (the same rule as the
 * forecasting workspace). `inputVersion` is the approved snapshot ID or its
 * assumption version (`3` / `v3`).
 */
export function createForecastReportingReadPort(executorOrPort: RentOpsQueryExecutor | ForecastingPort, options: ForecastReportingReadPortOptions = {}): ForecastReportingReadPort {
  async function withService<T>(work: (service: ForecastReadService, principal: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!options.principal) throw new ReportingError("report_forbidden", "Report access is required.", 403);
    if (isPort(executorOrPort)) return executorOrPort.withReadService(options.principal, work);
    return work(new ForecastReadService(executorOrPort, { sources: createForecastSourceReader, today: () => operatingToday() }), options.principal);
  }
  return {
    async read({ context, scenarioId, inputVersion, modelVersion }) {
      if (!forecastScenarioIdSchema.safeParse(scenarioId).success) throw new ReportingError("report_validation", "Choose a saved forecast scenario.", 400);
      if (!forecastReportInputVersionPattern.test(inputVersion)) throw new ReportingError("report_validation", "Forecast input version must be a snapshot ID or an assumption version such as v3.", 400);
      const organizationId = context.request.scope.organizationId;
      try {
        const stored = await withService(async (service, principal) => {
          authorizeCompanyRead(principal, { organizationId } as never, FORECAST_READ_ROLES);
          assertCompanyScope(context.request.scope);
          return service.reportSnapshot(principal, { organizationId, scenarioId, inputVersion, modelVersion });
        });
        return forecastReportRows(stored.meta, stored.result, forecastReportBounds(context.request.period));
      } catch (error) {
        return mapError(error);
      }
    },
    async probe({ organizationId }): Promise<ReportingEngineProbeResult> {
      if (!options.principal) return { status: "missing_data", reason: "Forecast reports require company-wide finance access.", dependency: "forecast_read_access" };
      try {
        const approved = await withService((service, principal) => service.hasApprovedScenario(principal, organizationId));
        return approved ? { status: "available" } : { status: "missing_data", reason: NOT_APPROVED, dependency: "approved_forecast_scenario" };
      } catch (error) {
        if (error instanceof CompanyCommandError && error.code === "forbidden") return { status: "missing_data", reason: "Forecast reports require company-wide finance access.", dependency: "forecast_read_access" };
        throw error;
      }
    },
  };
}
