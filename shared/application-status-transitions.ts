import type { ApplicationStatus } from "./rent-ops-contracts";

/**
 * Public/admin status changes are deliberately narrower than the set of
 * persisted statuses. Conversion is a separate atomic action and therefore
 * is not reachable through the generic status endpoint.
 */
export const APPLICATION_STATUS_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  // Imported progress states require an explicit review step before approval.
  complete: ["under_review", "missing_information", "withdrawn"],
  in_progress: ["submitted", "missing_information", "withdrawn"],
  awaiting_payment: ["submitted", "missing_information", "withdrawn"],
  draft: ["submitted", "withdrawn"],
  submitted: ["under_review", "missing_information", "approved", "declined", "withdrawn"],
  missing_information: ["submitted", "under_review", "approved", "declined", "withdrawn"],
  under_review: ["approved", "missing_information", "declined", "withdrawn"],
  approved: ["withdrawn"],
  declined: [],
  withdrawn: [],
  converted: [],
};
