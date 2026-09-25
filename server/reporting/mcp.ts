import { z } from "zod";
import { organizationIdSchema } from "../../shared/company";
import { legalEntityIdSchema } from "../../shared/company";
import { reportExportRequestSchema, reportRecordIdSchema, reportReferenceKindSchema, reportRunRequestSchema } from "../../shared/reporting";
import { publicReportRunResponse, type ReportingAccess, type ReportingPort } from "./service";

export type ReportingToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

export interface ReportingMcpOptions {
  readonly service: ReportingPort;
  readonly resolveAccess: (organizationId: string) => Promise<ReportingAccess>;
}

const organizationInput = { organizationId: organizationIdSchema };

/** MCP and web calls share the same service, authorization, snapshots, and exports. */
export function registerReportingMcpTools(register: ReportingToolRegistrar, options: ReportingMcpOptions): void {
  register("list_company_reports", "List the report library with each report's runtime status: available, missing_data (runtimeReason names the missing source or connection) or not_implemented. Only available reports can run. Each entry lists its setup sections, filters, basis and period mode.", organizationInput, false,
    async ({ organizationId }) => options.service.catalog(await options.resolveAccess(organizationId)));
  register("list_company_report_references", "Search the named choices for a report reference filter (account, investor, project, vendor, staff, tenant, tenancy). Results are limited to authorized records; follow nextCursor for more.", { organizationId: organizationIdSchema, kind: reportReferenceKindSchema, search: z.string().trim().max(120).optional(), cursor: z.string().max(1_024).nullable().optional(), limit: z.number().int().min(1).max(100).optional(), legalEntityIds: z.array(legalEntityIdSchema).max(100).optional() }, false,
    async ({ organizationId, kind, search, cursor, limit, legalEntityIds }) => options.service.references(await options.resolveAccess(organizationId), { kind, search, cursor: cursor ?? null, limit: limit ?? 50, legalEntityIds: legalEntityIds ?? [] }));
  register("run_company_report", "Run one available report. Supply the period in `period` (not filters), basis and currency as request fields, only the filters the catalog entry lists, `forecast` (scenario and versions) for forecast reports and `consolidation` for consolidated reports. The response is an immutable snapshot with totals, coverage and missing data, plus paging and export IDs.", { request: reportRunRequestSchema }, false,
    async ({ request }) => publicReportRunResponse(await options.service.run(await options.resolveAccess(request.scope.organizationId), request)));
  register("get_company_report_page", "Read a page from an immutable report snapshot. Use nextCursor until it is null.", { organizationId: organizationIdSchema, runId: reportRecordIdSchema, cursor: z.string().max(1_024).nullable().optional(), limit: z.number().int().min(1).max(1_000).optional() }, false,
    async ({ organizationId, runId, cursor, limit }) => options.service.page(await options.resolveAccess(organizationId), { runId, cursor: cursor ?? null, limit: limit ?? 100 }));
  register("get_company_report_drilldown", "Read durable source or allocation rows for one report row. Missing drilldowns remain explicit instead of being inferred.", { organizationId: organizationIdSchema, runId: reportRecordIdSchema, rowId: z.string().min(1).max(240), cursor: z.string().max(1_024).nullable().optional(), limit: z.number().int().min(1).max(1_000).optional() }, false,
    async ({ organizationId, runId, rowId, cursor, limit }) => options.service.drilldown(await options.resolveAccess(organizationId), { runId, rowId, cursor: cursor ?? null, limit: limit ?? 100 }));
  register("export_company_report", "Create a CSV, JSON, or HTML export from the same immutable report run.", { request: reportExportRequestSchema, organizationId: organizationIdSchema }, false,
    async ({ request, organizationId }) => options.service.createExport(await options.resolveAccess(organizationId), request));
  register("get_company_report_export", "Read a completed report export by ID.", { organizationId: organizationIdSchema, jobId: reportRecordIdSchema }, false,
    async ({ organizationId, jobId }) => options.service.getExport(await options.resolveAccess(organizationId), jobId));
  register("list_company_report_presets", "List private presets owned by the actor and shared presets in the organization.", organizationInput, false,
    async ({ organizationId }) => options.service.listPresets(await options.resolveAccess(organizationId)));
  register("save_company_report_preset", "Save a versioned private or shared report preset. The report is authorized against the current actor scope before the preset is stored.", { organizationId: organizationIdSchema, preset: z.record(z.unknown()) }, true,
    async ({ organizationId, preset }) => options.service.savePreset(await options.resolveAccess(organizationId), preset));
  register("list_company_report_packages", "List private packages owned by the actor and shared packages in the organization.", organizationInput, false,
    async ({ organizationId }) => options.service.listPackages(await options.resolveAccess(organizationId)));
  register("save_company_report_package", "Save a versioned package with frozen constituent report filters and explicit scopes.", { organizationId: organizationIdSchema, package: z.record(z.unknown()) }, true,
    async ({ organizationId, package: pkg }) => options.service.savePackage(await options.resolveAccess(organizationId), pkg));
  register("run_company_report_package", "Run every frozen package item and return durable item run IDs. A failed or partial item leaves the package run marked incomplete; it is never reported as a complete package.", { organizationId: organizationIdSchema, packageId: reportRecordIdSchema }, false,
    async ({ organizationId, packageId }) => options.service.runPackage(await options.resolveAccess(organizationId), packageId));
  register("get_company_report_package_run", "Read a durable package run and its constituent report run IDs.", { organizationId: organizationIdSchema, runId: reportRecordIdSchema }, false,
    async ({ organizationId, runId }) => options.service.getPackageRun(await options.resolveAccess(organizationId), runId));
}
