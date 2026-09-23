import { randomUUID } from "node:crypto";
import { z } from "zod";
import { centsFromBigInt, centsSchema, currencyCodeSchema, isoDateSchema, isoTimestampSchema, revisionSchema, type CompanyScope } from "../../shared/company";
import {
  timeConnectionScopeSchema,
  timeConnectionSummarySchema,
  timeCorrectionRevisionSchema,
  timeCoverageSchema,
  timeEmployeeMappingSchema,
  timeEntrySchema,
  timeJobcodeMappingSchema,
  timeJobcodeSchema,
  timeListQuerySchema,
  timeSourceReferenceSchema,
  timeUserSchema,
  type TimeConnectionScope,
  type TimeConnectionSummary,
  type TimeCoverage,
  type TimeEmployeeMapping,
  type TimeEntry,
  type TimeJobcode,
  type TimeJobcodeMapping,
  type TimeReadPort,
  type TimeSourceReference,
  type TimeUser,
} from "../../shared/time";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "../accounting/errors";
import type { NormalizedDelete, NormalizedTimeEntry, NormalizedTimeJobcode, NormalizedTimeUser } from "./normalize";

function scopeParts(scope: TimeConnectionScope): unknown[] { return [scope.organizationId, scope.legalEntityId, scope.environment, scope.providerCompanyId]; }
function dbDate(value: unknown): string { const result = isoDateSchema.safeParse(value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : value); if (!result.success) throw new AccountingError("accounting_unavailable", "Time storage returned an invalid date"); return result.data; }
function dbTimestamp(value: unknown): string { const result = isoTimestampSchema.safeParse(value instanceof Date ? value.toISOString() : value); if (!result.success) throw new AccountingError("accounting_unavailable", "Time storage returned an invalid timestamp"); return result.data; }
function dbNullableTimestamp(value: unknown): string | null { return value === null || value === undefined ? null : dbTimestamp(value); }
function dbString(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0) throw new AccountingError("accounting_unavailable", `Time storage returned an invalid ${field}`); return value; }
function dbBool(value: unknown): boolean { return value === true || value === 1 || value === "1" || value === "t"; }
function dbInt(value: unknown, field: string): number { const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new AccountingError("accounting_unavailable", `Time storage returned an invalid ${field}`); return result; }
function source(scope: TimeConnectionScope, kind: "user" | "jobcode" | "timesheet", id: string, version: string): TimeSourceReference { return timeSourceReferenceSchema.parse({ provider: "quickbooks_time", ...scope, objectKind: kind, providerObjectId: id, sourceVersion: version }); }
function roundHourSeconds(seconds: number, hourlyRateCents: bigint): bigint { const numerator = BigInt(seconds) * hourlyRateCents; const quotient = numerator / BigInt(3600); const remainder = numerator % BigInt(3600); return quotient + (remainder * BigInt(2) >= BigInt(3600) ? BigInt(1) : BigInt(0)); }
function cursorEncode(value: { readonly updatedAt: string; readonly id: string }): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function cursorDecode(value: string | undefined): { updatedAt: string; id: string } | null { if (!value) return null; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>; if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error(); return { updatedAt: parsed.updatedAt, id: parsed.id }; } catch { throw new AccountingError("accounting_validation", "Time cursor is invalid"); } }

/** Provider revisions are timestamp-prefixed. The hash suffix makes equal
 * timestamp payloads deterministic while preserving every unseen revision. */
function compareSourceVersion(left: string, right: string): number {
  const timestamp = (value: string): string => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/.exec(value)?.[0] ?? value;
  const leftTime = Date.parse(timestamp(left));
  const rightTime = Date.parse(timestamp(right));
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRevision(value: unknown, field: string): string {
  return dbString(value, field);
}

interface TimeStore extends TimeReadPort {
  forExecutor(executor: RentOpsQueryExecutor): TimeStore;
  /** The executor this store reads through (a read transaction for scoped reads). */
  executorForRead(): RentOpsQueryExecutor;
  upsertUser(scope: TimeConnectionScope, input: NormalizedTimeUser, receivedAt: string): Promise<void>;
  upsertJobcode(scope: TimeConnectionScope, input: NormalizedTimeJobcode, receivedAt: string): Promise<void>;
  upsertEntry(scope: TimeConnectionScope, input: NormalizedTimeEntry, receivedAt: string): Promise<{ readonly conflict: string }>;
  applyDeleted(scope: TimeConnectionScope, input: NormalizedDelete, receivedAt: string): Promise<void>;
  recordCoverage(input: TimeCoverageInput): Promise<void>;
  readCheckpoint(scope: TimeConnectionScope, stream: string): Promise<TimeCheckpoint | null>;
  saveCheckpoint(scope: TimeConnectionScope, stream: string, input: TimeCheckpointInput): Promise<void>;
  beginSyncRun(scope: TimeConnectionScope, idempotencyKey: string): Promise<string>;
  finishSyncRun(scope: TimeConnectionScope, runId: string, status: "complete" | "partial" | "failed", error?: { code: string; message: string }): Promise<void>;
  correctTimesheet(input: TimeCorrectionInput): Promise<TimeEntry>;
  reviewTimesheet(input: TimeReviewInput): Promise<TimeEntry>;
  mapEmployee(input: TimeEmployeeMappingInput): Promise<TimeEmployeeMapping>;
  mapJobcode(input: TimeJobcodeMappingInput): Promise<TimeJobcodeMapping>;
}

export interface TimeCoverageInput extends TimeCoverage { readonly runId?: string | null; }
export interface TimeCheckpoint { readonly modifiedSince: string | null; readonly watermark: string | null; readonly status: TimeCoverage["status"]; readonly reason: string | null; }
export interface TimeCheckpointInput { readonly modifiedSince: string | null; readonly watermark: string | null; readonly status: TimeCoverage["status"]; readonly reason: string | null; readonly runId: string; }
export interface TimeCorrectionInput { readonly scope: TimeConnectionScope; readonly timesheetId: string; readonly expectedCorrectionRevision?: number; readonly type: "regular" | "manual"; readonly start: string | null; readonly end: string | null; readonly date: string; readonly durationSeconds: number; readonly timezoneOffsetMinutes: number | null; readonly timezoneName: string | null; readonly notes: string; readonly reason: string; readonly actorId: string; readonly operationId: string; }
export interface TimeReviewInput { readonly scope: TimeConnectionScope; readonly timesheetId: string; readonly action: "approve" | "reject" | "request_review"; readonly reason?: string; readonly actorId: string; readonly operationId: string; }
export interface TimeEmployeeMappingInput { readonly scope: TimeConnectionScope; readonly providerUserId: string; readonly contactId: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null; readonly hourlyRateCents?: string | null; readonly currency?: string | null; readonly actorId: string; readonly operationId: string; }
export interface TimeJobcodeMappingInput { readonly scope: TimeConnectionScope; readonly providerJobcodeId: string; readonly propertyId?: string | null; readonly projectId?: string | null; readonly costCode?: string | null; readonly actorId: string; readonly operationId: string; }

class PostgresTimeStore implements TimeStore {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly bound = false, private readonly now: () => Date = () => new Date()) {}
  forExecutor(executor: RentOpsQueryExecutor): TimeStore { return new PostgresTimeStore(executor, true, this.now); }
  executorForRead(): RentOpsQueryExecutor { return this.executor; }

  async listEntries(rawInput: unknown): Promise<{ items: readonly TimeEntry[]; nextCursor: string | null; coverage: readonly TimeCoverage[] }> {
    const input = timeListQuerySchema.parse(rawInput); const scope: TimeConnectionScope = timeConnectionScopeSchema.parse({ ...input.scope, environment: input.environment, providerCompanyId: input.providerCompanyId });
    const values: unknown[] = [...scopeParts(scope)]; const conditions = ["t.organization_id=$1", "t.legal_entity_id=$2", "t.environment=$3", "t.provider_company_id=$4"];
    if (input.reviewState) { values.push(input.reviewState); conditions.push(`t.review_state=$${values.length}`); }
    if (input.from) { values.push(input.from); conditions.push(`t.entry_date >= $${values.length}`); }
    if (input.through) { values.push(input.through); conditions.push(`t.entry_date <= $${values.length}`); }
    if (input.scope.propertyId !== undefined) { values.push(input.scope.propertyId); conditions.push(`jm.property_id=$${values.length}`); }
    if (input.mappingStatus) { const expression = input.mappingStatus === "mapped" ? "em.id IS NOT NULL AND jm.id IS NOT NULL" : input.mappingStatus === "unmapped_employee" ? "em.id IS NULL" : "jm.id IS NULL"; conditions.push(expression); }
    const cursor = cursorDecode(input.cursor); if (cursor) { values.push(cursor.updatedAt, cursor.id); conditions.push(`(t.updated_at, t.id) > ($${values.length - 1}, $${values.length})`); }
    values.push(input.limit + 1);
    const result = await this.executor.query<Record<string, unknown>>(`SELECT t.*, r.source_version, em.id AS employee_mapping_id, em.hourly_rate_cents AS hourly_rate_cents, jm.id AS jobcode_mapping_id, le.currency AS estimated_currency, le.labor_cost_cents, pp.amount_cents AS posted_payroll_cents, pp.currency AS posted_payroll_currency FROM time_timesheets t JOIN time_timesheet_revisions r ON r.organization_id=t.organization_id AND r.id=t.current_revision_id LEFT JOIN time_employee_mappings em ON em.organization_id=t.organization_id AND em.legal_entity_id=t.legal_entity_id AND em.environment=t.environment AND em.provider_company_id=t.provider_company_id AND em.provider_user_id=t.provider_user_id AND em.status='active' AND em.effective_from <= t.entry_date AND (em.effective_to IS NULL OR t.entry_date < em.effective_to) LEFT JOIN time_jobcode_mappings jm ON jm.organization_id=t.organization_id AND jm.legal_entity_id=t.legal_entity_id AND jm.environment=t.environment AND jm.provider_company_id=t.provider_company_id AND jm.provider_jobcode_id=t.provider_jobcode_id AND jm.status='active' LEFT JOIN time_labor_estimates le ON le.organization_id=t.organization_id AND le.timesheet_id=t.id LEFT JOIN LATERAL (SELECT SUM(amount_cents)::text AS amount_cents, MIN(currency) AS currency FROM time_posted_payroll_sources WHERE organization_id=t.organization_id AND timesheet_id=t.id AND evidence_state='verified') pp ON true WHERE ${conditions.join(" AND ")} ORDER BY t.updated_at ASC, t.id ASC LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, input.limit); const next = result.rows.length > input.limit && rows.length > 0 ? cursorEncode({ updatedAt: dbTimestamp(rows[rows.length - 1]!.updated_at), id: dbString(rows[rows.length - 1]!.id, "time entry id") }) : null;
    const items = rows.map(row => this.mapEntry(row, scope));
    return { items, nextCursor: next, coverage: await this.readCoverage(scope) };
  }

  async listUsers(scopeInput: TimeConnectionScope): Promise<readonly TimeUser[]> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_source_users WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND deleted_at IS NULL ORDER BY display_name ASC, id ASC`, scopeParts(scope)); return result.rows.map(row => timeUserSchema.parse({ source: source(scope, "user", dbString(row.provider_user_id, "provider user id"), dbString(row.source_version, "user source version")), providerUserId: dbString(row.provider_user_id, "provider user id"), firstName: String(row.first_name ?? ""), lastName: String(row.last_name ?? ""), displayName: dbString(row.display_name, "user display name"), email: row.email === null || row.email === undefined ? null : String(row.email), active: dbBool(row.active), submittedTo: row.submitted_to === null || row.submitted_to === undefined ? null : dbDate(row.submitted_to), approvedTo: row.approved_to === null || row.approved_to === undefined ? null : dbDate(row.approved_to), lastModified: dbTimestamp(row.last_modified), deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : dbTimestamp(row.deleted_at) })); }
  async listJobcodes(scopeInput: TimeConnectionScope): Promise<readonly TimeJobcode[]> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_source_jobcodes WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND deleted_at IS NULL ORDER BY name ASC, id ASC`, scopeParts(scope)); return result.rows.map(row => timeJobcodeSchema.parse({ source: source(scope, "jobcode", dbString(row.provider_jobcode_id, "provider jobcode id"), dbString(row.source_version, "jobcode source version")), providerJobcodeId: dbString(row.provider_jobcode_id, "provider jobcode id"), name: dbString(row.name, "jobcode name"), parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id), type: String(row.provider_type ?? ""), billable: dbBool(row.billable), active: dbBool(row.active), lastModified: dbTimestamp(row.last_modified), deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : dbTimestamp(row.deleted_at) })); }
  async listEmployeeMappings(scopeInput: TimeConnectionScope): Promise<readonly TimeEmployeeMapping[]> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_employee_mappings WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 ORDER BY provider_user_id ASC, effective_from DESC, id DESC`, scopeParts(scope)); return result.rows.map(row => timeEmployeeMappingSchema.parse({ id: dbString(row.id, "employee mapping id"), scope, providerUserId: dbString(row.provider_user_id, "provider user id"), contactId: dbString(row.contact_id, "contact id"), effectiveFrom: dbDate(row.effective_from), effectiveTo: row.effective_to === null || row.effective_to === undefined ? null : dbDate(row.effective_to), hourlyRateCents: row.hourly_rate_cents === null || row.hourly_rate_cents === undefined ? null : centsSchema.parse(String(row.hourly_rate_cents)), currency: row.currency === null || row.currency === undefined ? null : currencyCodeSchema.parse(row.currency), status: String(row.status), recordRevision: revisionSchema.parse(dbInt(row.record_revision, "mapping revision")), updatedAt: dbTimestamp(row.updated_at) })); }
  async listJobcodeMappings(scopeInput: TimeConnectionScope): Promise<readonly TimeJobcodeMapping[]> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_jobcode_mappings WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 ORDER BY provider_jobcode_id ASC, id DESC`, scopeParts(scope)); return result.rows.map(row => timeJobcodeMappingSchema.parse({ id: dbString(row.id, "jobcode mapping id"), scope, providerJobcodeId: dbString(row.provider_jobcode_id, "provider jobcode id"), propertyId: row.property_id === null || row.property_id === undefined ? null : String(row.property_id), projectId: row.project_id === null || row.project_id === undefined ? null : dbString(row.project_id, "project id"), costCode: row.cost_code === null || row.cost_code === undefined ? null : String(row.cost_code), status: String(row.status), recordRevision: revisionSchema.parse(dbInt(row.record_revision, "mapping revision")), updatedAt: dbTimestamp(row.updated_at) })); }
  async readCoverage(scopeInput: TimeConnectionScope): Promise<readonly TimeCoverage[]> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_sync_checkpoints WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 ORDER BY stream ASC`, scopeParts(scope)); return result.rows.map(row => timeCoverageSchema.parse({ scope, stream: row.stream, status: row.status, evidence: row.status === "unavailable" ? "unverified" : "live_provider_readback", modifiedSince: row.modified_since === null || row.modified_since === undefined ? null : dbTimestamp(row.modified_since), watermark: row.watermark === null || row.watermark === undefined ? null : dbTimestamp(row.watermark), observedAt: dbTimestamp(row.updated_at), objectCount: 0, deletedCount: 0, reason: row.reason === null || row.reason === undefined ? null : String(row.reason) })); }
  async listConnections(input: { readonly organizationId: TimeConnectionScope["organizationId"]; readonly legalEntityId: TimeConnectionScope["legalEntityId"]; readonly environment?: TimeConnectionScope["environment"] }): Promise<readonly TimeConnectionSummary[]> {
    const environment = input.environment;
    const values = [input.organizationId, input.legalEntityId, environment ?? null];
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT provider_company_id,environment,status,connected_at
         FROM time_connections
        WHERE organization_id=$1 AND legal_entity_id=$2 AND ($3::text IS NULL OR environment=$3)
        ORDER BY environment ASC, provider_company_id ASC`,
      values,
    );
    return result.rows.map(row => {
      const providerCompanyId = dbString(row.provider_company_id, "provider company id");
      const connectionEnvironment = z.enum(["sandbox", "production"]).parse(row.environment);
      const scope = timeConnectionScopeSchema.parse({ organizationId: input.organizationId, legalEntityId: input.legalEntityId, environment: connectionEnvironment, providerCompanyId });
      return timeConnectionSummarySchema.parse({ scope, name: `QuickBooks Time · ${connectionEnvironment === "production" ? "Production" : "Sandbox"}`, status: row.status, connectedAt: row.connected_at === null || row.connected_at === undefined ? null : dbTimestamp(row.connected_at) });
    });
  }

  async upsertUser(scope: TimeConnectionScope, input: NormalizedTimeUser, receivedAt: string): Promise<void> {
    const current = await this.executor.query<{ id: string; source_version: unknown; body_hash: unknown }>(
      `SELECT id,source_version,body_hash FROM time_source_users
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_user_id=$5 FOR UPDATE`,
      [...scopeParts(scope), input.providerUserId],
    );
    const existing = current.rows[0];
    if (existing && compareSourceVersion(sourceRevision(existing.source_version, "user source version"), input.source.sourceVersion) >= 0) return;
    await this.executor.query(
      `INSERT INTO time_source_users (id,organization_id,legal_entity_id,environment,provider_company_id,provider_user_id,first_name,last_name,display_name,email,active,submitted_to,approved_to,last_modified,provider_body,source_version,body_hash,deleted_at,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_user_id) DO UPDATE SET
         first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,display_name=EXCLUDED.display_name,email=EXCLUDED.email,
         active=EXCLUDED.active,submitted_to=EXCLUDED.submitted_to,approved_to=EXCLUDED.approved_to,last_modified=EXCLUDED.last_modified,
         provider_body=EXCLUDED.provider_body,source_version=EXCLUDED.source_version,body_hash=EXCLUDED.body_hash,deleted_at=EXCLUDED.deleted_at,received_at=EXCLUDED.received_at
       WHERE time_source_users.source_version < EXCLUDED.source_version`,
      [randomUUID(), ...scopeParts(scope), input.providerUserId, input.firstName, input.lastName, input.displayName, input.email, input.active, input.submittedTo, input.approvedTo, input.lastModified, JSON.stringify(input.providerBody), input.source.sourceVersion, input.bodyHash, input.deletedAt, receivedAt],
    );
  }
  async upsertJobcode(scope: TimeConnectionScope, input: NormalizedTimeJobcode, receivedAt: string): Promise<void> {
    const current = await this.executor.query<{ id: string; source_version: unknown }>(
      `SELECT id,source_version FROM time_source_jobcodes
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_jobcode_id=$5 FOR UPDATE`,
      [...scopeParts(scope), input.providerJobcodeId],
    );
    const existing = current.rows[0];
    if (existing && compareSourceVersion(sourceRevision(existing.source_version, "jobcode source version"), input.source.sourceVersion) >= 0) return;
    await this.executor.query(
      `INSERT INTO time_source_jobcodes (id,organization_id,legal_entity_id,environment,provider_company_id,provider_jobcode_id,name,parent_id,provider_type,billable,active,last_modified,provider_body,source_version,body_hash,deleted_at,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_jobcode_id) DO UPDATE SET
         name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,provider_type=EXCLUDED.provider_type,billable=EXCLUDED.billable,active=EXCLUDED.active,last_modified=EXCLUDED.last_modified,
         provider_body=EXCLUDED.provider_body,source_version=EXCLUDED.source_version,body_hash=EXCLUDED.body_hash,deleted_at=EXCLUDED.deleted_at,received_at=EXCLUDED.received_at
       WHERE time_source_jobcodes.source_version < EXCLUDED.source_version`,
      [randomUUID(), ...scopeParts(scope), input.providerJobcodeId, input.name, input.parentId, input.type, input.billable, input.active, input.lastModified, JSON.stringify(input.providerBody ?? {}), input.source.sourceVersion, input.bodyHash, input.deletedAt, receivedAt],
    );
  }

  async upsertEntry(scope: TimeConnectionScope, input: NormalizedTimeEntry, receivedAt: string): Promise<{ readonly conflict: string }> {
    const activeRows = input.onTheClock && input.providerActive
      ? await this.executor.query(`SELECT id FROM time_timesheets WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_user_id=$5 AND on_the_clock AND provider_active AND deleted_at IS NULL AND provider_timesheet_id<>$6 LIMIT 1`, [...scopeParts(scope), input.providerUserId, input.providerTimesheetId])
      : { rows: [] };
    if (activeRows.rows.length > 0) {
      throw new AccountingError("accounting_conflict", "QuickBooks Time returned more than one active timesheet for an employee", { reason: "multiple_active_timesheets" });
    }
    let conflict: "none" | "overlap" | "invalid_duration" = input.conflict;
    const startAt = input.start ? new Date(input.start).toISOString() : null;
    const endAt = input.end ? new Date(input.end).toISOString() : null;
    if (conflict === "none" && input.type === "regular" && input.providerActive && startAt && endAt) {
      const overlaps = await this.executor.query(
        `SELECT id FROM time_timesheets
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4
            AND provider_user_id=$5 AND provider_timesheet_id<>$6 AND provider_active AND deleted_at IS NULL
            AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_at < $8::timestamptz AND end_at > $7::timestamptz
          LIMIT 1`,
        [...scopeParts(scope), input.providerUserId, input.providerTimesheetId, endAt, startAt],
      );
      if (overlaps.rows.length > 0) conflict = "overlap";
    }
    const current = await this.executor.query<Record<string, unknown>>(`SELECT t.id,t.current_revision_id,t.correction_revision,t.review_state,r.source_version AS current_source_version,t.deleted_at AS current_deleted_at FROM time_timesheets t JOIN time_timesheet_revisions r ON r.organization_id=t.organization_id AND r.id=t.current_revision_id WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.provider_company_id=$4 AND t.provider_timesheet_id=$5 FOR UPDATE OF t`, [...scopeParts(scope), input.providerTimesheetId]);
    const row = current.rows[0];
    const tombstone = await this.executor.query<{ source_version: unknown; deleted_at: unknown }>(
      `SELECT source_version,deleted_at FROM time_timesheet_deletion_tombstones
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_timesheet_id=$5
        ORDER BY deleted_at DESC,id DESC LIMIT 1`,
      [...scopeParts(scope), input.providerTimesheetId],
    );
    const tombstoneVersion = tombstone.rows[0] ? sourceRevision(tombstone.rows[0].source_version, "deletion source version") : null;
    if (tombstoneVersion && compareSourceVersion(tombstoneVersion, input.sourceVersion) >= 0) return { conflict: "deleted" };
    const currentVersion = row ? sourceRevision(row.current_source_version, "current time source version") : null;
    if (currentVersion && compareSourceVersion(currentVersion, input.sourceVersion) > 0) return { conflict: "stale_source" };
    const revisionId = randomUUID();
    await this.executor.query(
      `INSERT INTO time_timesheet_revisions
        (id,organization_id,legal_entity_id,environment,provider_company_id,provider_timesheet_id,source_version,provider_user_id,provider_jobcode_id,entry_type,start_at,end_at,start_local,end_local,entry_date,duration_seconds,timezone_offset_minutes,timezone_name,on_the_clock,locked,provider_active,deleted_at,notes,last_modified,provider_body,body_hash,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_timesheet_id,source_version) DO NOTHING`,
      [revisionId, ...scopeParts(scope), input.providerTimesheetId, input.sourceVersion, input.providerUserId, input.providerJobcodeId, input.type, startAt, endAt, input.start, input.end, input.date, input.durationSeconds, input.timezoneOffsetMinutes, input.timezoneName, input.onTheClock, input.locked, input.providerActive, input.deletedAt, input.notes, input.lastModified, JSON.stringify(input.providerBody), input.bodyHash, receivedAt],
    );
    const persistedRevision = await this.executor.query<{ id: string; source_version: unknown; body_hash: unknown }>(
      `SELECT id,source_version,body_hash FROM time_timesheet_revisions
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_timesheet_id=$5 AND source_version=$6`,
      [...scopeParts(scope), input.providerTimesheetId, input.sourceVersion],
    );
    const storedRevision = persistedRevision.rows[0];
    if (!storedRevision) throw new AccountingError("accounting_unavailable", "Time source revision could not be read back");
    if (String(storedRevision.body_hash) !== input.bodyHash) throw new AccountingError("accounting_conflict", "Time provider revision identity is bound to different content");
    const effectiveRevisionId = storedRevision.id;
    const sourceChanged = !currentVersion || compareSourceVersion(currentVersion, input.sourceVersion) < 0;
    if (!sourceChanged) return { conflict: "none" };
    const common = [scope.organizationId, row?.id ?? randomUUID(), scope.legalEntityId, scope.environment, scope.providerCompanyId, effectiveRevisionId, input.providerUserId, input.providerJobcodeId, input.type, startAt, endAt, input.start, input.end, input.date, input.durationSeconds, input.timezoneOffsetMinutes, input.timezoneName, input.onTheClock, input.locked, input.providerActive, input.deletedAt, input.notes, input.lastModified, conflict, receivedAt];
    if (row) {
      await this.executor.query(
        `UPDATE time_timesheets SET
          current_revision_id=$6,provider_user_id=$7,provider_jobcode_id=$8,entry_type=$9,start_at=$10,end_at=$11,start_local=$12,end_local=$13,
          entry_date=$14,duration_seconds=$15,timezone_offset_minutes=$16,timezone_name=$17,on_the_clock=$18,locked=$19,provider_active=$20,
          deleted_at=$21,notes=$22,last_modified=$23,conflict=$24,review_state=CASE WHEN review_state='approved' AND $24='none' AND current_revision_id=$6 THEN review_state ELSE 'needs_review' END,
          record_revision=record_revision+1,updated_at=$25
         WHERE organization_id=$1 AND id=$2 AND legal_entity_id=$3 AND environment=$4 AND provider_company_id=$5`,
        common,
      );
    } else {
      await this.executor.query(
        `INSERT INTO time_timesheets
          (id,organization_id,legal_entity_id,environment,provider_company_id,provider_timesheet_id,current_revision_id,provider_user_id,provider_jobcode_id,entry_type,start_at,end_at,start_local,end_local,entry_date,duration_seconds,timezone_offset_minutes,timezone_name,on_the_clock,locked,provider_active,deleted_at,notes,last_modified,review_state,conflict,correction_revision,record_revision,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'needs_review',$25,0,1,$26)`,
        [common[1], common[0], common[2], common[3], common[4], input.providerTimesheetId, common[5], ...common.slice(6)],
      );
    }
    if (conflict === "overlap") {
      await this.executor.query(
        `UPDATE time_timesheets SET conflict='overlap',review_state='needs_review',updated_at=$7
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4
            AND provider_user_id=$5 AND id<>$6 AND provider_active AND deleted_at IS NULL
            AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_at < $9::timestamptz AND end_at > $8::timestamptz`,
        [...scopeParts(scope), row?.id ?? common[1], receivedAt, endAt, startAt],
      );
    }
    return { conflict };
  }

  async applyDeleted(scope: TimeConnectionScope, input: NormalizedDelete, receivedAt: string): Promise<void> {
    const found = await this.executor.query<Record<string, unknown>>(
      `SELECT t.id,r.source_version AS current_source_version FROM time_timesheets t
        JOIN time_timesheet_revisions r ON r.organization_id=t.organization_id AND r.id=t.current_revision_id
        WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.provider_company_id=$4 AND t.provider_timesheet_id=$5
        FOR UPDATE OF t`,
      [...scopeParts(scope), input.providerTimesheetId],
    );
    const currentVersion = found.rows[0]?.current_source_version === undefined
      ? null
      : sourceRevision(found.rows[0]?.current_source_version, "current time source version");
    if (currentVersion && compareSourceVersion(currentVersion, input.sourceVersion) > 0) return;
    const tombstone = await this.executor.query<{ source_version: unknown }>(
      `SELECT source_version FROM time_timesheet_deletion_tombstones
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_timesheet_id=$5
        ORDER BY deleted_at DESC,id DESC LIMIT 1`,
      [...scopeParts(scope), input.providerTimesheetId],
    );
    const tombstoneVersion = tombstone.rows[0] ? sourceRevision(tombstone.rows[0].source_version, "deletion source version") : null;
    if (tombstoneVersion && compareSourceVersion(tombstoneVersion, input.sourceVersion) >= 0) return;
    if (found.rows[0]) {
      await this.executor.query(
        `UPDATE time_timesheets SET provider_active=false,deleted_at=$6,on_the_clock=false,conflict='none',
          review_state=CASE WHEN review_state='approved' THEN 'needs_review' ELSE review_state END,
          record_revision=record_revision+1,updated_at=$7
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_timesheet_id=$5`,
        [...scopeParts(scope), input.providerTimesheetId, input.lastModified, receivedAt],
      );
    }
    await this.executor.query(
      `INSERT INTO time_timesheet_deletion_tombstones
        (id,organization_id,legal_entity_id,environment,provider_company_id,provider_timesheet_id,source_version,body_hash,provider_body,deleted_at,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_timesheet_id,source_version) DO NOTHING`,
      [randomUUID(), ...scopeParts(scope), input.providerTimesheetId, input.sourceVersion, input.bodyHash, JSON.stringify(input.providerBody), input.lastModified, receivedAt],
    );
  }

  async recordCoverage(input: TimeCoverageInput): Promise<void> { const scope = timeConnectionScopeSchema.parse(input.scope); await this.executor.query(`INSERT INTO time_sync_checkpoints (organization_id,legal_entity_id,environment,provider_company_id,stream,modified_since,watermark,status,last_run_id,reason,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,stream) DO UPDATE SET modified_since=EXCLUDED.modified_since,watermark=EXCLUDED.watermark,status=EXCLUDED.status,last_run_id=EXCLUDED.last_run_id,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`, [...scopeParts(scope), input.stream, input.modifiedSince, input.watermark, input.status, input.runId ?? null, input.reason, input.observedAt]); }
  async readCheckpoint(scopeInput: TimeConnectionScope, stream: string): Promise<TimeCheckpoint | null> { const scope = timeConnectionScopeSchema.parse(scopeInput); const result = await this.executor.query<Record<string, unknown>>(`SELECT modified_since,watermark,status,reason FROM time_sync_checkpoints WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND stream=$5`, [...scopeParts(scope), stream]); const row = result.rows[0]; return row ? { modifiedSince: row.modified_since === null || row.modified_since === undefined ? null : dbTimestamp(row.modified_since), watermark: row.watermark === null || row.watermark === undefined ? null : dbTimestamp(row.watermark), status: z.enum(["unavailable", "partial", "complete"]).parse(row.status), reason: row.reason === null || row.reason === undefined ? null : String(row.reason) } : null; }
  async saveCheckpoint(scopeInput: TimeConnectionScope, stream: string, input: TimeCheckpointInput): Promise<void> { await this.recordCoverage({ scope: scopeInput, stream: z.enum(["users", "jobcodes", "timesheets", "timesheets_deleted"]).parse(stream), status: input.status, evidence: "live_provider_readback", modifiedSince: input.modifiedSince ? isoTimestampSchema.parse(input.modifiedSince) : null, watermark: input.watermark ? isoTimestampSchema.parse(input.watermark) : null, observedAt: isoTimestampSchema.parse(this.now().toISOString()), objectCount: 0, deletedCount: 0, reason: input.reason, runId: input.runId }); }
  async beginSyncRun(scope: TimeConnectionScope, idempotencyKey: string): Promise<string> {
    const id = randomUUID();
    const inserted = await this.executor.query<{ id: string }>(
      `INSERT INTO time_sync_runs
        (id,organization_id,legal_entity_id,environment,provider_company_id,idempotency_key,status)
       VALUES ($1,$2,$3,$4,$5,$6,'running')
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,idempotency_key) DO NOTHING
       RETURNING id`,
      [id, ...scopeParts(scope), idempotencyKey],
    );
    if (inserted.rows[0]?.id) return inserted.rows[0].id;
    const existing = await this.executor.query<{ id: string }>(
      `SELECT id FROM time_sync_runs
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND idempotency_key=$5
        FOR UPDATE`,
      [...scopeParts(scope), idempotencyKey],
    );
    const persistedId = existing.rows[0]?.id;
    if (!persistedId) throw new AccountingError("accounting_unavailable", "Time sync run could not be read back");
    return persistedId;
  }
  async finishSyncRun(scope: TimeConnectionScope, runId: string, status: "complete" | "partial" | "failed", error?: { code: string; message: string }): Promise<void> {
    await this.executor.query(
      `UPDATE time_sync_runs SET status=$6,error_code=$7,error_message=$8,completed_at=$9
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND id=$5`,
      [...scopeParts(scope), runId, status, error?.code ?? null, error?.message ?? null, this.now().toISOString()],
    );
  }

  async correctTimesheet(input: TimeCorrectionInput): Promise<TimeEntry> {
    if (!this.executor.transaction && !this.bound) throw new AccountingError("accounting_configuration", "Time correction requires a transaction");
    const current = await this.executor.query<Record<string, unknown>>(`SELECT * FROM time_timesheets WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND id=$5 FOR UPDATE`, [...scopeParts(input.scope), input.timesheetId]);
    const row = current.rows[0];
    if (!row) throw new AccountingError("accounting_not_found", "Time entry was not found");
    const revision = dbInt(row.correction_revision, "correction revision");
    if (input.expectedCorrectionRevision !== undefined && revision !== input.expectedCorrectionRevision) throw new AccountingError("accounting_conflict", "Time correction is stale", { reason: "stale_correction" });
    const startAt = input.start ? new Date(input.start).toISOString() : null;
    const endAt = input.end ? new Date(input.end).toISOString() : null;
    let conflict: "none" | "overlap" = "none";
    if (input.type === "regular" && dbBool(row.provider_active) && startAt && endAt) {
      const overlaps = await this.executor.query(
        `SELECT id FROM time_timesheets
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4
            AND provider_user_id=$5 AND id<>$6 AND provider_active AND deleted_at IS NULL
            AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_at < $8::timestamptz AND end_at > $7::timestamptz
          LIMIT 1`,
        [...scopeParts(input.scope), dbString(row.provider_user_id, "provider user id"), input.timesheetId, endAt, startAt],
      );
      if (overlaps.rows.length > 0) conflict = "overlap";
    }
    const next = revision + 1;
    await this.executor.query(`INSERT INTO time_timesheet_corrections (id,organization_id,legal_entity_id,timesheet_id,correction_revision,entry_type,start_at,end_at,start_local,end_local,entry_date,duration_seconds,timezone_offset_minutes,timezone_name,notes,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [randomUUID(), input.scope.organizationId, input.scope.legalEntityId, input.timesheetId, next, input.type, startAt, endAt, input.start, input.end, input.date, input.durationSeconds, input.timezoneOffsetMinutes, input.timezoneName, input.notes, input.reason, input.actorId]);
    const onTheClock = input.type === "regular" && input.end === null;
    const reviewState = conflict === "none" ? "corrected" : "needs_review";
    await this.executor.query(`UPDATE time_timesheets SET entry_type=$6,start_at=$7,end_at=$8,start_local=$9,end_local=$10,entry_date=$11,duration_seconds=$12,timezone_offset_minutes=$13,timezone_name=$14,on_the_clock=$15,notes=$16,conflict=$17,correction_revision=$18,review_state=$19,record_revision=record_revision+1,updated_at=$20 WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND id=$5`, [...scopeParts(input.scope), input.timesheetId, input.type, startAt, endAt, input.start, input.end, input.date, input.durationSeconds, input.timezoneOffsetMinutes, input.timezoneName, onTheClock, input.notes, conflict, next, reviewState, this.now().toISOString()]);
    await this.executor.query(`INSERT INTO time_review_events (id,organization_id,legal_entity_id,timesheet_id,action,from_state,to_state,operation_id,actor_id,reason) VALUES ($1,$2,$3,$4,'correct',NULL,$5,$6,$7,$8)`, [randomUUID(), input.scope.organizationId, input.scope.legalEntityId, input.timesheetId, reviewState, input.operationId, input.actorId, input.reason]);
    return this.getEntry(input.scope, input.timesheetId);
  }
  async reviewTimesheet(input: TimeReviewInput): Promise<TimeEntry> { const result = await this.executor.query<Record<string, unknown>>(`SELECT t.*,r.source_version,em.id AS employee_mapping_id,em.hourly_rate_cents AS hourly_rate_cents,em.currency AS currency,jm.id AS jobcode_mapping_id,le.currency AS estimated_currency,le.labor_cost_cents,pp.amount_cents AS posted_payroll_cents,pp.currency AS posted_payroll_currency FROM time_timesheets t JOIN time_timesheet_revisions r ON r.organization_id=t.organization_id AND r.id=t.current_revision_id LEFT JOIN time_employee_mappings em ON em.organization_id=t.organization_id AND em.legal_entity_id=t.legal_entity_id AND em.environment=t.environment AND em.provider_company_id=t.provider_company_id AND em.provider_user_id=t.provider_user_id AND em.status='active' AND em.effective_from <= t.entry_date AND (em.effective_to IS NULL OR t.entry_date < em.effective_to) LEFT JOIN time_jobcode_mappings jm ON jm.organization_id=t.organization_id AND jm.legal_entity_id=t.legal_entity_id AND jm.environment=t.environment AND jm.provider_company_id=t.provider_company_id AND jm.provider_jobcode_id=t.provider_jobcode_id AND jm.status='active' LEFT JOIN time_labor_estimates le ON le.organization_id=t.organization_id AND le.timesheet_id=t.id LEFT JOIN LATERAL (SELECT SUM(amount_cents)::text AS amount_cents, MIN(currency) AS currency FROM time_posted_payroll_sources WHERE organization_id=t.organization_id AND timesheet_id=t.id AND evidence_state='verified') pp ON true WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.provider_company_id=$4 AND t.id=$5 FOR UPDATE OF t`, [...scopeParts(input.scope), input.timesheetId]); const row = result.rows[0]; if (!row) throw new AccountingError("accounting_not_found", "Time entry was not found"); const current = String(row.review_state); if (input.action === "approve") { if (!row.employee_mapping_id || !row.jobcode_mapping_id) throw new AccountingError("accounting_validation", "Map the employee and jobcode before approval", { reason: "time_mapping_required" }); if (row.conflict !== "none" || !dbBool(row.provider_active) || (row.locked !== undefined && !dbBool(row.locked) && false)) throw new AccountingError("accounting_conflict", "Time entry has unresolved conflicts", { reason: "time_entry_not_approvable" }); }
    const next = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "needs_review";
    await this.executor.query(`UPDATE time_timesheets SET review_state=$6,record_revision=record_revision+1,updated_at=$7 WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND id=$5`, [...scopeParts(input.scope), input.timesheetId, next, this.now().toISOString()]);
    await this.executor.query(`INSERT INTO time_review_events (id,organization_id,legal_entity_id,timesheet_id,action,from_state,to_state,operation_id,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), input.scope.organizationId, input.scope.legalEntityId, input.timesheetId, input.action === "approve" ? "approve" : input.action === "reject" ? "reject" : "request_review", current, next, input.operationId, input.actorId, input.reason ?? null]);
    if (input.action === "approve" && row.hourly_rate_cents !== null && row.hourly_rate_cents !== undefined && row.currency) await this.writeEstimate(input.scope, input.timesheetId, String(row.employee_mapping_id), dbInt(row.duration_seconds, "duration"), String(row.hourly_rate_cents), String(row.currency));
    return this.getEntry(input.scope, input.timesheetId);
  }
  private async writeEstimate(scope: TimeConnectionScope, timesheetId: string, mappingId: string, seconds: number, rate: string, currency: string): Promise<void> { const rateBig = BigInt(rate); const cost = roundHourSeconds(seconds, rateBig); await this.executor.query(`INSERT INTO time_labor_estimates (id,organization_id,legal_entity_id,timesheet_id,mapping_id,duration_seconds,hourly_rate_cents,labor_cost_cents,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (organization_id,timesheet_id) DO UPDATE SET mapping_id=EXCLUDED.mapping_id,duration_seconds=EXCLUDED.duration_seconds,hourly_rate_cents=EXCLUDED.hourly_rate_cents,labor_cost_cents=EXCLUDED.labor_cost_cents,currency=EXCLUDED.currency,calculated_at=now()`, [randomUUID(), ...scopeParts(scope).slice(0, 2), timesheetId, mappingId, seconds, rateBig.toString(), cost.toString(), currency]); }
  async mapEmployee(input: TimeEmployeeMappingInput): Promise<TimeEmployeeMapping> {
    const currency = input.currency ?? null;
    if ((input.hourlyRateCents === null) !== (currency === null)) throw new AccountingError("accounting_validation", "Hourly rate and currency must be supplied together");
    const overlap = await this.executor.query(
      `SELECT id FROM time_employee_mappings
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND provider_user_id=$5
          AND status='active' AND effective_from<>$6
          AND effective_from < COALESCE($7::date, '9999-12-31'::date)
          AND COALESCE(effective_to, '9999-12-31'::date) > $6::date
        LIMIT 1`,
      [...scopeParts(input.scope), input.providerUserId, input.effectiveFrom, input.effectiveTo ?? null],
    );
    if (overlap.rows.length > 0) throw new AccountingError("accounting_conflict", "Employee mapping dates overlap an existing active mapping", { reason: "time_mapping_period_overlap" });
    const id = randomUUID();
    await this.executor.query(
      `INSERT INTO time_employee_mappings
        (id,organization_id,legal_entity_id,environment,provider_company_id,provider_user_id,contact_id,effective_from,effective_to,hourly_rate_cents,currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_user_id,effective_from)
       DO UPDATE SET contact_id=EXCLUDED.contact_id,effective_to=EXCLUDED.effective_to,hourly_rate_cents=EXCLUDED.hourly_rate_cents,currency=EXCLUDED.currency,status='active',record_revision=time_employee_mappings.record_revision+1,updated_at=now()`,
      [id, ...scopeParts(input.scope), input.providerUserId, input.contactId, input.effectiveFrom, input.effectiveTo ?? null, input.hourlyRateCents ?? null, currency],
    );
    const rows = await this.listEmployeeMappings(input.scope);
    const found = rows.find(row => row.providerUserId === input.providerUserId && row.effectiveFrom === input.effectiveFrom);
    if (!found) throw new AccountingError("accounting_unavailable", "Employee mapping could not be read back");
    return found;
  }
  async mapJobcode(input: TimeJobcodeMappingInput): Promise<TimeJobcodeMapping> {
    const id = randomUUID();
    await this.executor.query(
      `INSERT INTO time_jobcode_mappings
        (id,organization_id,legal_entity_id,environment,provider_company_id,provider_jobcode_id,property_id,project_id,cost_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id,legal_entity_id,environment,provider_company_id,provider_jobcode_id)
       DO UPDATE SET property_id=EXCLUDED.property_id,project_id=EXCLUDED.project_id,cost_code=EXCLUDED.cost_code,status='active',record_revision=time_jobcode_mappings.record_revision+1,updated_at=now()`,
      [id, ...scopeParts(input.scope), input.providerJobcodeId, input.propertyId ?? null, input.projectId ?? null, input.costCode ?? null],
    );
    const rows = await this.listJobcodeMappings(input.scope);
    const found = rows.find(row => row.providerJobcodeId === input.providerJobcodeId);
    if (!found) throw new AccountingError("accounting_unavailable", "Jobcode mapping could not be read back");
    return found;
  }
  private mapEntry(row: Record<string, unknown>, scope: TimeConnectionScope): TimeEntry { const sourceVersion = dbString(row.source_version, "time source version"); const start = row.start_local === null || row.start_local === undefined ? null : String(row.start_local); const end = row.end_local === null || row.end_local === undefined ? null : String(row.end_local); const employeeMapped = row.employee_mapping_id !== null && row.employee_mapping_id !== undefined; const jobcodeMapped = row.jobcode_mapping_id !== null && row.jobcode_mapping_id !== undefined; const estimated = row.labor_cost_cents === null || row.labor_cost_cents === undefined ? null : centsSchema.parse(String(row.labor_cost_cents)); const estimatedCurrency = row.estimated_currency === null || row.estimated_currency === undefined ? null : currencyCodeSchema.parse(row.estimated_currency); const posted = row.posted_payroll_cents === null || row.posted_payroll_cents === undefined ? null : centsSchema.parse(String(row.posted_payroll_cents)); const postedCurrency = row.posted_payroll_currency === null || row.posted_payroll_currency === undefined ? null : currencyCodeSchema.parse(row.posted_payroll_currency); return timeEntrySchema.parse({ id: dbString(row.id, "time entry id"), source: source(scope, "timesheet", dbString(row.provider_timesheet_id, "provider timesheet id"), sourceVersion), providerTimesheetId: dbString(row.provider_timesheet_id, "provider timesheet id"), providerUserId: dbString(row.provider_user_id, "provider user id"), providerJobcodeId: dbString(row.provider_jobcode_id, "provider jobcode id"), type: row.entry_type, start, end, date: dbDate(row.entry_date), durationSeconds: dbInt(row.duration_seconds, "duration"), timezoneOffsetMinutes: row.timezone_offset_minutes === null || row.timezone_offset_minutes === undefined ? null : Number(row.timezone_offset_minutes), timezoneName: row.timezone_name === null || row.timezone_name === undefined ? null : String(row.timezone_name), onTheClock: dbBool(row.on_the_clock), locked: dbBool(row.locked), providerActive: dbBool(row.provider_active), deletedAt: dbNullableTimestamp(row.deleted_at), notes: String(row.notes ?? ""), lastModified: dbTimestamp(row.last_modified), reviewState: row.review_state, conflict: row.conflict, mappingStatus: employeeMapped && jobcodeMapped ? "mapped" : !employeeMapped ? "unmapped_employee" : "unmapped_jobcode", correctionRevision: timeCorrectionRevisionSchema.parse(dbInt(row.correction_revision, "correction revision")), estimatedLaborCostCents: estimated, estimatedLaborCurrency: estimatedCurrency, postedPayrollCents: posted, postedPayrollCurrency: postedCurrency, updatedAt: dbTimestamp(row.updated_at) }); }
  private async getEntry(scope: TimeConnectionScope, timesheetId: string): Promise<TimeEntry> { const result = await this.executor.query<Record<string, unknown>>(`SELECT t.*,r.source_version,em.id AS employee_mapping_id,em.hourly_rate_cents AS hourly_rate_cents,jm.id AS jobcode_mapping_id,le.currency AS estimated_currency,le.labor_cost_cents,pp.amount_cents AS posted_payroll_cents,pp.currency AS posted_payroll_currency FROM time_timesheets t JOIN time_timesheet_revisions r ON r.organization_id=t.organization_id AND r.id=t.current_revision_id LEFT JOIN time_employee_mappings em ON em.organization_id=t.organization_id AND em.legal_entity_id=t.legal_entity_id AND em.environment=t.environment AND em.provider_company_id=t.provider_company_id AND em.provider_user_id=t.provider_user_id AND em.status='active' AND em.effective_from <= t.entry_date AND (em.effective_to IS NULL OR t.entry_date < em.effective_to) LEFT JOIN time_jobcode_mappings jm ON jm.organization_id=t.organization_id AND jm.legal_entity_id=t.legal_entity_id AND jm.environment=t.environment AND jm.provider_company_id=t.provider_company_id AND jm.provider_jobcode_id=t.provider_jobcode_id AND jm.status='active' LEFT JOIN time_labor_estimates le ON le.organization_id=t.organization_id AND le.timesheet_id=t.id LEFT JOIN LATERAL (SELECT SUM(amount_cents)::text AS amount_cents, MIN(currency) AS currency FROM time_posted_payroll_sources WHERE organization_id=t.organization_id AND timesheet_id=t.id AND evidence_state='verified') pp ON true WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.provider_company_id=$4 AND t.id=$5`, [...scopeParts(scope), timesheetId]); const row = result.rows[0]; if (!row) throw new AccountingError("accounting_not_found", "Time entry was not found"); return this.mapEntry(row, scope); }
}

export function createTimeStore(executor: RentOpsQueryExecutor, now?: () => Date): TimeStore { return new PostgresTimeStore(executor, false, now); }
export type { TimeStore };
