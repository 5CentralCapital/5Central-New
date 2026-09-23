import { reportEntrySchema, reportExportJobSchema, reportPageSchema, reportPackageRunSchema, reportPackageSchema, reportPresetSchema, reportReferencePageSchema, reportRunSummarySchema, type ReportEntry, type ReportExportJob, type ReportPage, type ReportRunRequest } from "@shared/reporting";
import { normalizeForecastScenarios } from "./setup-model";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type { ReportPackageSaveRequest, ReportPresetSaveRequest, ReportRunResponse, ReportingApi } from "./types";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }

export class ReportingApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "ReportingApiError"; }
}

function parseError(value: unknown): { message?: string; code?: string } {
  const object = isRecord(value) ? value : {};
  return { message: typeof object.message === "string" ? object.message : undefined, code: typeof object.code === "string" ? object.code : undefined };
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new ReportingApiError("Reporting records could not be loaded. Try again.", 0, "report_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) { const error = parseError(payload); throw new ReportingApiError(error.message ?? `Reporting API returned ${response.status}.`, response.status, error.code); }
  return payload;
}

function path(organizationId: string): string { return `/api/company/${encodeURIComponent(organizationId)}/reporting`; }

export function createReportingApi(): ReportingApi {
  return {
    async catalog(organizationId, signal) {
      const payload = await requestJson(`${path(organizationId)}/catalog`, { signal });
      if (!Array.isArray(payload)) throw new ReportingApiError("Report library returned an invalid response.", 0, "report_invalid_response");
      return payload.map(item => reportEntrySchema.parse(item));
    },
    async run(organizationId, request) {
      const payload = await requestJson(`${path(organizationId)}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      if (!isRecord(payload)) throw new ReportingApiError("Report run returned an invalid response.", 0, "report_invalid_response");
      return { run: reportRunSummarySchema.parse(payload.run), page: reportPageSchema.parse(payload.page) } satisfies ReportRunResponse;
    },
    async page(organizationId, runId, cursor, limit = 100) {
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      return reportPageSchema.parse(await requestJson(`${path(organizationId)}/runs/${encodeURIComponent(runId)}?${query}`));
    },
    async references(organizationId, kind, query = {}, signal) {
      const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
      if (query.search?.trim()) params.set("search", query.search.trim());
      if (query.cursor) params.set("cursor", query.cursor);
      for (const id of query.legalEntityIds ?? []) params.append("legalEntityIds", id);
      return reportReferencePageSchema.parse(await requestJson(`/api/company/${encodeURIComponent(organizationId)}/report-references/${encodeURIComponent(kind)}?${params}`, { signal }));
    },
    async forecastScenarios(organizationId, signal) {
      // Provided by the forecasting service. Until it exists (404), setup
      // shows "No scenarios yet" instead of an error.
      try {
        return normalizeForecastScenarios(await requestJson(`/api/company/${encodeURIComponent(organizationId)}/forecast-scenarios`, { signal }));
      } catch (error) {
        if (error instanceof ReportingApiError && error.status === 404) return [];
        throw error;
      }
    },
    async export(organizationId, runId, format) {
      const payload = await requestJson(`${path(organizationId)}/exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, format }) });
      return reportExportJobSchema.parse(payload);
    },
    async listPresets(organizationId, signal) {
      const payload = await requestJson(`${path(organizationId)}/presets`, { signal });
      if (!Array.isArray(payload)) throw new ReportingApiError("Saved report setups returned an invalid response.", 0, "report_invalid_response");
      return payload.map(item => reportPresetSchema.parse(item));
    },
    async savePreset(organizationId, request: ReportPresetSaveRequest) {
      return reportPresetSchema.parse(await requestJson(`${path(organizationId)}/presets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
    },
    async listPackages(organizationId, signal) {
      const payload = await requestJson(`${path(organizationId)}/packages`, { signal });
      if (!Array.isArray(payload)) throw new ReportingApiError("Report packages returned an invalid response.", 0, "report_invalid_response");
      return payload.map(item => reportPackageSchema.parse(item));
    },
    async savePackage(organizationId, request: ReportPackageSaveRequest) {
      return reportPackageSchema.parse(await requestJson(`${path(organizationId)}/packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
    },
    async runPackage(organizationId, packageId) {
      return reportPackageRunSchema.parse(await requestJson(`${path(organizationId)}/packages/${encodeURIComponent(packageId)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    },
    async getPackageRun(organizationId, runId) {
      return reportPackageRunSchema.parse(await requestJson(`${path(organizationId)}/package-runs/${encodeURIComponent(runId)}`));
    },
  };
}

export const reportingApi = createReportingApi();
