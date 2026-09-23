import { forecastReportInputVersionPattern, forecastScenarioIdSchema } from "../../shared/forecasting/contracts";
import type { ForecastResult } from "../../shared/forecasting/result";
import type { ForecastSnapshotMeta } from "../../shared/forecasting/contracts";
import { ZodError } from "zod";
import type { AuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ReportingError } from "../reporting/errors";
import type { ForecastDebtLine, ForecastExitLine, ForecastGrowthLine, ForecastReportingReadPort, ForecastReportingReadResult, ForecastWeek } from "../reporting/forecast-engine";
import type { ForecastingPort } from "./port";
import { ForecastReadService, operatingToday } from "./service";
import { createForecastSourceReader } from "./sources";
import { forecastStore } from "./store";

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

/** Map an immutable snapshot to the report engine's forecast read shape. */
export function forecastReportRows(meta: ForecastSnapshotMeta, result: ForecastResult): ForecastReportingReadResult {
  const snapshotRef = `forecast_snapshot:${meta.id}`;
  const weeks: ForecastWeek[] = result.weeks.slice(0, 13).map(week => ({
    weekStart: week.start, inflowsCents: week.inflowsCents, outflowsCents: week.outflowsCents, currency: result.currency,
    openingCashCents: week.openingCashCents, closingCashCents: week.closingCashCents, sourceIds: [snapshotRef],
  }));
  // The actual boundary: known opening balances at the cutoff (unknown items are never zero-filled).
  const actuals = result.opening.items
    .filter(item => item.amountCents !== null && !item.memo && !item.key.startsWith("property:") && !item.key.startsWith("project:"))
    .map(item => ({ date: result.actualsCutoff, category: `opening:${item.key}`, amountCents: item.amountCents!, currency: result.currency, sourceId: item.sourceIds[0] ?? `${snapshotRef}:opening:${item.key}` }));
  const growth: ForecastGrowthLine[] = result.months.flatMap(month => {
    const lines: ForecastGrowthLine[] = [
      { period: month.start, metric: "Revenue", value: centsToDollars(month.revenueCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Net operating income", value: centsToDollars(month.noiCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Net income", value: centsToDollars(month.netIncomeCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Closing cash", value: centsToDollars(month.cashFlow.closingCashCents), unit: "currency", currency: result.currency },
      { period: month.start, metric: "Occupied units", value: String(month.operations.occupiedUnitsAtEnd), unit: "count", currency: null },
    ];
    if (month.operations.occupancyBps !== null) lines.push({ period: month.start, metric: "Occupancy", value: `${Math.floor(month.operations.occupancyBps / 100)}.${String(month.operations.occupancyBps % 100).padStart(2, "0")}`, unit: "percent", currency: null });
    return lines;
  });
  const refinancedBy = new Map(result.capital.refinances.filter(item => !item.excluded).flatMap(refinance => result.debt.loans.filter(loan => loan.paidOffOn === refinance.closeOn).map(loan => [loan.loanId, refinance] as const)));
  const debt: ForecastDebtLine[] = result.debt.loans.map(loan => {
    const payoff = loan.payments.find(row => row.kind === "payoff");
    return {
      debtId: loan.loanId, lender: loan.lender, currency: result.currency,
      currentBalanceCents: loan.origin === "existing" ? loan.openingPrincipalCents : null,
      refinanceBalanceCents: loan.origin === "refinance" ? (loan.payments.find(row => row.kind === "draw")?.principalCents.replace(/^-/, "") ?? null) : refinancedBy.has(loan.loanId) && payoff ? payoff.principalCents : null,
      rate: bpsToFraction(loan.annualRateBps), maturityOn: loan.maturityOn, sourceIds: [snapshotRef],
    };
  });
  const exits: ForecastExitLine[] = [
    ...result.capital.sales.filter(sale => !sale.excluded).map(sale => ({
      scenario: `${result.scenario.name} · ${sale.label}`, propertyId: sale.propertyId, currency: result.currency, valueCents: sale.priceCents,
      debtCents: sale.payoffCents, proceedsCents: sale.netProceedsCents, returnCents: sale.gainCents, sourceIds: [snapshotRef],
    })),
    ...result.capital.refinances.filter(refinance => !refinance.excluded).map(refinance => ({
      scenario: `${result.scenario.name} · ${refinance.label}`, propertyId: null, currency: result.currency, valueCents: null,
      debtCents: refinance.payoffCents, proceedsCents: refinance.netUsableCents, returnCents: null, sourceIds: [snapshotRef],
    })),
  ];
  const checksPassed = result.checks.every(check => check.passed);
  return {
    actuals, weeks, growth, debt, exits,
    scenarioId: meta.scenarioId, modelVersion: meta.modelVersion,
    coverage: {
      state: result.completeness === "complete" && checksPassed ? "complete" : "partial",
      evidence: "reproducible_snapshot",
      watermark: meta.createdAt,
      reason: result.completeness === "complete" ? (checksPassed ? null : "One or more forecast accounting checks failed.") : `Opening position incomplete: ${result.opening.unknown.join(", ")}`,
    },
  };
}

export interface ForecastReportingReadPortOptions {
  /** Authenticated reader; when omitted the port trusts the reporting service's own authorization and stays inside the request organization. */
  readonly principal?: AuthenticatedPrincipal;
}

function isPort(value: RentOpsQueryExecutor | ForecastingPort): value is ForecastingPort {
  return typeof (value as ForecastingPort).withReadService === "function";
}

/**
 * Reporting adapter: cash-forecast-13-week, operating-growth-plan,
 * debt-refinance and exit-scenarios read immutable snapshots. `inputVersion`
 * is a snapshot ID or an assumption version (`3` / `v3`, latest snapshot of
 * that version for the requested model).
 */
export function createForecastReportingReadPort(executorOrPort: RentOpsQueryExecutor | ForecastingPort, options: ForecastReportingReadPortOptions = {}): ForecastReportingReadPort {
  return {
    async read({ context, scenarioId, inputVersion, modelVersion }) {
      if (!forecastScenarioIdSchema.safeParse(scenarioId).success) throw new ReportingError("report_validation", "Choose a saved forecast scenario.", 400);
      if (!forecastReportInputVersionPattern.test(inputVersion)) throw new ReportingError("report_validation", "Forecast input version must be a snapshot ID or an assumption version such as v3.", 400);
      const organizationId = context.request.scope.organizationId;
      const request = { organizationId, scenarioId, inputVersion, modelVersion };
      let stored: { meta: ForecastSnapshotMeta; result: ForecastResult } | null;
      try {
        if (isPort(executorOrPort)) {
          if (!options.principal) throw new ReportingError("report_forbidden", "Report access is required.", 403);
          stored = await executorOrPort.withReadService(options.principal, (service, fresh) => service.reportSnapshot(fresh, request));
        } else if (options.principal) {
          const service = new ForecastReadService(executorOrPort, { sources: createForecastSourceReader, today: () => operatingToday() });
          stored = await service.reportSnapshot(options.principal, request);
        } else {
          const snapshotId = /^v?\d+$/.test(inputVersion)
            ? await forecastStore.latestSnapshotFor(executorOrPort, organizationId, scenarioId, Number(inputVersion.replace(/^v/, "")), modelVersion)
            : inputVersion;
          stored = snapshotId ? await forecastStore.getSnapshot(executorOrPort, organizationId, snapshotId) : null;
          if (stored && (stored.meta.scenarioId !== scenarioId || stored.meta.modelVersion !== modelVersion)) stored = null;
        }
      } catch (error) {
        if (error instanceof ReportingError) throw error;
        if (error instanceof CompanyCommandError) {
          if (error.code === "forbidden") throw new ReportingError("report_forbidden", "Forecast scenarios require company-wide finance access.", 403);
          throw new ReportingError("report_validation", error.message, 400);
        }
        if (error instanceof ZodError) throw new ReportingError("report_validation", "Forecast scenario or version is invalid.", 400);
        throw error;
      }
      if (!stored) throw new ReportingError("report_unavailable", "No saved forecast snapshot matches this scenario, input version and model version. Run a snapshot first.", 409, { dependency: "versioned_forecast_inputs" });
      return forecastReportRows(stored.meta, stored.result);
    },
  };
}
