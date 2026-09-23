import { z } from "zod";
import {
  allocateCents,
  centsSchema,
  centsToBigInt,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  type MoneyCents,
} from "../company";
import { financialSourceReferenceSchema } from "../accounting/source";

/**
 * Posted payroll and project labor. Approved time is an estimate
 * (hours × mapped rate) until a posted QBO payroll or journal line is linked to
 * the same timesheets; the posted amount then replaces the estimate. A payroll
 * line is reserved in the central QBO allocation ledger, so it cannot be
 * consumed twice across payroll links, project bindings or work orders.
 */

const providerScopeFields = {
  environment: z.enum(["sandbox", "production"]),
  providerCompanyId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
} as const;
const positiveCents = centsSchema.refine((value) => centsToBigInt(value) > BigInt(0), "Expected positive cents");

export const TIME_PAYROLL_SOURCE_KIND = "qbo_payroll_line" as const;

export const timePayrollLinkPayloadSchema = z.object({
  ...providerScopeFields,
  source: financialSourceReferenceSchema,
  amountCents: positiveCents,
  periodFrom: isoDateSchema,
  periodThrough: isoDateSchema,
  /** Limit the link to these provider employees. */
  providerUserIds: z.array(z.string().trim().min(1).max(160)).min(1).max(500).optional(),
  /** Or name the exact timesheets. */
  timesheetIds: z.array(z.string().uuid()).min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.periodThrough < value.periodFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodThrough"], message: "periodThrough must be on or after periodFrom" });
  if (value.source.lineId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "lineId"], message: "A payroll link needs an exact QBO line" });
});
export type TimePayrollLinkPayload = z.infer<typeof timePayrollLinkPayloadSchema>;

export const timePayrollUnlinkPayloadSchema = z.object({
  ...providerScopeFields,
  batchId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();
export type TimePayrollUnlinkPayload = z.infer<typeof timePayrollUnlinkPayloadSchema>;

export const timePayrollLinkSchema = z.object({
  batchId: z.string().uuid(),
  source: financialSourceReferenceSchema,
  currency: currencyCodeSchema,
  amountCents: centsSchema,
  periodFrom: isoDateSchema,
  periodThrough: isoDateSchema,
  postedOn: isoDateSchema,
  timesheetCount: z.number().int().nonnegative(),
  status: z.enum(["active", "released"]),
  linkedAt: isoTimestampSchema,
}).strict();
export type TimePayrollLink = z.infer<typeof timePayrollLinkSchema>;

export const timePayrollLinkListSchema = z.object({ items: z.array(timePayrollLinkSchema).max(500) }).strict();

export const projectLaborRowSchema = z.object({
  timesheetId: z.string().uuid(),
  entryDate: isoDateSchema,
  providerUserId: z.string().min(1).max(160),
  providerJobcodeId: z.string().min(1).max(160),
  durationSeconds: z.number().int().nonnegative(),
  costCode: z.string().max(160).nullable(),
  scopeItemId: z.string().uuid().nullable(),
  currency: currencyCodeSchema.nullable(),
  estimatedCents: centsSchema.nullable(),
  postedCents: centsSchema.nullable(),
  basis: z.enum(["posted_payroll", "estimated", "unpriced"]),
}).strict();
export type ProjectLaborRow = z.infer<typeof projectLaborRowSchema>;

export const projectLaborResponseSchema = z.object({
  projectId: z.string().uuid(),
  rows: z.array(projectLaborRowSchema).max(5_000),
  truncated: z.boolean(),
  approvedSeconds: z.number().int().nonnegative(),
  estimatedCents: centsSchema,
  postedCents: centsSchema,
  unpricedEntries: z.number().int().nonnegative(),
}).strict();
export type ProjectLaborResponse = z.infer<typeof projectLaborResponseSchema>;

/** Elapsed seconds between two offset-bearing timestamps (DST and overnight safe). */
export function timeEntryDurationSeconds(start: string, end: string): number {
  const offset = /(?:Z|[+-]\d{2}:?\d{2})$/;
  if (!offset.test(start) || !offset.test(end)) throw new RangeError("Timestamps need an explicit offset");
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1_000);
  if (!Number.isFinite(seconds)) throw new RangeError("Timestamps are invalid");
  return seconds;
}

/**
 * Split one posted payroll amount across timesheets. Estimates are the weight
 * when every timesheet has one; otherwise hours are. The largest-remainder
 * allocation always sums exactly to the posted amount.
 */
export function allocatePayrollToTimesheets(
  totalCents: MoneyCents | string,
  timesheets: readonly { readonly id: string; readonly estimatedCents: MoneyCents | string | null; readonly durationSeconds: number }[],
): { readonly id: string; readonly amountCents: MoneyCents }[] {
  if (!timesheets.length) throw new RangeError("At least one timesheet is required");
  const useEstimates = timesheets.every((entry) => entry.estimatedCents !== null && centsToBigInt(entry.estimatedCents) > BigInt(0));
  const weights = timesheets.map((entry) => useEstimates ? centsToBigInt(entry.estimatedCents!).toString() : String(Math.max(0, entry.durationSeconds)));
  if (weights.every((weight) => weight === "0")) throw new RangeError("Timesheets have no hours to allocate payroll against");
  const amounts = allocateCents(totalCents, weights);
  return timesheets.map((entry, index) => ({ id: entry.id, amountCents: amounts[index]! }));
}
