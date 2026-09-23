import { randomUUID } from "node:crypto";
import {
  newRecordId,
  type IsoTimestamp,
  type Revision,
} from "../../shared/company";
import {
  nextReviewAction,
  reviewAffectedRecordSchema,
  reviewCaseEventSchema,
  reviewCaseSummarySchema,
  reviewEvidenceSchema,
  reviewProposedCorrectionSchema,
  reviewReason,
  type ReviewAffectedRecord,
  type ReviewCaseEvent,
  type ReviewCaseEventKind,
  type ReviewCaseState,
  type ReviewCaseSummary,
  type ReviewEvidence,
  type ReviewMateriality,
  type ReviewProposedCorrection,
  type ReviewReasonCode,
} from "../../shared/review-cases";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import { dbDate, dbNullableCents, dbNullableString, dbNullableTimestamp, dbRevision, dbString, dbTimestamp } from "../projects/helpers";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

/** Full stored case. JSON columns are parsed and validated on every read. */
export interface ReviewCaseRow {
  readonly id: string;
  readonly organizationId: string;
  readonly legalEntityId: string | null;
  readonly propertyId: string | null;
  readonly reasonCode: ReviewReasonCode;
  readonly causeKey: string;
  readonly scopeKey: string;
  readonly scopeLabel: string | null;
  readonly state: ReviewCaseState;
  readonly materiality: ReviewMateriality;
  readonly asOf: string;
  readonly impactCents: string | null;
  readonly impactCurrency: string | null;
  readonly affectedRecords: ReviewAffectedRecord[];
  readonly affectedCount: number;
  readonly sourceFingerprint: string;
  readonly evidence: ReviewEvidence[];
  readonly proposedCorrection: ReviewProposedCorrection | null;
  readonly blockedOn: string | null;
  readonly detectedBy: "detector" | "manual" | "intake" | "accounting";
  readonly reopenedCount: number;
  readonly recordRevision: Revision;
  readonly firstDetectedAt: IsoTimestamp;
  readonly lastDetectedAt: IsoTimestamp;
  readonly resolvedAt: IsoTimestamp | null;
  readonly updatedAt: IsoTimestamp;
}

export const REVIEW_CASE_COLUMNS = `c.id, c.organization_id, c.legal_entity_id, c.property_id, c.reason_code, c.cause_key, c.scope_key, c.scope_label,
  c.state, c.materiality, c.as_of, c.impact_cents::text AS impact_cents, c.impact_currency, c.affected_records, c.affected_count,
  c.source_fingerprint, c.evidence, c.proposed_correction, c.blocked_on, c.detected_by, c.reopened_count, c.record_revision,
  c.first_detected_at, c.last_detected_at, c.resolved_at, c.updated_at`;

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new ValidationCommandError("Review case storage returned invalid JSON", { reason: "invalid_review_case_row" }); }
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new ValidationCommandError("Review case storage returned an invalid count", { reason: "invalid_review_case_row", field });
  return parsed;
}

export function mapReviewCaseRow(row: Record<string, unknown>): ReviewCaseRow {
  const affected = json(row.affected_records);
  const evidence = json(row.evidence);
  const proposed = json(row.proposed_correction);
  return {
    id: dbString(row.id, "id"),
    organizationId: dbString(row.organization_id, "organization_id"),
    legalEntityId: dbNullableString(row.legal_entity_id, "legal_entity_id"),
    propertyId: dbNullableString(row.property_id, "property_id"),
    reasonCode: reviewReason(dbString(row.reason_code, "reason_code")).code as ReviewReasonCode,
    causeKey: dbString(row.cause_key, "cause_key"),
    scopeKey: dbString(row.scope_key, "scope_key"),
    scopeLabel: dbNullableString(row.scope_label, "scope_label"),
    state: dbString(row.state, "state") as ReviewCaseState,
    materiality: dbString(row.materiality, "materiality") as ReviewMateriality,
    asOf: dbDate(row.as_of, "as_of"),
    impactCents: dbNullableCents(row.impact_cents, "impact_cents"),
    impactCurrency: dbNullableString(row.impact_currency, "impact_currency"),
    affectedRecords: (Array.isArray(affected) ? affected : []).map(item => reviewAffectedRecordSchema.parse(item)),
    affectedCount: count(row.affected_count, "affected_count"),
    sourceFingerprint: dbString(row.source_fingerprint, "source_fingerprint"),
    evidence: (Array.isArray(evidence) ? evidence : []).map(item => reviewEvidenceSchema.parse(item)),
    proposedCorrection: proposed === null || proposed === undefined ? null : reviewProposedCorrectionSchema.parse(proposed),
    blockedOn: dbNullableString(row.blocked_on, "blocked_on"),
    detectedBy: dbString(row.detected_by, "detected_by") as ReviewCaseRow["detectedBy"],
    reopenedCount: count(row.reopened_count, "reopened_count"),
    recordRevision: dbRevision(row.record_revision),
    firstDetectedAt: dbTimestamp(row.first_detected_at, "first_detected_at"),
    lastDetectedAt: dbTimestamp(row.last_detected_at, "last_detected_at"),
    resolvedAt: dbNullableTimestamp(row.resolved_at, "resolved_at"),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
  };
}

export function toReviewCaseSummary(row: ReviewCaseRow): ReviewCaseSummary {
  const reason = reviewReason(row.reasonCode);
  return reviewCaseSummarySchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId,
    propertyId: row.propertyId,
    reasonCode: row.reasonCode,
    shortLabel: reason.shortLabel,
    causeFamily: reason.causeFamily,
    causeKey: row.causeKey,
    scopeKey: row.scopeKey,
    scopeLabel: row.scopeLabel,
    state: row.state,
    materiality: row.materiality,
    asOf: row.asOf,
    impactCents: row.impactCents,
    impactCurrency: row.impactCurrency,
    affectedCount: row.affectedCount,
    blockedOn: row.blockedOn,
    detectedBy: row.detectedBy,
    reopenedCount: row.reopenedCount,
    recordRevision: row.recordRevision,
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    resolvedAt: row.resolvedAt,
    updatedAt: row.updatedAt,
    nextAction: nextReviewAction(row.state, reason.resolution, row.blockedOn),
  });
}

export async function loadReviewCaseForUpdate(executor: RentOpsQueryExecutor, input: {
  organizationId: string; caseId: string; legalEntityId?: string; propertyId?: string;
}): Promise<ReviewCaseRow> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${REVIEW_CASE_COLUMNS} FROM company_review_cases c
      WHERE c.organization_id = $1 AND c.id = $2
        AND ($3::uuid IS NULL OR c.legal_entity_id = $3)
        AND ($4::varchar IS NULL OR c.property_id = $4)
      FOR UPDATE`,
    [input.organizationId, input.caseId, input.legalEntityId ?? null, input.propertyId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Review case was not found in the requested company scope", { reason: "review_case_not_found" });
  return mapReviewCaseRow(row);
}

export interface ReviewCaseChanges {
  readonly state?: ReviewCaseState;
  readonly materiality?: ReviewMateriality;
  readonly asOf?: string;
  readonly impactCents?: string | null;
  readonly impactCurrency?: string | null;
  readonly affectedRecords?: readonly ReviewAffectedRecord[];
  readonly affectedCount?: number;
  readonly sourceFingerprint?: string;
  readonly evidence?: readonly ReviewEvidence[];
  readonly proposedCorrection?: ReviewProposedCorrection | null;
  readonly blockedOn?: string | null;
  readonly scopeLabel?: string | null;
  readonly legalEntityId?: string | null;
  readonly reopenedCount?: number;
  readonly resolvedAt?: "now" | null;
  readonly lastDetectedAt?: "now";
}

const COLUMN: Record<Exclude<keyof ReviewCaseChanges, "resolvedAt" | "lastDetectedAt">, { column: string; cast?: string; json?: boolean }> = {
  state: { column: "state" },
  materiality: { column: "materiality" },
  asOf: { column: "as_of", cast: "date" },
  impactCents: { column: "impact_cents", cast: "bigint" },
  impactCurrency: { column: "impact_currency" },
  affectedRecords: { column: "affected_records", cast: "jsonb", json: true },
  affectedCount: { column: "affected_count", cast: "integer" },
  sourceFingerprint: { column: "source_fingerprint" },
  evidence: { column: "evidence", cast: "jsonb", json: true },
  proposedCorrection: { column: "proposed_correction", cast: "jsonb", json: true },
  blockedOn: { column: "blocked_on" },
  scopeLabel: { column: "scope_label" },
  legalEntityId: { column: "legal_entity_id", cast: "uuid" },
  reopenedCount: { column: "reopened_count", cast: "integer" },
};

/** Apply changes under an exact revision fence and advance the revision by one. */
export async function saveReviewCase(executor: RentOpsQueryExecutor, current: ReviewCaseRow, changes: ReviewCaseChanges): Promise<Revision> {
  const values: unknown[] = [];
  const assignments: string[] = [];
  for (const [key, spec] of Object.entries(COLUMN) as [keyof typeof COLUMN, (typeof COLUMN)[keyof typeof COLUMN]][]) {
    if (!(key in changes)) continue;
    const value = changes[key];
    values.push(value === null || value === undefined ? null : spec.json ? JSON.stringify(value) : value);
    assignments.push(`${spec.column} = $${values.length}${spec.cast ? `::${spec.cast}` : ""}`);
  }
  if ("resolvedAt" in changes) assignments.push(changes.resolvedAt === "now" ? "resolved_at = COALESCE(resolved_at, now())" : "resolved_at = NULL");
  if (changes.lastDetectedAt === "now") assignments.push("last_detected_at = GREATEST(now(), first_detected_at)");
  values.push(current.organizationId, current.id, current.recordRevision);
  const n = values.length;
  const result = await executor.query<{ record_revision: number }>(
    `UPDATE company_review_cases
        SET ${[...assignments, "updated_at = now()", "record_revision = record_revision + 1"].join(", ")}
      WHERE organization_id = $${n - 2} AND id = $${n - 1} AND record_revision = $${n}
      RETURNING record_revision`,
    values,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Review case changed while it was being saved", { reason: "revision_conflict" });
  return dbRevision(result.rows[0]!.record_revision);
}

export interface ReviewCaseEventInput {
  readonly organizationId: string;
  readonly caseId: string;
  readonly revision: number;
  readonly kind: ReviewCaseEventKind;
  readonly fromState: ReviewCaseState | null;
  readonly toState: ReviewCaseState;
  readonly actorId: string;
  readonly sourceFingerprint: string;
  readonly detail?: Record<string, unknown>;
}

export async function recordReviewCaseEvent(executor: RentOpsQueryExecutor, input: ReviewCaseEventInput): Promise<void> {
  await executor.query(
    `INSERT INTO company_review_case_events
       (id, organization_id, case_id, case_revision, event_kind, from_state, to_state, actor_id, source_fingerprint, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [newRecordId(), input.organizationId, input.caseId, input.revision, input.kind, input.fromState, input.toState,
      input.actorId, input.sourceFingerprint, JSON.stringify(input.detail ?? {})],
  );
}

export interface InsertReviewCaseInput {
  readonly organizationId: string;
  readonly legalEntityId: string | null;
  readonly propertyId: string | null;
  readonly reasonCode: string;
  readonly causeKey: string;
  readonly scopeKey: string;
  readonly scopeLabel: string | null;
  readonly materiality: ReviewMateriality;
  readonly asOf: string;
  readonly impactCents: string | null;
  readonly impactCurrency: string | null;
  readonly affectedRecords: readonly ReviewAffectedRecord[];
  readonly affectedCount: number;
  readonly sourceFingerprint: string;
  readonly evidence: readonly ReviewEvidence[];
  readonly detectedBy: ReviewCaseRow["detectedBy"];
}

export async function insertReviewCase(executor: RentOpsQueryExecutor, input: InsertReviewCaseInput): Promise<string> {
  const id = randomUUID();
  await executor.query(
    `INSERT INTO company_review_cases
       (id, organization_id, legal_entity_id, property_id, reason_code, cause_key, scope_key, scope_label, state, materiality,
        as_of, impact_cents, impact_currency, affected_records, affected_count, source_fingerprint, evidence, detected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10::date,$11::bigint,$12,$13::jsonb,$14,$15,$16::jsonb,$17)`,
    [id, input.organizationId, input.legalEntityId, input.propertyId, input.reasonCode, input.causeKey, input.scopeKey, input.scopeLabel,
      input.materiality, input.asOf, input.impactCents, input.impactCurrency, JSON.stringify(input.affectedRecords), input.affectedCount,
      input.sourceFingerprint, JSON.stringify(input.evidence), input.detectedBy],
  );
  return id;
}

export async function readReviewCaseEvents(executor: RentOpsQueryExecutor, organizationId: string, caseId: string): Promise<ReviewCaseEvent[]> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id, event_kind, from_state, to_state, case_revision, actor_id, source_fingerprint, detail, occurred_at
       FROM company_review_case_events
      WHERE organization_id = $1 AND case_id = $2
      ORDER BY case_revision, occurred_at, id
      LIMIT 1000`,
    [organizationId, caseId],
  );
  return result.rows.map(row => reviewCaseEventSchema.parse({
    id: dbString(row.id, "id"),
    kind: dbString(row.event_kind, "event_kind"),
    fromState: dbNullableString(row.from_state, "from_state"),
    toState: dbString(row.to_state, "to_state"),
    caseRevision: dbRevision(row.case_revision, "case_revision"),
    actorId: dbString(row.actor_id, "actor_id"),
    sourceFingerprint: dbString(row.source_fingerprint, "source_fingerprint"),
    detail: (json(row.detail) ?? {}) as Record<string, unknown>,
    occurredAt: dbTimestamp(row.occurred_at, "occurred_at"),
  }));
}
