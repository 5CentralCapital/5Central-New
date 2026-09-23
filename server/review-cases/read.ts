import { companyScopeSchema, nowIsoTimestamp, type CompanyScope } from "../../shared/company";
import {
  REVIEW_CASE_ACTIVE_STATES,
  REVIEW_MATERIALITY_RANK,
  REVIEW_REASONS,
  allowedReviewCaseCommands,
  nextReviewAction,
  reviewCaseDetailSchema,
  reviewCaseIdSchema,
  reviewCaseListQuerySchema,
  reviewCaseListResponseSchema,
  reviewInventorySchema,
  reviewReason,
  type ReviewCaseDetail,
  type ReviewCaseListQuery,
  type ReviewCaseListResponse,
  type ReviewCaseState,
  type ReviewInventory,
  type ReviewMateriality,
  type ReviewReasonCode,
} from "../../shared/review-cases";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { REVIEW_CASE_COLUMNS, mapReviewCaseRow, readReviewCaseEvents, toReviewCaseSummary, type ReviewCaseRow } from "./store";

export const REVIEW_CASE_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

const MATERIALITY_SQL = `CASE c.materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END`;

interface Cursor { m: number; r: string; id: string }

function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.m !== "number" || !Number.isInteger(parsed.m) || parsed.m < 0 || parsed.m > 3) throw new Error("m");
    if (typeof parsed.r !== "string" || !/^[a-z][a-z0-9_]{1,79}$/.test(parsed.r)) throw new Error("r");
    return { m: parsed.m, r: parsed.r, id: reviewCaseIdSchema.parse(parsed.id) };
  } catch {
    throw new ValidationCommandError("Review case cursor is invalid", { reason: "invalid_review_case_cursor" });
  }
}

/**
 * Restrict rows to the principal's paired grants. An organization-wide grant
 * sees everything, including organization-level cases; an entity or property
 * grant sees only cases bound to that entity or property.
 */
function grantPredicate(principal: AuthenticatedPrincipal, values: unknown[]): string {
  if (principal.authorizedScopes.some(grant => grant.legalEntityId === undefined)) return "TRUE";
  const clauses = principal.authorizedScopes.map(grant => {
    values.push(grant.legalEntityId);
    const entity = `c.legal_entity_id = $${values.length}::uuid`;
    if (grant.propertyId === undefined) return `(${entity})`;
    values.push(grant.propertyId);
    return `(${entity} AND c.property_id = $${values.length})`;
  });
  return clauses.length ? `(${clauses.join(" OR ")})` : "FALSE";
}

function scopePredicates(scope: CompanyScope, values: unknown[]): string[] {
  values.push(scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null);
  const base = values.length - 2;
  return [`c.organization_id = $${base}`, `($${base + 1}::uuid IS NULL OR c.legal_entity_id = $${base + 1}::uuid)`, `($${base + 2}::varchar IS NULL OR c.property_id = $${base + 2})`];
}

function familyReasonCodes(families: readonly string[]): string[] {
  return REVIEW_REASONS.filter(reason => families.includes(reason.causeFamily)).map(reason => reason.code);
}

export class ReviewCaseReadService {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async list(principal: AuthenticatedPrincipal, input: ReviewCaseListQuery): Promise<ReviewCaseListResponse> {
    const query = reviewCaseListQuerySchema.parse(input);
    authorizeCompanyRead(principal, query.scope, REVIEW_CASE_READ_ROLES);
    const values: unknown[] = [];
    const where = scopePredicates(query.scope, values);
    where.push(grantPredicate(principal, values));
    const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    const states = query.states ?? REVIEW_CASE_ACTIVE_STATES;
    where.push(`c.state = ANY(${add([...states])}::text[])`);
    if (query.materialities) where.push(`c.materiality = ANY(${add([...query.materialities])}::text[])`);
    const reasonCodes = new Set<string>(query.reasonCodes ?? []);
    if (query.causeFamilies) {
      const familyCodes = familyReasonCodes(query.causeFamilies);
      if (query.reasonCodes) { for (const code of Array.from(reasonCodes)) if (!familyCodes.includes(code)) reasonCodes.delete(code); }
      else for (const code of familyCodes) reasonCodes.add(code);
    }
    if (query.reasonCodes || query.causeFamilies) where.push(`c.reason_code = ANY(${add(Array.from(reasonCodes))}::text[])`);
    const filterValues = [...values];
    const filterWhere = [...where];
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      const m = add(cursor.m); const r = add(cursor.r); const id = add(cursor.id);
      where.push(`(${MATERIALITY_SQL} > ${m} OR (${MATERIALITY_SQL} = ${m} AND (c.reason_code > ${r} OR (c.reason_code = ${r} AND c.id > ${id}::uuid))))`);
    }
    const limit = add(query.limit + 1);
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT ${REVIEW_CASE_COLUMNS}, ${MATERIALITY_SQL} AS materiality_rank
         FROM company_review_cases c WHERE ${where.join(" AND ")}
        ORDER BY materiality_rank ASC, c.reason_code ASC, c.id ASC
        LIMIT ${limit}`,
      values,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = (hasMore ? result.rows.slice(0, query.limit) : result.rows).map(mapReviewCaseRow);
    const last = rows.at(-1);
    const groupsResult = await this.executor.query<{ reason_code: string; materiality: string; case_count: string | number; affected_count: string | number }>(
      `SELECT c.reason_code, c.materiality, count(*) AS case_count, COALESCE(sum(c.affected_count), 0) AS affected_count
         FROM company_review_cases c WHERE ${filterWhere.join(" AND ")}
        GROUP BY c.reason_code, c.materiality`,
      filterValues,
    );
    const groups = new Map<string, { causeFamily: string; materiality: ReviewMateriality; caseCount: number; affectedCount: number }>();
    let caseTotal = 0; let affectedTotal = 0;
    for (const row of groupsResult.rows) {
      const reason = reviewReason(row.reason_code);
      const key = `${reason.causeFamily}|${row.materiality}`;
      const group = groups.get(key) ?? { causeFamily: reason.causeFamily, materiality: row.materiality as ReviewMateriality, caseCount: 0, affectedCount: 0 };
      group.caseCount += Number(row.case_count); group.affectedCount += Number(row.affected_count);
      caseTotal += Number(row.case_count); affectedTotal += Number(row.affected_count);
      groups.set(key, group);
    }
    return reviewCaseListResponseSchema.parse({
      items: rows.map(toReviewCaseSummary),
      groups: Array.from(groups.values()).sort((left, right) => REVIEW_MATERIALITY_RANK[left.materiality] - REVIEW_MATERIALITY_RANK[right.materiality] || left.causeFamily.localeCompare(right.causeFamily)),
      totals: { caseCount: caseTotal, affectedCount: affectedTotal },
      nextCursor: hasMore && last ? encodeCursor({ m: REVIEW_MATERIALITY_RANK[last.materiality], r: last.reasonCode, id: last.id }) : null,
    });
  }

  private async readOne(principal: AuthenticatedPrincipal, scope: CompanyScope, caseId: string): Promise<ReviewCaseRow> {
    const values: unknown[] = [];
    const where = scopePredicates(scope, values);
    where.push(grantPredicate(principal, values));
    values.push(reviewCaseIdSchema.parse(caseId));
    where.push(`c.id = $${values.length}::uuid`);
    const result = await this.executor.query<Record<string, unknown>>(`SELECT ${REVIEW_CASE_COLUMNS} FROM company_review_cases c WHERE ${where.join(" AND ")}`, values);
    const row = result.rows[0];
    if (!row) throw new ValidationCommandError("Review case was not found in the requested company scope", { reason: "review_case_not_found" });
    return mapReviewCaseRow(row);
  }

  async get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; caseId: string }): Promise<ReviewCaseDetail> {
    const scope = companyScopeSchema.parse(input.scope);
    authorizeCompanyRead(principal, scope, REVIEW_CASE_READ_ROLES);
    const row = await this.readOne(principal, scope, input.caseId);
    const reason = reviewReason(row.reasonCode);
    return reviewCaseDetailSchema.parse({
      ...toReviewCaseSummary(row),
      sourceFingerprint: row.sourceFingerprint,
      affectedRecords: row.affectedRecords,
      affectedRecordsTruncated: row.affectedRecords.length < row.affectedCount,
      evidence: row.evidence,
      proposedCorrection: row.proposedCorrection,
      history: await readReviewCaseEvents(this.executor, row.organizationId, row.id),
      allowedCommands: allowedReviewCaseCommands(row.state),
      researchGuidance: reason.researchGuidance,
      requiredVerification: reason.requiredVerification,
      resolution: reason.resolution,
    });
  }

  /**
   * Release-gate inventory: counts by reason, materiality and state, record
   * overlap across reasons, and a bounded list of every remaining case with
   * its missing evidence and next action. Impact totals are never summed.
   */
  async inventory(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; limit?: number }): Promise<ReviewInventory> {
    const scope = companyScopeSchema.parse(input.scope);
    authorizeCompanyRead(principal, scope, REVIEW_CASE_READ_ROLES);
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const values: unknown[] = [];
    const where = scopePredicates(scope, values);
    where.push(grantPredicate(principal, values));
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT ${REVIEW_CASE_COLUMNS}, ${MATERIALITY_SQL} AS materiality_rank FROM company_review_cases c WHERE ${where.join(" AND ")}
        ORDER BY materiality_rank ASC, c.reason_code ASC, c.first_detected_at ASC, c.id ASC
        LIMIT 20000`,
      values,
    );
    const rows = result.rows.map(mapReviewCaseRow);
    return summarizeReviewCaseRows(scope.organizationId, rows, limit);
  }
}

export function summarizeReviewCaseRows(organizationId: string, rows: readonly ReviewCaseRow[], limit = 200): ReviewInventory {
  const active = rows.filter(row => row.state !== "verified");
  const byReason = new Map<string, { caseCount: number; affectedCount: number }>();
  const byMateriality = new Map<ReviewMateriality, { caseCount: number; affectedCount: number }>();
  const byState = new Map<ReviewCaseState, number>();
  const recordReasons = new Map<string, Set<ReviewReasonCode>>();
  for (const row of rows) byState.set(row.state, (byState.get(row.state) ?? 0) + 1);
  for (const row of active) {
    const reason = byReason.get(row.reasonCode) ?? { caseCount: 0, affectedCount: 0 };
    reason.caseCount += 1; reason.affectedCount += row.affectedCount; byReason.set(row.reasonCode, reason);
    const materiality = byMateriality.get(row.materiality) ?? { caseCount: 0, affectedCount: 0 };
    materiality.caseCount += 1; materiality.affectedCount += row.affectedCount; byMateriality.set(row.materiality, materiality);
    for (const record of row.affectedRecords) {
      // Overlap is counted on the person/tenancy/unit a record resolves to, so one account shared by several reasons counts once.
      const identity = record.personId ? `person:${record.personId}` : record.tenancyId ? `tenancy:${record.tenancyId}` : record.unitId ? `unit:${record.unitId}` : `${record.kind}:${record.id}`;
      const set = recordReasons.get(identity) ?? new Set<ReviewReasonCode>();
      set.add(row.reasonCode); recordReasons.set(identity, set);
    }
  }
  const pairs = new Map<string, number>();
  let overlapping = 0;
  for (const reasons of Array.from(recordReasons.values())) {
    if (reasons.size < 2) continue;
    overlapping += 1;
    const sorted = Array.from(reasons).sort();
    for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) {
      const key = `${sorted[i]}|${sorted[j]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const remaining = active.slice(0, limit).map(row => {
    const reason = reviewReason(row.reasonCode);
    return {
      caseId: row.id, reasonCode: row.reasonCode, shortLabel: reason.shortLabel, scopeLabel: row.scopeLabel, propertyId: row.propertyId,
      state: row.state, materiality: row.materiality, affectedCount: row.affectedCount, impactCents: row.impactCents,
      missingEvidence: row.state === "blocked" && row.blockedOn ? row.blockedOn : reason.requiredVerification,
      nextAction: nextReviewAction(row.state, reason.resolution, row.blockedOn),
    };
  });
  return reviewInventorySchema.parse({
    organizationId,
    generatedAt: nowIsoTimestamp(),
    totals: {
      activeCaseCount: active.length,
      verifiedCaseCount: rows.length - active.length,
      affectedRecordCount: recordReasons.size,
      overlappingRecordCount: overlapping,
      unknownImpactCaseCount: active.filter(row => row.impactCents === null).length,
    },
    byReason: Array.from(byReason.entries()).map(([reasonCode, value]) => {
      const reason = reviewReason(reasonCode);
      return { reasonCode, shortLabel: reason.shortLabel, causeFamily: reason.causeFamily, ...value };
    }).sort((left, right) => right.caseCount - left.caseCount || left.reasonCode.localeCompare(right.reasonCode)),
    byMateriality: Array.from(byMateriality.entries()).map(([materiality, value]) => ({ materiality, ...value }))
      .sort((left, right) => REVIEW_MATERIALITY_RANK[left.materiality] - REVIEW_MATERIALITY_RANK[right.materiality]),
    byState: Array.from(byState.entries()).map(([state, caseCount]) => ({ state, caseCount })).sort((left, right) => left.state.localeCompare(right.state)),
    overlap: Array.from(pairs.entries()).map(([key, recordCount]) => ({ reasonCodes: key.split("|") as [ReviewReasonCode, ReviewReasonCode], recordCount }))
      .sort((left, right) => right.recordCount - left.recordCount).slice(0, 50),
    remaining,
    remainingTruncated: active.length > remaining.length,
  });
}

