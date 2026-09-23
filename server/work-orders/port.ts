import type { CompanyScope, OperationReceipt } from "../../shared/company";
import type {
  WorkOrderCommandKind,
  WorkOrderDetail,
  WorkOrderDocumentOptionsResponse,
  WorkOrderListQuery,
  WorkOrderListResponse,
  WorkOrderReportPage,
  WorkOrderReportQuery,
  WorkOrderTenantOptionsResponse,
  WorkOrderVendorOptionsResponse,
} from "../../shared/work-orders";
import type { CostSourceLinePage, CostSourceLineQuery } from "../../shared/projects/source-lines";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ProjectExecutionFinancePorts } from "../projects/execution-commands";
import { searchCostSourceLines } from "../projects/source-lines";
import { executeWorkOrderCommand, type WorkOrderCommandExecutionOptions } from "./commands";
import { listWorkOrdersForReporting, type WorkOrderReportingReadPort } from "./reporting";
import { WorkOrderReadService } from "./service";

export interface WorkOrderPort extends WorkOrderReportingReadPort {
  list(principal: AuthenticatedPrincipal, query: WorkOrderListQuery): Promise<WorkOrderListResponse>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; workOrderId: string }): Promise<WorkOrderDetail>;
  tenantOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyId: string }): Promise<WorkOrderTenantOptionsResponse>;
  vendorOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope }): Promise<WorkOrderVendorOptionsResponse>;
  documentOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyId: string; search?: string }): Promise<WorkOrderDocumentOptionsResponse>;
  /** Posted QBO bill lines with their unallocated balance, for linking actual cost. */
  costSourceLines(principal: AuthenticatedPrincipal, query: CostSourceLineQuery): Promise<CostSourceLinePage>;
  execute(kind: WorkOrderCommandKind, envelope: unknown, access: WorkOrderCommandExecutionOptions): Promise<OperationReceipt>;
}

export interface CreateWorkOrderPortOptions {
  /** Build the QBO mirror ports inside the command transaction (needed for cost links). */
  readonly financeFactory?: (executor: RentOpsQueryExecutor) => ProjectExecutionFinancePorts;
  readonly today?: () => string;
}

/** One read/command implementation shared by the HTTP and Codex adapters and the reporting engine. */
export function createWorkOrderPort(executor: RentOpsQueryExecutor, options: CreateWorkOrderPortOptions = {}): WorkOrderPort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: WorkOrderReadService, fresh: AuthenticatedPrincipal, transaction: RentOpsQueryExecutor) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Work order reads require transaction support");
    return executor.transaction(async transaction => {
      // Reload grants inside the snapshot so a revoked grant cannot keep reading.
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(new WorkOrderReadService(transaction, options.today), fresh, transaction);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, input) => read(principal, (service, fresh) => service.get(fresh, input)),
    tenantOptions: (principal, input) => read(principal, (service, fresh) => service.tenantOptions(fresh, input)),
    vendorOptions: (principal, input) => read(principal, (service, fresh) => service.vendorOptions(fresh, input)),
    documentOptions: (principal, input) => read(principal, (service, fresh) => service.documentOptions(fresh, input)),
    costSourceLines: (principal, query) => read(principal, (_service, fresh, transaction) => searchCostSourceLines(transaction, fresh, query)),
    listForReporting: (principal, query) => read(principal, (_service, fresh, transaction) => listWorkOrdersForReporting(transaction, fresh, query, options.today)),
    execute: (kind, envelope, access) => executeWorkOrderCommand(executor, kind, envelope, { ...access, financeFactory: access.financeFactory ?? options.financeFactory }),
  };
}
