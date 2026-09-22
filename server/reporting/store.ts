import type {
  ReportDrilldown,
  ReportExportJob,
  ReportPackage,
  ReportPackageRun,
  ReportPreset,
  ReportRunRecord,
  ReportRow,
} from "../../shared/reporting";
import { deepClone } from "./utils";

export interface ReportingStore {
  saveRun(run: ReportRunRecord): Promise<ReportRunRecord>;
  readRun(organizationId: string, runId: string): Promise<ReportRunRecord | null>;
  readRunByRequest?(organizationId: string, actorId: string, requestId: string): Promise<ReportRunRecord | null>;
  /** Optional page path that avoids hydrating the full immutable snapshot. */
  readRunMetadata?(organizationId: string, runId: string): Promise<ReportRunRecord | null>;
  readRunRows?(organizationId: string, runId: string, offset: number, limit: number): Promise<{ readonly rows: readonly ReportRow[]; readonly totalRows: number }>;
  /** Optional drilldown path that avoids hydrating every row in a snapshot. */
  readRunDrilldown?(organizationId: string, runId: string, rowId: string): Promise<ReportDrilldown | null>;
  saveExport(job: ReportExportJob): Promise<ReportExportJob>;
  readExport(organizationId: string, jobId: string): Promise<ReportExportJob | null>;
  savePreset(preset: ReportPreset): Promise<ReportPreset>;
  readPreset(organizationId: string, presetId: string): Promise<ReportPreset | null>;
  listPresets(organizationId: string, actorId: string): Promise<readonly ReportPreset[]>;
  savePackage(pkg: ReportPackage): Promise<ReportPackage>;
  readPackage(organizationId: string, packageId: string): Promise<ReportPackage | null>;
  listPackages(organizationId: string, actorId: string): Promise<readonly ReportPackage[]>;
  savePackageRun(run: ReportPackageRun): Promise<ReportPackageRun>;
  readPackageRun(organizationId: string, runId: string): Promise<ReportPackageRun | null>;
}

/**
 * A deterministic store for tests and local development. The service never
 * treats this store as production persistence; production injects the SQL
 * store through the same interface.
 */
export class InMemoryReportingStore implements ReportingStore {
  private readonly runs = new Map<string, ReportRunRecord>();
  private readonly exports = new Map<string, ReportExportJob>();
  private readonly presets = new Map<string, ReportPreset>();
  private readonly packages = new Map<string, ReportPackage>();
  private readonly packageRuns = new Map<string, ReportPackageRun>();

  async saveRun(run: ReportRunRecord): Promise<ReportRunRecord> { if (this.runs.has(run.id)) throw new Error("report_run_immutable"); this.runs.set(run.id, deepClone(run)); return deepClone(run); }
  async readRun(organizationId: string, runId: string): Promise<ReportRunRecord | null> { const value = this.runs.get(runId); return value?.organizationId === organizationId ? deepClone(value) : null; }
  async readRunByRequest(organizationId: string, actorId: string, requestId: string): Promise<ReportRunRecord | null> { const value = Array.from(this.runs.values()).find(run => run.organizationId === organizationId && run.actorId === actorId && run.requestId === requestId); return value ? deepClone(value) : null; }
  async readRunDrilldown(organizationId: string, runId: string, rowId: string): Promise<ReportDrilldown | null> { const value = this.runs.get(runId); if (!value || value.organizationId !== organizationId) return null; const drilldown = value.drilldowns.find(item => item.rowId === rowId); return drilldown ? deepClone(drilldown) : null; }
  async saveExport(job: ReportExportJob): Promise<ReportExportJob> { if (this.exports.has(job.id)) throw new Error("report_export_immutable"); this.exports.set(job.id, deepClone(job)); return deepClone(job); }
  async readExport(organizationId: string, jobId: string): Promise<ReportExportJob | null> { const value = this.exports.get(jobId); return value?.organizationId === organizationId ? deepClone(value) : null; }
  async savePreset(preset: ReportPreset): Promise<ReportPreset> { const current = this.presets.get(preset.id); if (current && current.revision !== preset.revision - 1) throw new Error("report_preset_revision_conflict"); this.presets.set(preset.id, deepClone(preset)); return deepClone(preset); }
  async readPreset(organizationId: string, presetId: string): Promise<ReportPreset | null> { const value = this.presets.get(presetId); return value?.organizationId === organizationId ? deepClone(value) : null; }
  async listPresets(organizationId: string, actorId: string): Promise<readonly ReportPreset[]> { return Array.from(this.presets.values()).filter(value => value.organizationId === organizationId && (value.visibility === "shared" || value.ownerActorId === actorId)).map(deepClone); }
  async savePackage(pkg: ReportPackage): Promise<ReportPackage> { const current = this.packages.get(pkg.id); if (current && current.revision !== pkg.revision - 1) throw new Error("report_package_revision_conflict"); this.packages.set(pkg.id, deepClone(pkg)); return deepClone(pkg); }
  async readPackage(organizationId: string, packageId: string): Promise<ReportPackage | null> { const value = this.packages.get(packageId); return value?.organizationId === organizationId ? deepClone(value) : null; }
  async listPackages(organizationId: string, actorId: string): Promise<readonly ReportPackage[]> { return Array.from(this.packages.values()).filter(value => value.organizationId === organizationId && (value.visibility === "shared" || value.ownerActorId === actorId)).map(deepClone); }
  async savePackageRun(run: ReportPackageRun): Promise<ReportPackageRun> { if (this.packageRuns.has(run.id)) throw new Error("report_package_run_immutable"); this.packageRuns.set(run.id, deepClone(run)); return deepClone(run); }
  async readPackageRun(organizationId: string, runId: string): Promise<ReportPackageRun | null> { const value = this.packageRuns.get(runId); return value?.organizationId === organizationId ? deepClone(value) : null; }
}

export function createInMemoryReportingStore(): ReportingStore { return new InMemoryReportingStore(); }
