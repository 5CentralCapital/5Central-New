import {
  REVIEW_CASE_STATE_LABELS,
  REVIEW_CAUSE_FAMILY_LABELS,
  REVIEW_MATERIALITY_LABELS,
  REVIEW_MATERIALITY_RANK,
  REVIEW_CAUSE_FAMILIES,
  UNKNOWN_AMOUNT_LABEL,
  type ReviewAffectedRecord,
  type ReviewCaseCommandKind,
  type ReviewCaseState,
  type ReviewCaseSummary,
  type ReviewCauseFamily,
  type ReviewEvidence,
  type ReviewMateriality,
} from "@shared/review-cases";

/** Exact money from signed cents text; unknown is "Unknown", never $0.00. */
export function formatImpact(cents: string | null | undefined, currency: string | null | undefined = "USD"): string {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(cents)) return UNKNOWN_AMOUNT_LABEL;
  const value = BigInt(cents);
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = (absolute / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  const symbol = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${whole}.${fraction}`;
}

/**
 * Sum known impacts. A total containing any unknown amount, or summed from a
 * truncated page of cases, is labeled incomplete: it is a known subtotal, not
 * a total.
 */
export function impactTotal(items: readonly Pick<ReviewCaseSummary, "impactCents" | "impactCurrency">[], truncated = false): { label: string; complete: boolean; knownCount: number; unknownCount: number } {
  let total = BigInt(0);
  let known = 0;
  let unknown = 0;
  const currencies = new Set<string>();
  for (const item of items) {
    if (item.impactCents === null) { unknown += 1; continue; }
    known += 1; total += BigInt(item.impactCents); currencies.add(item.impactCurrency ?? "USD");
  }
  if (currencies.size > 1) return { label: "Mixed currencies", complete: false, knownCount: known, unknownCount: unknown };
  if (known === 0) return { label: UNKNOWN_AMOUNT_LABEL, complete: false, knownCount: 0, unknownCount: unknown };
  const amount = formatImpact(total.toString(), Array.from(currencies)[0] ?? "USD");
  return unknown || truncated ? { label: `${amount} known · incomplete`, complete: false, knownCount: known, unknownCount: unknown } : { label: amount, complete: true, knownCount: known, unknownCount: 0 };
}

export function ageLabel(since: string, now: Date = new Date()): string {
  const start = new Date(since);
  if (Number.isNaN(start.getTime())) return "—";
  const days = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  return `${months} months`;
}

export function stateLabel(state: ReviewCaseState): string { return REVIEW_CASE_STATE_LABELS[state]; }
export function materialityLabel(materiality: ReviewMateriality): string { return REVIEW_MATERIALITY_LABELS[materiality]; }
export function familyLabel(family: ReviewCauseFamily): string { return REVIEW_CAUSE_FAMILY_LABELS[family]; }

export function stateClass(state: ReviewCaseState): string {
  switch (state) {
    case "verified": return "rm-status rm-status--success";
    case "applied": return "rm-status rc-status--applied";
    case "blocked": return "rm-status rm-status--error";
    case "proposed": return "rm-status rm-status--warning";
    case "researching": return "rm-status rc-status--active";
    default: return "rm-status rm-status--unknown";
  }
}

export function materialityClass(materiality: ReviewMateriality): string {
  return materiality === "high" ? "rc-materiality rc-materiality--high" : materiality === "medium" ? "rc-materiality rc-materiality--medium" : "rc-materiality";
}

export interface ReviewQueueGroup {
  readonly key: string;
  readonly family: ReviewCauseFamily;
  readonly materiality: ReviewMateriality;
  readonly items: readonly ReviewCaseSummary[];
  readonly caseCount: number;
  readonly affectedCount: number;
}

/** One queue grouped by materiality (most material first), then cause family. */
export function groupQueue(items: readonly ReviewCaseSummary[], counts?: readonly { causeFamily: ReviewCauseFamily; materiality: ReviewMateriality; caseCount: number; affectedCount: number }[]): ReviewQueueGroup[] {
  const groups = new Map<string, { family: ReviewCauseFamily; materiality: ReviewMateriality; items: ReviewCaseSummary[] }>();
  for (const item of items) {
    const key = `${item.materiality}|${item.causeFamily}`;
    const group = groups.get(key) ?? { family: item.causeFamily, materiality: item.materiality, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, group]) => {
    const count = counts?.find(value => value.causeFamily === group.family && value.materiality === group.materiality);
    return {
      key, family: group.family, materiality: group.materiality, items: group.items,
      caseCount: count?.caseCount ?? group.items.length,
      affectedCount: count?.affectedCount ?? group.items.reduce((sum, item) => sum + item.affectedCount, 0),
    };
  }).sort((left, right) => REVIEW_MATERIALITY_RANK[left.materiality] - REVIEW_MATERIALITY_RANK[right.materiality]
    || REVIEW_CAUSE_FAMILIES.indexOf(left.family) - REVIEW_CAUSE_FAMILIES.indexOf(right.family));
}

export const COMMAND_LABELS: Readonly<Record<ReviewCaseCommandKind, string>> = Object.freeze({
  "review_case.detect": "Check Again",
  "review_case.start_research": "Start Research",
  "review_case.add_evidence": "Add Evidence",
  "review_case.propose": "Propose Fix",
  "review_case.block": "Mark Blocked",
  "review_case.apply": "Apply Fix",
  "review_case.verify": "Verify",
  "review_case.reopen": "Reopen",
  "review_case.note": "Add Note",
});

/** The one primary (filled) action for a case in this state, if any. */
export function primaryCommand(state: ReviewCaseState, allowed: readonly ReviewCaseCommandKind[]): ReviewCaseCommandKind | undefined {
  const preference: Record<ReviewCaseState, ReviewCaseCommandKind[]> = {
    open: ["review_case.start_research"],
    researching: ["review_case.propose"],
    proposed: ["review_case.apply"],
    blocked: ["review_case.start_research"],
    applied: ["review_case.verify"],
    verified: [],
  };
  return preference[state].find(command => allowed.includes(command));
}

export interface RecordLinkTarget {
  readonly kind: "tenant" | "property" | "unit" | "intake" | "document" | "none";
  readonly id?: string;
}

/** Where an affected record opens. Technical IDs are shown only in detail views. */
export function recordLinkTarget(record: ReviewAffectedRecord): RecordLinkTarget {
  if (record.personId) return { kind: "tenant", id: record.personId };
  if (record.kind === "unit" && record.id) return { kind: "unit", id: record.id };
  if (record.unitId) return { kind: "unit", id: record.unitId };
  if (record.kind === "property") return { kind: "property", id: record.id };
  if (record.kind === "intake_packet" || record.kind === "intake_line") return { kind: "intake" };
  if (record.kind === "document") return { kind: "document", id: record.id };
  if (record.propertyId) return { kind: "property", id: record.propertyId };
  return { kind: "none" };
}

export function recordLabel(record: ReviewAffectedRecord): string {
  if (record.label) return record.label;
  switch (record.kind) {
    case "person": return "Tenant";
    case "tenancy": return "Tenancy";
    case "unit": return "Unit";
    case "property": return "Property";
    case "legal_entity": return "Legal entity";
    case "qbo_object": return "QuickBooks record";
    case "intake_line": return "MRA line";
    default: return "Record";
  }
}

export function evidenceKindLabel(evidence: ReviewEvidence): string {
  switch (evidence.kind) {
    case "detector": return "Detected";
    case "document": return "Document";
    case "source_record": return "Source record";
    case "email": return "Email";
    case "observation": return "Observation";
    default: return "Note";
  }
}

export function eventLabel(kind: string, toState: ReviewCaseState, detail: Record<string, unknown>): string {
  switch (kind) {
    case "detected": return "Detected";
    case "refreshed": return "Evidence changed";
    case "proposed": return "Fix proposed";
    case "applied": return "Fix applied";
    case "verified": return "Verified";
    case "auto_resolved": return "Resolved by readback";
    case "reopened": return "Reopened";
    case "note": return detail.evidenceAdded ? "Evidence added" : detail.routedToAccounting ? "Routed to Accounting" : "Note";
    default: return `Moved to ${stateLabel(toState).toLowerCase()}`;
  }
}
