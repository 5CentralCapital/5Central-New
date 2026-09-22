import type { CompanyContextEntity } from "@shared/company/context";

export type AccountingEnvironment = "sandbox" | "production";
export type AccountingMirrorKind = "accounts" | "vendors" | "customers" | "employees";

export interface AccountingScope {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: AccountingEnvironment;
  readonly realmId: string;
}

export interface AccountingConnection {
  readonly scope: AccountingScope;
  readonly name: string;
  readonly status: "connected" | "ready" | "needs_reconnect";
  readonly version: number;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string | null;
  readonly refreshTokenHardExpiresAt: string | null;
  readonly updatedAt: string;
}

export interface AccountingPendingBinding {
  readonly pendingId: string;
  readonly scope: AccountingScope;
  readonly providerCompanyId: string;
  readonly providerCompanyName: string | null;
  readonly providerLegalName: string | null;
  readonly homeCurrency: string | null;
  readonly expiresAt: string;
}

export interface AccountingMirror {
  readonly kind: AccountingMirrorKind;
  readonly objectType: "Account" | "Vendor" | "Customer" | "Employee";
  readonly providerObjectId: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly version: string;
  readonly providerUpdatedAt: string | null;
}

export interface AccountingTransaction {
  readonly source: { readonly objectType: string; readonly objectId: string; readonly lineId: string | null; readonly version: string };
  readonly amountCents: string;
  readonly currency: string;
  readonly transactionType: string;
  readonly description: string | null;
  readonly postingState: string;
  readonly postedOn: string | null;
  readonly settlement: { readonly state: string; readonly settledOn: string | null; readonly settledAmountCents: string | null };
}

export interface AccountingTransactionPage {
  readonly items: readonly AccountingTransaction[];
  readonly nextCursor: string | null;
  readonly coverage: { readonly status: string; readonly evidence: string; readonly reason: string | null };
}

export interface AccountingApi {
  getConfiguration(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<{ readonly configured: boolean; readonly environment: AccountingEnvironment | null }>;
  listConnections(organizationId: string, legalEntityId: string, environment: AccountingEnvironment, signal?: AbortSignal): Promise<readonly AccountingConnection[]>;
  listMirrors(organizationId: string, scope: AccountingScope, kind: AccountingMirrorKind, signal?: AbortSignal): Promise<readonly AccountingMirror[]>;
  listTransactions(organizationId: string, scope: AccountingScope, signal?: AbortSignal): Promise<AccountingTransactionPage>;
  beginConnection(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  getPendingBinding(organizationId: string, legalEntityId: string, pendingId: string, signal?: AbortSignal): Promise<AccountingPendingBinding | null>;
  confirmConnection(organizationId: string, legalEntityId: string, pendingId: string, signal?: AbortSignal): Promise<void>;
  sync(organizationId: string, scope: AccountingScope, signal?: AbortSignal): Promise<{ readonly status: "complete" | "partial"; readonly streams: readonly unknown[] }>;
  disconnect(organizationId: string, scope: AccountingScope, signal?: AbortSignal): Promise<{ readonly providerOutcome: "revoked" | "already_revoked" }>;
}

export interface AccountingWorkspaceEntity extends CompanyContextEntity {}

export interface AccountingWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly AccountingWorkspaceEntity[];
  readonly api?: AccountingApi;
}
