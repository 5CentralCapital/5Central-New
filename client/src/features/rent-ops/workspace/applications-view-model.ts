import type { AdminApplicationView } from "../types";

/**
 * Presentation-only grouping for the applications register. Stored statuses
 * and the shared transition contract are unchanged; the groups only decide
 * which rows a segmented control shows and which tone a status pill uses.
 */
export type ApplicationStatusGroup = "all" | "needs_action" | "in_progress" | "complete";

export const APPLICATION_STATUS_GROUPS: ReadonlyArray<readonly [ApplicationStatusGroup, string]> = [
  ["all", "All"],
  ["needs_action", "Needs action"],
  ["in_progress", "In progress"],
  ["complete", "Complete"],
];

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Needs action: the manager decides next (a submitted or imported-complete
 * application, a review in progress, or an approval not yet converted).
 * In progress: waiting on the applicant. Complete: decided or closed.
 * Unknown statuses appear only under All.
 */
export function applicationStatusGroup(application: Pick<AdminApplicationView, "status" | "convertedTenancyId">): Exclude<ApplicationStatusGroup, "all"> | undefined {
  const status = normalized(application.status);
  if (status === "approved") return application.convertedTenancyId ? "complete" : "needs_action";
  if (["submitted", "under_review", "complete"].includes(status)) return "needs_action";
  if (["draft", "in_progress", "awaiting_payment", "missing_information"].includes(status)) return "in_progress";
  if (["declined", "withdrawn", "converted"].includes(status)) return "complete";
  return undefined;
}

export function filterApplicationsByGroup<T extends Pick<AdminApplicationView, "status" | "convertedTenancyId">>(applications: readonly T[], group: ApplicationStatusGroup): T[] {
  return group === "all" ? [...applications] : applications.filter((application) => applicationStatusGroup(application) === group);
}

export function applicationGroupCounts(applications: readonly Pick<AdminApplicationView, "status" | "convertedTenancyId">[]): Record<ApplicationStatusGroup, number> {
  const counts: Record<ApplicationStatusGroup, number> = { all: applications.length, needs_action: 0, in_progress: 0, complete: 0 };
  for (const application of applications) {
    const group = applicationStatusGroup(application);
    if (group) counts[group] += 1;
  }
  return counts;
}

/** Pill tone for a stored status; uncertain or unknown statuses stay neutral. */
export function applicationStatusTone(status: unknown, knowledge?: string): "success" | "warning" | "error" | "unknown" | undefined {
  if (["unknown", "ambiguous", "inferred"].includes(normalized(knowledge))) return "unknown";
  const value = normalized(status);
  if (value === "approved" || value === "converted") return "success";
  if (value === "declined") return "error";
  if (value === "missing_information") return "warning";
  if (value === "withdrawn" || !value) return "unknown";
  return undefined;
}

/** Keep the applications register scoped to every property chosen in the global filter. */
export function applicationsInPropertySelection<T extends Pick<AdminApplicationView, "propertyId">>(applications: readonly T[], propertyIds: readonly string[] | undefined): T[] {
  if (!propertyIds?.length) return [...applications];
  const selected = new Set(propertyIds);
  return applications.filter((application) => !!application.propertyId && selected.has(application.propertyId));
}
