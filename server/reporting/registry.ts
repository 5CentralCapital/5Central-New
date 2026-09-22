import {
  getReportingDefinitions,
  type ReportDefinition,
  type ReportEntry,
  type ReportId,
  type ReportingEngineContext,
  type ReportingEngineResult,
} from "../../shared/reporting";
import { ReportingError } from "./errors";

export interface ReportingEngine {
  readonly key: string;
  readonly reportIds: readonly ReportId[];
  readonly ready: boolean;
  readonly reason?: string;
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
  getEntry(reportId: string, version?: string): ReportEntry;
  listEntries(): readonly ReportEntry[];
  registerEngine(engine: ReportingEngine): void;
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
    if (!engine || !engine.ready) throw new ReportingError("report_unavailable", `Report ${definition.title} is not executable yet`, 409, { reportId: definition.id, dependencies: definition.dependencies, reason: engine?.reason ?? "engine_not_registered" });
    return engine;
  };
  const api: ReportingRegistry = {
    definitions,
    get engines() { return Object.freeze(Array.from(engines.values()).filter((engine, index, all) => all.findIndex(item => item.key === engine.key) === index)); },
    getDefinition: definitionFor,
    getEngine,
    getEntry(reportId, version = "1") {
      const definition = definitionFor(reportId, version);
      const engine = engines.get(engineKey(definition.id, definition.version));
      const executable = Boolean(engine?.ready);
      return Object.freeze({
        ...definition,
        executable,
        runtimeStatus: executable ? "ready" as const : engine ? "blocked" as const : "planned" as const,
        runtimeReason: executable ? null : engine?.reason ?? "engine_not_registered",
      });
    },
    listEntries() { return Object.freeze(definitions.map(definition => api.getEntry(definition.id, definition.version))); },
    registerEngine(engine) {
      if (!engine.key || engine.reportIds.length === 0) throw new ReportingError("report_validation", "A reporting engine needs a key and at least one report ID");
      for (const reportId of engine.reportIds) {
        if (!definitions.some(definition => definition.id === reportId)) throw new ReportingError("report_validation", `Engine ${engine.key} references an unknown report`, 400, { reportId });
        const versions = engine.definitionVersions?.filter(item => item.reportId === reportId).map(item => item.version) ?? [definitions.find(definition => definition.id === reportId)?.version ?? "1"];
        for (const version of versions) engines.set(engineKey(reportId, version), engine);
      }
    },
  };
  // Validate the supplied definitions before exposing the registry.
  for (const definition of definitions) {
    if (!definition.id || !definition.version) throw new ReportingError("report_validation", "A report definition needs an ID and version");
  }
  return api;
}
