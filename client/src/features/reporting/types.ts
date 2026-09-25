import type {
  ReportEntry,
  ReportExportJob,
  ReportPackage,
  ReportPackageItem,
  ReportPackageRun,
  ReportPage,
  ReportPreset,
  ReportReferenceKind,
  ReportReferencePage,
  ReportRunRequest,
  ReportRunSummary,
} from "@shared/reporting";
import type { ForecastScenarioOption } from "./setup-model";

export interface ReportRunResponse {
  readonly run: ReportRunSummary;
  readonly page: ReportPage;
}

export interface ReportPresetSaveRequest {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: "private" | "shared";
  readonly reportId: string;
  readonly definitionVersion?: string;
  readonly scope: ReportRunRequest["scope"];
  readonly filters: ReportRunRequest["filters"];
  readonly period: ReportRunRequest["period"];
  readonly basis: ReportRunRequest["basis"];
  readonly currency: ReportRunRequest["currency"];
  readonly consolidation?: ReportRunRequest["consolidation"];
  readonly forecast?: ReportRunRequest["forecast"];
  readonly columns?: readonly string[];
  readonly sort?: ReportRunRequest["sort"];
  readonly expectedRevision?: number;
}

export interface ReportPackageSaveRequest {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: "private" | "shared";
  readonly items: readonly (Omit<ReportPackageItem, "id"> & { readonly id?: string; readonly title?: string })[];
  readonly expectedRevision?: number;
}

export interface ReportingApi {
  catalog(organizationId: string, signal?: AbortSignal): Promise<readonly ReportEntry[]>;
  run(organizationId: string, request: ReportRunRequest): Promise<ReportRunResponse>;
  references(organizationId: string, kind: ReportReferenceKind, query?: { readonly search?: string; readonly cursor?: string | null; readonly limit?: number; readonly legalEntityIds?: readonly string[] }, signal?: AbortSignal): Promise<ReportReferencePage>;
  forecastScenarios(organizationId: string, signal?: AbortSignal): Promise<ForecastScenarioOption[]>;
  page(organizationId: string, runId: string, cursor?: string | null, limit?: number): Promise<ReportPage>;
  export(organizationId: string, runId: string, format: "csv" | "json" | "html"): Promise<ReportExportJob>;
  listPresets(organizationId: string, signal?: AbortSignal): Promise<readonly ReportPreset[]>;
  savePreset(organizationId: string, request: ReportPresetSaveRequest): Promise<ReportPreset>;
  listPackages(organizationId: string, signal?: AbortSignal): Promise<readonly ReportPackage[]>;
  savePackage(organizationId: string, request: ReportPackageSaveRequest): Promise<ReportPackage>;
  runPackage(organizationId: string, packageId: string): Promise<ReportPackageRun>;
  getPackageRun(organizationId: string, runId: string): Promise<ReportPackageRun>;
}
