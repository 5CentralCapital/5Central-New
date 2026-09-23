/**
 * Evidence-backed review reasons. Every uncertainty or invariant code emitted
 * by the rental domain maps to exactly one reason with a short, specific
 * status label. Pure data and functions only: safe for the browser, server and
 * Codex adapters.
 */

export const REVIEW_CAUSE_FAMILIES = [
  "identity",
  "receipt_allocation",
  "history_coverage",
  "operational_balance",
  "occupancy_dates",
  "connection",
] as const;
export type ReviewCauseFamily = (typeof REVIEW_CAUSE_FAMILIES)[number];

export const REVIEW_CAUSE_FAMILY_LABELS: Readonly<Record<ReviewCauseFamily, string>> = Object.freeze({
  identity: "Identity",
  receipt_allocation: "Receipts and ledger",
  history_coverage: "History coverage",
  operational_balance: "Balances",
  occupancy_dates: "Leases and dates",
  connection: "Connections",
});

export const REVIEW_MATERIALITIES = ["high", "medium", "low", "unknown"] as const;
export type ReviewMateriality = (typeof REVIEW_MATERIALITIES)[number];
export const REVIEW_MATERIALITY_LABELS: Readonly<Record<ReviewMateriality, string>> = Object.freeze({
  high: "High", medium: "Medium", low: "Low", unknown: "Unrated",
});
export const REVIEW_MATERIALITY_RANK: Readonly<Record<ReviewMateriality, number>> = Object.freeze({ high: 0, medium: 1, unknown: 2, low: 3 });

/**
 * How candidates are deduplicated. A case is one (reason, cause, scope): an
 * organization-level cause such as a missing import partition is one case no
 * matter how many accounts it touches.
 */
export const REVIEW_SCOPE_LEVELS = ["record", "account", "property", "legal_entity", "organization", "packet"] as const;
export type ReviewScopeLevel = (typeof REVIEW_SCOPE_LEVELS)[number];

/** Operational corrections use the guarded reconciliation writer; financial ones route to accounting. */
export type ReviewResolutionKind = "operational" | "financial" | "connection";

export interface ReviewReasonDefinition {
  readonly code: string;
  readonly shortLabel: string;
  readonly causeFamily: ReviewCauseFamily;
  readonly defaultMateriality: Exclude<ReviewMateriality, "unknown">;
  readonly scopeLevel: ReviewScopeLevel;
  /** "reason": all codes of this reason in a scope form one case; "code": one case per source code. */
  readonly causeBy: "reason" | "code";
  readonly resolution: ReviewResolutionKind;
  readonly researchGuidance: string;
  readonly requiredVerification: string;
  /** Exact source codes emitted by the rental domain, coverage checks or adapters. */
  readonly sourceCodes: readonly string[];
  /** Families of generated codes (for example coverage reasons per collection). */
  readonly sourcePatterns?: readonly RegExp[];
}

const define = <T extends readonly ReviewReasonDefinition[]>(value: T) => value;

export const REVIEW_REASONS = define([
  {
    code: "history_incomplete",
    shortLabel: "History incomplete",
    causeFamily: "history_coverage",
    defaultMateriality: "high",
    scopeLevel: "organization",
    causeBy: "code",
    resolution: "operational",
    researchGuidance: "Locate the original archive partitions, pagination and source IDs; compare counts, dates and control totals with what was imported.",
    requiredVerification: "Complete coverage evidence (partitions, pagination, counts and control totals) is recorded and passed to readers. Absence of errors alone is insufficient.",
    sourceCodes: [
      "imported_account_history_unverified", "source_coverage_not_verified", "archive_identity_not_verified",
      "source_observation_outdated_or_unknown", "tenant_partitions_incomplete", "allocation_embedding_not_verified",
      "account_join_not_verified", "target_readback_not_verified",
    ],
    sourcePatterns: [/^(?:charges|payments|credits|allocations)_(?:collection_incomplete|source_identity_missing|source_date_missing|missing_from_target|duplicate_identity|source_checksum_mismatch|posted_date_mismatch)$/],
  },
  {
    code: "balance_unverified",
    shortLabel: "Balance unverified",
    causeFamily: "operational_balance",
    defaultMateriality: "high",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "financial",
    researchGuidance: "Compare the source-dated property manager observation with the account and tenancy detail for the same date.",
    requiredVerification: "The operational observation is preserved separately and the posted ledger is not overwritten; the balance is complete for the account.",
    sourceCodes: ["account_balance_unknown", "ledger_balance_out_of_range", "balance_review_unresolved"],
  },
  {
    code: "balance_review_stale",
    shortLabel: "Review outdated",
    causeFamily: "operational_balance",
    defaultMateriality: "medium",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "New ledger activity arrived after the owner balance review. Obtain a newer dated observation or confirm the posted ledger.",
    requiredVerification: "A balance review whose ledger fingerprint matches the current ledger is recorded.",
    sourceCodes: ["balance_review_stale"],
  },
  {
    code: "balance_review_conflict",
    shortLabel: "Balance reviews conflict",
    causeFamily: "operational_balance",
    defaultMateriality: "high",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Equally dated balance reviews disagree. Identify which observation is authoritative from the source documents.",
    requiredVerification: "Exactly one latest review applies to the account and property.",
    sourceCodes: ["balance_review_scope_ambiguous"],
  },
  {
    code: "receipt_unmatched",
    shortLabel: "Receipt unmatched",
    causeFamily: "receipt_allocation",
    defaultMateriality: "high",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "financial",
    researchGuidance: "Find the receipt, payer identity, tenant/HAP split, bank observation and source ledger entry.",
    requiredVerification: "Amount and source identity match, there is no prior posting or duplicate, and the receipt is allocated once.",
    sourceCodes: [
      "allocation_evidence_unknown", "allocation_parent_union_invalid", "allocation_reversal_exceeds_history", "allocation_transfer_source_invalid", "allocations_exceed_charge",
      "allocations_exceed_payment", "collected_allocation_date_unknown", "collected_amount_unknown", "collected_category_unknown",
      "collected_charge_posted_unknown", "collected_link_unknown", "collected_payment_posted_unknown", "collected_property_unknown",
      "collected_reversal_excluded", "credit_allocation_credit_invalid", "credit_allocation_person_mismatch", "credit_allocation_source_invalid",
      "generic_payment_payer_unknown", "shared_application_reversal_unknown", "shared_payment_scope_invalid", "transaction_reversed_twice",
    ],
    sourcePatterns: [/^allocation_[a-z_]+$/],
  },
  {
    code: "ledger_entry_incomplete",
    shortLabel: "Ledger entry incomplete",
    causeFamily: "receipt_allocation",
    defaultMateriality: "medium",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "financial",
    researchGuidance: "Open the source ledger entry and confirm its amount, date, category, direction and reversal link.",
    requiredVerification: "Every ledger entry in the account has a known amount, date, category and status from source or manual evidence.",
    sourceCodes: [
      "ledger_amount_unknown", "ledger_date_unknown", "ledger_category_unknown", "ledger_kind_unknown", "ledger_status_unknown",
      "ledger_adjustment_direction_unknown", "ledger_reversal_evidence_unknown", "ledger_reversal_link_unknown", "invalid_ledger_amount",
      "ledger_date_invalid", "ledger_due_date_invalid", "ledger_reference_invalid", "non_reversal_has_link", "adjustment_direction_missing",
      "adjustment_direction_unexpected", "balance_category_unknown", "charge_category_unknown", "description_unknown", "amount_unknown",
    ],
    sourcePatterns: [/^reversal_[a-z_]+$/, /^ledger_[a-z_]+_(?:unknown|invalid)$/],
  },
  {
    code: "tenancy_identity_unknown",
    shortLabel: "Tenant link unknown",
    causeFamily: "identity",
    defaultMateriality: "high",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Resolve the person, unit and tenancy from the executed lease, amendments, unit aliases and dated property manager email.",
    requiredVerification: "Correct person, unit, tenancy and effective date are linked; transfers and future tenancies are preserved.",
    sourceCodes: [
      "tenancy_balance_scope_unknown", "account_ledger_link_unknown", "account_or_unlinked_ledger_scope", "ledger_scope_unknown",
      "ledger_scope_conflict", "tenancy_link_unknown", "person_link_unknown", "unit_link_unknown", "property_link_unknown",
      "tenancy_reference_invalid", "household_reference_invalid", "unit_property_missing", "duplicate_id", "missing_id",
    ],
  },
  {
    code: "tenancy_conflict",
    shortLabel: "Tenancy conflict",
    causeFamily: "identity",
    defaultMateriality: "high",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Two tenancies claim the same unit or status. Check the lease, move-in/out evidence and actual occupancy.",
    requiredVerification: "Exactly one current occupancy per unit; no occupancy is inferred from an inquiry, signed future lease or marketing status alone.",
    sourceCodes: [
      "overlapping_current_tenancies", "multiple_current_tenancies", "multiple_future_tenancies", "future_conflicts_current",
      "simultaneous_tenancy_conflict", "occupancy_conflict", "tenancy_account_status_conflict", "tenancy_status_unknown",
      "tenancy_status_date_conflict",
    ],
  },
  {
    code: "lease_missing",
    shortLabel: "Lease missing",
    causeFamily: "occupancy_dates",
    defaultMateriality: "medium",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Locate the executed lease and amendments for this tenancy.",
    requiredVerification: "An executed lease term with its start and end dates is linked to the tenancy.",
    sourceCodes: ["lease_term_missing", "future_lease_term_missing", "lease_tenancy_missing", "overlapping_lease_terms", "lease_unknown", "future_lease_unknown"],
  },
  {
    code: "move_in_missing",
    shortLabel: "Move-in date missing",
    causeFamily: "occupancy_dates",
    defaultMateriality: "medium",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Find the move-in inspection, key handoff or first rent receipt that dates actual occupancy.",
    requiredVerification: "A dated move-in (or scheduled move-in for future tenancies) comes from lease or occupancy evidence.",
    sourceCodes: ["current_move_in_missing", "future_move_in_missing", "actual_move_in_unknown", "planned_move_in_unknown"],
  },
  {
    code: "occupancy_dates_stale",
    shortLabel: "Occupancy dates out of date",
    causeFamily: "occupancy_dates",
    defaultMateriality: "medium",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "The recorded status disagrees with its dates. Confirm the move-out, notice or move-in from dated evidence.",
    requiredVerification: "Status and move dates agree as of today.",
    sourceCodes: ["current_move_out_stale", "future_move_in_elapsed", "actual_move_out_unknown"],
  },
  {
    code: "rent_amount_unknown",
    shortLabel: "Rent amount unknown",
    causeFamily: "occupancy_dates",
    defaultMateriality: "medium",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Confirm the monthly rent from the executed lease and any effective rent changes.",
    requiredVerification: "A confirmed monthly base rent schedule applies to the tenancy.",
    sourceCodes: ["base_rent_unconfirmed", "scheduled_amount_unconfirmed"],
  },
  {
    code: "schedule_unconfirmed",
    shortLabel: "Charge schedule unconfirmed",
    causeFamily: "occupancy_dates",
    defaultMateriality: "medium",
    scopeLevel: "property",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Review the recurring charge schedules' scope, cadence and lineage against the lease terms.",
    requiredVerification: "Each recurring schedule has a confirmed scope, amount, monthly cadence and a single lineage.",
    sourceCodes: [
      "scheduled_category_unknown", "schedule_cadence_unknown", "active_state_unknown", "active_unknown", "overlapping_base_rent_schedule", "property_schedule_duplicate_conflict",
      "unknown_open_start", "unknown_open_start_historical", "unknown_open_start_current_configuration",
    ],
    sourcePatterns: [/^schedule_[a-z_]+$/],
  },
  {
    code: "market_rent_missing",
    shortLabel: "Market rent missing",
    causeFamily: "occupancy_dates",
    defaultMateriality: "low",
    scopeLevel: "property",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Record the asking rent for each unit from the current listing or rent survey.",
    requiredVerification: "Every active unit has a market rent.",
    sourceCodes: ["market_rent_unknown"],
  },
  {
    code: "subsidy_split_unknown",
    shortLabel: "Subsidy split unknown",
    causeFamily: "receipt_allocation",
    defaultMateriality: "medium",
    scopeLevel: "record",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Obtain the housing authority contract (HAP) showing agency and tenant portions and effective dates.",
    requiredVerification: "One active subsidy contract with a verified gross rent split applies to the tenancy.",
    sourceCodes: ["assistance_responsibility_unverified", "subsidy_contract_unconfirmed", "subsidy_contract_ambiguous", "overlapping_hap_contract", "duplicate_subsidy_payment_id"],
    sourcePatterns: [/^subsidy_[a-z_]+$/],
  },
  {
    code: "deposit_unverified",
    shortLabel: "Deposit unverified",
    causeFamily: "operational_balance",
    defaultMateriality: "medium",
    scopeLevel: "account",
    causeBy: "reason",
    resolution: "financial",
    researchGuidance: "Match the deposit receipt, amount held and any disposition to the lease and bank evidence.",
    requiredVerification: "The deposit held amount and dates are known from source evidence.",
    sourceCodes: ["deposit_amount_invalid", "deposit_date_knowledge_invalid", "deposit_reference_invalid", "deposit_source_balance_invalid"],
    sourcePatterns: [/^deposit_[a-z_]+$/],
  },
  {
    code: "document_link_invalid",
    shortLabel: "Document link invalid",
    causeFamily: "identity",
    defaultMateriality: "low",
    scopeLevel: "property",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "The record references a missing or mismatched person, unit, tenancy or application. Relink it to the correct record.",
    requiredVerification: "Every reference resolves to an existing record in the same property.",
    sourceCodes: [
      "application_member_reference_invalid", "application_reference_invalid", "application_requirement_reference_invalid",
      "answer_restricted_value_present", "answer_value_shape_invalid", "answer_value_type_invalid", "history_blocker_count_invalid",
      "history_blocker_duplicate", "participant_person_knowledge_missing", "requirement_document_unknown", "requirement_status_undefined",
    ],
    sourcePatterns: [/^document_[a-z_]+$/],
  },
  {
    code: "observation_conflict",
    shortLabel: "Sources disagree",
    causeFamily: "history_coverage",
    defaultMateriality: "medium",
    scopeLevel: "property",
    causeBy: "reason",
    resolution: "operational",
    researchGuidance: "Dated source observations disagree. Prefer recent dated evidence while preserving the conflict for investigation.",
    requiredVerification: "The conflicting observations are reconciled or explicitly superseded by dated evidence.",
    sourceCodes: ["observation_conflict", "observation_invalid", "source_conflict", "event_invalid", "event_scope_mismatch", "future_observation", "property_out_of_scope"],
  },
  {
    code: "qbo_disconnected",
    shortLabel: "QBO disconnected",
    causeFamily: "connection",
    defaultMateriality: "high",
    scopeLevel: "legal_entity",
    causeBy: "reason",
    resolution: "connection",
    researchGuidance: "Reconnect QuickBooks for this legal entity from Accounting. Tenant research cannot fix a connection gap.",
    requiredVerification: "An active QuickBooks connection exists for the legal entity.",
    sourceCodes: ["qbo_needs_reconnect", "qbo_revoked"],
  },
  {
    code: "sync_exception",
    shortLabel: "Sync exception",
    causeFamily: "connection",
    defaultMateriality: "medium",
    scopeLevel: "legal_entity",
    causeBy: "code",
    resolution: "connection",
    researchGuidance: "A QuickBooks object could not be mirrored exactly. Check the connector configuration or unsupported transaction type.",
    requiredVerification: "A later provider revision of each object normalizes completely.",
    sourceCodes: ["qbo_sync_unsupported", "qbo_sync_missing_from_full_replay"],
  },
  {
    code: "intake_identity_missing",
    shortLabel: "Intake identity missing",
    causeFamily: "identity",
    defaultMateriality: "medium",
    scopeLevel: "packet",
    causeBy: "code",
    resolution: "operational",
    researchGuidance: "Map each held MRA line to the exact tenant account using the lease, unit aliases and property manager records.",
    requiredVerification: "Every held line has an exact reviewed mapping and the packet previews without identity holds.",
    sourceCodes: ["intake_held_missing_identity", "intake_held_ambiguous_identity"],
  },
  {
    code: "intake_line_unsupported",
    shortLabel: "Intake line unsupported",
    causeFamily: "connection",
    defaultMateriality: "medium",
    scopeLevel: "packet",
    causeBy: "code",
    resolution: "connection",
    researchGuidance: "The MRA line type or custody cannot be applied by the current adapter. Extend the adapter or route the line to accounting.",
    requiredVerification: "The line is applied by a supported command or explicitly routed with a recorded reason.",
    sourceCodes: ["intake_held_unsupported", "intake_apply_failed"],
  },
  {
    code: "record_unverified",
    shortLabel: "Unverified",
    causeFamily: "identity",
    defaultMateriality: "low",
    scopeLevel: "record",
    causeBy: "code",
    resolution: "operational",
    researchGuidance: "Inspect the underlying record and its source evidence.",
    requiredVerification: "The record's source evidence confirms the value.",
    sourceCodes: [],
  },
] as const);

export type ReviewReasonCode = (typeof REVIEW_REASONS)[number]["code"];
export const REVIEW_REASON_CODES = REVIEW_REASONS.map(reason => reason.code) as unknown as readonly [ReviewReasonCode, ...ReviewReasonCode[]];
export const FALLBACK_REVIEW_REASON: ReviewReasonCode = "record_unverified";

const byCode = new Map<string, ReviewReasonDefinition>(REVIEW_REASONS.map(reason => [reason.code, reason]));
const exactSource = new Map<string, ReviewReasonCode>();
for (const reason of REVIEW_REASONS) for (const code of reason.sourceCodes) {
  if (exactSource.has(code)) throw new Error(`Review source code ${code} is mapped twice`);
  exactSource.set(code, reason.code);
}

export function reviewReason(code: ReviewReasonCode | string): ReviewReasonDefinition {
  return byCode.get(code) ?? byCode.get(FALLBACK_REVIEW_REASON)!;
}

export function isReviewReasonCode(value: unknown): value is ReviewReasonCode {
  return typeof value === "string" && byCode.has(value);
}

export interface ReviewCodeClassification {
  readonly reason: ReviewReasonCode;
  readonly matchedBy: "exact" | "pattern" | "fallback";
}

/** Map any domain uncertainty/violation code to its review reason. */
export function classifyReviewCode(code: string): ReviewCodeClassification {
  const exact = exactSource.get(code);
  if (exact) return { reason: exact, matchedBy: "exact" };
  for (const reason of REVIEW_REASONS) {
    const patterns = (reason as ReviewReasonDefinition).sourcePatterns ?? [];
    if (patterns.some(pattern => pattern.test(code))) return { reason: reason.code, matchedBy: "pattern" };
  }
  return { reason: FALLBACK_REVIEW_REASON, matchedBy: "fallback" };
}

function reasonPriority(reason: ReviewReasonDefinition): number {
  return REVIEW_MATERIALITY_RANK[reason.defaultMateriality] * 100 + REVIEW_REASONS.findIndex(item => item.code === reason.code);
}

/**
 * The specific short status for a set of uncertainty codes, most material
 * first. "Unverified" is only used when no code explains the uncertainty.
 */
export function reviewLabelForCodes(codes: readonly string[] | null | undefined): string {
  const reasons = Array.from(new Set((codes ?? []).filter(code => typeof code === "string" && code.length > 0).map(code => classifyReviewCode(code).reason)))
    .map(reviewReason)
    .sort((left, right) => reasonPriority(left) - reasonPriority(right));
  return reasons[0]?.shortLabel ?? reviewReason(FALLBACK_REVIEW_REASON).shortLabel;
}

/** Distinct short labels for display lists, most material first. */
export function reviewLabelsForCodes(codes: readonly string[] | null | undefined): string[] {
  const reasons = Array.from(new Set((codes ?? []).filter(code => typeof code === "string" && code.length > 0).map(code => classifyReviewCode(code).reason)))
    .map(reviewReason)
    .sort((left, right) => reasonPriority(left) - reasonPriority(right));
  return reasons.map(reason => reason.shortLabel);
}

export const UNVERIFIED_LABEL = "Unverified";
export const UNKNOWN_AMOUNT_LABEL = "Unknown";
