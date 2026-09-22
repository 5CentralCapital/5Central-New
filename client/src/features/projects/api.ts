import { operationIdSchema } from "@shared/company/identifiers";
import { operationReceiptSchema } from "@shared/company/commands";
import { projectDetailSchema, projectExecutionDetailSchema, projectListResponseSchema, type ProjectCommandKind, type ProjectExecutionCommandKind } from "@shared/projects";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type {
  ProjectCommandEnvelope,
  ProjectCommandResult,
  ProjectDetail,
  ProjectExecutionCommandEnvelope,
  ProjectExecutionDetail,
  ProjectListFilters,
  ProjectListPage,
  ProjectsApi,
} from "./types";

type JsonRecord = Record<string, unknown>;

export class ProjectApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ProjectApiError";
  }
}

export class ProjectRevisionConflictError extends ProjectApiError {
  readonly conflict = true as const;

  constructor(
    readonly expectedRevision?: number,
    readonly actualRevision?: number,
    message = "This project changed since it was opened. Your draft is still here; reload the latest record before saving again.",
  ) {
    super(message, 409, "revision_conflict");
    this.name = "ProjectRevisionConflictError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseError(value: unknown): { code?: string; message?: string; expectedRevision?: number; actualRevision?: number } {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const error = isRecord(data.error) ? data.error : data;
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" && error.message.length <= 240 ? error.message : undefined,
    expectedRevision: typeof error.expectedRevision === "number" ? error.expectedRevision : undefined,
    actualRevision: typeof error.actualRevision === "number" ? error.actualRevision : undefined,
  };
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new ProjectApiError(init.method === 'POST' ? 'The save could not be confirmed. Retry the pending save.' : 'Project records could not be loaded. Try again.', 0, 'company_connection_unavailable');
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = parseError(payload);
    if (response.status === 409 || error.code === "revision_conflict" || error.code === "conflict") {
      throw new ProjectRevisionConflictError(error.expectedRevision, error.actualRevision, error.message);
    }
    throw new ProjectApiError(error.message ?? `Projects API returned ${response.status}.`, response.status, error.code);
  }
  return payload;
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(value)) throw new Error(`${label} is unavailable.`);
}

function basePath(organizationId: string): string {
  assertId(organizationId, "Company");
  return `/api/company/${encodeURIComponent(organizationId)}/projects`;
}

function projectPath(organizationId: string, projectId: string): string {
  assertId(projectId, "Project");
  return `${basePath(organizationId)}/${encodeURIComponent(projectId)}`;
}

function executionPath(organizationId: string, projectId: string): string {
  return `${projectPath(organizationId, projectId)}/execution`;
}

function executionCommandPath(organizationId: string, kind: ProjectExecutionCommandKind): string {
  assertId(organizationId, "Company");
  return `${basePath(organizationId).replace(/\/projects$/, "")}/project-execution-commands/${encodeURIComponent(kind)}`;
}

export function createProjectCommandEnvelope<TPayload>(
  scope: ProjectCommandEnvelope["scope"],
  payload: TPayload,
  expectedRevision?: number,
): ProjectCommandEnvelope<TPayload> {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new Error("Secure operation IDs are unavailable in this browser.");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return {
    operationId,
    idempotencyKey: `projects:${operationId}`,
    scope,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload,
  } as ProjectCommandEnvelope<TPayload>;
}

function commandResult(value: unknown): ProjectCommandResult {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const result = isRecord(data.result) ? data.result : data;
  const projectValue = result.project;
  const receiptValue = result.receipt ?? (typeof result.operationId === "string" ? result : undefined);
  const parsedReceipt = operationReceiptSchema.safeParse(receiptValue);
  if (!parsedReceipt.success) throw new ProjectApiError('The save response could not be confirmed. Retry the pending save.', 0, 'company_unknown_outcome');
  const receipt = parsedReceipt.data;
  return {
    receipt,
    ...(projectValue === undefined ? {} : { project: projectDetailSchema.parse(projectValue) }),
  };
}

function createApi(): ProjectsApi {
  return {
  async listProjects(organizationId, filters = {}, signal) {
    const params = new URLSearchParams();
    if (filters.status && filters.status !== "all") params.set("status", filters.status);
    if (filters.search?.trim()) params.set("search", filters.search.trim());
    if (filters.cursor) params.set("cursor", filters.cursor);
    const query = params.toString();
    const payload = await requestJson(`${basePath(organizationId)}${query ? `?${query}` : ""}`, { signal });
    const page = projectListResponseSchema.parse(payload);
    return { items: page.items, nextCursor: page.nextCursor } satisfies ProjectListPage;
  },

  async getProject(organizationId, projectId, signal): Promise<ProjectDetail> {
    const payload = await requestJson(projectPath(organizationId, projectId), { signal });
    const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
    const projectValue = isRecord(root) && root.project !== undefined ? root.project : root;
    return projectDetailSchema.parse(projectValue);
  },

  async getProjectExecution(organizationId, projectId, scope = {}, signal): Promise<ProjectExecutionDetail> {
    const params = new URLSearchParams();
    if (scope.legalEntityId) params.set("legalEntityId", scope.legalEntityId);
    if (scope.propertyId) params.set("propertyId", scope.propertyId);
    const query = params.toString();
    const payload = await requestJson(`${executionPath(organizationId, projectId)}${query ? `?${query}` : ""}`, { signal });
    const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
    const executionValue = isRecord(root) && root.execution !== undefined ? root.execution : root;
    return projectExecutionDetailSchema.parse(executionValue);
  },

  async sendCommand(organizationId, kind: ProjectCommandKind, envelope) {
    assertId(organizationId, "Company");
    const payload = await requestJson(`${basePath(organizationId).replace(/\/projects$/, "")}/project-commands/${encodeURIComponent(kind)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return commandResult(payload);
  },

  async sendExecutionCommand(organizationId, kind, envelope) {
    const payload = await requestJson(executionCommandPath(organizationId, kind), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return commandResult(payload);
  },
  };
}

export const projectsApi: ProjectsApi = createApi();

export function createProjectsApi(): ProjectsApi {
  return createApi();
}
