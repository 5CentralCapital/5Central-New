import { rentOpsAuthClient } from "../rent-ops/auth";
import type { AccountingApi, AccountingConnection, AccountingEnvironment, AccountingMirror, AccountingMirrorKind, AccountingPendingBinding, AccountingScope, AccountingTransaction, AccountingTransactionPage } from "./types";

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

function basePath(organizationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(organizationId)) throw new AccountingApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}/accounting/qbo`;
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
    status: root.status === "ready" ? "ready" : "connected",
    version: Number(root.version ?? 0),
    accessTokenExpiresAt: String(root.accessTokenExpiresAt ?? ""),
    refreshTokenExpiresAt: root.refreshTokenExpiresAt === null || root.refreshTokenExpiresAt === undefined ? null : String(root.refreshTokenExpiresAt),
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

function parseTransaction(value: unknown): AccountingTransaction {
  const root = record(value); const source = record(root.source); const settlement = record(root.settlement);
  return { source: { objectType: String(source.objectType ?? ""), objectId: String(source.objectId ?? ""), lineId: source.lineId === null || source.lineId === undefined ? null : String(source.lineId), version: String(source.version ?? "") }, amountCents: String(root.amountCents ?? "0"), currency: String(root.currency ?? ""), transactionType: String(root.transactionType ?? ""), description: root.description === null || root.description === undefined ? null : String(root.description), postingState: String(root.postingState ?? "unknown"), postedOn: root.postedOn === null || root.postedOn === undefined ? null : String(root.postedOn), settlement: { state: String(settlement.state ?? "unknown"), settledOn: settlement.settledOn === null || settlement.settledOn === undefined ? null : String(settlement.settledOn), settledAmountCents: settlement.settledAmountCents === null || settlement.settledAmountCents === undefined ? null : String(settlement.settledAmountCents) } };
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
  async listTransactions(organizationId, scope, signal) {
    const value = record(await requestJson(`${basePath(organizationId)}/transactions?${scopeParams(scope)}&limit=100`, { signal }));
    return { items: Array.isArray(value.items) ? value.items.map(parseTransaction) : [], nextCursor: value.nextCursor === null || value.nextCursor === undefined ? null : String(value.nextCursor), coverage: (() => { const coverage = record(value.coverage); return { status: String(coverage.status ?? "unavailable"), evidence: String(coverage.evidence ?? "unverified"), reason: coverage.reason === null || coverage.reason === undefined ? null : String(coverage.reason) }; })() } satisfies AccountingTransactionPage;
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
    return { status: value.status === "partial" ? "partial" : "complete", streams: Array.isArray(value.streams) ? value.streams : [] };
  },
};

export const accountingApi: AccountingApi = api;
