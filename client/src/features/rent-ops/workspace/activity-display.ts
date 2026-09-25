import { DETAILS_UNAVAILABLE_LABEL } from "@shared/review-cases/display-labels";
import { formatLabel } from "./display";

export interface ActivityDisplayInput {
  type?: string | null;
  summary?: string | null;
  detail?: string | null;
  actor?: string | null;
  summaryKnowledge?: string | null;
  actorKnowledge?: string | null;
  typeKnowledge?: string | null;
}

export interface ActivityDisplay {
  title: string;
  body?: string;
  actor: string;
  type: string;
  typeKnown: boolean;
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

/**
 * Display text for an activity entry. Imported history can arrive without a
 * title, body, type or author; those facts are stated as not recorded rather
 * than filled in with a plausible description or actor.
 */
export function activityDisplay(event: ActivityDisplayInput): ActivityDisplay {
  // A legacy import stored placeholders ("Unknown actor") with unknown
  // knowledge; a placeholder is not a source fact.
  const summary = event.summaryKnowledge === "unknown" ? undefined : present(event.summary);
  const detail = present(event.detail);
  const actor = event.actorKnowledge === "unknown" ? undefined : present(event.actor);
  const type = event.typeKnowledge === "unknown" ? undefined : present(event.type);
  return {
    title: summary ?? (detail ? "No title recorded" : DETAILS_UNAVAILABLE_LABEL),
    ...(detail ? { body: detail } : {}),
    actor: actor ? `By ${actor}` : "Author not recorded",
    type: type ? formatLabel(type) : "Type not recorded",
    typeKnown: Boolean(type),
  };
}
