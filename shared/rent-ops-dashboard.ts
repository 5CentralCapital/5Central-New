import { z } from "zod";

const count = z.number().int().nonnegative();
const cents = z.number().int().safe();
export const dashboardPropertyPointSchema = z.object({
  propertyId: z.string(), propertyName: z.string(), unitCount: count,
  occupiedUnits: count, vacantUnits: count, preleasedUnits: count, unknownUnits: count,
  occupancyRate: z.number().min(0).max(100).nullable(),
  vacancyRate: z.number().min(0).max(100).nullable(),
  baseRentCents: cents.nullable(), confirmedBaseRentCents: cents, unconfirmedRentUnits: count,
}).strict();
export const dashboardTrendsSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: z.array(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    properties: z.array(dashboardPropertyPointSchema),
  }).strict()).length(12),
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
