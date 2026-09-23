import { operationIdSchema, operationReceiptSchema, type OperationReceipt } from "@shared/company";
import { projectListResponseSchema } from "@shared/projects";
import {
  workOrderDetailSchema,
  workOrderListResponseSchema,
  workOrderTenantOptionsResponseSchema,
  workOrderDocumentOptionsResponseSchema,
  workOrderVendorOptionsResponseSchema,
  type WorkOrderDocumentOptionsResponse,
  type WorkOrderVendorOptionsResponse,
  type WorkOrderCategory,
  type WorkOrderCommandKind,
  type WorkOrderDetail,
  type WorkOrderListResponse,
  type WorkOrderPriority,
  type WorkOrderStatus,
  type WorkOrderTenantOption,
} from "@shared/work-orders";
import { costSourceLinePageSchema, type CostSourceLinePage } from "@shared/projects/source-lines";
import { rentOpsAuthClient } from "../rent-ops/auth";

export class WorkOrderApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "WorkOrderApiError";
  }
  get conflict(): boolean { return this.status === 409; }
  /** Network loss: the save may or may not have committed; retry the same envelope. */
  get uncertain(): boolean { return this.status === 0; }
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new WorkOrderApiError(init.method === "POST" ? "The save could not be confirmed. Try again; a repeated save is safe." : "Work orders could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" && payload.message.length <= 300 ? payload.message : undefined;
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
    if (response.status === 409) throw new WorkOrderApiError("This work order changed since you opened it. Reload it, then save again.", 409, code);
    throw new WorkOrderApiError(message ?? `Work orders returned ${response.status}.`, response.status, code);
  }
  return payload;
}

function companyPath(organizationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(organizationId)) throw new WorkOrderApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}`;
}

export interface WorkOrderListFilters {
  readonly statuses?: readonly WorkOrderStatus[];
  readonly openOnly: boolean;
  readonly priority?: WorkOrderPriority;
  readonly category?: WorkOrderCategory;
  readonly legalEntityId?: string;
  readonly propertyId?: string;
  readonly search?: string;
  readonly cursor?: string;
}

export interface WorkOrderCommandEnvelope {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly scope: { organizationId: string; legalEntityId: string };
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
}

export function workOrderEnvelope(organizationId: string, legalEntityId: string, payload: Record<string, unknown>, expectedRevision?: number): WorkOrderCommandEnvelope {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new WorkOrderApiError("Secure action IDs are unavailable in this browser.", 0, "work_order_security_unavailable");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return { operationId, idempotencyKey: `work-order:${operationId}`, scope: { organizationId, legalEntityId }, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

export const workOrdersApi = {
  async list(organizationId: string, filters: WorkOrderListFilters, signal?: AbortSignal): Promise<WorkOrderListResponse> {
    const params = new URLSearchParams({ limit: "100", openOnly: String(filters.openOnly) });
    if (filters.statuses?.length) params.set("status", filters.statuses.join(","));
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.category) params.set("category", filters.category);
    if (filters.legalEntityId) params.set("legalEntityId", filters.legalEntityId);
    if (filters.propertyId) params.set("propertyId", filters.propertyId);
    if (filters.search?.trim()) params.set("search", filters.search.trim());
    if (filters.cursor) params.set("cursor", filters.cursor);
    return workOrderListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders?${params}`, { signal }));
  },
  async get(organizationId: string, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderDetail> {
    return workOrderDetailSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders/${encodeURIComponent(workOrderId)}`, { signal }));
  },
  async tenantOptions(organizationId: string, legalEntityId: string, propertyId: string, signal?: AbortSignal): Promise<readonly WorkOrderTenantOption[]> {
    const params = new URLSearchParams({ legalEntityId, propertyId });
    return workOrderTenantOptionsResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders/tenant-options?${params}`, { signal })).items;
  },
  async projects(organizationId: string, legalEntityId: string, propertyId: string, signal?: AbortSignal): Promise<readonly { id: string; name: string }[]> {
    const params = new URLSearchParams({ legalEntityId, propertyId, limit: "100" });
    const value = projectListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/projects?${params}`, { signal }));
    return value.items.map(item => ({ id: String(item.id), name: item.name }));
  },
  async vendorOptions(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<WorkOrderVendorOptionsResponse["items"]> {
    return workOrderVendorOptionsResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders/vendor-options?${new URLSearchParams({ legalEntityId })}`, { signal })).items;
  },
  async documentOptions(organizationId: string, legalEntityId: string, propertyId: string, signal?: AbortSignal): Promise<WorkOrderDocumentOptionsResponse["items"]> {
    return workOrderDocumentOptionsResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders/document-options?${new URLSearchParams({ legalEntityId, propertyId })}`, { signal })).items;
  },
  async costLines(organizationId: string, legalEntityId: string, search?: string, cursor?: string, signal?: AbortSignal): Promise<CostSourceLinePage> {
    const params = new URLSearchParams({ legalEntityId, limit: "50" });
    if (search?.trim()) params.set("search", search.trim());
    if (cursor) params.set("cursor", cursor);
    return costSourceLinePageSchema.parse(await requestJson(`${companyPath(organizationId)}/work-orders/cost-lines?${params}`, { signal }));
  },
  async command(organizationId: string, kind: WorkOrderCommandKind, envelope: WorkOrderCommandEnvelope): Promise<OperationReceipt> {
    const value = await requestJson(`${companyPath(organizationId)}/work-order-commands/${encodeURIComponent(kind)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
    });
    const parsed = operationReceiptSchema.safeParse(value);
    if (!parsed.success) throw new WorkOrderApiError("The save could not be confirmed. Try again; a repeated save is safe.", 0, "company_unknown_outcome");
    return parsed.data;
  },
};

export function revisionFrom(receipt: OperationReceipt): number | undefined {
  return receipt.resultingRevisions[0]?.revision;
}
