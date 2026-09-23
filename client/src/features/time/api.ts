import { operationIdSchema, operationReceiptSchema } from "@shared/company";
import { investorContactListResponseSchema } from "@shared/investors";
import { projectDetailSchema, projectListResponseSchema } from "@shared/projects";
import { costSourceLinePageSchema } from "@shared/projects/source-lines";
import { timePayrollLinkListSchema } from "@shared/time/labor";
import {
  timeCoverageSchema,
  timeEmployeeMappingSchema,
  timeEntrySchema,
  timeJobcodeMappingSchema,
  timeJobcodeSchema,
  timeListQuerySchema,
  timeConnectionSummarySchema,
  timeUserSchema,
  timeEnvironmentSchema,
  type TimeConnectionScope,
  type TimeEnvironment,
  type TimeEntry,
  type TimeJobcode,
  type TimeUser,
} from "@shared/time";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type { TimeApi, TimeCommandEnvelope, TimeListFilters, TimeListPage, TimeContactOption, TimeProjectOption } from "./types";

type JsonRecord = Record<string, unknown>;

export class TimeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "TimeApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseData(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.data)) return value;
  return value.data;
}

function errorDetails(value: unknown): { readonly message?: string; readonly code?: string } {
  const root = responseData(value);
  const record = isRecord(root) && isRecord(root.error) ? root.error : root;
  return {
    message: isRecord(record) && typeof record.message === "string" ? record.message : undefined,
    code: isRecord(record) && typeof record.code === "string" ? record.code : undefined,
  };
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new TimeApiError(init.method === "POST" ? "The time action could not be confirmed. Retry with the same action." : "Employee time records could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const details = errorDetails(payload);
    throw new TimeApiError(details.message ?? `Employee time returned ${response.status}.`, response.status, details.code);
  }
  return responseData(payload);
}

function basePath(organizationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(organizationId)) throw new TimeApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}/time`;
}

function queryForScope(scope: TimeConnectionScope, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({ legalEntityId: scope.legalEntityId, environment: scope.environment, providerCompanyId: scope.providerCompanyId });
  for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== "") params.set(key, value);
  return params.toString();
}

function scopeFromFilters(organizationId: string, filters: TimeListFilters): TimeConnectionScope {
  return {
    organizationId: organizationId as TimeConnectionScope["organizationId"],
    legalEntityId: filters.legalEntityId as TimeConnectionScope["legalEntityId"],
    environment: filters.environment,
    providerCompanyId: filters.providerCompanyId,
  };
}

function commandEnvelope<TPayload>(scope: TimeConnectionScope, payload: TPayload): TimeCommandEnvelope<TPayload> {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new TimeApiError("Secure action IDs are unavailable in this browser.", 0, "time_security_unavailable");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return {
    operationId,
    idempotencyKey: `time:${operationId}`,
    scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId },
    payload,
  } as TimeCommandEnvelope<TPayload>;
}

function parseEntries(value: unknown): TimeListPage {
  const root = isRecord(value) ? value : {};
  const items = Array.isArray(root.items) ? root.items.map(item => timeEntrySchema.parse(item)) : [];
  const coverage = Array.isArray(root.coverage) ? root.coverage.map(item => timeCoverageSchema.parse(item)) : [];
  return { items, nextCursor: root.nextCursor === null || root.nextCursor === undefined ? null : String(root.nextCursor), coverage };
}

function parseUsers(value: unknown): readonly TimeUser[] {
  return Array.isArray(value) ? value.map(item => timeUserSchema.parse(item)) : [];
}

function parseJobcodes(value: unknown): readonly TimeJobcode[] {
  return Array.isArray(value) ? value.map(item => timeJobcodeSchema.parse(item)) : [];
}

function parseCoverage(value: unknown): readonly ReturnType<typeof timeCoverageSchema.parse>[] {
  return Array.isArray(value) ? value.map(item => timeCoverageSchema.parse(item)) : [];
}

function createApi(): TimeApi {
  return {
    async listEntries(organizationId, filters, signal): Promise<TimeListPage> {
      const query = timeListQuerySchema.parse({
        scope: { organizationId, legalEntityId: filters.legalEntityId, ...(filters.propertyId ? { propertyId: filters.propertyId } : {}) },
        environment: filters.environment,
        providerCompanyId: filters.providerCompanyId,
        reviewState: filters.reviewState,
        mappingStatus: filters.mappingStatus,
        from: filters.from,
        through: filters.through,
        cursor: filters.cursor,
        limit: filters.limit ?? 100,
      });
      const params = new URLSearchParams({ legalEntityId: query.scope.legalEntityId, environment: query.environment, providerCompanyId: query.providerCompanyId, limit: String(query.limit) });
      for (const [key, value] of [["propertyId", query.scope.propertyId], ["reviewState", query.reviewState], ["mappingStatus", query.mappingStatus], ["from", query.from], ["through", query.through], ["cursor", query.cursor]] as const) if (value !== undefined) params.set(key, value);
      return parseEntries(await requestJson(`${basePath(organizationId)}/entries?${params.toString()}`, { signal }));
    },
    async listConnections(organizationId, legalEntityId, environment, signal) {
      const params = new URLSearchParams({ legalEntityId });
      if (environment) params.set("environment", environment);
      const value = await requestJson(`${basePath(organizationId)}/connections?${params.toString()}`, { signal });
      return Array.isArray(value) ? value.map(item => timeConnectionSummarySchema.parse(item)) : [];
    },
    async beginConnection(organizationId, legalEntityId, providerCompanyId, signal) {
      const response = await requestJson(`${basePath(organizationId)}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legalEntityId, ...(providerCompanyId ? { providerCompanyId } : {}) }),
        signal,
      });
      const root = isRecord(response) ? response : {};
      if (typeof root.authorizationUrl !== "string" || typeof root.expiresAt !== "string") throw new TimeApiError("QuickBooks Time setup could not be started.", 0, "time_connect_invalid_response");
      const environment = timeEnvironmentSchema.parse(root.environment);
      return { authorizationUrl: root.authorizationUrl, expiresAt: root.expiresAt, environment };
    },
    async listContacts(organizationId, signal): Promise<readonly TimeContactOption[]> {
      const value = investorContactListResponseSchema.parse(await requestJson(`${basePath(organizationId).replace(/\/time$/, "")}/investors/contacts`, { signal }));
      return value.items.map(item => ({ id: String(item.id), displayName: item.displayName, kind: item.kind }));
    },
    async listProjects(organizationId, legalEntityId, signal): Promise<readonly TimeProjectOption[]> {
      const params = new URLSearchParams({ legalEntityId, status: "active", limit: "100" });
      const value = projectListResponseSchema.parse(await requestJson(`${basePath(organizationId).replace(/\/time$/, "")}/projects?${params.toString()}`, { signal }));
      return value.items.map(item => ({ id: String(item.id), name: item.name, legalEntityId: String(item.legalEntityId) }));
    },
    async listProjectScopeItems(organizationId, projectId, signal) {
      const value = projectDetailSchema.parse(await requestJson(`${basePath(organizationId).replace(/\/time$/, "")}/projects/${encodeURIComponent(projectId)}`, { signal }));
      return value.scopeItems.filter(item => item.archivedAt === null).map(item => ({ id: String(item.id), description: item.description }));
    },
    async listPayrollLinks(organizationId, legalEntityId, signal) {
      return timePayrollLinkListSchema.parse(await requestJson(`${basePath(organizationId)}/payroll-links?${new URLSearchParams({ legalEntityId }).toString()}`, { signal })).items;
    },
    async searchPayrollLines(organizationId, query, signal) {
      const params = new URLSearchParams({ legalEntityId: query.legalEntityId, purpose: "payroll", limit: "50" });
      if (query.search?.trim()) params.set("search", query.search.trim());
      if (query.cursor) params.set("cursor", query.cursor);
      return costSourceLinePageSchema.parse(await requestJson(`${basePath(organizationId).replace(/\/time$/, "")}/cost-source-lines?${params.toString()}`, { signal }));
    },
    async listUsers(organizationId, scope, signal) {
      return parseUsers(await requestJson(`${basePath(organizationId)}/users?${queryForScope(scope)}`, { signal }));
    },
    async listJobcodes(organizationId, scope, signal) {
      return parseJobcodes(await requestJson(`${basePath(organizationId)}/jobcodes?${queryForScope(scope)}`, { signal }));
    },
    async listEmployeeMappings(organizationId, scope, signal) {
      const value = await requestJson(`${basePath(organizationId)}/employee-mappings?${queryForScope(scope)}`, { signal });
      return Array.isArray(value) ? value.map(item => timeEmployeeMappingSchema.parse(item)) : [];
    },
    async listJobcodeMappings(organizationId, scope, signal) {
      const value = await requestJson(`${basePath(organizationId)}/jobcode-mappings?${queryForScope(scope)}`, { signal });
      return Array.isArray(value) ? value.map(item => timeJobcodeMappingSchema.parse(item)) : [];
    },
    async sync(organizationId, scope, signal) {
      const value = await requestJson(`${basePath(organizationId)}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope), signal });
      const root = isRecord(value) ? value : {};
      return { status: root.status === "partial" ? "partial" : "complete", streams: parseCoverage(root.streams), conflicts: Array.isArray(root.conflicts) ? root.conflicts.filter((item): item is string => typeof item === "string") : [] };
    },
    async sendCommand(organizationId, kind, envelope) {
      const value = await requestJson(`${basePath(organizationId).replace(/\/time$/, "")}/time-commands/${encodeURIComponent(kind)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
      const root = isRecord(value) && isRecord(value.result) ? value.result : value;
      const parsed = operationReceiptSchema.safeParse(root);
      if (!parsed.success) throw new TimeApiError("The time action could not be confirmed. Retry with the same action.", 0, "company_unknown_outcome");
      return parsed.data;
    },
  };
}

export const timeApi: TimeApi = createApi();
export { commandEnvelope, scopeFromFilters };
