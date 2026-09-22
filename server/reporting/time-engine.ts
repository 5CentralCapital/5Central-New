import type { TimeEntry, TimeJobcode, TimeJobcodeMapping, TimeUser } from "../../shared/time";
import type { ReportMissingData, ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const TIME_REPORT_IDS = ["work-sessions"] as const;

export interface TimeReportingReadResult {
  readonly entries: readonly TimeEntry[];
  readonly users?: readonly TimeUser[];
  readonly jobcodes?: readonly TimeJobcode[];
  readonly jobcodeMappings?: readonly TimeJobcodeMapping[];
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

export interface TimeReportingReadPort {
  read(input: { readonly context: ReportingEngineContext; readonly legalEntityIds: readonly string[]; readonly propertyIds: readonly string[]; readonly projectIds: readonly string[] }): Promise<TimeReportingReadResult>;
}

function inPeriod(date: string, context: ReportingEngineContext): boolean {
  const bounds = periodBounds(context);
  return (!bounds.from || date >= bounds.from) && (!bounds.through || date <= bounds.through);
}

function coverage(context: ReportingEngineContext, result: TimeReportingReadResult, rows: number): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, {
    source: "quickbooks_time_timesheets",
    state: result.coverage.state,
    evidence: result.coverage.evidence,
    basis: "operational",
    watermark: result.coverage.watermark ?? null,
    coveredFrom: bounds.from,
    coveredThrough: bounds.through,
    rowCount: rows,
    reason: result.coverage.reason ?? "Time coverage is reported by the provider stream and mapping status is retained per entry.",
  });
}

export function createTimeReportingEngine(read: TimeReportingReadPort): ReportingEngine {
  return {
    key: "company.time",
    reportIds: [...TIME_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const source = await read.read({ context, legalEntityIds: context.request.scope.legalEntityIds.map(String), propertyIds: context.request.scope.propertyIds.map(String), projectIds: context.request.scope.projectIds.map(String) });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", "Time entries are unavailable for the requested legal entity.", 409, { dependency: "time_entries" });
      if ((Array.isArray(context.request.filters.staffIds) && context.request.filters.staffIds.length) || (Array.isArray(context.request.filters.vendorIds) && context.request.filters.vendorIds.length) || (Array.isArray(context.request.filters.status) && context.request.filters.status.length)) throw new ReportingError("report_unavailable", "Assignee, vendor, and task status filters are not modeled on the time source.", 409, { dependency: "time_assignment_identity" });
      const mappings = new Map((source.jobcodeMappings ?? []).map(mapping => [mapping.providerJobcodeId, mapping]));
      const jobcodes = new Map((source.jobcodes ?? []).map(jobcode => [jobcode.providerJobcodeId, jobcode]));
      const users = new Map((source.users ?? []).map(user => [user.providerUserId, user]));
      const missing: ReportMissingData[] = [];
      const requestedProjects = Array.isArray(context.request.filters.projectIds) ? context.request.filters.projectIds.filter((value): value is string => typeof value === "string") : [];
      const search = typeof context.request.filters.search === "string" ? context.request.filters.search.trim().toLocaleLowerCase() : "";
      const rows = source.entries.filter(entry => inPeriod(entry.date, context)).filter(entry => {
        const mapping = mappings.get(entry.providerJobcodeId);
        if (context.request.scope.propertyIds.length && mapping?.propertyId && !context.request.scope.propertyIds.includes(String(mapping.propertyId) as typeof context.request.scope.propertyIds[number])) return false;
        if (context.request.scope.projectIds.length && mapping?.projectId && !context.request.scope.projectIds.includes(String(mapping.projectId) as typeof context.request.scope.projectIds[number])) return false;
        if (requestedProjects.length && (!mapping?.projectId || !requestedProjects.includes(String(mapping.projectId)))) return false;
        if (search && !`${users.get(entry.providerUserId)?.displayName ?? ""} ${jobcodes.get(entry.providerJobcodeId)?.name ?? ""}`.toLocaleLowerCase().includes(search)) return false;
        return true;
      }).map(entry => {
        const mapping = mappings.get(entry.providerJobcodeId);
        const jobcode = jobcodes.get(entry.providerJobcodeId);
        const user = users.get(entry.providerUserId);
        if (!mapping || !user) missing.push({ code: !mapping ? "time_jobcode_unmapped" : "time_employee_unmapped", state: "partial", message: !mapping ? `Time entry ${entry.providerTimesheetId} has no verified jobcode mapping.` : `Time entry ${entry.providerTimesheetId} has no verified employee mapping.`, scope: entry.providerTimesheetId });
        if (entry.conflict !== "none") missing.push({ code: "time_entry_conflict", state: "partial", message: `Time entry ${entry.providerTimesheetId} has provider conflict ${entry.conflict}.`, scope: entry.providerTimesheetId });
        return {
          timeEntryId: entry.id,
          providerTimesheetId: entry.providerTimesheetId,
          date: entry.date,
          providerUserId: entry.providerUserId,
          employeeName: user?.displayName ?? null,
          providerJobcodeId: entry.providerJobcodeId,
          jobcodeName: jobcode?.name ?? null,
          propertyId: mapping?.propertyId ?? null,
          projectId: mapping?.projectId ?? null,
          costCode: mapping?.costCode ?? null,
          type: entry.type,
          durationSeconds: entry.durationSeconds,
          estimatedLaborCostCents: entry.estimatedLaborCostCents,
          estimatedLaborCurrency: entry.estimatedLaborCurrency,
          postedPayrollCents: entry.postedPayrollCents,
          postedPayrollCurrency: entry.postedPayrollCurrency,
          reviewState: entry.reviewState,
          conflict: entry.conflict,
          mappingStatus: entry.mappingStatus,
          providerActive: entry.providerActive,
          sourceVersion: entry.source.sourceVersion,
        };
      });
      const result = resultFromRecords(context, rows, { source: "quickbooks_time_timesheets", basis: "operational", missingData: missing, columns: reportColumns([
        { id: "date", label: "Date", type: "date" },
        { id: "employeeName", label: "Employee", type: "text" },
        { id: "jobcodeName", label: "Job code", type: "text" },
        { id: "propertyId", label: "Property", type: "text" },
        { id: "projectId", label: "Project", type: "text" },
        { id: "costCode", label: "Cost code", type: "text" },
        { id: "type", label: "Entry type", type: "status" },
        { id: "durationSeconds", label: "Duration (seconds)", type: "integer" },
        { id: "estimatedLaborCostCents", label: "Estimated labor", type: "money" },
        { id: "estimatedLaborCurrency", label: "Labor currency", type: "text" },
        { id: "postedPayrollCents", label: "Posted payroll", type: "money" },
        { id: "postedPayrollCurrency", label: "Payroll currency", type: "text" },
        { id: "reviewState", label: "Review", type: "status" },
        { id: "conflict", label: "Conflict", type: "status" },
        { id: "mappingStatus", label: "Mapping", type: "status" },
      ]) });
      return { ...result, coverage: [coverage(context, source, result.rows.length)] };
    },
  };
}

export function createUnavailableTimeReportingEngine(reason = "QuickBooks Time read source is not registered."): ReportingEngine {
  return { key: "company.time", reportIds: [...TIME_REPORT_IDS], ready: false, reason, async run() { throw new ReportingError("report_unavailable", reason, 409, { dependency: "time_entries" }); } };
}
