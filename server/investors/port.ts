import type { OperationReceipt, CompanyScope } from "../../shared/company";
import type {
  InvestorCommandKind,
  InvestorContactListResponse,
  InvestorDetail,
  InvestorDocumentListResponse,
  InvestorFinancialSourceResponse,
  InvestorListQuery,
  InvestorListResponse,
  InvestorMonthlyPaymentResponse,
  InvestorPaymentLogQuery,
} from "../../shared/investors";
import type { FinancialSourceReadPort } from "../../shared/accounting/source";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal, type TransportAttestation } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { executeInvestorCommand, type InvestorCommandExecutionOptions } from "./commands";
import { InvestorReadService } from "./service";
import type { InvestorSourceResolver } from "./source";

export interface InvestorPort {
  list(principal: AuthenticatedPrincipal, query: InvestorListQuery): Promise<InvestorListResponse>;
  listContacts(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; search?: string }): Promise<InvestorContactListResponse>;
  listDocuments(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyIds?: readonly string[]; search?: string }): Promise<InvestorDocumentListResponse>;
  listFinancialSources(principal: AuthenticatedPrincipal, input: { scope: CompanyScope & { legalEntityId: string }; from?: string; through?: string; limit?: number; cursor?: string }): Promise<InvestorFinancialSourceResponse>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; accountId: string }): Promise<InvestorDetail>;
  monthlyPayments(principal: AuthenticatedPrincipal, query: InvestorPaymentLogQuery): Promise<InvestorMonthlyPaymentResponse>;
  execute(kind: InvestorCommandKind, envelope: unknown, access: InvestorCommandExecutionOptions): Promise<OperationReceipt>;
}

export interface CreateInvestorPortOptions {
  readonly sourceRead?: FinancialSourceReadPort;
  /** Build the financial read port against the same transaction as the company snapshot. */
  readonly sourceReadFactory?: (executor: RentOpsQueryExecutor) => FinancialSourceReadPort;
  readonly sourceResolver?: InvestorSourceResolver;
  readonly sourceResolverFactory?: (executor: RentOpsQueryExecutor) => InvestorSourceResolver;
}

/** One read/command implementation is shared by the HTTP and Codex adapters. */
export function createInvestorPort(executor: RentOpsQueryExecutor, options: CreateInvestorPortOptions = {}): InvestorPort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: InvestorReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Investor reads require transaction support");
    return executor.transaction(async transaction => {
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      const sourceRead = options.sourceReadFactory?.(transaction) ?? options.sourceRead;
      return work(new InvestorReadService(transaction, { sourceRead }), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    listContacts: (principal, input) => read(principal, (service, fresh) => service.listContacts(fresh, input)),
    listDocuments: (principal, input) => read(principal, (service, fresh) => service.listDocuments(fresh, input)),
    listFinancialSources: (principal, input) => read(principal, (service, fresh) => service.listFinancialSources(fresh, input)),
    get: (principal, input) => read(principal, (service, fresh) => service.get(fresh, input)),
    monthlyPayments: (principal, query) => read(principal, (service, fresh) => service.monthlyPayments(fresh, query)),
    execute: (kind, envelope, access) => executeInvestorCommand(executor, kind, envelope, {
      ...access,
      sourceResolver: options.sourceResolver ?? access.sourceResolver,
      sourceResolverFactory: options.sourceResolverFactory ?? access.sourceResolverFactory,
    }),
  };
}

export type { AuthenticatedPrincipal, TransportAttestation };
