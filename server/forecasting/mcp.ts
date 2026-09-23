import { z } from "zod";
import { commandEnvelopeSchema, companyScopeSchema, organizationIdSchema } from "../../shared/company";
import {
  FORECAST_COMMAND_KINDS,
  FORECAST_MCP_TOOL_NAMES,
  forecastCommandPayloadSchemas,
  forecastCompareQuerySchema,
  forecastExplainQuerySchema,
  forecastScenarioIdSchema,
  forecastScenarioListQuerySchema,
  forecastSnapshotIdSchema,
  type ForecastCommandKind,
} from "../../shared/forecasting/contracts";
import type { ForecastResultView } from "../../shared/forecasting/result";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ForecastingPort } from "./port";

export type ForecastToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

const RESULT_SECTIONS = ["summary", "opening", "weeks", "months", "debt", "capital", "checks", "warnings", "owner"] as const;
const sectionsSchema = z.array(z.enum(RESULT_SECTIONS)).min(1).max(RESULT_SECTIONS.length).default(["summary", "opening", "weeks", "checks", "warnings"]);

/** Bounded tool output: only the requested result sections are returned. */
function pick(result: ForecastResultView, sections: readonly (typeof RESULT_SECTIONS)[number][]): Record<string, unknown> {
  const header = { modelVersion: result.modelVersion, currency: result.currency, scenario: result.scenario, actualsCutoff: result.actualsCutoff, calendarEnd: result.calendarEnd, rounding: result.rounding, completeness: result.completeness };
  const picked: Record<string, unknown> = { ...header };
  for (const section of sections) picked[section] = result[section];
  return picked;
}

const COMMAND_DESCRIPTIONS: Readonly<Record<ForecastCommandKind, string>> = {
  "forecast.scenario.create": "Create a forecast scenario (base, downside, upside, hold, sell, refinance or custom) at organization scope. Start date must be a Monday. Pass baseScenarioId to duplicate another scenario's current assumptions, or an assumptions document.",
  "forecast.scenario.update": "Change a scenario's name, kind, start date, horizons or reserve floor. Requires expectedRevision; an approved scenario returns to draft.",
  "forecast.scenario.archive": "Archive a scenario. Its versions and snapshots stay readable. Requires expectedRevision.",
  "forecast.scenario.approve": "Approve a scenario by pinning a snapshot of its current assumptions whose accounting checks all passed. Owners and admins only. Requires expectedRevision.",
  "forecast.assumptions.save": "Save a complete assumption document as a new immutable version with a reason, or restore an earlier version with fromVersion. Requires expectedRevision.",
  "forecast.override.set": "Set or remove one approved override (opening balance, unit rent for a month, or expense amount for a month). The server records the author, date and reason in a new assumption version. Requires expectedRevision.",
  "forecast.snapshot.create": "Run the deterministic model for an assumption version and save an immutable snapshot with its source fingerprint and result hash. Forecasts are never posted to QuickBooks.",
};

/** MCP tools call the same port as the browser; there is no second mutation path. */
export function registerForecastingMcpTools(register: ForecastToolRegistrar, options: { executor: RentOpsQueryExecutor; forecasting: ForecastingPort; actorId: string }): void {
  const { executor, forecasting, actorId } = options;
  const transport = attestTransport("codex_mcp");
  const principalFor = (organizationId: string, connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  register("list_forecast_scenarios", "List forecast scenarios for a company (organization scope) with their latest snapshot. Follow nextCursor to continue.",
    { query: forecastScenarioListQuerySchema }, false,
    async ({ query }) => forecasting.list(await principalFor(query.scope.organizationId), query));
  register("get_forecast_scenario", "Read a scenario with its assumption version history and snapshots. Set includeAssumptions to also return the current assumption document. Read recordRevision before changing it.",
    { scope: companyScopeSchema, scenarioId: forecastScenarioIdSchema, includeAssumptions: z.boolean().default(false) }, false,
    async ({ scope, scenarioId, includeAssumptions }) => {
      const detail = await forecasting.get(await principalFor(scope.organizationId), { scope, scenarioId });
      return includeAssumptions ? detail : { ...detail, assumptions: detail.assumptions ? "(omitted; set includeAssumptions)" : null };
    });
  register("preview_forecast", "Run the deterministic model without saving: a saved assumption version (default current) or a draft assumptions document. Returns the requested result sections; use explain_forecast_line for supporting events.",
    { scope: companyScopeSchema, scenarioId: forecastScenarioIdSchema, assumptionVersion: z.number().int().positive().optional(), assumptions: z.record(z.string(), z.unknown()).optional(), sections: sectionsSchema }, false,
    async ({ scope, scenarioId, assumptionVersion, assumptions, sections }) => {
      const preview = await forecasting.preview(await principalFor(scope.organizationId), { scope, scenarioId, ...(assumptionVersion ? { assumptionVersion } : {}), ...(assumptions ? { assumptions } : {}) });
      return { ...preview, result: pick(preview.result, sections) };
    });
  register("get_forecast_snapshot", "Read an immutable forecast snapshot (model version, assumption version, source fingerprint, result hash) and the requested result sections.",
    { scope: companyScopeSchema, snapshotId: forecastSnapshotIdSchema, sections: sectionsSchema }, false,
    async ({ scope, snapshotId, sections }) => {
      const view = await forecasting.snapshot(await principalFor(scope.organizationId), { scope, snapshotId });
      return { snapshot: view.snapshot, result: pick(view.result, sections) };
    });
  register("compare_forecast_snapshots", "Compare two snapshots: changed assumptions, weekly cash, monthly NOI/net income/cash and the events that contribute most to the difference.",
    { query: forecastCompareQuerySchema }, false,
    async ({ query }) => forecasting.compare(await principalFor(query.scope.organizationId), query));
  register("explain_forecast_line", "Explain one forecast figure: line (e.g. cash.closing, cash.category.debt_service, is.noi, bs.debt, cf.operating, debt.service) for a period (W:<Monday> or M:<YYYY-MM>) of a snapshot or a scenario run. Returns the dated contributing events and assumption inputs. Deterministic; follow nextCursor for more events.",
    { query: forecastExplainQuerySchema }, false,
    async ({ query }) => forecasting.explain(await principalFor(query.scope.organizationId), query));
  for (const kind of FORECAST_COMMAND_KINDS) {
    register(FORECAST_MCP_TOOL_NAMES[kind], `${COMMAND_DESCRIPTIONS[kind]} Supply a stable operationId/idempotencyKey and retry an uncertain response with the identical envelope.`,
      { command: commandEnvelopeSchema(forecastCommandPayloadSchemas[kind]) }, true,
      async ({ command }) => {
        const organizationId = organizationIdSchema.parse(command.scope.organizationId);
        const principal = await principalFor(organizationId);
        return forecasting.execute(kind, command, { principal, transport, resolvePrincipal: transaction => principalFor(organizationId, transaction) });
      });
  }
}
