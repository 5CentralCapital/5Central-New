import { centsFromBigInt, centsToBigInt } from "../../shared/company";
import type { ReportMissingData, ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const FORECAST_REPORT_IDS = ["cash-forecast-13-week", "operating-growth-plan", "debt-refinance", "exit-scenarios"] as const;
export type ForecastReportId = (typeof FORECAST_REPORT_IDS)[number];

export interface ForecastWeek {
  readonly weekStart: string;
  readonly inflowsCents: string;
  readonly outflowsCents: string;
  readonly currency: string;
  readonly openingCashCents?: string | null;
  readonly closingCashCents?: string | null;
  readonly sourceIds?: readonly string[];
}

export interface ForecastGrowthLine {
  readonly period: string;
  readonly metric: string;
  readonly value: string;
  readonly unit: "currency" | "percent" | "count" | "text";
  readonly currency?: string | null;
}

export interface ForecastDebtLine {
  readonly debtId: string;
  readonly lender: string | null;
  readonly currency: string;
  readonly currentBalanceCents: string | null;
  readonly refinanceBalanceCents: string | null;
  readonly rate: string | null;
  readonly maturityOn: string | null;
  readonly sourceIds: readonly string[];
}

export interface ForecastExitLine {
  readonly scenario: string;
  readonly propertyId: string | null;
  readonly currency: string;
  readonly valueCents: string | null;
  readonly debtCents: string | null;
  readonly proceedsCents: string | null;
  readonly returnCents: string | null;
  readonly sourceIds: readonly string[];
}

export interface ForecastReportingReadResult {
  readonly actuals: readonly { readonly date: string; readonly category: string; readonly amountCents: string; readonly currency: string; readonly sourceId: string }[];
  readonly weeks?: readonly ForecastWeek[];
  readonly growth?: readonly ForecastGrowthLine[];
  readonly debt?: readonly ForecastDebtLine[];
  readonly exits?: readonly ForecastExitLine[];
  /** The reader may echo the selected immutable revision for verification. */
  readonly scenarioId?: string;
  readonly inputVersion?: string;
  readonly modelVersion?: string;
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

export interface ForecastReportingReadPort {
  read(input: { readonly context: ReportingEngineContext; readonly scenarioId: string; readonly inputVersion: string; readonly modelVersion: string }): Promise<ForecastReportingReadResult>;
}

function coverage(context: ReportingEngineContext, result: ForecastReportingReadResult, rows: number): ReportSourceCoverage {
  return sourceCoverage(context, { source: "versioned_forecast_inputs", state: result.coverage.state, evidence: result.coverage.evidence, basis: "mixed", watermark: result.coverage.watermark ?? null, rowCount: rows, reason: result.coverage.reason ?? "Forecast rows are available only from an explicitly versioned scenario input and model." });
}

function matchingForecastContext(context: ReportingEngineContext): { scenarioId: string; inputVersion: string; modelVersion: string } {
  const forecast = context.request.forecast;
  if (!forecast) throw new ReportingError("report_validation", "Forecast reports require an explicit scenario, input version, and model version", 400);
  return forecast;
}

export function createForecastReportingEngine(read: ForecastReportingReadPort): ReportingEngine {
  return {
    key: "combined.forecast",
    reportIds: [...FORECAST_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const requested = matchingForecastContext(context);
      const source = await read.read({ context, ...requested });
      if ((source.scenarioId !== undefined && source.scenarioId !== requested.scenarioId) || (source.inputVersion !== undefined && source.inputVersion !== requested.inputVersion) || (source.modelVersion !== undefined && source.modelVersion !== requested.modelVersion)) {
        throw new ReportingError("report_unavailable", "The forecast source returned a different scenario revision than the requested input.", 409, { dependency: "versioned_forecast_inputs" });
      }
      const missing: ReportMissingData[] = [];
      const reportId = context.definition.id as ForecastReportId;
      let rows: unknown[] = [];
      if (reportId === "cash-forecast-13-week") {
        if (!source.weeks) throw new ReportingError("report_unavailable", "The selected forecast scenario has no 13-week cash input series.", 409, { dependency: "versioned_forecast_inputs" });
        if (source.weeks.length !== 13) throw new ReportingError("report_unavailable", "The selected forecast scenario must contain exactly 13 weekly inputs.", 409, { dependency: "versioned_forecast_inputs" });
        if (!source.actuals.length) throw new ReportingError("report_unavailable", "A 13-week cash forecast requires actual cash rows to establish its boundary.", 409, { dependency: "verified_actuals" });
        const currencies = new Set(source.weeks.map(week => week.currency));
        if (currencies.size !== 1) throw new ReportingError("report_unavailable", "A 13-week cash forecast must use one currency throughout the series.", 409, { dependency: "single_currency_forecast" });
        const firstWeek = source.weeks[0]!;
        const firstWeekTime = Date.parse(`${firstWeek.weekStart}T00:00:00Z`);
        if (!Number.isFinite(firstWeekTime)) throw new ReportingError("report_unavailable", "The forecast contains an invalid week start date.", 409, { dependency: "versioned_forecast_inputs" });
        const latestActual = source.actuals.reduce((latest, actual) => latest === null || actual.date > latest ? actual.date : latest, null as string | null);
        if (latestActual !== null && latestActual >= firstWeek.weekStart) throw new ReportingError("report_unavailable", "Forecast actuals must end before the first forecast week.", 409, { dependency: "forecast_actual_boundary" });
        let previousClosing: bigint | null = null;
        rows = source.weeks.map((week, index) => {
          const weekTime = Date.parse(`${week.weekStart}T00:00:00Z`);
          if (!Number.isFinite(weekTime) || weekTime !== firstWeekTime + index * 7 * 86_400_000) throw new ReportingError("report_unavailable", "Forecast weeks must be ordered and continuous seven-day periods.", 409, { dependency: "versioned_forecast_inputs" });
          if (week.openingCashCents === undefined || week.openingCashCents === null || week.closingCashCents === undefined || week.closingCashCents === null) throw new ReportingError("report_unavailable", `Forecast week ${week.weekStart} is missing an explicit opening or closing cash balance.`, 409, { dependency: "versioned_forecast_inputs" });
          const inflows = centsToBigInt(week.inflowsCents); const outflows = centsToBigInt(week.outflowsCents); const net = inflows - outflows;
          const opening = centsToBigInt(week.openingCashCents);
          const closing = centsToBigInt(week.closingCashCents);
          if (previousClosing !== null && opening !== previousClosing) throw new ReportingError("report_unavailable", `Forecast week ${week.weekStart} does not reconcile to the prior week's closing cash.`, 409, { dependency: "forecast_cash_reconciliation" });
          if (opening + net !== closing) throw new ReportingError("report_unavailable", `Forecast week ${week.weekStart} does not reconcile opening cash, inflows, and outflows.`, 409, { dependency: "forecast_cash_reconciliation" });
          previousClosing = closing;
          return { weekStart: week.weekStart, inflowsCents: week.inflowsCents, outflowsCents: week.outflowsCents, netCents: centsFromBigInt(net), openingCashCents: centsFromBigInt(opening), closingCashCents: centsFromBigInt(closing), currency: week.currency, sourceIds: week.sourceIds ?? [] };
        });
      } else if (reportId === "operating-growth-plan") {
        if (!source.growth) throw new ReportingError("report_unavailable", "The selected scenario has no versioned operating-growth assumptions.", 409, { dependency: "versioned_forecast_inputs" });
        rows = source.growth.map(line => ({ period: line.period, metric: line.metric, value: line.value, unit: line.unit, currency: line.currency ?? null }));
      } else if (reportId === "debt-refinance") {
        if (!source.debt) throw new ReportingError("report_unavailable", "The selected scenario has no versioned debt and refinance inputs.", 409, { dependency: "debt_agreements" });
        rows = source.debt.map(line => ({ debtId: line.debtId, lender: line.lender, currency: line.currency, currentBalanceCents: line.currentBalanceCents, refinanceBalanceCents: line.refinanceBalanceCents, rate: line.rate, maturityOn: line.maturityOn, sourceIds: line.sourceIds }));
      } else {
        if (!source.exits) throw new ReportingError("report_unavailable", "The selected scenario has no versioned exit assumptions.", 409, { dependency: "versioned_forecast_inputs" });
        rows = source.exits.map(line => ({ scenario: line.scenario, propertyId: line.propertyId, currency: line.currency, valueCents: line.valueCents, debtCents: line.debtCents, proceedsCents: line.proceedsCents, returnCents: line.returnCents, sourceIds: line.sourceIds }));
      }
      if (!source.actuals.length) throw new ReportingError("report_unavailable", "The selected scenario has no verified actual source rows.", 409, { dependency: "verified_actuals" });
      const columns = reportId === "cash-forecast-13-week"
        ? reportColumns([{ id: "weekStart", label: "Week starting", type: "date" }, { id: "inflowsCents", label: "Inflows", type: "money" }, { id: "outflowsCents", label: "Outflows", type: "money" }, { id: "netCents", label: "Net cash flow", type: "money" }, { id: "openingCashCents", label: "Opening cash", type: "money" }, { id: "closingCashCents", label: "Closing cash", type: "money" }, { id: "currency", label: "Currency", type: "text" }])
        : reportId === "operating-growth-plan"
          ? reportColumns([{ id: "period", label: "Period", type: "date" }, { id: "metric", label: "Metric", type: "text" }, { id: "value", label: "Value", type: "decimal" }, { id: "unit", label: "Unit", type: "status" }, { id: "currency", label: "Currency", type: "text" }])
          : reportId === "debt-refinance"
            ? reportColumns([{ id: "lender", label: "Lender", type: "text" }, { id: "currency", label: "Currency", type: "text" }, { id: "currentBalanceCents", label: "Current balance", type: "money" }, { id: "refinanceBalanceCents", label: "Refinance balance", type: "money" }, { id: "rate", label: "Rate", type: "decimal" }, { id: "maturityOn", label: "Maturity", type: "date" }])
            : reportColumns([{ id: "scenario", label: "Scenario", type: "text" }, { id: "currency", label: "Currency", type: "text" }, { id: "valueCents", label: "Value", type: "money" }, { id: "debtCents", label: "Debt", type: "money" }, { id: "proceedsCents", label: "Proceeds", type: "money" }, { id: "returnCents", label: "Return", type: "money" }]);
      const result = resultFromRecords(context, rows, { source: "versioned_forecast_inputs", basis: "mixed", missingData: missing, columns });
      return { ...result, coverage: [coverage(context, source, result.rows.length)] };
    },
  };
}

export function createUnavailableForecastEngine(reason = "No versioned forecast scenario reader is registered."): ReportingEngine {
  return { key: "combined.forecast", reportIds: [...FORECAST_REPORT_IDS], ready: false, reason, async run() { throw new ReportingError("report_unavailable", reason, 409, { dependency: "versioned_forecast_inputs" }); } };
}
