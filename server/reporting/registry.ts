import {
  getReportingDefinitions,
  type ReportDefinition,
  type ReportEntry,
  type ReportId,
  type ReportingEngineContext,
  type ReportingEngineResult,
  type ReportingRuntimeStatus,
} from "../../shared/reporting";
import { ReportingError } from "./errors";

/** Organization-level source check used by the catalog. It never runs a report. */
export interface ReportingEngineProbeResult {
  readonly status: Exclude<ReportingRuntimeStatus, "not_implemented">;
  readonly reason?: string | null;
  readonly dependency?: string | null;
}

export interface ReportingEngineProbeInput {
  readonly organizationId: string;
  readonly reportId: ReportId;
}

export interface ReportingEngine {
  readonly key: string;
  readonly reportIds: readonly ReportId[];
  readonly ready: boolean;
  readonly reason?: string;
  /** Why a registered engine is not ready. Missing data is the default; a
   * placeholder that has no calculation must say `not_implemented`. */
  readonly unavailableKind?: "missing_data" | "not_implemented";
  /** The exact source/mapping that is missing (for example `approved_forecast_scenario`). */
  readonly dependency?: string;
  /** Optional cheap source check (connection, mapping or record presence). */
  probe?(input: ReportingEngineProbeInput): Promise<ReportingEngineProbeResult>;
  /** Optional explicit definition versions. Omitted means the matching v1 definition. */
  readonly definitionVersions?: readonly { readonly reportId: ReportId; readonly version: string }[];
  run(context: ReportingEngineContext): Promise<ReportingEngineResult>;
}

export interface ReportingRegistryOptions {
  readonly definitions?: readonly ReportDefinition[];
  readonly engines?: readonly ReportingEngine[];
}

export interface ReportingRegistry {
  readonly definitions: readonly ReportDefinition[];
  readonly engines: readonly ReportingEngine[];
  getDefinition(reportId: string, version?: string): ReportDefinition;
  getEngine(reportId: string, version?: string): ReportingEngine;
  /** Static capability from the registered engine (no source probes). */
  getEntry(reportId: string, version?: string): ReportEntry;
  listEntries(): readonly ReportEntry[];
  /** Runtime capability including each engine's organization-level source probe. */
  listRuntimeEntries(organizationId: string): Promise<readonly ReportEntry[]>;
  registerEngine(engine: ReportingEngine): void;
}

export const REPORT_NOT_IMPLEMENTED_REASON = "No report engine is registered for this report.";

function entryFor(definition: ReportDefinition, engine: ReportingEngine | undefined, probe?: ReportingEngineProbeResult): ReportEntry {
  let runtimeStatus: ReportingRuntimeStatus;
  let runtimeReason: string | null;
  let runtimeDependency: string | null;
  if (!engine) {
    runtimeStatus = "not_implemented"; runtimeReason = REPORT_NOT_IMPLEMENTED_REASON; runtimeDependency = null;
  } else if (!engine.ready) {
    runtimeStatus = engine.unavailableKind ?? "missing_data";
    runtimeReason = engine.reason ?? "A required report source is not registered.";
    runtimeDependency = engine.dependency ?? null;
  } else if (probe && probe.status !== "available") {
    runtimeStatus = "missing_data";
    runtimeReason = probe.reason ?? "A required report source has no data for this company.";
    runtimeDependency = probe.dependency ?? null;
  } else {
    runtimeStatus = "available"; runtimeReason = null; runtimeDependency = null;
  }
  return Object.freeze({ ...definition, executable: runtimeStatus === "available", runtimeStatus, runtimeReason, runtimeDependency });
}

export function createReportingRegistry(options: ReportingRegistryOptions = {}): ReportingRegistry {
  const definitions = Object.freeze([...(options.definitions ?? getReportingDefinitions())]);
  const engines = new Map<string, ReportingEngine>();
  const engineKey = (reportId: string, version: string): string => `${reportId}@${version}`;
  for (const engine of options.engines ?? []) for (const reportId of engine.reportIds) {
    const versions = engine.definitionVersions?.filter(item => item.reportId === reportId).map(item => item.version) ?? [definitions.find(item => item.id === reportId)?.version ?? "1"];
    for (const version of versions) engines.set(engineKey(reportId, version), engine);
  }
  const definitionFor = (reportId: string, version = "1"): ReportDefinition => {
    const definition = definitions.find(item => item.id === reportId && item.version === version);
    if (!definition) throw new ReportingError("report_not_found", `Report ${reportId} is not available in this service`, 404, { reportId, version });
    return definition;
  };
  const getEngine = (reportId: string, version = "1"): ReportingEngine => {
    const definition = definitionFor(reportId, version);
    const engine = engines.get(engineKey(definition.id, definition.version));
    if (!engine || !engine.ready) throw new ReportingError("report_unavailable", engine?.reason ?? `Report ${definition.title} has no registered engine.`, 409, { reportId: definition.id, runtimeStatus: engine ? engine.unavailableKind ?? "missing_data" : "not_implemented", dependency: engine?.dependency ?? null });
    return engine;
  };
  const api: ReportingRegistry = {
    definitions,
    get engines() { return Object.freeze(Array.from(engines.values()).filter((engine, index, all) => all.findIndex(item => item.key === engine.key) === index)); },
    getDefinition: definitionFor,
    getEngine,
    getEntry(reportId, version = "1") {
      const definition = definitionFor(reportId, version);
      return entryFor(definition, engines.get(engineKey(definition.id, definition.version)));
    },
    listEntries() { return Object.freeze(definitions.map(definition => api.getEntry(definition.id, definition.version))); },
    async listRuntimeEntries(organizationId) {
      // One probe per engine and report; probes are cheap source checks and a
      // failing probe is reported as missing data, never as available.
      const results = await Promise.all(definitions.map(async definition => {
        const engine = engines.get(engineKey(definition.id, definition.version));
        if (!engine?.ready || !engine.probe) return entryFor(definition, engine);
        let probe: ReportingEngineProbeResult;
        try { probe = await engine.probe({ organizationId, reportId: definition.id }); }
        catch (error) { probe = { status: "missing_data", reason: error instanceof ReportingError ? error.message : "The report source could not be checked.", dependency: error instanceof ReportingError && typeof error.details.dependency === "string" ? error.details.dependency : null }; }
        return entryFor(definition, engine, probe);
      }));
      return Object.freeze(results);
    },
    registerEngine(engine) {
      if (!engine.key || engine.reportIds.length === 0) throw new ReportingError("report_validation", "A reporting engine needs a key and at least one report ID");
      for (const reportId of engine.reportIds) {
        if (!definitions.some(definition => definition.id === reportId)) throw new ReportingError("report_validation", `Engine ${engine.key} references an unknown report`, 400, { reportId });
        const versions = engine.definitionVersions?.filter(item => item.reportId === reportId).map(item => item.version) ?? [definitions.find(definition => definition.id === reportId)?.version ?? "1"];
        for (const version of versions) engines.set(engineKey(reportId, version), engine);
      }
    },
  };
  for (const definition of definitions) {
    if (!definition.id || !definition.version) throw new ReportingError("report_validation", "A report definition needs an ID and version");
  }
  return api;
}
