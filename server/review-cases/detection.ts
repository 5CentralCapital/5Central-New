import { emptyRentOpsSnapshot, type RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import {
  REVIEW_CASE_AUTO_RESOLVABLE_STATES,
  reviewDetectionSummarySchema,
  type ReviewDetectionSummary,
  type ReviewEvidence,
} from "../../shared/review-cases";
import { isoDateSchema, organizationIdSchema, type IsoDate } from "../../shared/company";
import { detectReviewCasesWithStatus, reviewCandidateKey, type ReviewCaseCandidate, type ReviewDetectorInput, type ReviewDetectorIntakePacket, type ReviewDetectorQboConnection, type ReviewDetectorSyncException } from "../rent-ops/domain/review-detector";
import { RentOpsInvariantError } from "../rent-ops/domain/invariants";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ValidationCommandError } from "../company/commands/errors";
import {
  REVIEW_CASE_COLUMNS,
  insertReviewCase,
  mapReviewCaseRow,
  recordReviewCaseEvent,
  saveReviewCase,
  type ReviewCaseRow,
} from "./store";

export const REVIEW_DETECTOR_ACTOR = "system:review-detector";

/** Operating date in the company's time zone. */
export function operatingDate(now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return isoDateSchema.parse(`${value.year}-${value.month}-${value.day}`);
}

export interface LoadedDetectionInput {
  readonly input: ReviewDetectorInput;
  /** False when the rental snapshot could not be read or an input was truncated; auto-resolution is then suppressed. */
  readonly complete: boolean;
  /** Why the input is incomplete (bounded, human-readable). */
  readonly incompleteReasons: readonly string[];
}

/** Bounded detector inputs: a result at the bound means more rows exist and the input is incomplete. */
export const REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS = 5_000;
export const REVIEW_DETECTION_MAX_INTAKE_PACKETS = 500;

const INCOMPLETE_REPORT_LABELS = { rent_roll: "rent roll", delinquency: "delinquency report", scheduled_income: "scheduled income" } as const;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Read everything the pure detector needs for one organization inside the caller's transaction. */
export async function loadReviewDetectionInput(executor: RentOpsQueryExecutor, organizationId: string, asOf: IsoDate): Promise<LoadedDetectionInput> {
  const properties = await executor.query<{ property_id: string; legal_entity_id: string }>(
    `SELECT property_id, legal_entity_id FROM company_property_entity_periods
      WHERE organization_id = $1 AND effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $2::date)`,
    [organizationId, asOf],
  );
  const propertyEntities = new Map(properties.rows.map(row => [String(row.property_id), String(row.legal_entity_id)]));
  let snapshot: RentOpsSnapshot;
  let complete = true;
  const incompleteReasons: string[] = [];
  let violations: { code: string; entityId: string; message?: string }[] | undefined;
  try {
    snapshot = await new PostgresRentOpsRepository(executor, true).getSnapshot();
  } catch (error) {
    if (!(error instanceof RentOpsInvariantError)) throw error;
    // The rental snapshot itself is invalid: report its violations, but never
    // auto-verify other cases from a partial read.
    snapshot = emptyRentOpsSnapshot();
    complete = false;
    incompleteReasons.push("Rental records could not be read.");
    violations = (error.violations ?? []).filter(item => item.entityId).map(item => ({ code: item.code, entityId: item.entityId!, message: item.message }));
  }
  const connections = await executor.query<Record<string, unknown>>(
    `SELECT c.legal_entity_id, e.name AS legal_entity_name, c.environment, c.realm_id, c.status
       FROM accounting_qbo_connections c
       JOIN company_legal_entities e ON e.organization_id = c.organization_id AND e.id = c.legal_entity_id
      WHERE c.organization_id = $1 AND e.archived_at IS NULL`,
    [organizationId],
  );
  const exceptions = await executor.query<Record<string, unknown>>(
    `SELECT x.legal_entity_id, e.name AS legal_entity_name, x.stream, x.object_type, x.object_id, x.exception_kind, x.reasons
       FROM accounting_qbo_sync_exceptions x
       JOIN company_legal_entities e ON e.organization_id = x.organization_id AND e.id = x.legal_entity_id
      WHERE x.organization_id = $1 AND x.resolved_at IS NULL
      ORDER BY x.legal_entity_id, x.stream, x.object_type, x.object_id
      LIMIT $2`,
    [organizationId, REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS + 1],
  );
  if (exceptions.rows.length > REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS) {
    complete = false;
    incompleteReasons.push(`More than ${REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS} QuickBooks sync exceptions are open; only the first ${REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS} were read.`);
    exceptions.rows.length = REVIEW_DETECTION_MAX_SYNC_EXCEPTIONS;
  }
  // Newest staged packet first: a later packet's observation of a source line supersedes an earlier one.
  const packets = await executor.query<Record<string, unknown>>(
    `SELECT id, source_file_name, legal_entity_id, property_id, lines_json
       FROM company_intake_packets
      WHERE organization_id = $1 AND reconciliation_json IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [organizationId, REVIEW_DETECTION_MAX_INTAKE_PACKETS + 1],
  );
  if (packets.rows.length > REVIEW_DETECTION_MAX_INTAKE_PACKETS) {
    complete = false;
    incompleteReasons.push(`More than ${REVIEW_DETECTION_MAX_INTAKE_PACKETS} MRA packets exist; only the newest ${REVIEW_DETECTION_MAX_INTAKE_PACKETS} were read.`);
    packets.rows.length = REVIEW_DETECTION_MAX_INTAKE_PACKETS;
  }
  const parsedPackets = packets.rows.map(row => ({ row, lines: (() => { const lines = parseJson(row.lines_json); return Array.isArray(lines) ? lines : []; })() }));
  // Source lines whose money any packet applied are verified history, never an open intake cause.
  const openKeys = new Set<string>();
  for (const { lines } of parsedPackets) for (const line of lines) {
    const value = line as Record<string, unknown> | null;
    if (value && typeof value === "object" && typeof value.sourceLineKey === "string" && value.outcome !== "applied") openKeys.add(value.sourceLineKey);
  }
  const appliedKeys = new Set<string>();
  if (openKeys.size) {
    const applied = await executor.query<{ source_line_key: string }>(
      `SELECT DISTINCT source_line_key FROM company_intake_line_registry
        WHERE organization_id = $1 AND outcome = 'applied' AND source_line_key = ANY($2::text[])`,
      [organizationId, Array.from(openKeys)],
    );
    for (const row of applied.rows) appliedKeys.add(String(row.source_line_key));
  }
  const observedLater = new Set<string>();
  const intakePackets: ReviewDetectorIntakePacket[] = parsedPackets.map(({ row, lines }) => {
    const packetKeys: string[] = [];
    const packet = {
      id: String(row.id),
      fileName: String(row.source_file_name),
      legalEntityId: row.legal_entity_id ? String(row.legal_entity_id) : null,
      propertyId: row.property_id ? String(row.property_id) : null,
      lines: lines.flatMap(line => {
        if (!line || typeof line !== "object") return [];
        const value = line as Record<string, unknown>;
        if (typeof value.sourceLineKey !== "string" || typeof value.amountCents !== "string") return [];
        packetKeys.push(value.sourceLineKey);
        // A revised packet re-observes the same source line: only the newest observation can open a case.
        if (observedLater.has(value.sourceLineKey) || appliedKeys.has(value.sourceLineKey)) return [];
        return [{
          sourceLineKey: value.sourceLineKey,
          outcome: typeof value.outcome === "string" ? value.outcome : null,
          outcomeReason: typeof value.outcomeReason === "string" ? value.outcomeReason : null,
          amountCents: value.amountCents,
          currency: typeof value.currency === "string" ? value.currency : "USD",
          sourceAccountId: typeof value.sourceAccountId === "string" ? value.sourceAccountId : "unknown",
          tenantDisplayName: typeof value.tenantDisplayName === "string" ? value.tenantDisplayName : null,
        }];
      }),
    };
    for (const key of packetKeys) observedLater.add(key);
    return packet;
  });
  return {
    complete,
    incompleteReasons,
    input: {
      asOf,
      snapshot,
      propertyIds: new Set(propertyEntities.keys()),
      propertyEntities,
      ...(violations ? { reports: { rentRoll: [], delinquency: [], scheduledIncome: [], violations } } : {}),
      qbo: {
        connections: connections.rows.map(row => ({
          legalEntityId: String(row.legal_entity_id), legalEntityName: row.legal_entity_name ? String(row.legal_entity_name) : null,
          environment: String(row.environment), realmId: String(row.realm_id), status: String(row.status) as ReviewDetectorQboConnection["status"],
        })),
        syncExceptions: exceptions.rows.map(row => {
          const reasons = parseJson(row.reasons);
          return {
            legalEntityId: String(row.legal_entity_id), legalEntityName: row.legal_entity_name ? String(row.legal_entity_name) : null,
            stream: String(row.stream), objectType: String(row.object_type), objectId: String(row.object_id),
            exceptionKind: String(row.exception_kind) as ReviewDetectorSyncException["exceptionKind"],
            reasons: Array.isArray(reasons) ? reasons.filter((item): item is string => typeof item === "string") : [],
          };
        }),
      },
      intake: { packets: intakePackets },
    },
  };
}

function detectedBy(candidate: ReviewCaseCandidate): ReviewCaseRow["detectedBy"] {
  if (candidate.reasonCode.startsWith("intake_")) return "intake";
  if (candidate.reasonCode === "qbo_disconnected" || candidate.reasonCode === "sync_exception") return "accounting";
  return "detector";
}

function detectorEvidence(candidate: ReviewCaseCandidate, addedAt: string): ReviewEvidence[] {
  return candidate.evidence.slice(0, 50).map(item => ({
    id: `detector:${item.code}`,
    kind: "detector",
    origin: "detector",
    reference: item.code,
    summary: item.message.slice(0, 1_000),
    documentId: null,
    sha256: null,
    observedOn: candidate.asOf as IsoDate,
    count: item.count,
    addedBy: REVIEW_DETECTOR_ACTOR,
    addedAt: addedAt as ReviewEvidence["addedAt"],
  }));
}

function mergeEvidence(existing: readonly ReviewEvidence[], candidate: ReviewCaseCandidate, addedAt: string): ReviewEvidence[] {
  const manual = existing.filter(item => item.origin !== "detector");
  return [...detectorEvidence(candidate, addedAt), ...manual].slice(0, 200);
}

export interface ReconcileOptions {
  readonly organizationId: string;
  readonly actorId: string;
  readonly candidates: readonly ReviewCaseCandidate[];
  readonly asOf: IsoDate;
  /** When false, cases missing from the candidates are left untouched. */
  readonly allowAutoResolve: boolean;
  /** Read-only: count what would change without writing anything. */
  readonly preview?: boolean;
  /** Carried into the summary when the input or a report was incomplete. */
  readonly incompleteReasons?: readonly string[];
}

/**
 * Upsert candidates on (organization, reason, cause, scope). Must run inside
 * the caller's transaction. Returns counts and the IDs of changed cases.
 */
export async function reconcileReviewCases(executor: RentOpsQueryExecutor, options: ReconcileOptions): Promise<ReviewDetectionSummary> {
  const organizationId = organizationIdSchema.parse(options.organizationId);
  const now = new Date().toISOString();
  const preview = options.preview === true;
  const existingResult = await executor.query<Record<string, unknown>>(
    `SELECT ${REVIEW_CASE_COLUMNS} FROM company_review_cases c
      WHERE c.organization_id = $1 AND c.detected_by <> 'manual'
      ORDER BY c.id
      ${preview ? "" : "FOR UPDATE"}`,
    [organizationId],
  );
  const existing = new Map(existingResult.rows.map(row => {
    const mapped = mapReviewCaseRow(row);
    return [reviewCandidateKey(mapped), mapped] as const;
  }));
  const summary = { opened: 0, refreshed: 0, updated: 0, reopened: 0, autoVerified: 0, unchanged: 0 };
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const candidate of options.candidates) {
    const key = reviewCandidateKey(candidate);
    if (seen.has(key)) throw new ValidationCommandError("Detector returned a duplicate case key", { reason: "review_detector_duplicate_candidate" });
    seen.add(key);
    const current = existing.get(key);
    const data = {
      materiality: candidate.materiality,
      asOf: candidate.asOf,
      impactCents: candidate.impactCents,
      impactCurrency: candidate.impactCurrency,
      affectedRecords: candidate.affectedRecords,
      affectedCount: candidate.affectedCount,
      sourceFingerprint: candidate.sourceFingerprint,
      scopeLabel: candidate.scopeLabel,
      ...(candidate.legalEntityId ? { legalEntityId: candidate.legalEntityId } : {}),
    };
    if (preview) {
      if (!current) summary.opened += 1;
      else if (current.state === "verified" || (current.state === "applied" && current.sourceFingerprint !== candidate.sourceFingerprint)) summary.reopened += 1;
      else if (current.sourceFingerprint === candidate.sourceFingerprint) summary.refreshed += 1;
      else summary.updated += 1;
      continue;
    }
    if (!current) {
      const id = await insertReviewCase(executor, {
        organizationId, legalEntityId: candidate.legalEntityId, propertyId: candidate.propertyId, reasonCode: candidate.reasonCode,
        causeKey: candidate.causeKey, scopeKey: candidate.scopeKey, scopeLabel: candidate.scopeLabel, materiality: candidate.materiality,
        asOf: candidate.asOf, impactCents: candidate.impactCents, impactCurrency: candidate.impactCurrency, affectedRecords: candidate.affectedRecords,
        affectedCount: candidate.affectedCount, sourceFingerprint: candidate.sourceFingerprint, evidence: detectorEvidence(candidate, now),
        detectedBy: detectedBy(candidate),
      });
      await recordReviewCaseEvent(executor, {
        organizationId, caseId: id, revision: 1, kind: "detected", fromState: null, toState: "open", actorId: options.actorId,
        sourceFingerprint: candidate.sourceFingerprint, detail: { affectedCount: candidate.affectedCount, codes: candidate.codes.slice(0, 50) },
      });
      summary.opened += 1; changed.push(id);
      continue;
    }
    const fingerprintChanged = current.sourceFingerprint !== candidate.sourceFingerprint;
    // A resolved case whose cause is detected again (or whose evidence changed after apply) reopens.
    if (current.state === "verified" || (current.state === "applied" && fingerprintChanged)) {
      const revision = await saveReviewCase(executor, current, {
        ...data, state: "open", resolvedAt: null, blockedOn: null, reopenedCount: current.reopenedCount + 1,
        evidence: mergeEvidence(current.evidence, candidate, now), lastDetectedAt: "now",
      });
      await recordReviewCaseEvent(executor, {
        organizationId, caseId: current.id, revision, kind: "reopened", fromState: current.state, toState: "open", actorId: options.actorId,
        sourceFingerprint: candidate.sourceFingerprint,
        detail: { reason: fingerprintChanged ? "source_changed" : "detected_again", previousFingerprint: current.sourceFingerprint, affectedCount: candidate.affectedCount },
      });
      summary.reopened += 1; changed.push(current.id);
      continue;
    }
    if (!fingerprintChanged) {
      // Same evidence: only the detection time moves; the revision is untouched so open editors do not conflict.
      await executor.query(
        `UPDATE company_review_cases SET last_detected_at = GREATEST(now(), first_detected_at), as_of = $3::date
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, current.id, candidate.asOf],
      );
      summary.refreshed += 1;
      continue;
    }
    const revision = await saveReviewCase(executor, current, { ...data, evidence: mergeEvidence(current.evidence, candidate, now), lastDetectedAt: "now" });
    await recordReviewCaseEvent(executor, {
      organizationId, caseId: current.id, revision, kind: "refreshed", fromState: current.state, toState: current.state, actorId: options.actorId,
      sourceFingerprint: candidate.sourceFingerprint, detail: { previousFingerprint: current.sourceFingerprint, affectedCount: candidate.affectedCount, previousAffectedCount: current.affectedCount },
    });
    summary.updated += 1; changed.push(current.id);
  }
  if (options.allowAutoResolve && !preview) {
    for (const [key, current] of Array.from(existing.entries())) {
      if (seen.has(key)) continue;
      if (!REVIEW_CASE_AUTO_RESOLVABLE_STATES.includes(current.state)) { summary.unchanged += 1; continue; }
      const revision = await saveReviewCase(executor, current, { state: "verified", resolvedAt: "now", blockedOn: null });
      await recordReviewCaseEvent(executor, {
        organizationId, caseId: current.id, revision, kind: current.state === "applied" ? "verified" : "auto_resolved", fromState: current.state, toState: "verified",
        actorId: options.actorId, sourceFingerprint: current.sourceFingerprint, detail: { readback: "detector", asOf: options.asOf },
      });
      summary.autoVerified += 1; changed.push(current.id);
    }
  } else {
    for (const key of Array.from(existing.keys())) if (!seen.has(key)) summary.unchanged += 1;
  }
  const incompleteReasons = (options.incompleteReasons ?? []).slice(0, 20).map(reason => reason.slice(0, 500));
  return reviewDetectionSummarySchema.parse({
    organizationId, asOf: options.asOf, candidateCount: options.candidates.length, ...summary, changedCaseIds: changed.slice(0, 1_000),
    mode: preview ? "preview" : "live", complete: incompleteReasons.length === 0 && options.allowAutoResolve, incompleteReasons,
  });
}

export interface RunReviewDetectionOptions {
  readonly actorId?: string;
  /**
   * Operating date to detect as of. Live cases always reflect the operating
   * date; any other date is a read-only preview that writes nothing.
   */
  readonly asOf?: string;
  readonly now?: () => Date;
}

interface DetectionRun {
  readonly candidates: ReviewCaseCandidate[];
  readonly complete: boolean;
  readonly incompleteReasons: string[];
  readonly asOf: IsoDate;
}

async function detectForDate(executor: RentOpsQueryExecutor, organizationId: string, asOf: IsoDate): Promise<DetectionRun> {
  const loaded = await loadReviewDetectionInput(executor, organizationId, asOf);
  const detected = detectReviewCasesWithStatus(loaded.input);
  const incompleteReasons = [
    ...loaded.incompleteReasons,
    ...detected.incompleteReports.map(item => `The ${INCOMPLETE_REPORT_LABELS[item.report]} could not be computed${item.codes.length ? ` (${item.codes.slice(0, 5).join(", ")})` : ""}.`),
  ];
  return { candidates: detected.candidates, complete: loaded.complete && detected.complete, incompleteReasons, asOf };
}

/** Detect and reconcile inside an existing transaction (command handler or job). */
export async function runReviewDetectionInTransaction(executor: RentOpsQueryExecutor, organizationId: string, options: RunReviewDetectionOptions = {}): Promise<ReviewDetectionSummary> {
  const today = operatingDate(options.now?.() ?? new Date());
  const asOf = options.asOf ? isoDateSchema.parse(options.asOf) : today;
  const run = await detectForDate(executor, organizationId, asOf);
  return reconcileReviewCases(executor, {
    organizationId, actorId: options.actorId ?? REVIEW_DETECTOR_ACTOR, candidates: run.candidates, asOf,
    allowAutoResolve: run.complete, preview: asOf !== today, incompleteReasons: run.incompleteReasons,
  });
}

/** Server-internal entry point (job worker, CLI). Opens its own transaction. */
export async function runReviewDetection(executor: RentOpsQueryExecutor, organizationId: string, options: RunReviewDetectionOptions = {}): Promise<ReviewDetectionSummary> {
  if (typeof executor.transaction !== "function") throw new ValidationCommandError("Review detection requires an atomic SQL transaction", { reason: "atomic_transaction_required" });
  return executor.transaction(transaction => runReviewDetectionInTransaction(transaction, organizationId, options), { readOnly: false });
}

/** Candidates for the current state without writing (used by verify readback). */
export async function detectCurrentCandidates(executor: RentOpsQueryExecutor, organizationId: string, asOf?: string): Promise<{ candidates: ReviewCaseCandidate[]; complete: boolean; incompleteReasons: string[]; asOf: IsoDate }> {
  const date = asOf ? isoDateSchema.parse(asOf) : operatingDate();
  return detectForDate(executor, organizationId, date);
}
