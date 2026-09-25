import type { z } from "zod";
import {
  companySettingsSchema, costLibrarySchema, dashboardCompanySchema, entityDirectorySchema, peopleDirectorySchema,
  propertyDocumentsSchema, propertyFinancialsSchema, propertyPerformanceSchema,
  type CompanySettings, type CostLibrary, type DashboardCompany, type EntityDirectory, type PeopleDirectory,
  type PropertyDocuments, type PropertyFinancials, type PropertyPerformance,
} from "@shared/workspaces/contracts";
import { rentOpsAuthClient } from "../rent-ops/auth";

export class WorkspaceApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "WorkspaceApiError"; }
}

async function read<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await rentOpsAuthClient.request(path, { signal, headers: { Accept: "application/json" } }).catch(error => {
    if (signal?.aborted) throw error;
    throw new WorkspaceApiError("Records could not be loaded. Check the connection and try again.", 0, "workspace_connection");
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = payload && typeof payload === "object" ? payload as { message?: unknown; code?: unknown } : {};
    const message = response.status === 403 ? "Your company access does not include these records." : typeof body.message === "string" ? body.message : "Records could not be loaded.";
    throw new WorkspaceApiError(message, response.status, typeof body.code === "string" ? body.code : undefined);
  }
  return schema.parse(payload);
}

function query(values: Record<string, string | readonly string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    if (typeof value === "string") params.set(key, value); else for (const item of value) params.append(key, item);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

const companyPath = (organizationId: string, path: string) => `/api/company/${encodeURIComponent(organizationId)}/workspaces/${path}`;

export const workspacesApi = {
  propertyFinancials(propertyId: string, input: { month: string; asOf: string; organizationId?: string }, signal?: AbortSignal): Promise<PropertyFinancials> {
    return read(`/api/workspaces/properties/${encodeURIComponent(propertyId)}/financials${query({ month: input.month, asOf: input.asOf, company: input.organizationId })}`, propertyFinancialsSchema, signal);
  },
  propertyPerformance(input: { month: string; asOf: string; scope: "active" | "all"; propertyIds: readonly string[]; organizationId?: string }, signal?: AbortSignal): Promise<PropertyPerformance> {
    return read(`/api/workspaces/property-performance${query({ month: input.month, asOf: input.asOf, scope: input.scope, property: input.propertyIds, company: input.organizationId })}`, propertyPerformanceSchema, signal);
  },
  entities(organizationId: string, asOf: string, signal?: AbortSignal): Promise<EntityDirectory> {
    return read(`${companyPath(organizationId, "entities")}${query({ asOf })}`, entityDirectorySchema, signal);
  },
  people(organizationId: string, input: { search?: string; role?: string; cursor?: string; asOf: string }, signal?: AbortSignal): Promise<PeopleDirectory> {
    return read(`${companyPath(organizationId, "people")}${query({ search: input.search, role: input.role, cursor: input.cursor, asOf: input.asOf, limit: "50" })}`, peopleDirectorySchema, signal);
  },
  settings(organizationId: string, signal?: AbortSignal): Promise<CompanySettings> {
    return read(companyPath(organizationId, "settings"), companySettingsSchema, signal);
  },
  propertyDocuments(organizationId: string, input: { asOf: string; propertyIds: readonly string[] }, signal?: AbortSignal): Promise<PropertyDocuments> {
    return read(`${companyPath(organizationId, "property-documents")}${query({ asOf: input.asOf, property: input.propertyIds })}`, propertyDocumentsSchema, signal);
  },
  costLibrary(organizationId: string, input: { search?: string; cursor?: string; asOf: string }, signal?: AbortSignal): Promise<CostLibrary> {
    return read(`${companyPath(organizationId, "cost-library")}${query({ search: input.search, cursor: input.cursor, asOf: input.asOf, limit: "50" })}`, costLibrarySchema, signal);
  },
  dashboard(organizationId: string, asOf: string, signal?: AbortSignal): Promise<DashboardCompany> {
    return read(`${companyPath(organizationId, "dashboard")}${query({ asOf })}`, dashboardCompanySchema, signal);
  },
};
