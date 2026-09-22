import { operationIdSchema, operationReceiptSchema, revisionSchema, type CompanyScope } from "@shared/company";
import {
  investorContactListResponseSchema,
  investorDocumentListResponseSchema,
  investorDetailSchema,
  investorFinancialSourceResponseSchema,
  investorListResponseSchema,
  investorMonthlyPaymentResponseSchema,
  investorPaymentLogQuerySchema,
  type InvestorCommandKind,
} from "@shared/investors";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type { InvestorListFilters, InvestorsApi } from "./types";

type JsonRecord = Record<string, unknown>;

export class InvestorApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "InvestorApiError"; }
}

export class InvestorRevisionConflictError extends InvestorApiError {
  readonly conflict = true as const;
  constructor(message = "This investor record changed since it was opened. Reload the latest record before saving again.") { super(message, 409, "revision_conflict"); this.name = "InvestorRevisionConflictError"; }
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }

function parseError(value: unknown): { code?: string; message?: string } {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  return { code: typeof data.code === "string" ? data.code : undefined, message: typeof data.message === "string" ? data.message : undefined };
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new InvestorApiError(init.method === "POST" ? "The investor save could not be confirmed. Retry with the same action." : "Investor records could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = parseError(payload);
    if (response.status === 409 || error.code?.includes("conflict") || error.code === "company_revision_conflict") throw new InvestorRevisionConflictError(error.message);
    throw new InvestorApiError(error.message ?? `Investor API returned ${response.status}.`, response.status, error.code);
  }
  return payload;
}

function companyPath(organizationId: string): string { return `/api/company/${encodeURIComponent(organizationId)}`; }

export function createInvestorCommandEnvelope<TPayload>(scope: CompanyScope, payload: TPayload, expectedRevision?: number) {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new Error("Secure operation IDs are unavailable in this browser.");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return { operationId, idempotencyKey: `investors:${operationId}`, scope, ...(expectedRevision === undefined ? {} : { expectedRevision: revisionSchema.parse(expectedRevision) }), payload };
}

function createApi(): InvestorsApi {
  return {
    async listInvestors(organizationId, filters = {}, signal) {
      const params = new URLSearchParams();
      if (filters.search?.trim()) params.set("search", filters.search.trim());
      if (filters.status) params.set("status", filters.status);
      const query = params.toString();
      const payload = await requestJson(`${companyPath(organizationId)}/investors${query ? `?${query}` : ""}`, { signal });
      return investorListResponseSchema.parse(payload);
    },
    async getInvestor(organizationId, accountId, legalEntityId, signal) {
      const params = legalEntityId ? `?legalEntityId=${encodeURIComponent(legalEntityId)}` : "";
      return investorDetailSchema.parse(await requestJson(`${companyPath(organizationId)}/investors/${encodeURIComponent(accountId)}${params}`, { signal }));
    },
    async listContacts(organizationId, search, signal) {
      const params = search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      return investorContactListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/investors/contacts${params}`, { signal }));
    },
    async listDocuments(organizationId, legalEntityId, propertyIds, search, signal) {
      const params = new URLSearchParams({ legalEntityId });
      if (propertyIds?.length) params.set("propertyIds", propertyIds.join(","));
      if (search?.trim()) params.set("search", search.trim());
      return investorDocumentListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/investors/documents?${params}`, { signal }));
    },
    async listFinancialSources(organizationId, legalEntityId, from, through, cursor, signal) {
      const params = new URLSearchParams({ legalEntityId });
      if (from) params.set("from", from);
      if (through) params.set("through", through);
      if (cursor) params.set("cursor", cursor);
      const payload = await requestJson(`${companyPath(organizationId)}/investors/sources?${params}`, { signal });
      return investorFinancialSourceResponseSchema.parse(payload);
    },
    async listMonthlyPayments(organizationId, query, signal) {
      const { legalEntityId, propertyId, ...queryFields } = query;
      const parsed = investorPaymentLogQuerySchema.parse({ ...queryFields, scope: { organizationId, legalEntityId, propertyId } });
      const params = new URLSearchParams({ legalEntityId: parsed.scope.legalEntityId!, fromMonth: parsed.fromMonth, throughMonth: parsed.throughMonth, limit: String(parsed.limit) });
      if (parsed.accountId) params.set("accountId", parsed.accountId);
      if (parsed.instrumentId) params.set("instrumentId", parsed.instrumentId);
      if (parsed.scope.propertyId) params.set("propertyId", parsed.scope.propertyId);
      if (parsed.status) params.set("status", parsed.status);
      if (parsed.cursor) params.set("cursor", parsed.cursor);
      const payload = await requestJson(`${companyPath(organizationId)}/investor-payments?${params}`, { signal });
      return investorMonthlyPaymentResponseSchema.parse(payload);
    },
    async sendCommand(organizationId, kind, envelope) {
      const payload = await requestJson(`${companyPath(organizationId)}/investor-commands/${encodeURIComponent(kind)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
      const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
      const result = isRecord(root) && isRecord(root.result) ? root.result : root;
      const receiptValue = isRecord(result) && result.receipt !== undefined ? result.receipt : result;
      const receipt = operationReceiptSchema.safeParse(receiptValue);
      if (!receipt.success) throw new InvestorApiError("The investor save response could not be confirmed. Retry with the same action.", 0, "company_unknown_outcome");
      return receipt.data;
    },
  };
}

export const investorsApi: InvestorsApi = createApi();
export function createInvestorsApi(): InvestorsApi { return createApi(); }
