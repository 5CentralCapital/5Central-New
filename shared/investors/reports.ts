import { z } from "zod";
import {
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
} from "../company";
import {
  investorAccountIdSchema,
  investorDebtSchema,
  investorInstrumentIdSchema,
  investorInstrumentKindSchema,
  investorObligationIdSchema,
  investorObligationStatusSchema,
} from "./contracts";
import {
  amortizationScheduleSchema,
  instrumentRollforwardSchema,
  investorCalendarStateSchema,
  OUTSTANDING_RECONCILIATION_STATES,
} from "./rollforward";

const monthSchema = isoDateSchema.refine((value) => value.endsWith("-01"), "Expected the first day of a calendar month");

export const investorInstrumentFinancialsQuerySchema = z.object({
  scope: companyScopeSchema,
  instrumentId: investorInstrumentIdSchema,
  fromMonth: monthSchema.optional(),
  throughMonth: monthSchema.optional(),
  asOf: isoDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.fromMonth && value.throughMonth && value.throughMonth < value.fromMonth) context.addIssue({ code: z.ZodIssueCode.custom, path: ["throughMonth"], message: "throughMonth must be on or after fromMonth" });
});
export type InvestorInstrumentFinancialsQuery = z.input<typeof investorInstrumentFinancialsQuerySchema>;

export const investorInstrumentFinancialsSchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  accountId: investorAccountIdSchema,
  name: z.string().min(1).max(240),
  kind: investorInstrumentKindSchema,
  currency: currencyCodeSchema,
  effectiveFrom: isoDateSchema,
  maturityOn: isoDateSchema.nullable(),
  fromMonth: monthSchema,
  throughMonth: monthSchema,
  debt: investorDebtSchema.nullable(),
  amortization: amortizationScheduleSchema.nullable(),
  rollforward: instrumentRollforwardSchema,
}).strict();
export type InvestorInstrumentFinancials = z.infer<typeof investorInstrumentFinancialsSchema>;

export const investorPaymentCalendarQuerySchema = z.object({
  scope: companyScopeSchema,
  fromMonth: monthSchema,
  throughMonth: monthSchema,
  accountId: investorAccountIdSchema.optional(),
  state: investorCalendarStateSchema.optional(),
  asOf: isoDateSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (value.throughMonth < value.fromMonth) context.addIssue({ code: z.ZodIssueCode.custom, path: ["throughMonth"], message: "throughMonth must be on or after fromMonth" });
  if (!value.scope.legalEntityId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "legalEntityId"], message: "The payment calendar needs a legal entity" });
});
export type InvestorPaymentCalendarQuery = z.input<typeof investorPaymentCalendarQuerySchema>;

export const investorPaymentCalendarItemSchema = z.object({
  obligationId: investorObligationIdSchema,
  accountId: investorAccountIdSchema,
  accountName: z.string().min(1).max(240),
  instrumentId: investorInstrumentIdSchema,
  instrumentName: z.string().min(1).max(240),
  periodMonth: monthSchema,
  dueOn: isoDateSchema,
  currency: currencyCodeSchema,
  expectedCents: centsSchema.nullable(),
  knownMinimumCents: centsSchema,
  recordedCents: centsSchema,
  postedCents: centsSchema,
  settledCents: centsSchema,
  remainingCents: centsSchema.nullable(),
  status: investorObligationStatusSchema,
  state: investorCalendarStateSchema,
}).strict();
export type InvestorPaymentCalendarItem = z.infer<typeof investorPaymentCalendarItemSchema>;

export const investorPaymentCalendarResponseSchema = z.object({
  asOf: isoDateSchema,
  items: z.array(investorPaymentCalendarItemSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type InvestorPaymentCalendarResponse = z.infer<typeof investorPaymentCalendarResponseSchema>;

export const investorDebtMaturityQuerySchema = z.object({
  scope: companyScopeSchema,
  asOf: isoDateSchema.optional(),
}).strict();
export type InvestorDebtMaturityQuery = z.input<typeof investorDebtMaturityQuerySchema>;

export const investorDebtMaturitySchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  accountId: investorAccountIdSchema,
  accountName: z.string().min(1).max(240),
  instrumentName: z.string().min(1).max(240),
  kind: investorInstrumentKindSchema,
  legalEntityId: z.string().uuid(),
  currency: currencyCodeSchema,
  maturityOn: isoDateSchema.nullable(),
  monthsToMaturity: z.number().int().nullable(),
  annualRate: z.string().nullable(),
  balloonCents: centsSchema.nullable(),
  balloonSource: z.enum(["documented", "computed", "none"]),
  derivedOutstandingCents: centsSchema.nullable(),
  manualOutstandingCents: centsSchema.nullable(),
  reconciliation: z.enum(OUTSTANDING_RECONCILIATION_STATES),
}).strict();
export type InvestorDebtMaturity = z.infer<typeof investorDebtMaturitySchema>;

export const investorDebtMaturityResponseSchema = z.object({
  asOf: isoDateSchema,
  items: z.array(investorDebtMaturitySchema).max(1_000),
}).strict();
export type InvestorDebtMaturityResponse = z.infer<typeof investorDebtMaturityResponseSchema>;
