import type { ForecastAssumptions } from "../../shared/forecasting/assumptions";
import type { ForecastAssumptionVersionMeta, ForecastScenarioState, ForecastScenarioSummary, ForecastSnapshotMeta } from "../../shared/forecasting/contracts";
import { forecastAssumptionVersionMetaSchema, forecastScenarioSummarySchema, forecastSnapshotMetaSchema } from "../../shared/forecasting/contracts";
import type { ForecastResultView } from "../../shared/forecasting/result";
import type { ForecastSourceData } from "./engine";

/**
 * Stored snapshot body: the statement views plus the exact source data the
 * run read. The event calendar is not stored; it is regenerated from the
 * immutable assumption version and these sources and must reproduce the
 * recorded result hash exactly.
 */
export type StoredForecastSnapshot = ForecastResultView & { readonly replay: { readonly sources: ForecastSourceData } };
import { ValidationCommandError } from "../company/commands/errors";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { dbNullableString, dbRevision, dbString, dbTimestamp, dbNullableTimestamp } from "../projects/helpers";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

/** SQL persistence for scenarios, immutable assumption versions and immutable snapshots. */
export interface ScenarioRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: string;
  readonly state: ForecastScenarioState;
  readonly baseScenarioId: string | null;
  readonly startDate: string;
  readonly horizonWeeks: number;
  readonly horizonMonths: number;
  readonly reserveFloorCents: string;
  readonly currency: string;
  readonly currentAssumptionVersion: number;
  readonly recordRevision: number;
  readonly approvedSnapshotId: string | null;
  readonly approvalNote: string | null;
}

/** Scenario settings that change a run's calendar or liquidity tests (not its name or kind). */
export interface ForecastScenarioParameterSet {
  readonly startDate: string;
  readonly horizonWeeks: number;
  readonly horizonMonths: number;
  readonly reserveFloorCents: string;
  readonly currency: string;
}

export function forecastParametersSha256(parameters: ForecastScenarioParameterSet): string {
  return canonicalJsonSha256({ startDate: parameters.startDate, horizonWeeks: parameters.horizonWeeks, horizonMonths: parameters.horizonMonths, reserveFloorCents: parameters.reserveFloorCents, currency: parameters.currency });
}

const SCENARIO_COLUMNS = `s.id, s.organization_id, s.name, s.kind, s.state, s.base_scenario_id, s.start_date::text AS start_date,
  s.horizon_weeks, s.horizon_months, s.reserve_floor_cents::text AS reserve_floor_cents, s.currency, s.current_assumption_version,
  s.record_revision, s.created_by, s.created_at, s.updated_at, s.updated_at::text AS updated_cursor, s.archived_at, s.approved_snapshot_id, s.approval_note`;

const SNAPSHOT_META_COLUMNS = `n.id, n.scenario_id, n.assumption_version, n.model_version, n.actuals_cutoff::text AS actuals_cutoff,
  n.source_fingerprint, n.result_sha256, n.label, n.created_by, n.created_at,
  n.result->>'completeness' AS completeness, n.result->'scenario' AS scenario_parameters, n.result->>'currency' AS result_currency,
  n.result->'summary'->>'openingCashKnown' AS opening_cash_known,
  NOT EXISTS (SELECT 1 FROM jsonb_array_elements(n.result->'checks') AS c(check_row) WHERE (c.check_row->>'passed')::boolean IS NOT TRUE) AS checks_passed`;

function scenarioRow(row: Record<string, unknown>): ScenarioRow {
  return {
    id: dbString(row.id, "id"),
    organizationId: dbString(row.organization_id, "organization_id"),
    name: dbString(row.name, "name"),
    kind: dbString(row.kind, "kind"),
    state: dbString(row.state, "state") as ForecastScenarioState,
    baseScenarioId: dbNullableString(row.base_scenario_id, "base_scenario_id"),
    startDate: dbString(row.start_date, "start_date"),
    horizonWeeks: Number(row.horizon_weeks),
    horizonMonths: Number(row.horizon_months),
    reserveFloorCents: dbString(row.reserve_floor_cents, "reserve_floor_cents"),
    currency: dbString(row.currency, "currency"),
    currentAssumptionVersion: Number(row.current_assumption_version),
    recordRevision: dbRevision(row.record_revision),
    approvedSnapshotId: dbNullableString(row.approved_snapshot_id, "approved_snapshot_id"),
    approvalNote: dbNullableString(row.approval_note, "approval_note"),
  };
}

function snapshotParametersSha256(row: Record<string, unknown>): string {
  const raw = typeof row.scenario_parameters === "string" ? JSON.parse(row.scenario_parameters) : row.scenario_parameters;
  const scenario = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return forecastParametersSha256({
    startDate: String(scenario.startDate ?? ""), horizonWeeks: Number(scenario.horizonWeeks ?? 0), horizonMonths: Number(scenario.horizonMonths ?? 0),
    reserveFloorCents: String(scenario.reserveFloorCents ?? ""), currency: String(row.result_currency ?? ""),
  });
}

export function snapshotMeta(row: Record<string, unknown>): ForecastSnapshotMeta {
  return forecastSnapshotMetaSchema.parse({
    id: dbString(row.id, "id"),
    scenarioId: dbString(row.scenario_id, "scenario_id"),
    assumptionVersion: Number(row.assumption_version),
    modelVersion: dbString(row.model_version, "model_version"),
    actualsCutoff: dbString(row.actuals_cutoff, "actuals_cutoff"),
    sourceFingerprint: dbString(row.source_fingerprint, "source_fingerprint"),
    resultSha256: dbString(row.result_sha256, "result_sha256"),
    label: dbNullableString(row.label, "label"),
    completeness: row.completeness === "complete" ? "complete" : "partial",
    checksPassed: row.checks_passed === true,
    openingCashKnown: row.opening_cash_known === "true" || row.opening_cash_known === true,
    parametersSha256: snapshotParametersSha256(row),
    createdBy: dbString(row.created_by, "created_by"),
    createdAt: dbTimestamp(row.created_at, "created_at"),
  });
}

const META_FIELDS = ["id", "assumption_version", "model_version", "actuals_cutoff", "source_fingerprint", "result_sha256", "label", "created_by", "created_at",
  "completeness", "checks_passed", "scenario_parameters", "result_currency", "opening_cash_known"] as const;
const prefixedMetaColumns = (alias: string) => META_FIELDS.map(field => `${alias}.${field} AS ${alias}_${field}`).join(", ");
function prefixedMeta(row: Record<string, unknown>, alias: string, scenarioId: string): ForecastSnapshotMeta | null {
  if (!row[`${alias}_id`]) return null;
  return snapshotMeta({ ...Object.fromEntries(META_FIELDS.map(field => [field, row[`${alias}_${field}`]])), scenario_id: scenarioId });
}

function summary(row: Record<string, unknown>): ForecastScenarioSummary {
  const base = scenarioRow(row);
  const latest = prefixedMeta(row, "latest", base.id);
  const approved = prefixedMeta(row, "approved", base.id);
  return forecastScenarioSummarySchema.parse({
    id: base.id, organizationId: base.organizationId, name: base.name, kind: base.kind, state: base.state, baseScenarioId: base.baseScenarioId,
    startDate: base.startDate, horizonWeeks: base.horizonWeeks, horizonMonths: base.horizonMonths, reserveFloorCents: base.reserveFloorCents,
    currency: base.currency, currentAssumptionVersion: base.currentAssumptionVersion, recordRevision: base.recordRevision,
    createdBy: dbString(row.created_by, "created_by"), createdAt: dbTimestamp(row.created_at, "created_at"), updatedAt: dbTimestamp(row.updated_at, "updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "archived_at"), parametersSha256: forecastParametersSha256(base), latestSnapshot: latest,
    approvedSnapshotId: base.approvedSnapshotId, approvedSnapshot: approved, approvalNote: base.approvalNote,
  });
}

const SUMMARY_SELECT = `SELECT ${SCENARIO_COLUMNS}, ${prefixedMetaColumns("latest")}, ${prefixedMetaColumns("approved")}
  FROM company_forecast_scenarios s
  LEFT JOIN LATERAL (
    SELECT ${SNAPSHOT_META_COLUMNS} FROM company_forecast_snapshots n
     WHERE n.organization_id = s.organization_id AND n.scenario_id = s.id
     ORDER BY n.created_at DESC, n.id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT ${SNAPSHOT_META_COLUMNS} FROM company_forecast_snapshots n
     WHERE n.organization_id = s.organization_id AND n.id = s.approved_snapshot_id
  ) approved ON true`;

interface ListCursor { readonly updatedAt: string; readonly id: string }
function encodeCursor(value: ListCursor): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeCursor(value: string | undefined): ListCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.id) || !/^\d{4}-\d{2}-\d{2}[ T][0-9:.+-]+$/.test(parsed.updatedAt)) throw new Error("cursor");
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new ValidationCommandError("Forecast scenario cursor is invalid", { reason: "invalid_forecast_cursor" });
  }
}

export const forecastStore = {
  async listScenarios(executor: RentOpsQueryExecutor, input: { organizationId: string; states?: readonly string[]; limit: number; cursor?: string }): Promise<{ items: ForecastScenarioSummary[]; nextCursor: string | null }> {
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [input.organizationId];
    const where = ["s.organization_id = $1"];
    if (input.states) { values.push([...input.states]); where.push(`s.state = ANY($${values.length}::text[])`); }
    if (cursor) {
      values.push(cursor.updatedAt, cursor.id);
      where.push(`(s.updated_at < $${values.length - 1}::timestamptz OR (s.updated_at = $${values.length - 1}::timestamptz AND s.id < $${values.length}::uuid))`);
    }
    values.push(input.limit + 1);
    const result = await executor.query<Record<string, unknown>>(`${SUMMARY_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.updated_at DESC, s.id DESC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > input.limit;
    const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    const items = rows.map(summary);
    const last = rows.at(-1);
    // The cursor keeps PostgreSQL's full timestamp precision (microseconds).
    return { items, nextCursor: hasMore && last ? encodeCursor({ updatedAt: dbString(last.updated_cursor, "updated_cursor"), id: dbString(last.id, "id") }) : null };
  },

  async getScenarioSummary(executor: RentOpsQueryExecutor, organizationId: string, scenarioId: string): Promise<ForecastScenarioSummary | null> {
    const result = await executor.query<Record<string, unknown>>(`${SUMMARY_SELECT} WHERE s.organization_id = $1 AND s.id = $2`, [organizationId, scenarioId]);
    return result.rows[0] ? summary(result.rows[0]) : null;
  },

  async getScenario(executor: RentOpsQueryExecutor, organizationId: string, scenarioId: string, lock = false): Promise<ScenarioRow | null> {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT ${SCENARIO_COLUMNS} FROM company_forecast_scenarios s WHERE s.organization_id = $1 AND s.id = $2${lock ? " FOR UPDATE" : ""}`,
      [organizationId, scenarioId],
    );
    return result.rows[0] ? scenarioRow(result.rows[0]) : null;
  },

  async activeNameTaken(executor: RentOpsQueryExecutor, organizationId: string, name: string, exceptId?: string): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM company_forecast_scenarios WHERE organization_id = $1 AND archived_at IS NULL AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
      [organizationId, name, exceptId ?? null],
    );
    return result.rows.length > 0;
  },

  async insertScenario(executor: RentOpsQueryExecutor, row: Omit<ScenarioRow, "state" | "recordRevision" | "approvedSnapshotId" | "approvalNote"> & { createdBy: string }): Promise<void> {
    await executor.query(
      `INSERT INTO company_forecast_scenarios
         (id, organization_id, name, kind, state, base_scenario_id, start_date, horizon_weeks, horizon_months, reserve_floor_cents, currency, current_assumption_version, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9::bigint,$10,$11,$12)`,
      [row.id, row.organizationId, row.name, row.kind, row.baseScenarioId, row.startDate, row.horizonWeeks, row.horizonMonths, row.reserveFloorCents, row.currency, row.currentAssumptionVersion, row.createdBy],
    );
  },

  /** Revision-fenced update; returns the new revision. */
  async updateScenario(executor: RentOpsQueryExecutor, current: ScenarioRow, changes: Record<string, unknown>): Promise<number> {
    const columns = Object.keys(changes);
    const values = columns.map(column => changes[column]);
    const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
    values.push(current.organizationId, current.id, current.recordRevision);
    const result = await executor.query<{ record_revision: number }>(
      `UPDATE company_forecast_scenarios SET ${[...assignments, "updated_at = now()", "record_revision = record_revision + 1"].join(", ")}
        WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length}
        RETURNING record_revision`,
      values,
    );
    if (!result.rows[0]) throw new ValidationCommandError("Forecast scenario changed during the save", { reason: "revision_conflict" });
    return Number(result.rows[0].record_revision);
  },

  async insertAssumptionVersion(executor: RentOpsQueryExecutor, input: { organizationId: string; scenarioId: string; version: number; assumptions: ForecastAssumptions; sha256: string; reason: string; authorId: string }): Promise<void> {
    await executor.query(
      `INSERT INTO company_forecast_assumption_versions (organization_id, scenario_id, version, assumptions, assumptions_sha256, reason, author_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [input.organizationId, input.scenarioId, input.version, JSON.stringify(input.assumptions), input.sha256, input.reason, input.authorId],
    );
  },

  async getAssumptionVersion(executor: RentOpsQueryExecutor, organizationId: string, scenarioId: string, version: number): Promise<{ assumptions: unknown; sha256: string } | null> {
    const result = await executor.query<{ assumptions: unknown; assumptions_sha256: string }>(
      `SELECT assumptions, assumptions_sha256 FROM company_forecast_assumption_versions WHERE organization_id = $1 AND scenario_id = $2 AND version = $3`,
      [organizationId, scenarioId, version],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { assumptions: typeof row.assumptions === "string" ? JSON.parse(row.assumptions) : row.assumptions, sha256: row.assumptions_sha256 };
  },

  async listVersions(executor: RentOpsQueryExecutor, organizationId: string, scenarioId: string): Promise<ForecastAssumptionVersionMeta[]> {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT version, reason, author_id, assumptions_sha256, created_at FROM company_forecast_assumption_versions
        WHERE organization_id = $1 AND scenario_id = $2 ORDER BY version DESC LIMIT 200`,
      [organizationId, scenarioId],
    );
    return result.rows.map(row => forecastAssumptionVersionMetaSchema.parse({
      version: Number(row.version), reason: dbString(row.reason, "reason"), authorId: dbString(row.author_id, "author_id"),
      assumptionsSha256: dbString(row.assumptions_sha256, "assumptions_sha256"), createdAt: dbTimestamp(row.created_at, "created_at"),
    }));
  },

  async insertSnapshot(executor: RentOpsQueryExecutor, input: { id: string; organizationId: string; scenarioId: string; assumptionVersion: number; modelVersion: string; actualsCutoff: string; sourceFingerprint: string; resultSha256: string; stored: StoredForecastSnapshot; label: string | null; createdBy: string }): Promise<void> {
    await executor.query(
      `INSERT INTO company_forecast_snapshots (id, organization_id, scenario_id, assumption_version, model_version, actuals_cutoff, source_fingerprint, result_sha256, result, label, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [input.id, input.organizationId, input.scenarioId, input.assumptionVersion, input.modelVersion, input.actualsCutoff, input.sourceFingerprint, input.resultSha256, JSON.stringify(input.stored), input.label, input.createdBy],
    );
  },

  async listSnapshots(executor: RentOpsQueryExecutor, organizationId: string, scenarioId: string, limit = 50): Promise<ForecastSnapshotMeta[]> {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT ${SNAPSHOT_META_COLUMNS} FROM company_forecast_snapshots n WHERE n.organization_id = $1 AND n.scenario_id = $2 ORDER BY n.created_at DESC, n.id DESC LIMIT $3`,
      [organizationId, scenarioId, limit],
    );
    return result.rows.map(snapshotMeta);
  },

  async getSnapshotMeta(executor: RentOpsQueryExecutor, organizationId: string, snapshotId: string): Promise<ForecastSnapshotMeta | null> {
    const result = await executor.query<Record<string, unknown>>(`SELECT ${SNAPSHOT_META_COLUMNS} FROM company_forecast_snapshots n WHERE n.organization_id = $1 AND n.id = $2`, [organizationId, snapshotId]);
    return result.rows[0] ? snapshotMeta(result.rows[0]) : null;
  },

  async getSnapshot(executor: RentOpsQueryExecutor, organizationId: string, snapshotId: string): Promise<{ meta: ForecastSnapshotMeta; view: ForecastResultView; sources: ForecastSourceData } | null> {
    const result = await executor.query<Record<string, unknown>>(`SELECT ${SNAPSHOT_META_COLUMNS}, n.result FROM company_forecast_snapshots n WHERE n.organization_id = $1 AND n.id = $2`, [organizationId, snapshotId]);
    const row = result.rows[0];
    if (!row) return null;
    const stored = (typeof row.result === "string" ? JSON.parse(row.result) : row.result) as StoredForecastSnapshot;
    const { replay, ...view } = stored;
    return { meta: snapshotMeta(row), view, sources: replay.sources };
  },

  async hasApprovedScenario(executor: RentOpsQueryExecutor, organizationId: string): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM company_forecast_scenarios s
         JOIN company_forecast_snapshots n ON n.organization_id = s.organization_id AND n.id = s.approved_snapshot_id
        WHERE s.organization_id = $1 AND s.state = 'approved' LIMIT 1`,
      [organizationId],
    );
    return result.rows.length > 0;
  },
};
