import { createHash, randomUUID } from "node:crypto";
import {
  centsFromBigInt,
  centsToBigInt,
  isoDateSchema,
  isoTimestampSchema,
  type CompanyScope,
} from "../../shared/company";
import { financialSourceReferenceSchema, type FinancialSourceReference } from "../../shared/accounting/source";
import {
  TIME_PAYROLL_SOURCE_KIND,
  allocatePayrollToTimesheets,
  projectLaborResponseSchema,
  timePayrollLinkListSchema,
  type ProjectLaborResponse,
  type TimeConnectionScope,
  type TimePayrollLink,
  type TimePayrollLinkPayload,
  type TimePayrollUnlinkPayload,
} from "../../shared/time";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ProjectExecutionFinancePorts } from "../projects/execution-commands";
import { reserveCostAllocation, verifyCostSourceLine } from "../projects/source-lines";

const PROJECT_LABOR_ROW_LIMIT = 5_000;
export const TIME_PAYROLL_CONSUMER_KIND = "time_payroll" as const;

function scopeParts(scope: TimeConnectionScope): unknown[] { return [scope.organizationId, scope.legalEntityId, scope.environment, scope.providerCompanyId]; }
function dateText(value: unknown): string { return isoDateSchema.parse(value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)); }
function timestampText(value: unknown): string { return isoTimestampSchema.parse(value instanceof Date ? value.toISOString() : String(value)); }
function body(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Stable per-line key: provider version is excluded so a relink reuses the row. */
export function payrollSourceReference(source: FinancialSourceReference, timesheetId: string): string {
  const line = [source.environment, source.realmId, source.objectType, source.objectId, source.lineId ?? "*"].join("\u0000");
  return `qbo:${createHash("sha256").update(line).digest("hex").slice(0, 32)}:${timesheetId}`;
}

/**
 * Approved project time with its labor basis. Posted payroll linked to a
 * timesheet always counts (it is real cost even if the entry is later
 * revised); otherwise only approved, active entries count, at their estimate.
 */
export async function readProjectLabor(executor: RentOpsQueryExecutor, input: { organizationId: string; projectId: string; scopeItemIds?: readonly string[] }): Promise<ProjectLaborResponse> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT t.id, t.entry_date, t.provider_user_id, t.provider_jobcode_id, t.duration_seconds, jm.cost_code,
            le.labor_cost_cents::text AS estimate_cents, le.currency AS estimate_currency,
            pp.posted_cents, pp.posted_currency,
            (t.review_state = 'approved' AND t.provider_active AND t.deleted_at IS NULL) AS approved
       FROM time_timesheets t
       JOIN time_jobcode_mappings jm
         ON jm.organization_id=t.organization_id AND jm.legal_entity_id=t.legal_entity_id AND jm.environment=t.environment
        AND jm.provider_company_id=t.provider_company_id AND jm.provider_jobcode_id=t.provider_jobcode_id AND jm.status='active'
       LEFT JOIN time_labor_estimates le ON le.organization_id=t.organization_id AND le.timesheet_id=t.id
       LEFT JOIN LATERAL (
         SELECT SUM(s.amount_cents)::text AS posted_cents, MIN(s.currency) AS posted_currency
           FROM time_posted_payroll_sources s
          WHERE s.organization_id=t.organization_id AND s.timesheet_id=t.id AND s.evidence_state='verified'
       ) pp ON true
      WHERE t.organization_id=$1 AND jm.project_id=$2
        AND ((t.review_state='approved' AND t.provider_active AND t.deleted_at IS NULL) OR pp.posted_cents IS NOT NULL)
      ORDER BY t.entry_date, t.id
      LIMIT ${PROJECT_LABOR_ROW_LIMIT + 1}`,
    [input.organizationId, input.projectId],
  );
  const scopeIds = new Set(input.scopeItemIds ?? []);
  const rows = result.rows.slice(0, PROJECT_LABOR_ROW_LIMIT).map((row) => {
    const posted = row.posted_cents === null || row.posted_cents === undefined ? null : centsFromBigInt(centsToBigInt(String(row.posted_cents)));
    const estimate = row.estimate_cents === null || row.estimate_cents === undefined ? null : centsFromBigInt(centsToBigInt(String(row.estimate_cents)));
    const costCode = row.cost_code === null || row.cost_code === undefined ? null : String(row.cost_code);
    return {
      timesheetId: String(row.id), entryDate: dateText(row.entry_date), providerUserId: String(row.provider_user_id), providerJobcodeId: String(row.provider_jobcode_id),
      durationSeconds: Number(row.duration_seconds), costCode, scopeItemId: costCode !== null && scopeIds.has(costCode) ? costCode : null,
      currency: posted !== null ? String(row.posted_currency) : estimate !== null ? String(row.estimate_currency) : null,
      estimatedCents: estimate, postedCents: posted, basis: posted !== null ? "posted_payroll" as const : estimate !== null ? "estimated" as const : "unpriced" as const,
    };
  });
  let approvedSeconds = 0; let estimated = BigInt(0); let postedTotal = BigInt(0); let unpriced = 0;
  for (const row of rows) {
    approvedSeconds += row.durationSeconds;
    if (row.postedCents !== null) postedTotal += centsToBigInt(row.postedCents);
    else if (row.estimatedCents !== null) estimated += centsToBigInt(row.estimatedCents);
    else unpriced += 1;
  }
  return projectLaborResponseSchema.parse({ projectId: input.projectId, rows, truncated: result.rows.length > PROJECT_LABOR_ROW_LIMIT, approvedSeconds, estimatedCents: centsFromBigInt(estimated), postedCents: centsFromBigInt(postedTotal), unpricedEntries: unpriced });
}

export interface PayrollCommandContext {
  readonly executor: RentOpsQueryExecutor;
  readonly scope: TimeConnectionScope;
  readonly actorId: string;
  readonly effectiveDate: string;
  readonly finance: ProjectExecutionFinancePorts | undefined;
}

/**
 * Link one posted payroll/journal line to approved timesheets for a pay
 * period. The amount is reserved in the central QBO allocation ledger (one
 * line cannot be consumed twice) and split exactly across the timesheets; a
 * timesheet can carry only one active payroll link.
 */
export async function linkPayroll(context: PayrollCommandContext, payload: TimePayrollLinkPayload): Promise<{ batchId: string; timesheetIds: readonly string[] }> {
  const { executor, scope } = context;
  const source = financialSourceReferenceSchema.parse(payload.source);
  if (source.organizationId !== scope.organizationId || source.legalEntityId !== scope.legalEntityId) throw new ValidationCommandError("Payroll line belongs to another company or entity", { reason: "time_payroll_scope_mismatch" });
  if (!context.finance) throw new ValidationCommandError("Verified QuickBooks source lines are unavailable", { reason: "time_payroll_finance_unavailable" });
  const line = await verifyCostSourceLine(context.finance, { source, amountCents: payload.amountCents, currency: (await entityCurrency(executor, scope)), effectiveDate: context.effectiveDate, purpose: "payroll", reasonPrefix: "time_payroll" });
  const values: unknown[] = [...scopeParts(scope), payload.periodFrom, payload.periodThrough];
  let filter = "";
  if (payload.providerUserIds) { values.push(payload.providerUserIds); filter += ` AND t.provider_user_id = ANY($${values.length}::varchar[])`; }
  if (payload.timesheetIds) { values.push(payload.timesheetIds); filter += ` AND t.id = ANY($${values.length}::uuid[])`; }
  const candidates = await executor.query<Record<string, unknown>>(
    `SELECT t.id, t.duration_seconds, le.labor_cost_cents::text AS estimate_cents, le.currency AS estimate_currency
       FROM time_timesheets t
       LEFT JOIN time_labor_estimates le ON le.organization_id=t.organization_id AND le.timesheet_id=t.id
      WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.provider_company_id=$4
        AND t.entry_date BETWEEN $5::date AND $6::date
        AND t.review_state='approved' AND t.provider_active AND t.deleted_at IS NULL${filter}
      ORDER BY t.entry_date, t.id
      FOR UPDATE OF t`,
    values,
  );
  if (payload.timesheetIds && candidates.rows.length !== payload.timesheetIds.length) throw new ValidationCommandError("Every named timesheet must be approved and inside the pay period", { reason: "time_payroll_timesheet_ineligible" });
  if (!candidates.rows.length) throw new ValidationCommandError("No approved time in this pay period", { reason: "time_payroll_no_timesheets" });
  const ids = candidates.rows.map((row) => String(row.id));
  const linked = await executor.query<{ timesheet_id: string }>(
    `SELECT DISTINCT timesheet_id FROM time_posted_payroll_sources WHERE organization_id=$1 AND timesheet_id = ANY($2::uuid[]) AND evidence_state='verified'`,
    [scope.organizationId, ids],
  );
  if (linked.rows.length) throw new ConflictCommandError("Some of this time already has posted payroll linked", { reason: "time_payroll_already_linked", count: linked.rows.length });
  const split = allocatePayrollToTimesheets(payload.amountCents, candidates.rows.map((row) => ({
    id: String(row.id),
    estimatedCents: row.estimate_cents === null || row.estimate_cents === undefined || String(row.estimate_currency) !== line.currency ? null : String(row.estimate_cents),
    durationSeconds: Number(row.duration_seconds),
  })));
  const batchId = randomUUID();
  await reserveCostAllocation(context.finance, { source, consumerKind: TIME_PAYROLL_CONSUMER_KIND, consumerId: batchId, amountCents: payload.amountCents, currency: line.currency }, "time_payroll");
  const linkedAt = new Date().toISOString();
  for (const item of split) {
    const providerBody = { kind: "qbo_payroll_link", status: "active", batchId, source, periodFrom: payload.periodFrom, periodThrough: payload.periodThrough, batchAmountCents: payload.amountCents, lineAmountCents: line.amountCents, linkedBy: context.actorId, linkedAt };
    const result = await executor.query(
      `INSERT INTO time_posted_payroll_sources (id, organization_id, legal_entity_id, timesheet_id, source_kind, source_reference, amount_cents, currency, posted_on, evidence_state, provider_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9::date,'verified',$10::jsonb)
       ON CONFLICT (organization_id, source_kind, source_reference) DO UPDATE
         SET amount_cents=EXCLUDED.amount_cents, currency=EXCLUDED.currency, posted_on=EXCLUDED.posted_on, evidence_state='verified', provider_body=EXCLUDED.provider_body
         WHERE time_posted_payroll_sources.evidence_state='unverified'
       RETURNING id`,
      [randomUUID(), scope.organizationId, scope.legalEntityId, item.id, TIME_PAYROLL_SOURCE_KIND, payrollSourceReference(source, item.id), item.amountCents, line.currency, line.postedOn, JSON.stringify(providerBody)],
    );
    if (result.rows.length !== 1) throw new ConflictCommandError("This payroll line is already linked to that time", { reason: "time_payroll_already_linked" });
  }
  return { batchId, timesheetIds: ids };
}

/** Release a payroll link. Rows are kept for audit and marked released. */
export async function unlinkPayroll(context: PayrollCommandContext, payload: TimePayrollUnlinkPayload): Promise<{ batchId: string; timesheetIds: readonly string[] }> {
  const { executor, scope } = context;
  if (!context.finance) throw new ValidationCommandError("Verified QuickBooks source lines are unavailable", { reason: "time_payroll_finance_unavailable" });
  const rows = await executor.query<Record<string, unknown>>(
    `SELECT id, timesheet_id, amount_cents::text AS amount_cents, currency, provider_body FROM time_posted_payroll_sources
      WHERE organization_id=$1 AND legal_entity_id=$2 AND source_kind=$3 AND evidence_state='verified' AND provider_body->>'batchId' = $4
      FOR UPDATE`,
    [scope.organizationId, scope.legalEntityId, TIME_PAYROLL_SOURCE_KIND, payload.batchId],
  );
  if (!rows.rows.length) throw new ValidationCommandError("This payroll link is not active", { reason: "time_payroll_link_not_found" });
  const source = financialSourceReferenceSchema.parse(body(rows.rows[0]!.provider_body).source);
  const total = rows.rows.reduce((sum, row) => sum + centsToBigInt(String(row.amount_cents)), BigInt(0));
  await context.finance.allocations.release({ source, consumerKind: TIME_PAYROLL_CONSUMER_KIND, consumerId: payload.batchId, amountCents: centsFromBigInt(total), currency: String(rows.rows[0]!.currency) });
  await executor.query(
    `UPDATE time_posted_payroll_sources
        SET evidence_state='unverified', provider_body = provider_body || $5::jsonb
      WHERE organization_id=$1 AND legal_entity_id=$2 AND source_kind=$3 AND provider_body->>'batchId' = $4 AND evidence_state='verified'`,
    [scope.organizationId, scope.legalEntityId, TIME_PAYROLL_SOURCE_KIND, payload.batchId, JSON.stringify({ status: "released", releasedBy: context.actorId, releasedAt: new Date().toISOString(), releaseReason: payload.reason })],
  );
  return { batchId: payload.batchId, timesheetIds: rows.rows.map((row) => String(row.timesheet_id)) };
}

export async function listPayrollLinks(executor: RentOpsQueryExecutor, scope: CompanyScope & { legalEntityId: string }): Promise<readonly TimePayrollLink[]> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT provider_body->>'batchId' AS batch_id, MIN(provider_body::text) AS body, SUM(amount_cents)::text AS amount_cents, MIN(currency) AS currency,
            MIN(posted_on) AS posted_on, COUNT(*) AS timesheet_count, BOOL_OR(evidence_state='verified') AS active, MIN(created_at) AS created_at
       FROM time_posted_payroll_sources
      WHERE organization_id=$1 AND legal_entity_id=$2 AND source_kind=$3 AND provider_body ? 'batchId'
      GROUP BY provider_body->>'batchId'
      ORDER BY MIN(posted_on) DESC, provider_body->>'batchId'
      LIMIT 500`,
    [scope.organizationId, scope.legalEntityId, TIME_PAYROLL_SOURCE_KIND],
  );
  return timePayrollLinkListSchema.parse({ items: result.rows.map((row) => {
    const providerBody = body(row.body);
    return {
      batchId: String(row.batch_id), source: providerBody.source, currency: String(row.currency), amountCents: centsFromBigInt(centsToBigInt(String(row.amount_cents))),
      periodFrom: providerBody.periodFrom, periodThrough: providerBody.periodThrough, postedOn: dateText(row.posted_on), timesheetCount: Number(row.timesheet_count),
      status: row.active === true || row.active === "t" ? "active" : "released", linkedAt: typeof providerBody.linkedAt === "string" ? providerBody.linkedAt : timestampText(row.created_at),
    };
  }) }).items;
}

async function entityCurrency(executor: RentOpsQueryExecutor, scope: TimeConnectionScope): Promise<string> {
  const result = await executor.query<{ currency: string }>(`SELECT currency FROM company_legal_entities WHERE organization_id=$1 AND id=$2`, [scope.organizationId, scope.legalEntityId]);
  const currency = result.rows[0]?.currency;
  if (!currency) throw new ValidationCommandError("Legal entity is unavailable", { reason: "time_entity_unavailable" });
  return currency;
}
