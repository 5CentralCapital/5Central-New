import type { JobHandlerDefinition, PeriodicJobDefinition } from "../jobs/worker-runtime";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { REVIEW_DETECTION_JOB_TOPIC, reviewDetectionJobHandler } from "./job";

export const REVIEW_FINANCIAL_CORRECTION_TOPIC = "review_case.financial_correction" as const;

/**
 * Worker topics for review cases: scheduled detection per organization, and the
 * acknowledgement of financial corrections routed to Accounting. The routed
 * correction is never posted by the worker; the case stays proposed until the
 * accounting fix is made and detection verifies it.
 */
export function createReviewJobHandlers(options: { readonly executor: RentOpsQueryExecutor }): Record<string, JobHandlerDefinition> {
  const detect = reviewDetectionJobHandler({ executor: options.executor });
  return {
    [REVIEW_DETECTION_JOB_TOPIC]: { leaseMs: 5 * 60_000, handler: async ({ job }) => detect({ organizationId: job.organizationId, payload: job.payload }) },
    [REVIEW_FINANCIAL_CORRECTION_TOPIC]: {
      leaseMs: 60_000,
      handler: async ({ job, executor }) => {
        const caseId = typeof job.payload.caseId === "string" ? job.payload.caseId : null;
        if (!caseId || !job.organizationId) return { acknowledged: false, reason: "missing_case" };
        const found = await executor.query<{ state: string }>("SELECT state FROM company_review_cases WHERE organization_id=$1 AND id=$2", [job.organizationId, caseId]);
        return { acknowledged: true, caseId, caseState: found.rows[0]?.state ?? "missing", owner: "accounting" };
      },
    },
  };
}

/** Daily detection per organization; the bucketed job key keeps scheduling idempotent across workers. */
export function reviewPeriodicJobs(options: { readonly executor: RentOpsQueryExecutor; readonly bucketMs?: number }): PeriodicJobDefinition[] {
  return [{
    topic: REVIEW_DETECTION_JOB_TOPIC,
    keyPrefix: REVIEW_DETECTION_JOB_TOPIC,
    bucketMs: options.bucketMs ?? 24 * 3_600_000,
    async enumerate() {
      const organizations = await options.executor.query<{ id: string }>("SELECT id FROM company_organizations WHERE archived_at IS NULL ORDER BY id LIMIT 100");
      return organizations.rows.map(row => ({ keyPart: row.id, organizationId: row.id, payload: { organizationId: row.id }, priority: 200, maxAttempts: 3 }));
    },
  }];
}
