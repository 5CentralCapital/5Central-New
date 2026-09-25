import type { CommandEnvelope, OperationReceipt } from "@shared/company";
import type { CompanyContextEntity } from "@shared/company/context";
import type {
  InvestorAccount,
  InvestorCommandKind,
  InvestorContactListResponse,
  InvestorDetail,
  InvestorDocumentListResponse,
  InvestorFinancialSourceResponse,
  InvestorListResponse,
  InvestorMonthlyPaymentResponse,
  InvestorPaymentLogQuery,
} from "@shared/investors";
import type { InvestorDebtMaturityResponse, InvestorInstrumentFinancials, InvestorPaymentCalendarResponse } from "@shared/investors/reports";

export type { InvestorDebtMaturityResponse, InvestorInstrumentFinancials, InvestorPaymentCalendarResponse };

export type InvestorWorkspaceEntity = CompanyContextEntity;
export type { InvestorAccount, InvestorDetail, InvestorCommandKind };

export const INVESTOR_TABS = ["overview", "payments", "capital", "debt", "contracts", "activity"] as const;
export type InvestorTab = (typeof INVESTOR_TABS)[number];
export const INVESTOR_TAB_LABELS: Readonly<Record<InvestorTab, string>> = { overview: "Overview", payments: "Payment calendar", capital: "Contributions & distributions", debt: "Debt & maturities", contracts: "Agreements", activity: "Activity" };

export interface InvestorListFilters {
  readonly search?: string;
  readonly status?: "active" | "archived";
}

export interface InvestorsApi {
  listInvestors(organizationId: string, filters?: InvestorListFilters, signal?: AbortSignal): Promise<InvestorListResponse>;
  getInvestor(organizationId: string, accountId: string, legalEntityId?: string, signal?: AbortSignal): Promise<InvestorDetail>;
  listContacts(organizationId: string, search?: string, signal?: AbortSignal): Promise<InvestorContactListResponse>;
  listDocuments(organizationId: string, legalEntityId: string, propertyIds?: readonly string[], search?: string, signal?: AbortSignal): Promise<InvestorDocumentListResponse>;
  listFinancialSources(organizationId: string, legalEntityId: string, from?: string, through?: string, cursor?: string, signal?: AbortSignal): Promise<InvestorFinancialSourceResponse>;
  listMonthlyPayments(organizationId: string, query: Omit<InvestorPaymentLogQuery, "scope"> & { legalEntityId: string; propertyId?: string }, signal?: AbortSignal): Promise<InvestorMonthlyPaymentResponse>;
  sendCommand<TPayload = unknown>(organizationId: string, kind: InvestorCommandKind, envelope: CommandEnvelope<TPayload>): Promise<OperationReceipt>;
  getInstrumentFinancials?(organizationId: string, instrumentId: string, query: { legalEntityId: string; asOf?: string }, signal?: AbortSignal): Promise<InvestorInstrumentFinancials>;
  getPaymentCalendar?(organizationId: string, query: { legalEntityId: string; fromMonth: string; throughMonth: string; accountId?: string; cursor?: string }, signal?: AbortSignal): Promise<InvestorPaymentCalendarResponse>;
  getDebtMaturities?(organizationId: string, query: { legalEntityId?: string }, signal?: AbortSignal): Promise<InvestorDebtMaturityResponse>;
}

export interface InvestorWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly InvestorWorkspaceEntity[];
  readonly api?: InvestorsApi;
  readonly initialAccountId?: string;
  readonly activeTab?: InvestorTab;
  readonly onTabChange?: (tab: InvestorTab) => void;
  readonly onNavigate?: (accountId?: string) => void;
}
