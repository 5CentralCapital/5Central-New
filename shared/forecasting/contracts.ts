import { z } from "zod";
import {
  canonicalUuidSchema,
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  organizationIdSchema,
  revisionSchema,
} from "../company";
import { forecastOverrideInputSchema } from "./assumptions";
import { isMonday } from "./calendar";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type ForecastScenarioId = Brand<string, "ForecastScenarioId">;
export type ForecastSnapshotId = Brand<string, "ForecastSnapshotId">;
export const forecastScenarioIdSchema = canonicalUuidSchema.transform(value => value as ForecastScenarioId);
export const forecastSnapshotIdSchema = canonicalUuidSchema.transform(value => value as ForecastSnapshotId);

export const FORECAST_SCENARIO_KINDS = ["base", "downside", "upside", "hold", "sell", "refinance", "custom"] as const;
export type ForecastScenarioKind = (typeof FORECAST_SCENARIO_KINDS)[number];
export const forecastScenarioKindSchema = z.enum(FORECAST_SCENARIO_KINDS);
export const FORECAST_SCENARIO_KIND_LABELS: Readonly<Record<ForecastScenarioKind, string>> = Object.freeze({
  base: "Base", downside: "Downside", upside: "Upside", hold: "Hold", sell: "Sell", refinance: "Refinance", custom: "Custom",
});
export const FORECAST_SCENARIO_STATES = ["draft", "approved", "archived"] as const;
export type ForecastScenarioState = (typeof FORECAST_SCENARIO_STATES)[number];
export const forecastScenarioStateSchema = z.enum(FORECAST_SCENARIO_STATES);

const nameSchema = z.string().trim().min(1).max(160);
const reasonSchema = z.string().trim().min(1, "Give a reason for this change").max(1000);
const startDateSchema = isoDateSchema.refine(isMonday, "Forecast weeks start on a Monday");
const nonNegativeCents = centsSchema.refine(value => !value.startsWith("-"), "Amount cannot be negative");
/** Assumption documents are validated in full by the service with forecastAssumptionsSchema. */
const assumptionsDocumentSchema = z.record(z.string(), z.unknown());

export const forecastSnapshotMetaSchema = z.object({
  id: forecastSnapshotIdSchema,
  scenarioId: forecastScenarioIdSchema,
  assumptionVersion: z.number().int().positive(),
  modelVersion: z.string(),
  actualsCutoff: isoDateSchema,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().nullable(),
  completeness: z.enum(["complete", "partial"]),
  checksPassed: z.boolean(),
  /** False when opening cash was unknown: its balances are relative movements. */
  openingCashKnown: z.boolean(),
  /**
   * QBO opening evidence is kept separate from the generic completeness flag.
   * These are nullable for snapshots created before the QBO source boundary
   * existed (and for snapshots that did not use QBO).
   */
  qboOpeningCoverage: z.enum(["complete", "partial", "unavailable"]).nullable().optional(),
  qboOpeningMappingCoverage: z.enum(["complete", "partial"]).nullable().optional(),
  qboOpeningReconciliation: z.enum(["reconciled", "unreconciled"]).nullable().optional(),
  qboOpeningFreshness: z.enum(["live_read", "stale", "unknown"]).nullable().optional(),
  /** Hash of the scenario settings (start date, horizons, reserve floor, currency) the snapshot ran with. */
  parametersSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string(),
  createdAt: isoTimestampSchema,
}).strict();
export type ForecastSnapshotMeta = z.infer<typeof forecastSnapshotMetaSchema>;

export const forecastScenarioSummarySchema = z.object({
  id: forecastScenarioIdSchema,
  organizationId: organizationIdSchema,
  name: z.string(),
  kind: forecastScenarioKindSchema,
  state: forecastScenarioStateSchema,
  baseScenarioId: forecastScenarioIdSchema.nullable(),
  startDate: isoDateSchema,
  horizonWeeks: z.number().int(),
  horizonMonths: z.number().int(),
  reserveFloorCents: centsSchema,
  currency: currencyCodeSchema,
  currentAssumptionVersion: z.number().int().nonnegative(),
  recordRevision: revisionSchema,
  createdBy: z.string(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
  /** Hash of the current scenario settings; a snapshot with a different hash is stale. */
  parametersSha256: z.string().regex(/^[a-f0-9]{64}$/),
  latestSnapshot: forecastSnapshotMetaSchema.nullable(),
  /** The snapshot pinned by approval; reports read only this snapshot. */
  approvedSnapshotId: forecastSnapshotIdSchema.nullable(),
  approvedSnapshot: forecastSnapshotMetaSchema.nullable(),
  /** Recorded acknowledgement when approval accepted an incomplete opening position. */
  approvalNote: z.string().nullable(),
}).strict();
export type ForecastScenarioSummary = z.infer<typeof forecastScenarioSummarySchema>;

export const forecastAssumptionVersionMetaSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string(),
  authorId: z.string(),
  assumptionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: isoTimestampSchema,
}).strict();
export type ForecastAssumptionVersionMeta = z.infer<typeof forecastAssumptionVersionMetaSchema>;

export const forecastScenarioDetailSchema = forecastScenarioSummarySchema.extend({
  versions: z.array(forecastAssumptionVersionMetaSchema),
  assumptions: assumptionsDocumentSchema.nullable(),
  snapshots: z.array(forecastSnapshotMetaSchema),
}).strict();
export type ForecastScenarioDetail = z.infer<typeof forecastScenarioDetailSchema>;

export const forecastScenarioListQuerySchema = z.object({
  scope: companyScopeSchema,
  states: z.array(forecastScenarioStateSchema).min(1).max(3).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export type ForecastScenarioListQuery = z.input<typeof forecastScenarioListQuerySchema>;
export const forecastScenarioListResponseSchema = z.object({
  items: z.array(forecastScenarioSummarySchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ForecastScenarioListResponse = z.infer<typeof forecastScenarioListResponseSchema>;

// ---------------------------------------------------------------- commands
export const createForecastScenarioPayloadSchema = z.object({
  name: nameSchema,
  kind: forecastScenarioKindSchema,
  startDate: startDateSchema,
  horizonWeeks: z.number().int().min(1).max(104).default(13),
  horizonMonths: z.number().int().min(1).max(360).default(36),
  reserveFloorCents: nonNegativeCents.default("0"),
  currency: currencyCodeSchema.default("USD"),
  /** Duplicate: copy the base scenario's current assumptions as version 1. */
  baseScenarioId: forecastScenarioIdSchema.optional(),
  assumptions: assumptionsDocumentSchema.optional(),
  reason: reasonSchema.optional(),
}).strict().refine(value => !(value.baseScenarioId && value.assumptions), { message: "Duplicate a scenario or supply assumptions, not both", path: ["assumptions"] });

export const updateForecastScenarioPayloadSchema = z.object({
  scenarioId: forecastScenarioIdSchema,
  name: nameSchema.optional(),
  kind: forecastScenarioKindSchema.optional(),
  startDate: startDateSchema.optional(),
  horizonWeeks: z.number().int().min(1).max(104).optional(),
  horizonMonths: z.number().int().min(1).max(360).optional(),
  reserveFloorCents: nonNegativeCents.optional(),
}).strict();

export const archiveForecastScenarioPayloadSchema = z.object({ scenarioId: forecastScenarioIdSchema, reason: reasonSchema.optional() }).strict();
export const approveForecastScenarioPayloadSchema = z.object({
  scenarioId: forecastScenarioIdSchema,
  snapshotId: forecastSnapshotIdSchema,
  /** Required (with a reason) to approve a snapshot with an incomplete opening position. */
  acknowledgeIncompleteOpening: z.literal(true).optional(),
  reason: reasonSchema.optional(),
}).strict().refine(value => !value.acknowledgeIncompleteOpening || value.reason !== undefined, { message: "Give a reason for approving with an incomplete opening position", path: ["reason"] });

export const saveForecastAssumptionsPayloadSchema = z.object({
  scenarioId: forecastScenarioIdSchema,
  reason: reasonSchema,
  assumptions: assumptionsDocumentSchema.optional(),
  /** Revert: save an earlier version's document as a new version. */
  fromVersion: z.number().int().positive().optional(),
}).strict().refine(value => (value.assumptions === undefined) !== (value.fromVersion === undefined), { message: "Supply assumptions or a version to restore", path: ["assumptions"] });

export const setForecastOverridePayloadSchema = z.object({
  scenarioId: forecastScenarioIdSchema,
  reason: reasonSchema,
  override: forecastOverrideInputSchema.optional(),
  removeOverrideId: z.string().min(1).max(80).optional(),
}).strict().refine(value => (value.override === undefined) !== (value.removeOverrideId === undefined), { message: "Set one override or remove one", path: ["override"] });

export const createForecastSnapshotPayloadSchema = z.object({
  scenarioId: forecastScenarioIdSchema,
  assumptionVersion: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(160).optional(),
}).strict();

export const FORECAST_COMMAND_KINDS = [
  "forecast.scenario.create",
  "forecast.scenario.update",
  "forecast.scenario.archive",
  "forecast.scenario.approve",
  "forecast.assumptions.save",
  "forecast.override.set",
  "forecast.snapshot.create",
] as const;
export type ForecastCommandKind = (typeof FORECAST_COMMAND_KINDS)[number];
export const forecastCommandPayloadSchemas = {
  "forecast.scenario.create": createForecastScenarioPayloadSchema,
  "forecast.scenario.update": updateForecastScenarioPayloadSchema,
  "forecast.scenario.archive": archiveForecastScenarioPayloadSchema,
  "forecast.scenario.approve": approveForecastScenarioPayloadSchema,
  "forecast.assumptions.save": saveForecastAssumptionsPayloadSchema,
  "forecast.override.set": setForecastOverridePayloadSchema,
  "forecast.snapshot.create": createForecastSnapshotPayloadSchema,
} as const satisfies Readonly<Record<ForecastCommandKind, z.ZodTypeAny>>;
/** Commands that edit an existing scenario require the revision that was read. */
export const FORECAST_REVISIONED_COMMANDS: readonly ForecastCommandKind[] = [
  "forecast.scenario.update", "forecast.scenario.archive", "forecast.scenario.approve", "forecast.assumptions.save", "forecast.override.set",
];

export const FORECAST_MCP_TOOL_NAMES: Readonly<Record<ForecastCommandKind, string>> = Object.freeze({
  "forecast.scenario.create": "create_forecast_scenario",
  "forecast.scenario.update": "update_forecast_scenario",
  "forecast.scenario.archive": "archive_forecast_scenario",
  "forecast.scenario.approve": "approve_forecast_scenario",
  "forecast.assumptions.save": "save_forecast_assumptions",
  "forecast.override.set": "set_forecast_override",
  "forecast.snapshot.create": "create_forecast_snapshot",
});
export const FORECAST_MCP_READ_TOOLS = [
  "list_forecast_scenarios", "get_forecast_scenario", "preview_forecast", "get_forecast_snapshot", "compare_forecast_snapshots", "explain_forecast_line",
] as const;

// ---------------------------------------------------------------- reads
/** Explainable lines. Period keys are `W:<Monday>` or `M:<YYYY-MM>`. */
export const FORECAST_LINE_PATTERN = /^(cash\.(opening|closing|inflows|outflows|net|available|restricted|category\.[a-z_]+)|is\.(revenue|operating_expenses|noi|net_income|[a-z_]+)|bs\.[a-z_]+|cf\.(operating|investing|financing|net|direct\.[a-z_]+)|debt\.service|ops\.scheduled_rent)$/;
export const forecastLineSchema = z.string().max(80).regex(FORECAST_LINE_PATTERN, "Unknown forecast line");
export const forecastPeriodSchema = z.string().regex(/^(W:\d{4}-\d{2}-\d{2}|M:\d{4}-(0[1-9]|1[0-2]))$/, "Use W:<date> or M:<YYYY-MM>");

export const forecastRunSourceSchema = z.union([
  z.object({ snapshotId: forecastSnapshotIdSchema }).strict(),
  z.object({ scenarioId: forecastScenarioIdSchema, assumptionVersion: z.number().int().positive().optional() }).strict(),
]);
export type ForecastRunSource = z.infer<typeof forecastRunSourceSchema>;

export const forecastExplainQuerySchema = z.object({
  scope: companyScopeSchema,
  source: forecastRunSourceSchema,
  line: forecastLineSchema,
  period: forecastPeriodSchema,
  limit: z.number().int().min(1).max(500).default(200),
  cursor: z.string().min(1).max(64).optional(),
}).strict();
export type ForecastExplainQuery = z.input<typeof forecastExplainQuerySchema>;

export const forecastContributionSchema = z.object({
  eventId: z.string(),
  date: isoDateSchema,
  label: z.string(),
  kind: z.string(),
  amountCents: centsSchema,
  ref: z.string(),
  modeled: z.boolean(),
  sourceIds: z.array(z.string()),
}).strict();
export type ForecastContribution = z.infer<typeof forecastContributionSchema>;

export const forecastExplainResponseSchema = z.object({
  line: z.string(),
  period: z.string(),
  label: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  totalCents: centsSchema,
  /** Balance lines: the balance at the start of the period that the contributions roll forward. */
  openingCents: centsSchema.nullable(),
  contributions: z.array(forecastContributionSchema),
  contributionCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  components: z.array(z.object({ key: z.string(), label: z.string(), cents: centsSchema }).strict()),
  inputs: z.array(z.object({ ref: z.string(), label: z.string(), value: z.unknown() }).strict()),
}).strict();
export type ForecastExplainResponse = z.infer<typeof forecastExplainResponseSchema>;

export const forecastCompareQuerySchema = z.object({
  scope: companyScopeSchema,
  snapshotA: forecastSnapshotIdSchema,
  snapshotB: forecastSnapshotIdSchema,
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type ForecastCompareQuery = z.input<typeof forecastCompareQuerySchema>;

export const forecastCompareResponseSchema = z.object({
  a: forecastSnapshotMetaSchema.extend({ scenarioName: z.string(), scenarioKind: forecastScenarioKindSchema }).strict(),
  b: forecastSnapshotMetaSchema.extend({ scenarioName: z.string(), scenarioKind: forecastScenarioKindSchema }).strict(),
  assumptionChanges: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() }).strict()),
  assumptionChangesTruncated: z.boolean(),
  summary: z.object({ a: z.record(z.string(), z.unknown()), b: z.record(z.string(), z.unknown()) }).strict(),
  weekly: z.array(z.object({ key: z.string(), aClosingCents: centsSchema.nullable(), bClosingCents: centsSchema.nullable(), aAvailableCents: centsSchema.nullable(), bAvailableCents: centsSchema.nullable() }).strict()),
  monthly: z.array(z.object({ key: z.string(), aNoiCents: centsSchema.nullable(), bNoiCents: centsSchema.nullable(), aNetIncomeCents: centsSchema.nullable(), bNetIncomeCents: centsSchema.nullable(), aClosingCashCents: centsSchema.nullable(), bClosingCashCents: centsSchema.nullable() }).strict()),
  contributingEvents: z.array(z.object({
    eventId: z.string(), label: z.string(), kind: z.string(), date: isoDateSchema, ref: z.string(),
    aCashCents: centsSchema, bCashCents: centsSchema, deltaCashCents: centsSchema, aIncomeCents: centsSchema, bIncomeCents: centsSchema, deltaIncomeCents: centsSchema,
  }).strict()),
  contributingEventCount: z.number().int().nonnegative(),
}).strict();
export type ForecastCompareResponse = z.infer<typeof forecastCompareResponseSchema>;

/** Parameters of the forecast report port: inputVersion is a snapshot ID or an assumption version (`3` or `v3`). */
export const forecastReportInputVersionPattern = /^(v?\d{1,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
