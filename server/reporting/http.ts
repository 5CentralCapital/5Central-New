import type { Express, RequestHandler, Request, Response } from "express";
import { z, ZodError } from "zod";
import { organizationIdSchema } from "../../shared/company";
import {
  reportExportRequestSchema,
  reportRecordIdSchema,
  reportRunRequestSchema,
} from "../../shared/reporting";
import { companyHttpError } from "../company/http";
import { ReportingError } from "./errors";
import { publicReportRunResponse, type ReportPackageInput, type ReportPresetInput, type ReportingAccess, type ReportingPort } from "./service";

const idParams = z.object({ organizationId: organizationIdSchema, runId: reportRecordIdSchema }).strict();
const jobParams = z.object({ organizationId: organizationIdSchema, jobId: reportRecordIdSchema }).strict();
const cursorQuery = z.object({ cursor: z.string().max(1_024).optional(), limit: z.coerce.number().int().min(1).max(1_000).default(100) }).strict();

export interface ReportingHttpRouteOptions {
  readonly service: ReportingPort;
  readonly requireAdmin: RequestHandler;
  readonly resolveAccess: (request: Request, organizationId: string) => Promise<ReportingAccess>;
  readonly prefix?: string;
}

function errorResponse(error: unknown, response: Response): void {
  if (error instanceof ReportingError) {
    response.status(error.status).json({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ code: "report_validation", message: "Check the report fields and try again.", fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) });
    return;
  }
  companyHttpError(error, response);
}

function handler(options: ReportingHttpRouteOptions, fn: (request: Request, response: Response, access: ReportingAccess, organizationId: string) => Promise<unknown>) {
  return (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    void (async () => {
      const organizationId = organizationIdSchema.parse(request.params.organizationId);
      const access = await options.resolveAccess(request, organizationId);
      await fn(request, response, access, organizationId);
    })().catch(error => errorResponse(error, response));
  };
}

/** Registers only reporting endpoints; the company router owns mounting and auth middleware. */
export function registerReportingHttpRoutes(app: Express, options: ReportingHttpRouteOptions): void {
  const prefix = options.prefix ?? "/api/company/:organizationId/reporting";
  const admin = options.requireAdmin;
  const route = (method: "get" | "post", path: string, fn: Parameters<typeof handler>[1]) => app[method](`${prefix}${path}`, admin, handler(options, fn));

  route("get", "/catalog", async (_request, response, access) => { response.json(options.service.catalog(access)); });
  route("post", "/runs", async (request, response, access, organizationId) => {
    const input = reportRunRequestSchema.parse(request.body);
    if (input.scope.organizationId !== organizationId) throw new ReportingError("report_forbidden", "Report organization does not match the route", 403);
    response.status(201).json(publicReportRunResponse(await options.service.run(access, input)));
  });
  route("get", "/runs/:runId", async (request, response, access, organizationId) => {
    const params = idParams.parse({ organizationId, runId: request.params.runId });
    const query = cursorQuery.parse(request.query);
    response.json(await options.service.page(access, { runId: params.runId, cursor: query.cursor ?? null, limit: query.limit }));
  });
  route("get", "/runs/:runId/drilldown/:rowId", async (request, response, access, organizationId) => {
    const params = idParams.parse({ organizationId, runId: request.params.runId });
    const query = cursorQuery.parse(request.query);
    response.json(await options.service.drilldown(access, { runId: params.runId, rowId: z.string().parse(request.params.rowId), cursor: query.cursor ?? null, limit: query.limit }));
  });
  route("post", "/exports", async (request, response, access, organizationId) => {
    const input = reportExportRequestSchema.parse(request.body);
    reportRecordIdSchema.parse(input.runId);
    if (organizationId.length === 0) throw new ReportingError("report_forbidden", "Report organization is required", 403);
    response.status(201).json(await options.service.createExport(access, input));
  });
  route("get", "/exports/:jobId", async (request, response, access, organizationId) => {
    const params = jobParams.parse({ organizationId, jobId: request.params.jobId });
    response.json(await options.service.getExport(access, reportRecordIdSchema.parse(params.jobId)));
  });
  route("get", "/presets", async (_request, response, access) => { response.json(await options.service.listPresets(access)); });
  route("post", "/presets", async (request, response, access) => { response.status(201).json(await options.service.savePreset(access, request.body as ReportPresetInput)); });
  route("get", "/presets/:presetId", async (request, response, access) => { response.json(await options.service.getPreset(access, reportRecordIdSchema.parse(request.params.presetId))); });
  route("get", "/packages", async (_request, response, access) => { response.json(await options.service.listPackages(access)); });
  route("post", "/packages", async (request, response, access) => { response.status(201).json(await options.service.savePackage(access, request.body as ReportPackageInput)); });
  route("get", "/packages/:packageId", async (request, response, access) => { response.json(await options.service.getPackage(access, reportRecordIdSchema.parse(request.params.packageId))); });
  route("post", "/packages/:packageId/run", async (request, response, access) => { response.status(201).json(await options.service.runPackage(access, reportRecordIdSchema.parse(request.params.packageId))); });
  route("get", "/package-runs/:runId", async (request, response, access) => { response.json(await options.service.getPackageRun(access, reportRecordIdSchema.parse(request.params.runId))); });
}
