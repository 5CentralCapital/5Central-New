import { operationIdSchema, operationReceiptSchema, type OperationReceipt } from "@shared/company";
import {
  reviewCaseDetailSchema,
  reviewCaseListResponseSchema,
  reviewInventorySchema,
  type ReviewCaseCommandKind,
  type ReviewCaseDetail,
  type ReviewCaseListResponse,
  type ReviewCaseState,
  type ReviewCauseFamily,
  type ReviewInventory,
  type ReviewMateriality,
} from "@shared/review-cases";
import { rentOpsAuthClient } from "../rent-ops/auth";

export class ReviewCaseApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ReviewCaseApiError";
  }
  get conflict(): boolean { return this.status === 409; }
  /** The save may or may not have committed; retry the identical envelope. */
  get uncertain(): boolean { return this.status === 0; }
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new ReviewCaseApiError(init.method === "POST" ? "The change could not be confirmed. Try again; repeating it is safe." : "Review cases could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" && payload.message.length <= 400 ? payload.message : undefined;
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
    if (response.status === 409) throw new ReviewCaseApiError(message ?? "This case changed since you opened it. Reload it, then try again.", 409, code);
    throw new ReviewCaseApiError(message ?? `Review cases returned ${response.status}.`, response.status, code);
  }
  return payload;
}

function companyPath(organizationId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(organizationId)) throw new ReviewCaseApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}`;
}

export interface ReviewCaseListFilters {
  readonly legalEntityId?: string;
  readonly propertyId?: string;
  readonly states?: readonly ReviewCaseState[];
  readonly materialities?: readonly ReviewMateriality[];
  readonly families?: readonly ReviewCauseFamily[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReviewCaseCommandEnvelope {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly scope: { organizationId: string; legalEntityId?: string; propertyId?: string };
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
}

export function reviewCaseEnvelope(organizationId: string, payload: Record<string, unknown>, expectedRevision?: number): ReviewCaseCommandEnvelope {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new ReviewCaseApiError("Secure action IDs are unavailable in this browser.", 0, "review_case_security_unavailable");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return { operationId, idempotencyKey: `review-case:${operationId}`, scope: { organizationId }, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

function scopeParams(filters: { legalEntityId?: string; propertyId?: string }): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.legalEntityId) params.set("legalEntityId", filters.legalEntityId);
  if (filters.legalEntityId && filters.propertyId) params.set("propertyId", filters.propertyId);
  return params;
}

export interface ReviewCasesApi {
  list(organizationId: string, filters: ReviewCaseListFilters, signal?: AbortSignal): Promise<ReviewCaseListResponse>;
  get(organizationId: string, caseId: string, signal?: AbortSignal): Promise<ReviewCaseDetail>;
  inventory(organizationId: string, filters?: { legalEntityId?: string; propertyId?: string }, signal?: AbortSignal): Promise<ReviewInventory>;
  command(organizationId: string, kind: ReviewCaseCommandKind, envelope: ReviewCaseCommandEnvelope): Promise<OperationReceipt>;
}

export const reviewCasesApi: ReviewCasesApi = {
  async list(organizationId, filters, signal) {
    const params = scopeParams(filters);
    params.set("limit", String(filters.limit ?? 100));
    if (filters.states?.length) params.set("state", filters.states.join(","));
    if (filters.materialities?.length) params.set("materiality", filters.materialities.join(","));
    if (filters.families?.length) params.set("family", filters.families.join(","));
    if (filters.cursor) params.set("cursor", filters.cursor);
    return reviewCaseListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/review-cases?${params}`, { signal }));
  },
  async get(organizationId, caseId, signal) {
    return reviewCaseDetailSchema.parse(await requestJson(`${companyPath(organizationId)}/review-cases/${encodeURIComponent(caseId)}`, { signal }));
  },
  async inventory(organizationId, filters = {}, signal) {
    const params = scopeParams(filters);
    return reviewInventorySchema.parse(await requestJson(`${companyPath(organizationId)}/review-cases/inventory${params.toString() ? `?${params}` : ""}`, { signal }));
  },
  async command(organizationId, kind, envelope) {
    const value = await requestJson(`${companyPath(organizationId)}/review-case-commands/${encodeURIComponent(kind)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
    });
    const parsed = operationReceiptSchema.safeParse(value);
    if (!parsed.success) throw new ReviewCaseApiError("The change could not be confirmed. Try again; repeating it is safe.", 0, "company_unknown_outcome");
    return parsed.data;
  },
};
