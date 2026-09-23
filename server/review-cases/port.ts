import type { CompanyScope, OperationReceipt } from "../../shared/company";
import type { ReviewCaseCommandKind, ReviewCaseDetail, ReviewCaseListQuery, ReviewCaseListResponse, ReviewInventory } from "../../shared/review-cases";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { StorageReadAdapter } from "../rent-ops/storage";
import { executeReviewCaseCommand, type ReviewCaseCommandAccess } from "./commands";
import { ReviewCaseReadService } from "./read";

export interface ReviewCasePort {
  list(principal: AuthenticatedPrincipal, query: ReviewCaseListQuery): Promise<ReviewCaseListResponse>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; caseId: string }): Promise<ReviewCaseDetail>;
  /** Release-gate helper: `summarizeReviewInventory(org)`. */
  inventory(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; limit?: number }): Promise<ReviewInventory>;
  execute(kind: ReviewCaseCommandKind, envelope: unknown, access: ReviewCaseCommandAccess): Promise<OperationReceipt>;
}

export interface ReviewCasePortOptions {
  /** Verified company document storage; operational fixes re-hash their evidence bytes. */
  readonly documentStorage?: StorageReadAdapter;
}

/** One read/command implementation shared by the browser, Codex and scripts. */
export function createReviewCasePort(executor: RentOpsQueryExecutor, options: ReviewCasePortOptions = {}): ReviewCasePort {
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: ReviewCaseReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Review case reads require transaction support");
    return executor.transaction(async transaction => {
      // Reload grants inside the snapshot so a revoked grant cannot keep reading.
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(new ReviewCaseReadService(transaction), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, input) => read(principal, (service, fresh) => service.get(fresh, input)),
    inventory: (principal, input) => read(principal, (service, fresh) => service.inventory(fresh, input)),
    execute: (kind, envelope, access) => executeReviewCaseCommand(executor, kind, envelope, access, { documentStorage: options.documentStorage }),
  };
}

/** Release-gate helper for callers that already hold an authenticated principal. */
export function summarizeReviewInventory(port: ReviewCasePort, principal: AuthenticatedPrincipal, organizationId: string, limit?: number): Promise<ReviewInventory> {
  return port.inventory(principal, { scope: { organizationId } as CompanyScope, limit });
}
