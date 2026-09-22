import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  reportExportJobSchema,
  reportPackageRunSchema,
  reportPackageSchema,
  reportPresetSchema,
  reportRunRecordSchema,
  reportDrilldownSchema,
  type ReportExportJob,
  type ReportDrilldown,
  type ReportPackage,
  type ReportPackageRun,
  type ReportPreset,
  type ReportRunRecord,
  type ReportRow,
} from "../../shared/reporting";
import type { ReportingStore } from "./store";

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error("reporting_payload_invalid"); }
}

function payload<T>(value: unknown, parser: { parse(value: unknown): T }): T { return parser.parse(storedJson(value)); }

export class PostgresReportingStore implements ReportingStore {
  constructor(private readonly database: RentOpsQueryExecutor) {}

  async saveRun(run: ReportRunRecord): Promise<ReportRunRecord> {
    const header = { ...run, rows: [], drilldowns: [] };
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO company_report_runs (id, snapshot_id, organization_id, actor_id, permission_fingerprint, report_id, definition_version, state, generated_at, expires_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (id) DO NOTHING RETURNING payload`,
      [run.id, run.snapshotId, run.organizationId, run.actorId, run.permissionFingerprint, run.reportId, run.definitionVersion, run.state, run.generatedAt, run.expiresAt, JSON.stringify(header)],
    );
    if (result.rows[0]) {
      await this.insertRunRows(run);
      return run;
    }
    throw new Error("report_run_immutable");
  }

  private async insertRunRows(run: ReportRunRecord): Promise<void> {
    const chunkSize = 500;
    for (let start = 0; start < run.rows.length; start += chunkSize) {
      const chunk = run.rows.slice(start, start + chunkSize);
      const values: unknown[] = [];
      const tuples = chunk.map((row, index) => {
        const offset = values.length;
        values.push(run.id, start + index, row.rowId, JSON.stringify(row));
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::jsonb)`;
      });
      if (tuples.length) await this.database.query(`INSERT INTO company_report_run_rows (run_id,row_index,row_id,payload) VALUES ${tuples.join(",")} ON CONFLICT (run_id,row_index) DO NOTHING`, values);
    }
    for (const drilldown of run.drilldowns) await this.database.query(`INSERT INTO company_report_run_drilldowns (run_id,row_id,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (run_id,row_id) DO NOTHING`, [run.id, drilldown.rowId, JSON.stringify(drilldown)]);
  }

  async readRun(organizationId: string, runId: string): Promise<ReportRunRecord | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_runs WHERE organization_id=$1 AND id=$2`, [organizationId, runId]);
    if (!result.rows[0]) return null;
    const header = payload(result.rows[0].payload, reportRunRecordSchema);
    const rows = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_run_rows WHERE run_id=$1 ORDER BY row_index`, [runId]);
    const drilldowns = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_run_drilldowns WHERE run_id=$1 ORDER BY row_id`, [runId]);
    return reportRunRecordSchema.parse({ ...header, rows: rows.rows.map(row => payload(row.payload, { parse: value => value as ReportRow })), drilldowns: drilldowns.rows.map(row => storedJson(row.payload)) });
  }

  async readRunByRequest(organizationId: string, actorId: string, requestId: string): Promise<ReportRunRecord | null> {
    const result = await this.database.query<{ id: string }>(`SELECT id FROM company_report_runs WHERE organization_id=$1 AND actor_id=$2 AND payload->>'requestId'=$3 ORDER BY generated_at DESC LIMIT 1`, [organizationId, actorId, requestId]);
    return result.rows[0] ? this.readRun(organizationId, result.rows[0].id) : null;
  }

  async readRunMetadata(organizationId: string, runId: string): Promise<ReportRunRecord | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_runs WHERE organization_id=$1 AND id=$2`, [organizationId, runId]);
    if (!result.rows[0]) return null;
    const header = payload(result.rows[0].payload, reportRunRecordSchema);
    return reportRunRecordSchema.parse({ ...header, rows: [], drilldowns: [] });
  }

  async readRunRows(organizationId: string, runId: string, offset: number, limit: number): Promise<{ readonly rows: readonly ReportRow[]; readonly totalRows: number }> {
    const count = await this.database.query<{ count: string | number }>(`SELECT count(*)::text AS count FROM company_report_run_rows r JOIN company_report_runs run ON run.id=r.run_id WHERE run.organization_id=$1 AND run.id=$2`, [organizationId, runId]);
    const result = await this.database.query<Record<string, unknown>>(`SELECT r.payload FROM company_report_run_rows r JOIN company_report_runs run ON run.id=r.run_id WHERE run.organization_id=$1 AND run.id=$2 ORDER BY r.row_index OFFSET $3 LIMIT $4`, [organizationId, runId, offset, limit]);
    return { rows: result.rows.map(row => payload(row.payload, { parse: value => value as ReportRow })), totalRows: Number(count.rows[0]?.count ?? 0) };
  }

  async readRunDrilldown(organizationId: string, runId: string, rowId: string): Promise<ReportDrilldown | null> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT drilldown.payload
       FROM company_report_run_drilldowns AS drilldown
       JOIN company_report_runs AS run ON run.id=drilldown.run_id
       WHERE run.organization_id=$1 AND run.id=$2 AND drilldown.row_id=$3`,
      [organizationId, runId, rowId],
    );
    return result.rows[0] ? payload(result.rows[0].payload, reportDrilldownSchema) : null;
  }

  async saveExport(job: ReportExportJob): Promise<ReportExportJob> {
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO company_report_exports (id, run_id, organization_id, actor_id, permission_fingerprint, state, format, file_name, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING RETURNING payload`,
      [job.id, job.runId, job.organizationId, job.actorId, job.permissionFingerprint, job.state, job.format, job.fileName, JSON.stringify(job), job.createdAt],
    );
    if (result.rows[0]) return payload(result.rows[0].payload, reportExportJobSchema);
    throw new Error("report_export_immutable");
  }

  async readExport(organizationId: string, jobId: string): Promise<ReportExportJob | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_exports WHERE organization_id=$1 AND id=$2`, [organizationId, jobId]);
    return result.rows[0] ? payload(result.rows[0].payload, reportExportJobSchema) : null;
  }

  async savePreset(preset: ReportPreset): Promise<ReportPreset> {
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO company_report_presets (id, organization_id, owner_actor_id, visibility, report_id, revision, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (id) DO UPDATE SET visibility=EXCLUDED.visibility, report_id=EXCLUDED.report_id, revision=EXCLUDED.revision, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at
         WHERE company_report_presets.organization_id = EXCLUDED.organization_id
           AND company_report_presets.revision = EXCLUDED.revision - 1
       RETURNING payload`,
      [preset.id, preset.organizationId, preset.ownerActorId, preset.visibility, preset.reportId, preset.revision, JSON.stringify(preset), preset.createdAt, preset.updatedAt],
    );
    if (!result.rows[0]) throw new Error("report_preset_revision_conflict");
    await this.database.query(`INSERT INTO company_report_preset_revisions (preset_id, revision, payload, created_at) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (preset_id, revision) DO NOTHING`, [preset.id, preset.revision, JSON.stringify(preset.current), preset.updatedAt]);
    return payload(result.rows[0].payload, reportPresetSchema);
  }

  async readPreset(organizationId: string, presetId: string): Promise<ReportPreset | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_presets WHERE organization_id=$1 AND id=$2`, [organizationId, presetId]);
    return result.rows[0] ? payload(result.rows[0].payload, reportPresetSchema) : null;
  }

  async listPresets(organizationId: string, actorId: string): Promise<readonly ReportPreset[]> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_presets WHERE organization_id=$1 AND (visibility='shared' OR owner_actor_id=$2) ORDER BY updated_at DESC, id`, [organizationId, actorId]);
    return result.rows.map(row => payload(row.payload, reportPresetSchema));
  }

  async savePackage(pkg: ReportPackage): Promise<ReportPackage> {
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO company_report_packages (id, organization_id, owner_actor_id, visibility, revision, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET visibility=EXCLUDED.visibility, revision=EXCLUDED.revision, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at
         WHERE company_report_packages.organization_id = EXCLUDED.organization_id
           AND company_report_packages.revision = EXCLUDED.revision - 1
       RETURNING payload`,
      [pkg.id, pkg.organizationId, pkg.ownerActorId, pkg.visibility, pkg.revision, JSON.stringify(pkg), pkg.createdAt, pkg.updatedAt],
    );
    if (!result.rows[0]) throw new Error("report_package_revision_conflict");
    await this.database.query(`INSERT INTO company_report_package_revisions (package_id, revision, payload, created_at) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (package_id, revision) DO NOTHING`, [pkg.id, pkg.revision, JSON.stringify(pkg), pkg.updatedAt]);
    return payload(result.rows[0].payload, reportPackageSchema);
  }

  async readPackage(organizationId: string, packageId: string): Promise<ReportPackage | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_packages WHERE organization_id=$1 AND id=$2`, [organizationId, packageId]);
    return result.rows[0] ? payload(result.rows[0].payload, reportPackageSchema) : null;
  }

  async listPackages(organizationId: string, actorId: string): Promise<readonly ReportPackage[]> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_packages WHERE organization_id=$1 AND (visibility='shared' OR owner_actor_id=$2) ORDER BY updated_at DESC, id`, [organizationId, actorId]);
    return result.rows.map(row => payload(row.payload, reportPackageSchema));
  }

  async savePackageRun(run: ReportPackageRun): Promise<ReportPackageRun> {
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO company_report_package_runs (id, package_id, organization_id, actor_id, permission_fingerprint, state, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (id) DO NOTHING RETURNING payload`,
      [run.id, run.packageId, run.organizationId, run.actorId, run.permissionFingerprint, run.state, JSON.stringify(run), run.createdAt],
    );
    if (result.rows[0]) return payload(result.rows[0].payload, reportPackageRunSchema);
    throw new Error("report_package_run_immutable");
  }

  async readPackageRun(organizationId: string, runId: string): Promise<ReportPackageRun | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT payload FROM company_report_package_runs WHERE organization_id=$1 AND id=$2`, [organizationId, runId]);
    return result.rows[0] ? payload(result.rows[0].payload, reportPackageRunSchema) : null;
  }
}
