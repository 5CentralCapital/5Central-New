import { z } from "zod";
import { operationReceiptSchema } from "@shared/company";
import {
  accountingPayablesResponseSchema,
  connectorHealthResponseSchema,
  jobDetailSchema,
  periodCloseChecklistSchema,
  pmSettlementDetailSchema,
  pmSettlementListResponseSchema,
  rentalBridgePreviewSchema,
  rentalPostingPolicyListSchema,
} from "@shared/accounting/operations";
import { financialSourceCoverageSchema, financialSourceLineResolutionSchema } from "@shared/accounting/source";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { parseCustomerLedger } from "./customer-ledger";
import type { AccountingApi, AccountingConnection, AccountingEnvironment, AccountingMirror, AccountingMirrorKind, AccountingPendingBinding, AccountingPeriod, AccountingScope, AccountingTransaction, AccountingTransactionPage } from "./types";

type JsonRecord = Record<string, unknown>;

export class AccountingApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "AccountingApiError";
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function responseData(value: unknown): unknown {
  const root = record(value);
  return root.data === undefined ? value : root.data;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new AccountingApiError(init.method === "POST" ? "The accounting action could not be confirmed." : "Accounting records could not be loaded.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const root = record(responseData(payload));
    throw new AccountingApiError(typeof root.message === "string" ? root.message : "Accounting records could not be loaded.", response.status, typeof root.code === "string" ? root.code : undefined);
  }
  return responseData(payload);
}

function companyPath(organizationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(organizationId)) throw new AccountingApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}`;
}

function basePath(organizationId: string): string {
  return `${companyPath(organizationId)}/accounting/qbo`;
}

function parsed<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw new AccountingApiError("Accounting records returned an unexpected shape. Reload and try again.", 0, "accounting_invalid_response"); }
}

function periodParams(legalEntityId: string, period: AccountingPeriod): URLSearchParams {
  return new URLSearchParams({ legalEntityId, periodStart: period.periodStart, periodEnd: period.periodEnd });
}

function scopeParams(scope: AccountingScope): URLSearchParams {
  return new URLSearchParams({ legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId });
}

function parseConnection(value: unknown): AccountingConnection {
  const root = record(value);
  const scope = record(root.scope);
  const environment = scope.environment === "production" ? "production" : "sandbox";
  return {
    scope: { organizationId: String(scope.organizationId), legalEntityId: String(scope.legalEntityId), environment, realmId: String(scope.realmId) },
    name: typeof root.name === "string" ? root.name : "QuickBooks Online",
    status: root.status === "ready" || root.status === "needs_reconnect" ? root.status : "connected",
    version: Number(root.version ?? 0),
    accessTokenExpiresAt: String(root.accessTokenExpiresAt ?? ""),
    refreshTokenExpiresAt: root.refreshTokenExpiresAt === null || root.refreshTokenExpiresAt === undefined ? null : String(root.refreshTokenExpiresAt),
    refreshTokenHardExpiresAt: root.refreshTokenHardExpiresAt === null || root.refreshTokenHardExpiresAt === undefined ? null : String(root.refreshTokenHardExpiresAt),
    updatedAt: String(root.updatedAt ?? ""),
  };
}

function parsePending(value: unknown): AccountingPendingBinding | null {
  const root = record(value); const scope = record(root.scope); const proof = record(root.proof);
  if (!root.pendingId || !scope.organizationId || !scope.legalEntityId || !scope.realmId) return null;
  return {
    pendingId: String(root.pendingId),
    scope: { organizationId: String(scope.organizationId), legalEntityId: String(scope.legalEntityId), environment: scope.environment === "production" ? "production" : "sandbox", realmId: String(scope.realmId) },
    providerCompanyId: String(proof.providerCompanyId ?? ""),
    providerCompanyName: proof.providerCompanyName === null || proof.providerCompanyName === undefined ? null : String(proof.providerCompanyName),
    providerLegalName: proof.providerLegalName === null || proof.providerLegalName === undefined ? null : String(proof.providerLegalName),
    homeCurrency: proof.homeCurrency === null || proof.homeCurrency === undefined ? null : String(proof.homeCurrency),
    expiresAt: String(root.expiresAt ?? ""),
  };
}

function parseMirror(value: unknown, kind: AccountingMirrorKind): AccountingMirror {
  const root = record(value);
  const objectType = ["Account", "Vendor", "Customer", "Employee"].includes(String(root.objectType)) ? String(root.objectType) as AccountingMirror["objectType"] : "Account";
  return { kind, objectType, providerObjectId: String(root.providerObjectId ?? ""), displayName: String(root.displayName ?? ""), active: root.active !== false, version: String(root.version ?? ""), providerUpdatedAt: root.providerUpdatedAt === null || root.providerUpdatedAt === undefined ? null : String(root.providerUpdatedAt) };
}

const transactionPageResponseSchema = z.object({
  items: z.array(financialSourceLineResolutionSchema),
  nextCursor: z.string().nullable(),
  coverage: financialSourceCoverageSchema,
}).strict();

export function parseTransaction(value: unknown): AccountingTransaction {
  const line = parsed(financialSourceLineResolutionSchema, value);
  return {
    source: {
      objectType: line.source.objectType,
      objectId: line.source.objectId,
      lineId: line.source.lineId,
      version: line.source.version,
    },
    amountCents: line.amountCents,
    currency: line.currency,
    transactionType: line.transactionType,
    description: line.description,
    postingState: line.postingState,
    postedOn: line.postedOn,
    settlement: {
      state: line.settlement.state,
      settledOn: line.settlement.settledOn,
      settledAmountCents: line.settlement.settledAmountCents,
    },
  };
}

const api: AccountingApi = {
  async getConfiguration(organizationId, legalEntityId, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/configuration?${new URLSearchParams({ legalEntityId })}`, { signal }));
    return { configured: value.configured === true, environment: value.environment === "production" || value.environment === "sandbox" ? value.environment : null };
  },
  async listConnections(organizationId, legalEntityId, environment, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/connections?${new URLSearchParams({ legalEntityId, environment })}`, { signal }));
    return Array.isArray(value.items) ? value.items.map(parseConnection) : [];
  },
  async listMirrors(organizationId, scope, kind, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/mirrors?${scopeParams(scope)}&kind=${kind}`, { signal }));
    return Array.isArray(value.items) ? value.items.map(item => parseMirror(item, kind)) : [];
  },
  async listTransactions(organizationId, scope, signal, cursor) {
    const value = parsed(transactionPageResponseSchema, await requestJson(`${basePath(organizationId)}/transactions?${scopeParams(scope)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal }));
    return {
      items: value.items.map(parseTransaction),
      nextCursor: value.nextCursor,
      coverage: { status: value.coverage.status, evidence: value.coverage.evidence, reason: value.coverage.reason },
    } satisfies AccountingTransactionPage;
  },
  async beginConnection(organizationId, legalEntityId, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId }), signal }));
    if (typeof value.authorizationUrl !== "string" || typeof value.expiresAt !== "string") throw new AccountingApiError("QuickBooks setup could not be started.", 0, "accounting_connect_invalid_response");
    return { authorizationUrl: value.authorizationUrl, expiresAt: value.expiresAt };
  },
  async getPendingBinding(organizationId, legalEntityId, pendingId, signal) {
    try {
      return parsePending(await requestJson(`${basePath(organizationId)}/pending?${new URLSearchParams({ legalEntityId, pendingId })}`, { signal }));
    } catch (error) {
      if (error instanceof AccountingApiError && error.status === 404) return null;
      throw error;
    }
  },
  async confirmConnection(organizationId, legalEntityId, pendingId, signal) {
    await requestJson(`${basePath(organizationId)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId, pendingId, confirmRealmBinding: true }), signal });
  },
  async sync(organizationId, scope, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId }), signal }));
    return { status: "queued", jobId: typeof value.jobId === "string" ? value.jobId : null, message: typeof value.message === "string" ? value.message : "QuickBooks refresh queued." };
  },
  async getJob(organizationId, jobId, signal) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new AccountingApiError("That refresh job is unavailable.", 400, "accounting_validation");
    const value = parsed(jobDetailSchema, await requestJson(`${companyPath(organizationId)}/jobs/${encodeURIComponent(jobId)}`, { signal }));
    return { state: value.state };
  },
  async health(organizationId, legalEntityId, signal) {
    const query = legalEntityId ? `?${new URLSearchParams({ legalEntityId })}` : "";
    return parsed(connectorHealthResponseSchema, await requestJson(`${companyPath(organizationId)}/accounting/health${query}`, { signal }));
  },
  async closeChecklist(organizationId, legalEntityId, period, signal) {
    return parsed(periodCloseChecklistSchema, await requestJson(`${companyPath(organizationId)}/accounting/period-close?${periodParams(legalEntityId, period)}`, { signal }));
  },
  async postingPolicies(organizationId, legalEntityId, signal) {
    return parsed(rentalPostingPolicyListSchema, await requestJson(`${companyPath(organizationId)}/accounting/posting-policies?${new URLSearchParams({ legalEntityId })}`, { signal })).items;
  },
  async pmSettlements(organizationId, query, signal) {
    const params = new URLSearchParams({ legalEntityId: query.legalEntityId, limit: "50" });
    if (query.states?.length) params.set("state", query.states.join(","));
    if (query.cursor) params.set("cursor", query.cursor);
    return parsed(pmSettlementListResponseSchema, await requestJson(`${companyPath(organizationId)}/accounting/pm-settlements?${params}`, { signal }));
  },
  async pmSettlement(organizationId, legalEntityId, settlementId, signal) {
    if (!/^[0-9a-f-]{36}$/i.test(settlementId)) throw new AccountingApiError("That statement is unavailable.", 400, "accounting_validation");
    return parsed(pmSettlementDetailSchema, await requestJson(`${companyPath(organizationId)}/accounting/pm-settlements/${settlementId}?${new URLSearchParams({ legalEntityId })}`, { signal }));
  },
  async bridgePreview(organizationId, legalEntityId, period, signal) {
    return parsed(rentalBridgePreviewSchema, await requestJson(`${companyPath(organizationId)}/accounting/rental-bridge?${periodParams(legalEntityId, period)}`, { signal }));
  },
  bridgeCsvHref(organizationId, legalEntityId, period) {
    const params = periodParams(legalEntityId, period); params.set("format", "csv");
    return `${companyPath(organizationId)}/accounting/rental-bridge?${params}`;
  },
  async payables(organizationId, scope, kind, cursor, signal) {
    const params = new URLSearchParams({ legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId, kind, limit: "50" });
    if (cursor) params.set("cursor", cursor);
    return parsed(accountingPayablesResponseSchema, await requestJson(`${basePath(organizationId)}/payables?${params}`, { signal }));
  },
  async command(organizationId, kind, envelope, signal) {
    if (!/^[a-z][a-z0-9_.-]*$/.test(kind)) throw new AccountingApiError("That action is unavailable.", 400, "accounting_validation");
    return parsed(operationReceiptSchema, await requestJson(`${companyPath(organizationId)}/accounting-commands/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope), signal }));
  },
  async tenancyLedger(organizationId, query, signal) {
    const params = new URLSearchParams({ tenancyId: query.tenancyId, environment: query.environment, limit: String(query.limit ?? 200) });
    if (query.cursor) params.set("cursor", query.cursor);
    try {
      return parsed({ parse: parseCustomerLedger }, await requestJson(`${basePath(organizationId)}/receivables/tenancy-ledger?${params}`, { signal }));
    } catch (error) {
      if (error instanceof AccountingApiError && error.status === 404 && error.code === "accounting_not_linked") return null;
      throw error;
    }
  },
  async linkTenancyCustomer(organizationId, input, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/receivables/tenancy-links`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId: input.scope.legalEntityId, environment: input.scope.environment, realmId: input.scope.realmId, tenancyId: input.tenancyId, customerId: input.customerId }), signal }));
    const status = value.status;
    if (status !== "linked" && status !== "already_linked") throw new AccountingApiError("The QuickBooks customer link could not be confirmed. Reload before trying again.", 0, "accounting_invalid_response");
    return { status };
  },
  async disconnect(organizationId, scope, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/disconnect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId: scope.legalEntityId, realmId: scope.realmId }), signal }));
    if (value.status !== "disconnected") throw new AccountingApiError("QuickBooks did not confirm the disconnect. The connection was kept; try again.", 0, "accounting_disconnect_unconfirmed");
    return { providerOutcome: value.providerOutcome === "already_revoked" ? "already_revoked" : "revoked" };
  },
};

export const accountingApi: AccountingApi = api;
