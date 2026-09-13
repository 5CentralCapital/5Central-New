import { z } from "zod";

const count = z.number().int().nonnegative();
const cents = z.number().int().safe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date");

/**
 * A historical leasing point is an append-only observation carried by an
 * activity event.  The source reference and digest stay inside the domain
 * boundary; only the allowlisted source system is copied to the dashboard
 * DTO below.  Counts may be null when the archived source did not establish
 * that bucket.  The domain normalizer turns such gaps into `unknown` units
 * and never treats them as vacancy.
 */
export const HISTORICAL_LEASING_SNAPSHOT_SCHEMA = "historical_leasing_snapshot_v1" as const;
export const HISTORICAL_LEASING_SOURCE_SYSTEMS = ["rent_manager", "appfolio", "evernest"] as const;
export type HistoricalLeasingSourceSystem = (typeof HISTORICAL_LEASING_SOURCE_SYSTEMS)[number];
export const historicalLeasingSnapshotKnowledgeSchema = z.enum(["source", "known", "partial", "unknown", "ambiguous", "manual"]);
export const historicalLeasingSnapshotCompletenessSchema = z.enum([
  "complete",
  "complete_property_snapshot",
  "complete_55_unit_snapshot",
  "complete_charge_snapshot",
  "complete_vacancy_snapshot",
  "partial",
  "lower_bound_only",
  "incomplete",
  "unknown",
]);
const historicalLeasingSnapshotKnowledgeByFieldSchema = z.object({
  occupancy: historicalLeasingSnapshotKnowledgeSchema.optional(),
  vacancy: historicalLeasingSnapshotKnowledgeSchema.optional(),
  rent: historicalLeasingSnapshotKnowledgeSchema.optional(),
}).strict();
const historicalLeasingSnapshotCompletenessByFieldSchema = z.object({
  occupancy: historicalLeasingSnapshotCompletenessSchema.optional(),
  vacancy: historicalLeasingSnapshotCompletenessSchema.optional(),
  rent: historicalLeasingSnapshotCompletenessSchema.optional(),
}).strict();
export const historicalLeasingSnapshotEvidenceSchema = z.object({
  /** Scalar values are retained for compact source records; the object form
   * lets rent and occupancy carry independent evidence strength. */
  knowledge: z.union([historicalLeasingSnapshotKnowledgeSchema, historicalLeasingSnapshotKnowledgeByFieldSchema]),
  completeness: z.union([historicalLeasingSnapshotCompletenessSchema, historicalLeasingSnapshotCompletenessByFieldSchema]),
}).strict();
export const historicalLeasingSnapshotSchema = z.object({
  schema: z.literal(HISTORICAL_LEASING_SNAPSHOT_SCHEMA),
  propertyId: z.string().trim().min(1).max(160),
  asOfDate: isoDate,
  sourceReference: z.string().trim().min(1).max(1000),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceSystem: z.enum(HISTORICAL_LEASING_SOURCE_SYSTEMS),
  unitCount: count.positive().safe(),
  occupied: count.safe().nullable(),
  vacant: count.safe().nullable(),
  preleased: count.safe().nullable(),
  unknown: count.safe().nullable(),
  monthlyBaseRentCents: z.number().int().safe().nonnegative().nullable(),
  evidence: historicalLeasingSnapshotEvidenceSchema,
}).strict();
export type HistoricalLeasingSnapshotObservation = z.infer<typeof historicalLeasingSnapshotSchema>;
/** Descriptive alias for callers that treat the payload as an event body. */
export const historicalLeasingSnapshotObservationSchema = historicalLeasingSnapshotSchema;

export const dashboardPropertyPointSchema = z.object({
  propertyId: z.string(), propertyName: z.string(), unitCount: count,
  occupiedUnits: count, vacantUnits: count, preleasedUnits: count, unknownUnits: count,
  /** Historical points retain explicit count knowledge so an unknown bucket
   * cannot be rendered as a confirmed zero in the units view. */
  occupiedUnitsKnown: z.boolean().optional(), vacantUnitsKnown: z.boolean().optional(), preleasedUnitsKnown: z.boolean().optional(),
  occupancyRate: z.number().min(0).max(100).nullable(),
  vacancyRate: z.number().min(0).max(100).nullable(),
  baseRentCents: cents.nullable(), confirmedBaseRentCents: cents, unconfirmedRentUnits: count,
}).strict();
const historicalSourceSystemSchema = z.enum(HISTORICAL_LEASING_SOURCE_SYSTEMS);
export const dashboardArchivedSnapshotSchema = z.object({
  asOfDate: isoDate,
  sourceSystem: historicalSourceSystemSchema,
  properties: z.array(dashboardPropertyPointSchema),
}).strict();
export type DashboardArchivedSnapshot = z.infer<typeof dashboardArchivedSnapshotSchema>;
export const dashboardTrendsSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: z.array(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    properties: z.array(dashboardPropertyPointSchema),
  }).strict()).length(12),
  /** Present only when validated persisted historical observations exist. */
  archivedSnapshots: z.array(dashboardArchivedSnapshotSchema).optional(),
}).strict();
export type DashboardPropertyPoint = z.infer<typeof dashboardPropertyPointSchema>;
export type DashboardTrends = z.infer<typeof dashboardTrendsSchema>;

export const dashboardCashSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unconfigured") }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
  z.object({ state: z.literal("ready"), name: z.string(), mask: z.string().regex(/^\d{4}$/),
    currentCents: cents.nullable(), availableCents: cents.nullable(), currency: z.literal("USD"), checkedAt: z.string(),
  }).strict(),
]);
export type DashboardCash = z.infer<typeof dashboardCashSchema>;
