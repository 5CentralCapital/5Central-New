import { z } from "zod";
import { isoDateSchema, organizationIdSchema } from "../../shared/company";
import type { ReviewDetectionSummary } from "../../shared/review-cases";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { REVIEW_DETECTOR_ACTOR, runReviewDetection } from "./detection";

export const REVIEW_DETECTION_JOB_TOPIC = "review.detect" as const;

const jobPayloadSchema = z.object({
  organizationId: organizationIdSchema.optional(),
  asOf: isoDateSchema.optional(),
}).passthrough();

/** Minimal job shape; the worker supplies the queued row. */
export interface ReviewDetectionJob {
  readonly organizationId?: string | null;
  readonly payload: Record<string, unknown>;
}

export interface ReviewDetectionJobResult extends Record<string, unknown> {
  readonly summary: ReviewDetectionSummary;
}

/**
 * Handler factory for the `review.detect` job topic. Detection is idempotent:
 * a retried job reconciles to the same case state. The job runs as the
 * server-internal detector actor; it performs no user-requested mutation.
 */
export function reviewDetectionJobHandler(options: { readonly executor: RentOpsQueryExecutor; readonly actorId?: string }) {
  return async function handleReviewDetectionJob(job: ReviewDetectionJob): Promise<ReviewDetectionJobResult> {
    const payload = jobPayloadSchema.parse(job.payload ?? {});
    const organizationId = organizationIdSchema.parse(job.organizationId ?? payload.organizationId);
    if (job.organizationId && payload.organizationId && job.organizationId !== payload.organizationId) {
      throw new Error("review_detection_job_organization_mismatch");
    }
    const summary = await runReviewDetection(options.executor, organizationId, { actorId: options.actorId ?? REVIEW_DETECTOR_ACTOR, asOf: payload.asOf });
    return { summary };
  };
}

export const reviewDetectionJob = { topic: REVIEW_DETECTION_JOB_TOPIC, handler: reviewDetectionJobHandler } as const;
