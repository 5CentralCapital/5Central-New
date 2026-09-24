import type { CompanyContextEntity } from "@shared/company/context";
import type { OperationReceipt } from "@shared/company";
import type {
  AccountingOperationCommandKind,
  AccountingPayablesResponse,
  ConnectorHealthResponse,
  PeriodCloseChecklist,
  PmSettlementDetail,
  PmSettlementListResponse,
  RentalBridgePreview,
  RentalPostingPolicy,
  JobState,
} from "@shared/accounting/operations";
import type { QboCustomerLedger } from "@shared/accounting/receivables";

export type AccountingView = "overview" | "transactions" | "bills" | "banking" | "pm-settlements" | "close" | "connections";
export const ACCOUNTING_VIEWS: readonly { readonly value: AccountingView; readonly label: string }[] = [
  { value: "overview", label: "Dashboard" },
  { value: "transactions", label: "Transactions" },
  { value: "bills", label: "Bills & payments" },
  { value: "banking", label: "Banking & reconciliation" },
  { value: "pm-settlements", label: "PM settlements" },
  { value: "close", label: "Period close" },
  { value: "connections", label: "Connections" },
];
export function isAccountingView(value: unknown): value is AccountingView {
  return ACCOUNTING_VIEWS.some(view => view.value === value);
}

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
  listTransactions(organizationId: string, scope: AccountingScope, signal?: AbortSignal, cursor?: string): Promise<AccountingTransactionPage>;
  beginConnection(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  getPendingBinding(organizationId: string, legalEntityId: string, pendingId: string, signal?: AbortSignal): Promise<AccountingPendingBinding | null>;
  confirmConnection(organizationId: string, legalEntityId: string, pendingId: string, signal?: AbortSignal): Promise<void>;
  /** Queues a background refresh; the worker performs it. */
  sync(organizationId: string, scope: AccountingScope, signal?: AbortSignal): Promise<{ readonly status: "queued"; readonly jobId: string | null; readonly message: string }>;
  /** Reads the durable refresh job so the UI can wait for completion. */
  getJob?(organizationId: string, jobId: string, signal?: AbortSignal): Promise<{ readonly state: JobState }>;
  disconnect(organizationId: string, scope: AccountingScope, signal?: AbortSignal): Promise<{ readonly providerOutcome: "revoked" | "already_revoked" }>;
  health(organizationId: string, legalEntityId: string | undefined, signal?: AbortSignal): Promise<ConnectorHealthResponse>;
  closeChecklist(organizationId: string, legalEntityId: string, period: AccountingPeriod, signal?: AbortSignal): Promise<PeriodCloseChecklist>;
  postingPolicies(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<readonly RentalPostingPolicy[]>;
  pmSettlements(organizationId: string, query: { readonly legalEntityId: string; readonly states?: readonly ("draft" | "reconciled" | "exception")[]; readonly cursor?: string }, signal?: AbortSignal): Promise<PmSettlementListResponse>;
  pmSettlement(organizationId: string, legalEntityId: string, settlementId: string, signal?: AbortSignal): Promise<PmSettlementDetail>;
  bridgePreview(organizationId: string, legalEntityId: string, period: AccountingPeriod, signal?: AbortSignal): Promise<RentalBridgePreview>;
  bridgeCsvHref(organizationId: string, legalEntityId: string, period: AccountingPeriod): string;
  payables(organizationId: string, scope: AccountingScope, kind: "bills" | "payments", cursor?: string, signal?: AbortSignal): Promise<AccountingPayablesResponse>;
  command(organizationId: string, kind: AccountingOperationCommandKind, envelope: AccountingCommandEnvelope, signal?: AbortSignal): Promise<OperationReceipt>;
  /** A tenancy's QuickBooks customer ledger from the receivables mirror; null when the tenancy is not linked to a customer. */
  tenancyLedger(organizationId: string, query: { readonly tenancyId: string; readonly environment: AccountingEnvironment; readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<QboCustomerLedger | null>;
  /** Records the tenancy ↔ QuickBooks customer link in the local identity map. Nothing is written to QuickBooks. */
  linkTenancyCustomer(organizationId: string, input: { readonly scope: AccountingScope; readonly tenancyId: string; readonly customerId: string }, signal?: AbortSignal): Promise<{ readonly status: "linked" | "already_linked" }>;
}

export interface AccountingPeriod {
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface AccountingCommandEnvelope {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly scope: { readonly organizationId: string; readonly legalEntityId?: string; readonly propertyId?: string };
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
}

export interface AccountingWorkspaceEntity extends CompanyContextEntity {}

export interface AccountingWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly AccountingWorkspaceEntity[];
  readonly api?: AccountingApi;
  readonly reportsApi?: import("../reporting/types").ReportingApi;
  /** Controlled sub-view, e.g. from `section=accounting&acctView=…`. */
  readonly view?: AccountingView;
  readonly onViewChange?: (view: AccountingView) => void;
}
