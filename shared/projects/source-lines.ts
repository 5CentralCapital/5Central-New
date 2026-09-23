import { z } from "zod";
import {
  centsSchema,
  currencyCodeSchema,
  isoDateSchema,
  legalEntityIdSchema,
  organizationIdSchema,
} from "../company";
import {
  financialSettlementStateSchema,
  financialSourceReferenceSchema,
} from "../accounting/source";

/**
 * Search of current, posted QBO source lines that can still be allocated to a
 * local consumer (project cost, work order cost or posted payroll). The
 * available amount is the line amount less every existing allocation across
 * projects, work orders and payroll, so one line can never be consumed twice.
 */
export const COST_SOURCE_LINE_PURPOSES = ["cost", "payroll"] as const;
export type CostSourceLinePurpose = (typeof COST_SOURCE_LINE_PURPOSES)[number];
export const costSourceLinePurposeSchema = z.enum(COST_SOURCE_LINE_PURPOSES);

export const costSourceLineQuerySchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  purpose: costSourceLinePurposeSchema.default("cost"),
  search: z.string().trim().max(200).optional(),
  from: isoDateSchema.optional(),
  through: isoDateSchema.optional(),
  /** Hide fully allocated lines by default. */
  availableOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.through && value.through < value.from) context.addIssue({ code: z.ZodIssueCode.custom, path: ["through"], message: "through must be on or after from" });
});
export type CostSourceLineQuery = z.input<typeof costSourceLineQuerySchema>;
export type ParsedCostSourceLineQuery = z.output<typeof costSourceLineQuerySchema>;

export const costSourceLineSchema = z.object({
  source: financialSourceReferenceSchema,
  transactionType: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  postedOn: isoDateSchema,
  currency: currencyCodeSchema,
  lineAmountCents: centsSchema,
  allocatedCents: centsSchema,
  availableCents: centsSchema,
  settlementState: financialSettlementStateSchema,
  counterpartyObjectId: z.string().max(200).nullable(),
}).strict();
export type CostSourceLine = z.infer<typeof costSourceLineSchema>;

export const costSourceLinePageSchema = z.object({
  items: z.array(costSourceLineSchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type CostSourceLinePage = z.infer<typeof costSourceLinePageSchema>;
