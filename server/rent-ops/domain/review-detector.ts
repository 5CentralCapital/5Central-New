import { createHash } from "node:crypto";
import type { DelinquencyRow, RentOpsSnapshot, RentRollRow, ScheduledIncomeRow } from "../../../shared/rent-ops-contracts";
import {
  REVIEW_MATERIALITY_RANK,
  classifyReviewCode,
  reviewReason,
  type ReviewAffectedRecord,
  type ReviewMateriality,
  type ReviewReasonCode,
  type ReviewScopeLevel,
} from "../../../shared/review-cases";
import type { AccountHistoryCoverage } from "../import/account-history-coverage";
import { RentOpsInvariantError } from "./invariants";
import { deriveDelinquency, deriveRentRoll, deriveScheduledIncome } from "./reports";

/**
 * Pure review-case detector. It turns the uncertainty and invariant codes that
 * the rental reports already compute, plus coverage, QuickBooks connection and
 * intake state, into deduplicated case candidates: one candidate per
 * (reason, cause, scope) with its affected records listed separately. It
 * performs no I/O and never infers a missing amount: impact stays null unless
 * every contributing amount is known.
 */

export interface ReviewDetectorViolation { readonly code: string; readonly entityId: string; readonly message?: string }

export interface ReviewDetectorQboConnection {
  readonly legalEntityId: string;
  readonly legalEntityName?: string | null;
  readonly environment: string;
  readonly realmId: string;
  readonly status: "active" | "revoked" | "needs_reconnect";
}

export interface ReviewDetectorSyncException {
  readonly legalEntityId: string;
  readonly legalEntityName?: string | null;
  readonly stream: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly exceptionKind: "unsupported" | "missing_from_full_replay";
  readonly reasons: readonly string[];
}

export interface ReviewDetectorIntakeLine {
  readonly sourceLineKey: string;
  readonly outcome: string | null;
  readonly outcomeReason?: string | null;
  readonly amountCents: string;
  readonly currency: string;
  readonly sourceAccountId: string;
  readonly tenantDisplayName?: string | null;
}

export interface ReviewDetectorIntakePacket {
  readonly id: string;
  readonly fileName: string;
  readonly legalEntityId?: string | null;
  readonly propertyId?: string | null;
  readonly lines: readonly ReviewDetectorIntakeLine[];
}

export interface ReviewDetectorInput {
  readonly asOf: string;
  readonly snapshot: RentOpsSnapshot;
  /** Organization property scope; observations at other properties are ignored. Undefined keeps all. */
  readonly propertyIds?: ReadonlySet<string>;
  /** Legal entity owning each property on the as-of date. */
  readonly propertyEntities?: ReadonlyMap<string, string>;
  /** Precomputed report rows; computed from the snapshot when omitted. */
  readonly reports?: {
    readonly rentRoll?: readonly RentRollRow[];
    readonly delinquency?: readonly DelinquencyRow[];
    readonly scheduledIncome?: readonly ScheduledIncomeRow[];
    readonly violations?: readonly ReviewDetectorViolation[];
  };
  /** Per-person imported history coverage, when coverage evidence is available. */
  readonly coverage?: ReadonlyMap<string, AccountHistoryCoverage>;
  readonly qbo?: { readonly connections: readonly ReviewDetectorQboConnection[]; readonly syncExceptions: readonly ReviewDetectorSyncException[] };
  readonly intake?: { readonly packets: readonly ReviewDetectorIntakePacket[] };
}

export interface ReviewDetectorEvidence { readonly code: string; readonly count: number; readonly message: string }

export interface ReviewCaseCandidate {
  readonly reasonCode: ReviewReasonCode;
  readonly causeKey: string;
  readonly scopeKey: string;
  readonly scopeLevel: ReviewScopeLevel;
  readonly scopeLabel: string | null;
  readonly legalEntityId: string | null;
  readonly propertyId: string | null;
  readonly affectedRecords: readonly ReviewAffectedRecord[];
  readonly affectedCount: number;
  readonly asOf: string;
  /** Exact signed cents as a decimal string, or null when not determinable. */
  readonly impactCents: string | null;
  readonly impactCurrency: string | null;
  readonly materiality: ReviewMateriality;
  readonly sourceFingerprint: string;
  readonly codes: readonly string[];
  readonly evidence: readonly ReviewDetectorEvidence[];
}

/** One observed code on one record, before grouping. */
interface Observation {
  readonly code: string;
  readonly record: Omit<ReviewAffectedRecord, "codes">;
  /** Account key (person@property) for account-scoped reasons. */
  readonly accountKey?: string;
  readonly legalEntityId?: string | null;
  readonly packetId?: string;
  readonly packetLabel?: string;
  readonly impactCents: bigint | null;
  readonly currency?: string;
  readonly message?: string;
}

const MAX_STORED_RECORDS = 500;
const HIGH_IMPACT_CENTS = BigInt(100_000);

function recordKey(record: Pick<ReviewAffectedRecord, "kind" | "id">): string { return `${record.kind}:${record.id}`; }

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function absolute(value: bigint): bigint { return value < BigInt(0) ? -value : value; }

class SnapshotIndex {
  readonly properties: Map<string, RentOpsSnapshot["properties"][number]>;
  readonly units: Map<string, RentOpsSnapshot["units"][number]>;
  readonly tenancies: Map<string, RentOpsSnapshot["tenancies"][number]>;
  readonly people: Map<string, RentOpsSnapshot["people"][number]>;
  readonly leaseTerms: Map<string, RentOpsSnapshot["leaseTerms"][number]>;
  readonly schedules: Map<string, RentOpsSnapshot["recurringSchedules"][number]>;
  readonly ledger: Map<string, RentOpsSnapshot["ledgerTransactions"][number]>;

  constructor(snapshot: RentOpsSnapshot) {
    this.properties = new Map(snapshot.properties.map(row => [row.id, row]));
    this.units = new Map(snapshot.units.map(row => [row.id, row]));
    this.tenancies = new Map(snapshot.tenancies.map(row => [row.id, row]));
    this.people = new Map(snapshot.people.map(row => [row.id, row]));
    this.leaseTerms = new Map((snapshot.leaseTerms ?? []).map(row => [row.id, row]));
    this.schedules = new Map((snapshot.recurringSchedules ?? []).map(row => [row.id, row]));
    this.ledger = new Map((snapshot.ledgerTransactions ?? []).map(row => [row.id, row]));
  }

  personName(personId: string | null | undefined): string | null {
    if (!personId) return null;
    const person = this.people.get(personId);
    const name = person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() : "";
    return name || null;
  }

  propertyName(propertyId: string | null | undefined): string | null {
    return propertyId ? this.properties.get(propertyId)?.name ?? null : null;
  }

  unitLabel(unitId: string | null | undefined): string | null {
    if (!unitId) return null;
    const unit = this.units.get(unitId);
    return unit ? `Unit ${unit.unitNumber}` : null;
  }

  tenancyRecord(tenancyId: string): Omit<ReviewAffectedRecord, "codes"> {
    const tenancy = this.tenancies.get(tenancyId);
    const label = [this.personName(tenancy?.primaryPersonId), this.unitLabel(tenancy?.unitId)].filter(Boolean).join(" · ") || null;
    return { kind: "tenancy", id: tenancyId, label, propertyId: tenancy?.propertyId ?? null, unitId: tenancy?.unitId ?? null, tenancyId, personId: tenancy?.primaryPersonId ?? null };
  }

  unitRecord(unitId: string, propertyId?: string | null): Omit<ReviewAffectedRecord, "codes"> {
    const unit = this.units.get(unitId);
    return { kind: "unit", id: unitId, label: this.unitLabel(unitId), propertyId: unit?.propertyId ?? propertyId ?? null, unitId, tenancyId: null, personId: null };
  }

  personRecord(personId: string, propertyId: string | null, tenancyId: string | null, unitId: string | null, name?: string | null): Omit<ReviewAffectedRecord, "codes"> {
    return { kind: "person", id: personId, label: name ?? this.personName(personId), propertyId, unitId, tenancyId, personId };
  }

  /** Resolve an invariant violation's entity to the record it names. */
  entityRecord(entityId: string): Omit<ReviewAffectedRecord, "codes"> {
    if (this.tenancies.has(entityId)) return this.tenancyRecord(entityId);
    if (this.units.has(entityId)) return this.unitRecord(entityId);
    if (this.people.has(entityId)) return this.personRecord(entityId, null, null, null);
    const lease = this.leaseTerms.get(entityId);
    if (lease) {
      const tenancy = lease.tenancyId ? this.tenancies.get(lease.tenancyId) : undefined;
      return { kind: "lease_term", id: entityId, label: tenancy ? this.tenancyRecord(tenancy.id).label : null, propertyId: tenancy?.propertyId ?? null, unitId: tenancy?.unitId ?? null, tenancyId: tenancy?.id ?? null, personId: tenancy?.primaryPersonId ?? null };
    }
    const schedule = this.schedules.get(entityId);
    if (schedule) return { kind: "schedule", id: entityId, label: schedule.description ?? null, propertyId: schedule.propertyId ?? null, unitId: schedule.unitId ?? null, tenancyId: schedule.tenancyId ?? null, personId: schedule.personId ?? null };
    const ledger = this.ledger.get(entityId);
    if (ledger) return { kind: "ledger_transaction", id: entityId, label: ledger.description ?? null, propertyId: ledger.propertyId ?? null, unitId: ledger.unitId ?? null, tenancyId: ledger.tenancyId ?? null, personId: ledger.personId ?? null };
    if (this.properties.has(entityId)) return { kind: "property", id: entityId, label: this.propertyName(entityId), propertyId: entityId, unitId: null, tenancyId: null, personId: null };
    return { kind: "tenancy", id: entityId, label: null, propertyId: null, unitId: null, tenancyId: entityId, personId: null };
  }
}

function accountKey(personId: string, propertyId: string | null): string {
  return `account:${personId}@${propertyId ?? "unassigned"}`;
}

/** Rent roll and invariant codes that describe a unit rather than one tenancy. */
const UNIT_LEVEL_CODES = new Set(["market_rent_unknown", "multiple_current_tenancies", "multiple_future_tenancies", "occupancy_conflict", "overlapping_current_tenancies"]);

function reportObservations(input: ReviewDetectorInput, index: SnapshotIndex): Observation[] {
  const observations: Observation[] = [];
  const filters = { asOfDate: input.asOf } as const;
  const violations: ReviewDetectorViolation[] = [...(input.reports?.violations ?? [])];
  const capture = <T>(work: () => T[]): T[] => {
    try { return work(); } catch (error) {
      if (error instanceof RentOpsInvariantError) {
        for (const violation of error.violations ?? []) if (violation.entityId) violations.push({ code: violation.code, entityId: violation.entityId, message: violation.message });
        return [];
      }
      throw error;
    }
  };
  const rentRoll = input.reports?.rentRoll ?? capture(() => deriveRentRoll(input.snapshot, filters));
  const delinquency = input.reports?.delinquency ?? capture(() => deriveDelinquency(input.snapshot, { ...filters, tenantStatus: "all" }));
  const scheduled = input.reports?.scheduledIncome ?? capture(() => deriveScheduledIncome(input.snapshot, filters));

  for (const row of rentRoll) {
    for (const code of Array.from(new Set(row.exceptionCodes ?? []))) {
      const record = row.tenancyId && !UNIT_LEVEL_CODES.has(code) ? index.tenancyRecord(row.tenancyId) : index.unitRecord(row.unitId, row.propertyId);
      observations.push({ code, record: { ...record, propertyId: record.propertyId ?? row.propertyId }, impactCents: null });
    }
    if (row.tenancyId) {
      const tenancy = index.tenancies.get(row.tenancyId);
      const personId = tenancy?.primaryPersonId ?? row.currentPersonId ?? null;
      for (const code of Array.from(new Set(row.balanceUncertaintyCodes ?? []))) {
        if (!personId) {
          observations.push({ code, record: index.tenancyRecord(row.tenancyId), impactCents: null });
          continue;
        }
        observations.push({ code, record: index.personRecord(personId, row.propertyId, row.tenancyId, row.unitId, row.currentTenantName ?? null), accountKey: accountKey(personId, row.propertyId), impactCents: null });
      }
    }
  }
  for (const row of delinquency) {
    for (const code of Array.from(new Set(row.balanceUncertaintyCodes ?? []))) {
      let impact: bigint | null = null;
      // A stale owner review has a determinable gap only when both sides are known.
      if (code === "balance_review_stale" && row.balanceReview && Number.isSafeInteger(row.balanceReview.reviewedBalanceCents) && Number.isSafeInteger(row.totalBalanceCents)) {
        impact = absolute(BigInt(row.totalBalanceCents as number) - BigInt(row.balanceReview.reviewedBalanceCents as number));
      }
      observations.push({ code, record: index.personRecord(row.personId, row.propertyId, row.tenancyId, row.unitId ?? null, row.tenantName), accountKey: accountKey(row.personId, row.propertyId), impactCents: impact });
    }
  }
  for (const row of scheduled) {
    for (const code of Array.from(new Set(row.exceptionCodes ?? []))) {
      const record = row.tenancyId ? index.tenancyRecord(row.tenancyId)
        : { kind: "schedule" as const, id: row.scheduleId, label: row.tenantName ?? null, propertyId: row.propertyId ?? null, unitId: row.unitId ?? null, tenancyId: null, personId: row.personId ?? null };
      observations.push({ code, record: { ...record, propertyId: record.propertyId ?? row.propertyId ?? null }, impactCents: null });
    }
  }
  for (const violation of violations) {
    const record = index.entityRecord(violation.entityId);
    observations.push({ code: violation.code, record, accountKey: record.personId ? accountKey(record.personId, record.propertyId) : undefined, impactCents: null, message: violation.message });
  }
  return observations;
}

function coverageObservations(input: ReviewDetectorInput, index: SnapshotIndex): Observation[] {
  const observations: Observation[] = [];
  for (const [personId, coverage] of Array.from(input.coverage?.entries() ?? [])) {
    if (coverage.status === "verified") continue;
    const reasons = coverage.reasons.length ? coverage.reasons : ["source_coverage_not_verified"];
    for (const code of Array.from(new Set(reasons))) observations.push({ code, record: index.personRecord(personId, null, null, null), accountKey: accountKey(personId, null), impactCents: null });
  }
  return observations;
}

function qboObservations(input: ReviewDetectorInput): Observation[] {
  const observations: Observation[] = [];
  const byEntity = new Map<string, ReviewDetectorQboConnection[]>();
  for (const connection of input.qbo?.connections ?? []) {
    const list = byEntity.get(connection.legalEntityId) ?? [];
    list.push(connection); byEntity.set(connection.legalEntityId, list);
  }
  for (const [legalEntityId, connections] of Array.from(byEntity.entries())) {
    if (connections.some(connection => connection.status === "active")) continue;
    for (const connection of connections) {
      observations.push({
        code: connection.status === "revoked" ? "qbo_revoked" : "qbo_needs_reconnect",
        record: { kind: "legal_entity", id: legalEntityId, label: connection.legalEntityName ?? null, propertyId: null, unitId: null, tenancyId: null, personId: null },
        legalEntityId, impactCents: null, message: `QuickBooks ${connection.environment} company ${connection.realmId} is ${connection.status.replace("_", " ")}.`,
      });
    }
  }
  for (const exception of input.qbo?.syncExceptions ?? []) {
    observations.push({
      code: exception.exceptionKind === "unsupported" ? "qbo_sync_unsupported" : "qbo_sync_missing_from_full_replay",
      record: { kind: "qbo_object", id: `${exception.objectType}:${exception.objectId}`, label: exception.objectType, propertyId: null, unitId: null, tenancyId: null, personId: null },
      legalEntityId: exception.legalEntityId, packetLabel: exception.legalEntityName ?? undefined, impactCents: null,
      message: exception.reasons.slice(0, 3).join("; ") || undefined, accountKey: exception.stream,
    });
  }
  return observations;
}

function intakeObservations(input: ReviewDetectorInput): Observation[] {
  const observations: Observation[] = [];
  const codeFor = (outcome: string | null): string | undefined => outcome === "held_missing_identity" ? "intake_held_missing_identity"
    : outcome === "held_ambiguous_identity" ? "intake_held_ambiguous_identity"
      : outcome === "held_unsupported" ? "intake_held_unsupported"
        : outcome === "apply_failed" ? "intake_apply_failed" : undefined;
  for (const packet of input.intake?.packets ?? []) {
    for (const line of packet.lines) {
      const code = codeFor(line.outcome);
      if (!code) continue;
      let impact: bigint | null = null;
      if (/^-?\d{1,19}$/.test(line.amountCents)) impact = absolute(BigInt(line.amountCents));
      observations.push({
        code,
        record: { kind: "intake_line", id: line.sourceLineKey, label: line.tenantDisplayName ?? line.sourceAccountId, propertyId: packet.propertyId ?? null, unitId: null, tenancyId: null, personId: null },
        packetId: packet.id, packetLabel: packet.fileName, legalEntityId: packet.legalEntityId ?? null,
        impactCents: impact, currency: line.currency, message: line.outcomeReason ?? undefined,
      });
    }
  }
  return observations;
}

interface Group {
  reasonCode: ReviewReasonCode;
  causeKey: string;
  scopeKey: string;
  scopeLevel: ReviewScopeLevel;
  scopeLabel: string | null;
  legalEntityId: string | null;
  propertyId: string | null;
  records: Map<string, ReviewAffectedRecord>;
  codes: Map<string, { count: number; message?: string }>;
  impact: bigint | null;
  impactKnown: boolean;
  currency: string | null;
  currencyMixed: boolean;
}

function materialityFor(defaultMateriality: ReviewMateriality, impact: bigint | null, affectedCount: number): ReviewMateriality {
  let materiality = defaultMateriality;
  if (impact !== null && absolute(impact) >= HIGH_IMPACT_CENTS) materiality = "high";
  if (affectedCount >= 10 && REVIEW_MATERIALITY_RANK[materiality] > REVIEW_MATERIALITY_RANK.medium) materiality = "medium";
  return materiality;
}

function scopeFor(observation: Observation, level: ReviewScopeLevel, index: SnapshotIndex, input: ReviewDetectorInput): { key: string; label: string | null; propertyId: string | null; legalEntityId: string | null } {
  const propertyId = observation.record.propertyId;
  const entityFor = (id: string | null) => (id ? input.propertyEntities?.get(id) ?? null : null) ?? observation.legalEntityId ?? null;
  const propertyLabel = index.propertyName(propertyId);
  switch (level) {
    case "organization":
      return { key: "organization", label: "All properties", propertyId: null, legalEntityId: null };
    case "legal_entity": {
      const legalEntityId = observation.legalEntityId ?? entityFor(propertyId);
      return { key: `legal_entity:${legalEntityId ?? "unassigned"}`, label: observation.packetLabel ?? (observation.record.kind === "legal_entity" ? observation.record.label : null), propertyId: null, legalEntityId };
    }
    case "packet":
      return { key: `packet:${observation.packetId ?? "unknown"}`, label: observation.packetLabel ?? null, propertyId: propertyId ?? null, legalEntityId: entityFor(propertyId) };
    case "property":
      return { key: `property:${propertyId ?? "unassigned"}`, label: propertyLabel ?? (propertyId ? null : "Unassigned records"), propertyId: propertyId ?? null, legalEntityId: entityFor(propertyId) };
    case "account": {
      const personId = observation.record.personId;
      if (!observation.accountKey || !personId) {
        const record = observation.record;
        return { key: `${record.kind}:${record.id}`, label: [record.label, propertyLabel].filter(Boolean).join(" · ") || null, propertyId, legalEntityId: entityFor(propertyId) };
      }
      const label = [index.personName(personId) ?? observation.record.label, propertyLabel].filter(Boolean).join(" · ") || null;
      return { key: observation.accountKey, label, propertyId, legalEntityId: entityFor(propertyId) };
    }
    case "record": {
      const record = observation.record;
      const label = [record.label, propertyLabel].filter(Boolean).join(" · ") || null;
      return { key: `${record.kind}:${record.id}`, label, propertyId, legalEntityId: entityFor(propertyId) };
    }
  }
}

/** Detect deduplicated review case candidates. Deterministic for identical input. */
export function detectReviewCases(input: ReviewDetectorInput): ReviewCaseCandidate[] {
  const index = new SnapshotIndex(input.snapshot);
  const observations = [
    ...reportObservations(input, index),
    ...coverageObservations(input, index),
    ...qboObservations(input),
    ...intakeObservations(input),
  ];
  const groups = new Map<string, Group>();
  for (const observation of observations) {
    const propertyId = observation.record.propertyId;
    if (propertyId && input.propertyIds && !input.propertyIds.has(propertyId)) continue;
    const reason = reviewReason(classifyReviewCode(observation.code).reason);
    const causeKey = reason.causeBy === "code"
      ? (reason.code === "sync_exception" && observation.accountKey ? `${observation.code}:${observation.accountKey}` : observation.code)
      : reason.code;
    const scope = scopeFor(observation, reason.scopeLevel, index, input);
    const key = JSON.stringify([reason.code, causeKey, scope.key]);
    let group = groups.get(key);
    if (!group) {
      group = {
        reasonCode: reason.code as ReviewReasonCode, causeKey, scopeKey: scope.key, scopeLevel: reason.scopeLevel, scopeLabel: scope.label,
        legalEntityId: scope.legalEntityId, propertyId: scope.propertyId, records: new Map(), codes: new Map(),
        impact: BigInt(0), impactKnown: true, currency: null, currencyMixed: false,
      };
      groups.set(key, group);
    }
    if (!group.scopeLabel && scope.label) group.scopeLabel = scope.label;
    if (!group.legalEntityId && scope.legalEntityId) group.legalEntityId = scope.legalEntityId;
    const rKey = recordKey(observation.record);
    const existing = group.records.get(rKey);
    const firstForRecord = !existing;
    if (existing) {
      if (!existing.codes.includes(observation.code)) group.records.set(rKey, { ...existing, codes: [...existing.codes, observation.code].sort() });
    } else {
      group.records.set(rKey, { ...observation.record, codes: [observation.code] });
    }
    const codeEntry = group.codes.get(observation.code) ?? { count: 0, message: observation.message };
    if (firstForRecord || !existing?.codes.includes(observation.code)) codeEntry.count += 1;
    group.codes.set(observation.code, codeEntry);
    // Impact: one amount per record; any unknown contribution makes the total unknown.
    if (firstForRecord) {
      if (observation.impactCents === null) group.impactKnown = false;
      else if (group.impactKnown) group.impact = (group.impact ?? BigInt(0)) + observation.impactCents;
      const currency = observation.currency ?? (observation.impactCents === null ? null : "USD");
      if (currency) {
        if (group.currency && group.currency !== currency) group.currencyMixed = true;
        group.currency = group.currency ?? currency;
      }
    }
  }
  const candidates: ReviewCaseCandidate[] = [];
  for (const group of Array.from(groups.values())) {
    const reason = reviewReason(group.reasonCode);
    const records = Array.from(group.records.values()).sort((left, right) => recordKey(left).localeCompare(recordKey(right)));
    const impact = group.impactKnown && !group.currencyMixed && records.length > 0 ? group.impact : null;
    const codes = Array.from(group.codes.keys()).sort();
    const fingerprint = sha256({
      reasonCode: group.reasonCode, causeKey: group.causeKey, scopeKey: group.scopeKey,
      records: records.map(record => [record.kind, record.id, record.codes]),
      impactCents: impact === null ? null : impact.toString(), codes,
    });
    candidates.push({
      reasonCode: group.reasonCode,
      causeKey: group.causeKey,
      scopeKey: group.scopeKey,
      scopeLevel: group.scopeLevel,
      scopeLabel: group.scopeLabel ? group.scopeLabel.slice(0, 240) : null,
      legalEntityId: group.legalEntityId,
      propertyId: group.propertyId,
      affectedRecords: records.slice(0, MAX_STORED_RECORDS).map(record => ({ ...record, label: record.label ? record.label.slice(0, 240) : null, codes: record.codes.slice(0, 50) })),
      affectedCount: records.length,
      asOf: input.asOf,
      impactCents: impact === null ? null : impact.toString(),
      impactCurrency: impact === null ? null : group.currency ?? "USD",
      materiality: materialityFor(reason.defaultMateriality, impact, records.length),
      sourceFingerprint: fingerprint,
      codes,
      evidence: codes.map(code => ({ code, count: group.codes.get(code)!.count, message: group.codes.get(code)!.message ?? `${code.replace(/_/g, " ")} on ${group.codes.get(code)!.count} record${group.codes.get(code)!.count === 1 ? "" : "s"}` })),
    });
  }
  return candidates.sort((left, right) => left.reasonCode.localeCompare(right.reasonCode) || left.causeKey.localeCompare(right.causeKey) || left.scopeKey.localeCompare(right.scopeKey));
}

/** Stable identity of a candidate within an organization. */
export function reviewCandidateKey(candidate: Pick<ReviewCaseCandidate, "reasonCode" | "causeKey" | "scopeKey">): string {
  return JSON.stringify([candidate.reasonCode, candidate.causeKey, candidate.scopeKey]);
}
