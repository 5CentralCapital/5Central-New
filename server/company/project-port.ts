import { ProjectReadService } from '../projects/service';
import { executeProjectCommand } from '../projects/commands';
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from './authorization';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import type { CompanyProjectPort } from './routes';
import { ProjectExecutionReadService } from '../projects/execution';
import { ProjectExecutionStore } from '../projects/execution-store';
import { executeProjectExecutionCommand, type ProjectExecutionFinancePorts } from '../projects/execution-commands';
import { executeProjectDealCostCommand, ProjectDealCostReadService, type ProjectDealCostFinancePorts } from '../projects/deal-costs';
import type { ProjectDealCostCommandKind } from '../../shared/projects/deal-costs';
import { unavailableProjectFinanceReadPort, type ProjectFinanceReadPort } from '../../shared/projects';
import { companyScopeSchema, isoDateSchema } from '../../shared/company';

/** One domain adapter is shared by web and Codex. Detail reads use a consistent snapshot. */
export function createCompanyProjectPort(executor: RentOpsQueryExecutor, options: {
  financeFactory?: (transaction: RentOpsQueryExecutor) => ProjectFinanceReadPort;
  commandFinanceFactory?: (transaction: RentOpsQueryExecutor) => ProjectExecutionFinancePorts;
} = {}): CompanyProjectPort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: ProjectReadService, fresh: AuthenticatedPrincipal, transaction: RentOpsQueryExecutor, finance: ProjectFinanceReadPort) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error('Company reads require transaction support');
    return executor.transaction(async transaction => {
      const fresh = await loadAuthenticatedPrincipal(transaction, {
        actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role,
      });
      const finance = options.financeFactory?.(transaction) ?? unavailableProjectFinanceReadPort;
      return work(new ProjectReadService(transaction, finance), fresh, transaction, finance);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, query) => read(principal, (service, fresh) => service.get(fresh, query)),
    execute: (kind, envelope, access) => executeProjectCommand(executor, kind, envelope, access),
    getExecution: (principal, query) => read(principal, async (service, fresh, transaction, finance) => {
      const project = await service.get(fresh, query);
      const scope = companyScopeSchema.parse({ organizationId: project.organizationId, legalEntityId: project.legalEntityId, propertyId: project.propertyId });
      return new ProjectExecutionReadService(new ProjectExecutionStore(transaction), finance).get(fresh, {
        scope, projectId: project.id, ...(query.asOf ? { asOf: isoDateSchema.parse(query.asOf) } : {}),
      });
    }),
    executeExecution: (kind, envelope, access) => executeProjectExecutionCommand(executor, kind, envelope, { ...access, financeFactory: options.commandFinanceFactory }),
    getDealCosts: (principal, query) => read(principal, async (_service, fresh, transaction, finance) => new ProjectDealCostReadService(transaction, finance, options.commandFinanceFactory?.(transaction)).get(fresh, query)),
    executeDealCost: (kind: ProjectDealCostCommandKind, envelope, access) => executeProjectDealCostCommand(executor, kind, envelope, {
      ...access,
      financeFactory: options.commandFinanceFactory as ((transaction: RentOpsQueryExecutor) => ProjectDealCostFinancePorts) | undefined,
    }),
  };
}
