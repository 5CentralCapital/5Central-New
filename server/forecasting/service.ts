import { ZodError } from "zod";
import { companyScopeSchema, type CompanyScope } from "../../shared/company";
import { forecastAssumptionsSchema, type ForecastAssumptions } from "../../shared/forecasting/assumptions";
import {
  forecastCompareQuerySchema,
  forecastExplainQuerySchema,
  forecastScenarioIdSchema,
  forecastScenarioListQuerySchema,
  forecastSnapshotIdSchema,
  type ForecastCompareQuery,
  type ForecastCompareResponse,
  type ForecastExplainQuery,
  type ForecastExplainResponse,
  type ForecastRunSource,
  type ForecastScenarioDetail,
  type ForecastScenarioListQuery,
  type ForecastScenarioListResponse,
  type ForecastSnapshotMeta,
} from "../../shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION, type ForecastResult, type ForecastResultView } from "../../shared/forecasting/result";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ForecastInputError, runForecast } from "./engine";
import { compareForecasts, explainForecastLine, resultView } from "./explain";
import type { ForecastSourceReader } from "./sources";
import { forecastStore, type ScenarioRow } from "./store";

/** Forecasts are portfolio-wide: reading or changing one requires an organization-level grant. */
export const FORECAST_READ_ROLES = ["owner", "admin", "finance", "read_only_reviewer"] as const;

export interface ForecastRuntime {
  readonly sources: (executor: RentOpsQueryExecutor) => ForecastSourceReader;
  /** Operating date (America/New_York) used to date-stamp source reads. */
  readonly today: () => string;
}

export interface ForecastPreview {
  readonly scenarioId: string;
  readonly assumptionVersion: number | null;
  readonly draft: boolean;
  readonly modelVersion: string;
  readonly sourceFingerprint: string;
  readonly resultSha256: string;
  readonly result: ForecastResultView;
}

export interface ForecastSnapshotView {
  readonly snapshot: ForecastSnapshotMeta;
  readonly result: ForecastResultView;
}

export function operatingToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function organizationScope(scope: CompanyScope | unknown): CompanyScope {
  const parsed = companyScopeSchema.parse(scope);
  return companyScopeSchema.parse({ organizationId: parsed.organizationId });
}

export function parseForecastAssumptions(document: unknown): ForecastAssumptions {
  try {
    return forecastAssumptionsSchema.parse(document);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw new ValidationCommandError(`Forecast assumptions are invalid. ${where}${issue?.message ?? "Check the document."}`, {
        reason: "forecast_assumptions_invalid", issues: error.issues.slice(0, 20).map(item => ({ path: item.path, message: item.message })),
      });
    }
    throw error;
  }
}

/** Read sources, run the deterministic engine and fingerprint inputs and output. */
export async function computeForecast(executor: RentOpsQueryExecutor, runtime: ForecastRuntime, scenario: ScenarioRow, assumptions: ForecastAssumptions): Promise<{ result: ForecastResult; sourceFingerprint: string; resultSha256: string }> {
  const debtIds = Array.from(new Set(assumptions.loans.flatMap(loan => (loan.sourceDebtId ? [loan.sourceDebtId] : [])))).sort();
  const sources = await runtime.sources(executor).read({ organizationId: scenario.organizationId, asOf: assumptions.actualsCutoff, debtIds, today: runtime.today() });
  const sourceFingerprint = canonicalJsonSha256({ modelVersion: FORECAST_MODEL_VERSION, asOf: assumptions.actualsCutoff, sources });
  let result: ForecastResult;
  try {
    result = runForecast({
      scenario: { name: scenario.name, kind: scenario.kind, startDate: scenario.startDate, horizonWeeks: scenario.horizonWeeks, horizonMonths: scenario.horizonMonths, reserveFloorCents: scenario.reserveFloorCents, currency: scenario.currency },
      assumptions, sources,
    });
  } catch (error) {
    if (error instanceof ForecastInputError) throw new ValidationCommandError(error.message, { reason: error.code, ...(error.path ? { path: error.path } : {}) });
    throw error;
  }
  return { result, sourceFingerprint, resultSha256: canonicalJsonSha256(result) };
}

/** Scoped forecast reads shared by the browser, HTTP API and MCP tools. */
export class ForecastReadService {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly runtime: ForecastRuntime) {}

  private authorize(principal: AuthenticatedPrincipal, scope: unknown): CompanyScope {
    const organization = organizationScope(scope);
    authorizeCompanyRead(principal, organization, FORECAST_READ_ROLES);
    return organization;
  }

  private async scenario(organizationId: string, scenarioId: string): Promise<ScenarioRow> {
    const scenario = await forecastStore.getScenario(this.executor, organizationId, forecastScenarioIdSchema.parse(scenarioId));
    if (!scenario) throw new ValidationCommandError("Forecast scenario was not found", { reason: "forecast_scenario_not_found" });
    return scenario;
  }

  private async assumptionsFor(organizationId: string, scenarioId: string, version: number): Promise<ForecastAssumptions> {
    const stored = await forecastStore.getAssumptionVersion(this.executor, organizationId, scenarioId, version);
    if (!stored) throw new ValidationCommandError(`Assumption version ${version} was not found`, { reason: "forecast_version_not_found" });
    return parseForecastAssumptions(stored.assumptions);
  }

  async list(principal: AuthenticatedPrincipal, input: ForecastScenarioListQuery): Promise<ForecastScenarioListResponse> {
    const query = forecastScenarioListQuerySchema.parse(input);
    const scope = this.authorize(principal, query.scope);
    return forecastStore.listScenarios(this.executor, { organizationId: scope.organizationId, ...(query.states ? { states: query.states } : {}), limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
  }

  async get(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string }): Promise<ForecastScenarioDetail> {
    const scope = this.authorize(principal, input.scope);
    const scenarioId = forecastScenarioIdSchema.parse(input.scenarioId);
    const summary = await forecastStore.getScenarioSummary(this.executor, scope.organizationId, scenarioId);
    if (!summary) throw new ValidationCommandError("Forecast scenario was not found", { reason: "forecast_scenario_not_found" });
    const current = summary.currentAssumptionVersion > 0 ? await forecastStore.getAssumptionVersion(this.executor, scope.organizationId, scenarioId, summary.currentAssumptionVersion) : null;
    return {
      ...summary,
      versions: await forecastStore.listVersions(this.executor, scope.organizationId, scenarioId),
      assumptions: (current?.assumptions ?? null) as Record<string, unknown> | null,
      snapshots: await forecastStore.listSnapshots(this.executor, scope.organizationId, scenarioId),
    };
  }

  async getAssumptionVersion(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string; version: number }): Promise<ForecastAssumptions> {
    const scope = this.authorize(principal, input.scope);
    const scenario = await this.scenario(scope.organizationId, input.scenarioId);
    return this.assumptionsFor(scope.organizationId, scenario.id, input.version);
  }

  /** Unsaved run of a saved version or of a draft document. Nothing is persisted. */
  async preview(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string; assumptionVersion?: number; assumptions?: unknown }): Promise<ForecastPreview> {
    const scope = this.authorize(principal, input.scope);
    const scenario = await this.scenario(scope.organizationId, input.scenarioId);
    const draft = input.assumptions !== undefined;
    const version = draft ? null : input.assumptionVersion ?? scenario.currentAssumptionVersion;
    if (version !== null && version < 1) throw new ValidationCommandError("This scenario has no saved assumptions yet", { reason: "forecast_version_not_found" });
    const assumptions = draft ? parseForecastAssumptions(input.assumptions) : await this.assumptionsFor(scope.organizationId, scenario.id, version!);
    const run = await computeForecast(this.executor, this.runtime, scenario, assumptions);
    return { scenarioId: scenario.id, assumptionVersion: version, draft, modelVersion: FORECAST_MODEL_VERSION, sourceFingerprint: run.sourceFingerprint, resultSha256: run.resultSha256, result: resultView(run.result) };
  }

  async snapshot(principal: AuthenticatedPrincipal, input: { scope: unknown; snapshotId: string }): Promise<ForecastSnapshotView> {
    const scope = this.authorize(principal, input.scope);
    const stored = await forecastStore.getSnapshot(this.executor, scope.organizationId, forecastSnapshotIdSchema.parse(input.snapshotId));
    if (!stored) throw new ValidationCommandError("Forecast snapshot was not found", { reason: "forecast_snapshot_not_found" });
    return { snapshot: stored.meta, result: resultView(stored.result) };
  }

  /** Full result (with events) for a snapshot or a fresh unsaved run. */
  private async resolveRun(organizationId: string, source: ForecastRunSource): Promise<{ result: ForecastResult; assumptions: ForecastAssumptions | null; meta: ForecastSnapshotMeta | null }> {
    if ("snapshotId" in source) {
      const stored = await forecastStore.getSnapshot(this.executor, organizationId, source.snapshotId);
      if (!stored) throw new ValidationCommandError("Forecast snapshot was not found", { reason: "forecast_snapshot_not_found" });
      const doc = await forecastStore.getAssumptionVersion(this.executor, organizationId, stored.meta.scenarioId, stored.meta.assumptionVersion);
      return { result: stored.result, assumptions: doc ? parseForecastAssumptions(doc.assumptions) : null, meta: stored.meta };
    }
    const scenario = await this.scenario(organizationId, source.scenarioId);
    const version = source.assumptionVersion ?? scenario.currentAssumptionVersion;
    const assumptions = await this.assumptionsFor(organizationId, scenario.id, version);
    const run = await computeForecast(this.executor, this.runtime, scenario, assumptions);
    return { result: run.result, assumptions, meta: null };
  }

  async explain(principal: AuthenticatedPrincipal, input: ForecastExplainQuery): Promise<ForecastExplainResponse> {
    const query = forecastExplainQuerySchema.parse(input);
    const scope = this.authorize(principal, query.scope);
    const run = await this.resolveRun(scope.organizationId, query.source);
    return explainForecastLine(run.result, run.assumptions, { line: query.line, period: query.period, limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
  }

  async compare(principal: AuthenticatedPrincipal, input: ForecastCompareQuery): Promise<ForecastCompareResponse> {
    const query = forecastCompareQuerySchema.parse(input);
    const scope = this.authorize(principal, query.scope);
    const side = async (snapshotId: string) => {
      const stored = await forecastStore.getSnapshot(this.executor, scope.organizationId, snapshotId);
      if (!stored) throw new ValidationCommandError("Forecast snapshot was not found", { reason: "forecast_snapshot_not_found" });
      const scenario = await this.scenario(scope.organizationId, stored.meta.scenarioId);
      const doc = await forecastStore.getAssumptionVersion(this.executor, scope.organizationId, stored.meta.scenarioId, stored.meta.assumptionVersion);
      return { meta: { ...stored.meta, scenarioName: scenario.name, scenarioKind: scenario.kind }, result: stored.result, assumptions: doc?.assumptions ?? null };
    };
    return compareForecasts(await side(query.snapshotA), await side(query.snapshotB), query.limit);
  }

  /** Resolve a snapshot for report runs: an explicit snapshot ID, or the latest snapshot of an assumption version. */
  async reportSnapshot(principal: AuthenticatedPrincipal, input: { organizationId: string; scenarioId: string; inputVersion: string; modelVersion: string }): Promise<{ meta: ForecastSnapshotMeta; result: ForecastResult } | null> {
    const scope = this.authorize(principal, { organizationId: input.organizationId });
    const scenarioId = forecastScenarioIdSchema.parse(input.scenarioId);
    let snapshotId: string | null;
    if (/^v?\d+$/.test(input.inputVersion)) {
      snapshotId = await forecastStore.latestSnapshotFor(this.executor, scope.organizationId, scenarioId, Number(input.inputVersion.replace(/^v/, "")), input.modelVersion);
    } else {
      snapshotId = forecastSnapshotIdSchema.parse(input.inputVersion);
    }
    if (!snapshotId) return null;
    const stored = await forecastStore.getSnapshot(this.executor, scope.organizationId, snapshotId);
    if (!stored || stored.meta.scenarioId !== scenarioId || stored.meta.modelVersion !== input.modelVersion) return null;
    return stored;
  }
}
