import type { CompanyScope, OperationReceipt } from "../../shared/company";
import type { WorkOrderCommandKind, WorkOrderDetail, WorkOrderListQuery, WorkOrderListResponse, WorkOrderTenantOptionsResponse } from "../../shared/work-orders";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { executeWorkOrderCommand, type WorkOrderCommandExecutionOptions } from "./commands";
import { WorkOrderReadService } from "./service";

export interface WorkOrderPort {
  list(principal: AuthenticatedPrincipal, query: WorkOrderListQuery): Promise<WorkOrderListResponse>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; workOrderId: string }): Promise<WorkOrderDetail>;
  tenantOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyId: string }): Promise<WorkOrderTenantOptionsResponse>;
  execute(kind: WorkOrderCommandKind, envelope: unknown, access: WorkOrderCommandExecutionOptions): Promise<OperationReceipt>;
}

/** One read/command implementation shared by the HTTP and Codex adapters. */
export function createWorkOrderPort(executor: RentOpsQueryExecutor): WorkOrderPort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: WorkOrderReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Work order reads require transaction support");
    return executor.transaction(async transaction => {
      // Reload grants inside the snapshot so a revoked grant cannot keep reading.
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(new WorkOrderReadService(transaction), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, input) => read(principal, (service, fresh) => service.get(fresh, input)),
    tenantOptions: (principal, input) => read(principal, (service, fresh) => service.tenantOptions(fresh, input)),
    execute: (kind, envelope, access) => executeWorkOrderCommand(executor, kind, envelope, access),
  };
}
