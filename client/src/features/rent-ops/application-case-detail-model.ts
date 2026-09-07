import type { AdminApplicationDetailView, AdminApplicationHistoryCaseView, AdminDocumentView } from "./types";

export type ApplicationCaseSectionKey = "overview" | "household" | "requirements" | "documents";
export type ApplicationCaseSectionState = "ready" | "empty" | "unknown";
export type ApplicationHistorySectionKey = "overview" | "interests" | "participants" | "requirements" | "answers" | "documents" | "activities" | "unknownRestricted";
export type ApplicationHistorySectionState = "full" | "empty" | "unknown" | "restricted";

const REVIEW_KNOWLEDGE = new Set(["unknown", "ambiguous", "inferred"]);

/** Keep missing facts distinct from facts that need operator verification. */
export function applicationCaseFact(value: unknown, knowledge?: string): string {
  if (knowledge && REVIEW_KNOWLEDGE.has(knowledge)) return "Needs review";
  if (value === undefined || value === null || value === "") return "Unknown";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && !Number.isFinite(value)) return "Unknown";
  return String(value);
}

export function applicationCaseDisplayName(application: Pick<AdminApplicationDetailView, "firstName" | "lastName">): string {
  const name = [application.firstName, application.lastName].filter((part): part is string => Boolean(part?.trim())).join(" ");
  return name || "Applicant needs review";
}

export function applicationCaseSectionState(detail: AdminApplicationDetailView | undefined, section: ApplicationCaseSectionKey): ApplicationCaseSectionState {
  if (!detail) return "unknown";
  if (section === "overview") {
    const hasOverviewFact = [detail.firstName, detail.lastName, detail.email, detail.phone, detail.status, detail.submittedOn, detail.preferences, detail.householdSummary, detail.employment, detail.voucher]
      .some((value) => value !== undefined && value !== null && value !== "");
    return hasOverviewFact ? "ready" : "unknown";
  }
  const values = detail[section === "household" ? "householdMembers" : section] as unknown[];
  return values.length ? "ready" : "empty";
}

/** Historical sections distinguish no rows from rows intentionally withheld. */
export function applicationHistorySectionState(history: AdminApplicationHistoryCaseView | undefined, section: ApplicationHistorySectionKey): ApplicationHistorySectionState {
  if (!history) return "unknown";
  if (section === "overview") return history.application || history.prospect ? "full" : "unknown";
  if (section === "unknownRestricted") {
    const summary = history.unknownRestricted;
    const hasRestricted = summary.restrictedAnswerCount > 0 || summary.unmappedAnswerCount > 0 || summary.metadataOnlyDocumentCount > 0 || summary.unavailableDocumentCount > 0 || summary.missingAnswerApplications > 0;
    return hasRestricted ? "restricted" : "full";
  }
  const collection = section === "participants" ? history.participants
    : section === "requirements" ? history.requirements
      : section === "answers" ? history.answers
        : section === "documents" ? history.documents
          : section === "activities" ? history.activities
            : history.interests;
  if (collection.length > 0) return "full";
  if (section === "answers" && history.unknownRestricted.restrictedAnswerCount > 0) return "restricted";
  if (section === "documents" && (history.unknownRestricted.metadataOnlyDocumentCount > 0 || history.unknownRestricted.unavailableDocumentCount > 0)) return "restricted";
  if (section === "activities" && history.unknownRestricted.unlinkedActivityCount > 0) return "unknown";
  if (section === "interests" && history.unknownRestricted.unlinkedInterestCount > 0) return "unknown";
  return "empty";
}

/** A document is downloadable only through the authenticated ID route. */
export function applicationDocumentDownloadable(document: Pick<AdminDocumentView, "id" | "state" | "availability" | "downloadAvailable">): boolean {
  return Boolean(document.downloadAvailable && document.id && document.state === "verified" && document.availability === "verified");
}

export function restoreApplicationCaseFocus(trigger: { focus: () => void } | null | undefined): void {
  trigger?.focus();
}
