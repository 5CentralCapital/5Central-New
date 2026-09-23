import type { WorkOrderSummary } from "../../shared/work-orders";
import type { ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { moneyTotal, periodBounds, reportColumns, resultFromRecords, rowMatchesSearch, sourceCoverage, stringArrayFilter } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const WORK_ORDER_REPORT_IDS = ["work-orders"] as const;

export interface WorkOrderReportingReadResult {
  readonly workOrders: readonly WorkOrderSummary[];
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

/** The port receives pushdown hints; the engine re-applies every filter. */
export interface WorkOrderReportingReadPort {
  read(input: { readonly context: ReportingEngineContext; readonly statuses: readonly string[]; readonly priorities: readonly string[]; readonly categories: readonly string[] }): Promise<WorkOrderReportingReadResult>;
}

function daysBetween(from: string, through: string): number {
  return Math.max(0, Math.round((Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

/**
 * Work-order activity from the company work-order service. A custom period
 * with only an as-of date lists orders open on that date; a date range lists
 * orders reported or completed in the range. Aging is measured to completion
 * for completed orders and to the report date for open ones.
 */
export function createWorkOrderReportingEngine(read: WorkOrderReportingReadPort): ReportingEngine {
  return {
    key: "company.work-orders",
    reportIds: [...WORK_ORDER_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const filters = context.request.filters;
      const statuses = stringArrayFilter(filters.status);
      const priorities = stringArrayFilter(filters.priority);
      const categories = stringArrayFilter(filters.category);
      const assignee = typeof filters.assignedTo === "string" ? filters.assignedTo.trim().toLocaleLowerCase() : "";
      const source = await read.read({ context, statuses, priorities, categories });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", source.coverage.reason ?? "Work orders are unavailable for this scope.", 409, { dependency: "company_work_orders" });
      const period = context.request.period;
      const bounds = periodBounds(context);
      const asOfOnly = period.mode === "as_of" || (period.mode === "custom" && Boolean(period.asOfDate) && !period.fromDate && !period.toDate);
      const reportDate = bounds.through ?? context.now.slice(0, 10);
      const scope = context.request.scope;
      const missing: ReportMissingData[] = [];
      let excludedCanceled = 0;
      const selected = source.workOrders.filter(order => {
        if (scope.propertyIds.length && !scope.propertyIds.includes(order.propertyId)) return false;
        if (scope.legalEntityIds.length && !scope.legalEntityIds.includes(order.legalEntityId)) return false;
        if (scope.unitIds.length && (!order.unitId || !scope.unitIds.includes(order.unitId as typeof scope.unitIds[number]))) return false;
        if (statuses.length && !statuses.includes(order.status)) return false;
        if (priorities.length && !priorities.includes(order.priority)) return false;
        if (categories.length && !categories.includes(order.category)) return false;
        if (assignee && !(order.assignedTo ?? "").toLocaleLowerCase().includes(assignee)) return false;
        if (asOfOnly) {
          if (order.reportedOn > reportDate) return false;
          if (order.completedOn && order.completedOn <= reportDate) return false;
          // Cancellation dates are not recorded, so a canceled order cannot be
          // shown as open on an earlier date.
          if (order.status === "canceled") { excludedCanceled += 1; return false; }
          return true;
        }
        const reportedInRange = (!bounds.from || order.reportedOn >= bounds.from) && (!bounds.through || order.reportedOn <= bounds.through);
        const completedInRange = order.completedOn !== null && (!bounds.from || order.completedOn >= bounds.from) && (!bounds.through || order.completedOn <= bounds.through);
        return reportedInRange || completedInRange;
      });
      if (excludedCanceled) missing.push({ code: "work_order_cancellation_date_unknown", state: "partial", message: `${excludedCanceled} canceled work order${excludedCanceled === 1 ? " was" : "s were"} excluded because the cancellation date is not recorded.`, count: excludedCanceled });
      const records = selected.map(order => {
        const closedOn = order.completedOn && order.completedOn <= reportDate ? order.completedOn : null;
        return {
          workOrderId: order.id, reference: order.reference, title: order.title, propertyId: order.propertyId, propertyName: order.propertyName, unitNumber: order.unitNumber,
          category: order.category, priority: order.priority, status: order.status, reportedOn: order.reportedOn, scheduledOn: order.scheduledOn, completedOn: order.completedOn,
          assignedTo: order.assignedTo, ageDays: order.status === "canceled" ? null : daysBetween(order.reportedOn, closedOn ?? reportDate),
          estimatedCostCents: order.estimatedCostCents, currency: order.currency, chargebackCents: order.chargeback?.amountCents ?? null,
        };
      }).filter(record => rowMatchesSearch(record, filters.search));
      const withoutEstimate = records.filter(record => record.estimatedCostCents === null).length;
      if (withoutEstimate) missing.push({ code: "work_order_estimate_missing", state: "partial", message: `${withoutEstimate} work order${withoutEstimate === 1 ? " has" : "s have"} no estimated cost; the estimate total covers the rest.`, count: withoutEstimate });
      const currencies = Array.from(new Set(records.map(record => record.currency)));
      const totals: ReportTotal[] = currencies.length === 1
        ? [moneyTotal("estimated_cost", records.flatMap(record => record.estimatedCostCents === null ? [] : [String(record.estimatedCostCents)]), currencies[0]!, { partial: withoutEstimate > 0 })]
        : [];
      if (currencies.length > 1) missing.push({ code: "work_order_multiple_currencies", state: "partial", message: "Estimated costs use more than one currency, so no single total is shown." });
      const columns = reportColumns([
        { id: "reference", label: "Reference", type: "text" }, { id: "title", label: "Work order", type: "text" }, { id: "propertyName", label: "Property", type: "text" },
        { id: "unitNumber", label: "Unit", type: "text" }, { id: "category", label: "Type", type: "status" }, { id: "priority", label: "Priority", type: "status" },
        { id: "status", label: "Status", type: "status" }, { id: "reportedOn", label: "Reported", type: "date" }, { id: "scheduledOn", label: "Scheduled", type: "date" },
        { id: "completedOn", label: "Completed", type: "date" }, { id: "assignedTo", label: "Assignee", type: "text" }, { id: "ageDays", label: "Age (days)", type: "integer" },
        { id: "estimatedCostCents", label: "Estimated cost", type: "money" },
      ]);
      const result = resultFromRecords(context, records, { source: "company_work_orders", basis: "operational", missingData: missing, totals, columns, rowId: (_record, _index, values) => `work-order:${String(values.workOrderId)}` });
      return { ...result, coverage: [sourceCoverage(context, { source: "company_work_orders", state: source.coverage.state, evidence: source.coverage.evidence, basis: "operational", watermark: source.coverage.watermark ?? null, rowCount: result.rows.length, reason: source.coverage.reason ?? null })] };
    },
  };
}
