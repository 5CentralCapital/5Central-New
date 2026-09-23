import { ZodError } from "zod";
import { commandEnvelopeSchema, newRecordId, recordReferenceIdSchema, type CommandEnvelope, type OperationReceipt } from "../../shared/company";
import { emptyForecastAssumptions, forecastAssumptionsSchema, type ForecastAssumptions, type ForecastOverride } from "../../shared/forecasting/assumptions";
import { addDays } from "../../shared/forecasting/calendar";
import {
  approveForecastScenarioPayloadSchema,
  archiveForecastScenarioPayloadSchema,
  createForecastScenarioPayloadSchema,
  createForecastSnapshotPayloadSchema,
  forecastCommandPayloadSchemas,
  saveForecastAssumptionsPayloadSchema,
  setForecastOverridePayloadSchema,
  updateForecastScenarioPayloadSchema,
  type ForecastCommandKind,
} from "../../shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION } from "../../shared/forecasting/result";
import type { AuthenticatedPrincipal, CommandAuthorizationPolicy, TransportAttestation } from "../company/authorization";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { computeForecast, parseForecastAssumptions, type ForecastRuntime } from "./service";
import { forecastStore, type ScenarioRow } from "./store";

type Context = CommandHandlerContext<Record<string, unknown>>;

export interface ForecastCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export const FORECAST_WRITE_ROLES = ["owner", "admin", "finance"] as const;
export const FORECAST_APPROVE_ROLES = ["owner", "admin"] as const;
const policy = (commandKind: ForecastCommandKind, allowedRoles: CommandAuthorizationPolicy["allowedRoles"]): CommandAuthorizationPolicy =>
  ({ commandKind, allowedRoles, requiredScope: "organization" });
export const FORECAST_COMMAND_POLICIES: Readonly<Record<ForecastCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "forecast.scenario.create": policy("forecast.scenario.create", FORECAST_WRITE_ROLES),
  "forecast.scenario.update": policy("forecast.scenario.update", FORECAST_WRITE_ROLES),
  "forecast.scenario.archive": policy("forecast.scenario.archive", FORECAST_WRITE_ROLES),
  "forecast.scenario.approve": policy("forecast.scenario.approve", FORECAST_APPROVE_ROLES),
  "forecast.assumptions.save": policy("forecast.assumptions.save", FORECAST_WRITE_ROLES),
  "forecast.override.set": policy("forecast.override.set", FORECAST_WRITE_ROLES),
  "forecast.snapshot.create": policy("forecast.snapshot.create", FORECAST_WRITE_ROLES),
});

const NOT_POSTED = { code: "forecast.not_posted", severity: "info" as const, message: "Saved in 5Central Ops. Forecasts are never posted to QuickBooks." };

function saved(id: string, revision: number | null, extra: readonly string[] = []): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [id, ...extra],
    resultingRevisions: revision === null ? [] : [{ recordId: recordReferenceIdSchema.parse(id), revision: revision as never }],
    validationOutcomes: [NOT_POSTED],
  };
}

function requireRevision(context: Context, scenario: ScenarioRow): void {
  const expected = context.envelope.expectedRevision;
  if (expected === undefined) throw new ValidationCommandError("Supply the scenario revision you read before editing", { reason: "forecast_revision_required" });
  if (expected !== scenario.recordRevision) {
    throw new ConflictCommandError("This scenario changed since it was read. Reload it before saving again.", { reason: "revision_conflict", expected, actual: scenario.recordRevision });
  }
}

async function loadScenario(context: Context, scenarioId: string, lock = true): Promise<ScenarioRow> {
  const scenario = await forecastStore.getScenario(context.executor, context.envelope.scope.organizationId, scenarioId, lock);
  if (!scenario) throw new ValidationCommandError("Forecast scenario was not found", { reason: "forecast_scenario_not_found" });
  return scenario;
}

function assertActive(scenario: ScenarioRow): void {
  if (scenario.state === "archived") throw new ConflictCommandError("Archived scenarios cannot be changed", { reason: "forecast_scenario_archived" });
}

function assertCompatible(assumptions: ForecastAssumptions, scenario: { startDate: string; currency: string }): void {
  if (assumptions.currency !== scenario.currency) throw new ValidationCommandError("Assumptions must use the scenario currency", { reason: "forecast_currency_mismatch" });
  if (assumptions.actualsCutoff >= scenario.startDate) throw new ValidationCommandError("The actuals cutoff must be before the forecast start date", { reason: "forecast_cutoff_after_start" });
}

async function currentAssumptions(context: Context, scenario: ScenarioRow): Promise<{ assumptions: ForecastAssumptions; sha256: string }> {
  if (scenario.currentAssumptionVersion < 1) return { assumptions: emptyForecastAssumptions(addDays(scenario.startDate, -1), scenario.currency), sha256: "" };
  const stored = await forecastStore.getAssumptionVersion(context.executor, scenario.organizationId, scenario.id, scenario.currentAssumptionVersion);
  if (!stored) throw new ValidationCommandError("Current assumptions are missing", { reason: "forecast_version_not_found" });
  return { assumptions: parseForecastAssumptions(stored.assumptions), sha256: stored.sha256 };
}

/** Append a new immutable version and move the scenario to it (back to draft). */
async function appendVersion(context: Context, scenario: ScenarioRow, assumptions: ForecastAssumptions, reason: string, previousSha: string): Promise<CommandHandlerResult> {
  assertCompatible(assumptions, scenario);
  const sha256 = canonicalJsonSha256(assumptions);
  if (sha256 === previousSha) throw new ValidationCommandError("These assumptions match the current version; nothing to save", { reason: "forecast_assumptions_unchanged" });
  const version = scenario.currentAssumptionVersion + 1;
  await forecastStore.insertAssumptionVersion(context.executor, { organizationId: scenario.organizationId, scenarioId: scenario.id, version, assumptions, sha256, reason, authorId: context.principal.actorId });
  const revision = await forecastStore.updateScenario(context.executor, scenario, {
    current_assumption_version: version, state: scenario.state === "approved" ? "draft" : scenario.state,
    approved_snapshot_id: null, approved_by: null, approved_at: null,
  });
  return saved(scenario.id, revision);
}

const handlersFor = (runtime: ForecastRuntime): Readonly<Record<ForecastCommandKind, (context: Context) => Promise<CommandHandlerResult>>> => ({
  async "forecast.scenario.create"(context) {
    const payload = createForecastScenarioPayloadSchema.parse(context.envelope.payload);
    const organizationId = context.envelope.scope.organizationId;
    if (await forecastStore.activeNameTaken(context.executor, organizationId, payload.name)) {
      throw new ConflictCommandError("Another active scenario already uses this name", { reason: "forecast_scenario_name_taken" });
    }
    let assumptions: ForecastAssumptions;
    let reason = payload.reason ?? "Initial assumptions";
    if (payload.baseScenarioId) {
      const base = await forecastStore.getScenario(context.executor, organizationId, payload.baseScenarioId);
      if (!base) throw new ValidationCommandError("The scenario to duplicate was not found", { reason: "forecast_scenario_not_found" });
      const current = await currentAssumptions(context, base);
      assumptions = forecastAssumptionsSchema.parse({ ...current.assumptions, currency: payload.currency });
      reason = payload.reason ?? `Duplicated from ${base.name} version ${base.currentAssumptionVersion}`;
    } else if (payload.assumptions) {
      assumptions = parseForecastAssumptions(payload.assumptions);
    } else {
      assumptions = emptyForecastAssumptions(addDays(payload.startDate, -1), payload.currency);
    }
    assertCompatible(assumptions, payload);
    const id = newRecordId();
    await forecastStore.insertScenario(context.executor, {
      id, organizationId, name: payload.name, kind: payload.kind, baseScenarioId: payload.baseScenarioId ?? null, startDate: payload.startDate,
      horizonWeeks: payload.horizonWeeks, horizonMonths: payload.horizonMonths, reserveFloorCents: payload.reserveFloorCents, currency: payload.currency,
      currentAssumptionVersion: 1, createdBy: context.principal.actorId,
    });
    await forecastStore.insertAssumptionVersion(context.executor, { organizationId, scenarioId: id, version: 1, assumptions, sha256: canonicalJsonSha256(assumptions), reason, authorId: context.principal.actorId });
    return saved(id, 1);
  },

  async "forecast.scenario.update"(context) {
    const payload = updateForecastScenarioPayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId);
    requireRevision(context, scenario);
    assertActive(scenario);
    const changes: Record<string, unknown> = {};
    if (payload.name !== undefined && payload.name !== scenario.name) {
      if (await forecastStore.activeNameTaken(context.executor, scenario.organizationId, payload.name, scenario.id)) throw new ConflictCommandError("Another active scenario already uses this name", { reason: "forecast_scenario_name_taken" });
      changes.name = payload.name;
    }
    if (payload.kind !== undefined && payload.kind !== scenario.kind) changes.kind = payload.kind;
    if (payload.startDate !== undefined && payload.startDate !== scenario.startDate) {
      const current = await currentAssumptions(context, scenario);
      assertCompatible(current.assumptions, { startDate: payload.startDate, currency: scenario.currency });
      changes.start_date = payload.startDate;
    }
    if (payload.horizonWeeks !== undefined && payload.horizonWeeks !== scenario.horizonWeeks) changes.horizon_weeks = payload.horizonWeeks;
    if (payload.horizonMonths !== undefined && payload.horizonMonths !== scenario.horizonMonths) changes.horizon_months = payload.horizonMonths;
    if (payload.reserveFloorCents !== undefined && payload.reserveFloorCents !== scenario.reserveFloorCents) changes.reserve_floor_cents = payload.reserveFloorCents;
    if (!Object.keys(changes).length) throw new ValidationCommandError("Nothing changed", { reason: "forecast_scenario_unchanged" });
    if (scenario.state === "approved") Object.assign(changes, { state: "draft", approved_snapshot_id: null, approved_by: null, approved_at: null });
    return saved(scenario.id, await forecastStore.updateScenario(context.executor, scenario, changes));
  },

  async "forecast.scenario.archive"(context) {
    const payload = archiveForecastScenarioPayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId);
    requireRevision(context, scenario);
    assertActive(scenario);
    return saved(scenario.id, await forecastStore.updateScenario(context.executor, scenario, { state: "archived", archived_at: new Date().toISOString() }));
  },

  async "forecast.scenario.approve"(context) {
    const payload = approveForecastScenarioPayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId);
    requireRevision(context, scenario);
    assertActive(scenario);
    const snapshot = await forecastStore.getSnapshotMeta(context.executor, scenario.organizationId, payload.snapshotId);
    if (!snapshot || snapshot.scenarioId !== scenario.id) throw new ValidationCommandError("Snapshot does not belong to this scenario", { reason: "forecast_snapshot_not_found" });
    if (snapshot.assumptionVersion !== scenario.currentAssumptionVersion) throw new ConflictCommandError("Run a snapshot of the current assumptions before approving", { reason: "forecast_snapshot_stale" });
    if (snapshot.modelVersion !== FORECAST_MODEL_VERSION) throw new ConflictCommandError("Run a snapshot with the current model before approving", { reason: "forecast_model_stale" });
    if (!snapshot.checksPassed) throw new ValidationCommandError("A snapshot with failed accounting checks cannot be approved", { reason: "forecast_checks_failed" });
    return saved(scenario.id, await forecastStore.updateScenario(context.executor, scenario, {
      state: "approved", approved_snapshot_id: snapshot.id, approved_by: context.principal.actorId, approved_at: new Date().toISOString(),
    }));
  },

  async "forecast.assumptions.save"(context) {
    const payload = saveForecastAssumptionsPayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId);
    requireRevision(context, scenario);
    assertActive(scenario);
    const current = await currentAssumptions(context, scenario);
    let assumptions: ForecastAssumptions;
    let reason = payload.reason;
    if (payload.fromVersion !== undefined) {
      const stored = await forecastStore.getAssumptionVersion(context.executor, scenario.organizationId, scenario.id, payload.fromVersion);
      if (!stored) throw new ValidationCommandError(`Assumption version ${payload.fromVersion} was not found`, { reason: "forecast_version_not_found" });
      assumptions = parseForecastAssumptions(stored.assumptions);
      reason = `Restored version ${payload.fromVersion}: ${payload.reason}`;
    } else {
      assumptions = parseForecastAssumptions(payload.assumptions);
    }
    return appendVersion(context, scenario, assumptions, reason, current.sha256);
  },

  async "forecast.override.set"(context) {
    const payload = setForecastOverridePayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId);
    requireRevision(context, scenario);
    assertActive(scenario);
    const current = await currentAssumptions(context, scenario);
    let overrides: ForecastOverride[];
    let reason: string;
    if (payload.override) {
      const stamped = { ...payload.override, reason: payload.reason, author: context.principal.actorId, setOn: context.envelope.effectiveDate ?? addDays(current.assumptions.actualsCutoff, 1) } as unknown as ForecastOverride;
      overrides = [...current.assumptions.overrides.filter(item => item.id !== stamped.id), stamped];
      reason = `Override ${stamped.id}: ${payload.reason}`;
    } else {
      if (!current.assumptions.overrides.some(item => item.id === payload.removeOverrideId)) throw new ValidationCommandError("Override was not found", { reason: "forecast_override_not_found" });
      overrides = current.assumptions.overrides.filter(item => item.id !== payload.removeOverrideId);
      reason = `Removed override ${payload.removeOverrideId}: ${payload.reason}`;
    }
    const assumptions = parseForecastAssumptions({ ...current.assumptions, overrides });
    return appendVersion(context, scenario, assumptions, reason, current.sha256);
  },

  async "forecast.snapshot.create"(context) {
    const payload = createForecastSnapshotPayloadSchema.parse(context.envelope.payload);
    const scenario = await loadScenario(context, payload.scenarioId, false);
    assertActive(scenario);
    const version = payload.assumptionVersion ?? scenario.currentAssumptionVersion;
    const stored = await forecastStore.getAssumptionVersion(context.executor, scenario.organizationId, scenario.id, version);
    if (!stored) throw new ValidationCommandError(`Assumption version ${version} was not found`, { reason: "forecast_version_not_found" });
    const assumptions = parseForecastAssumptions(stored.assumptions);
    const run = await computeForecast(context.executor, runtime, scenario, assumptions);
    const id = newRecordId();
    await forecastStore.insertSnapshot(context.executor, {
      id, organizationId: scenario.organizationId, scenarioId: scenario.id, assumptionVersion: version, modelVersion: FORECAST_MODEL_VERSION,
      actualsCutoff: assumptions.actualsCutoff, sourceFingerprint: run.sourceFingerprint, resultSha256: run.resultSha256, result: run.result,
      label: payload.label ?? null, createdBy: context.principal.actorId,
    });
    const failed = run.result.checks.filter(check => !check.passed);
    return {
      ...saved(id, null),
      validationOutcomes: [NOT_POSTED,
        ...(run.result.completeness === "partial" ? [{ code: "forecast.opening_incomplete", severity: "warning" as const, message: `Opening position incomplete: ${run.result.opening.unknown.join(", ")}` }] : []),
        ...failed.map(check => ({ code: `forecast.check_failed.${check.code}`, severity: "error" as const, message: check.detail.slice(0, 2_000) }))],
    };
  },
});

/** The one mutation path for web, HTTP and MCP callers. */
export async function executeForecastCommand(executor: RentOpsQueryExecutor, runtime: ForecastRuntime, kind: ForecastCommandKind, input: unknown, access: ForecastCommandExecutionOptions): Promise<OperationReceipt> {
  let envelope: CommandEnvelope<Record<string, unknown>>;
  try {
    envelope = commandEnvelopeSchema(forecastCommandPayloadSchemas[kind]).parse(input) as unknown as CommandEnvelope<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new ValidationCommandError(`Forecast command is invalid. ${issue?.path.join(".") ?? ""}${issue ? `: ${issue.message}` : ""}`, { reason: "forecast_command_invalid" });
    }
    throw error;
  }
  return runCompanyCommand(executor, {
    envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: FORECAST_COMMAND_POLICIES[kind],
    handler: context => handlersFor(runtime)[kind](context),
  });
}
