import { ProjectReadService } from '../projects/service';
import { executeProjectCommand } from '../projects/commands';
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from './authorization';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import type { CompanyProjectPort } from './routes';

/** One domain adapter is shared by web and Codex. Detail reads use a consistent snapshot. */
export function createCompanyProjectPort(executor: RentOpsQueryExecutor): CompanyProjectPort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: ProjectReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error('Company reads require transaction support');
    return executor.transaction(async transaction => {
      const fresh = await loadAuthenticatedPrincipal(transaction, {
        actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role,
      });
      return work(new ProjectReadService(transaction), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, query) => read(principal, (service, fresh) => service.get(fresh, query)),
    execute: (kind, envelope, access) => executeProjectCommand(executor, kind, envelope, access),
  };
}
