import { z } from "zod";
import { centsSchema, currencyCodeSchema, isoDateSchema } from "../company";

/**
 * Forecast assumption document, schema version 1.
 *
 * Every amount is exact signed bigint cents encoded as a decimal string.
 * Every percentage is an integer number of basis points (1% = 100 bps).
 * Nothing in this document is probabilistic: renewals, vacancy and timing are
 * explicit deterministic assumptions. A saved document is immutable once it
 * becomes an assumption version (company_forecast_assumption_versions).
 */
export const FORECAST_ASSUMPTIONS_SCHEMA_VERSION = 1 as const;

/** Local identifiers inside one assumption document (units, loans, items). */
export const forecastLocalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/, "Use letters, digits, dot, colon, underscore or hyphen (max 80)");
const labelSchema = z.string().trim().min(1).max(160);
const optionalNote = z.string().trim().max(1000).optional();
export const bpsSchema = z.number().int().min(0).max(100_000);
const nonNegativeCents = centsSchema.refine(value => !value.startsWith("-"), "Amount cannot be negative");
const daysSchema = z.number().int().min(0).max(3_660);
const monthsSchema = z.number().int().min(1).max(1_200);
const isoMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

export const OPENING_ITEM_KEYS = [
  "cash_operating",
  "cash_restricted",
  "rental_receivables",
  "pm_held_funds",
  "accounts_payable",
  "deposits_held",
  "investor_obligations",
  "project_commitments",
] as const;
export type OpeningItemKey = (typeof OPENING_ITEM_KEYS)[number];
export const openingItemKeySchema = z.enum(OPENING_ITEM_KEYS);
export const OPENING_ITEM_LABELS: Readonly<Record<OpeningItemKey, string>> = Object.freeze({
  cash_operating: "Operating cash",
  cash_restricted: "Restricted cash and reserves",
  rental_receivables: "Rental receivables",
  pm_held_funds: "Funds held by property managers",
  accounts_payable: "Accounts payable",
  deposits_held: "Security deposits held",
  investor_obligations: "Investor obligations due",
  project_commitments: "Open project commitments",
});

export const EXPENSE_CATEGORIES = ["utilities", "insurance", "property_tax", "payroll", "repairs", "admin", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = Object.freeze({
  utilities: "Utilities", insurance: "Insurance", property_tax: "Property taxes", payroll: "Payroll",
  repairs: "Repairs and maintenance", admin: "Administrative", other: "Other operating",
});

export const RECURRENCES = ["once", "weekly", "monthly", "quarterly", "annual"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const leasingDefaultsSchema = z.object({
  /** On lease expiry the tenant renews (true) or moves out and the unit turns (false). */
  renewOnExpiry: z.boolean().default(true),
  renewalTermMonths: z.number().int().min(1).max(60).default(12),
  newLeaseTermMonths: z.number().int().min(1).max(60).default(12),
  /** Days between move-out and a unit being rent ready. */
  makeReadyDays: daysSchema.default(14),
  /** Days a ready unit sits vacant before the next lease starts. */
  vacancyDays: daysSchema.default(30),
  /** Rent increase applied at each renewal and to market rent on each scenario anniversary. */
  annualRentGrowthBps: bpsSchema.default(0),
  /** One-time concession credited in the first month of a new (not renewed) lease. */
  newLeaseConcessionCents: nonNegativeCents.default("0"),
  /** Share of each month's tenant portion collected. Collected + bad debt <= 10,000. */
  collectionsBps: bpsSchema.max(10_000).default(10_000),
  /** Share of each month's tenant portion written off as bad debt. */
  badDebtBps: bpsSchema.max(10_000).default(0),
  /** Days after the due date (the 1st) that tenant rent is received. */
  collectionLagDays: daysSchema.default(3),
  /** Days after the due date that housing-assistance (HAP) payments are received. */
  subsidyLagDays: daysSchema.default(5),
  /** Deposit for a new lease, in months of rent when no unit amount is given. */
  depositMonths: z.number().int().min(0).max(3).default(1),
  /** Days after move-out that a deposit is returned. */
  depositReturnDays: daysSchema.default(15),
}).strict();
export type LeasingDefaults = z.infer<typeof leasingDefaultsSchema>;

export const propertyAssumptionSchema = z.object({
  propertyId: forecastLocalIdSchema,
  name: labelSchema,
  legalEntityId: z.string().uuid().optional(),
  /** Book basis at the actuals cutoff. Omit when unknown; it is then listed as incomplete. */
  fixedAsset: z.object({
    costBasisCents: nonNegativeCents,
    accumulatedDepreciationCents: nonNegativeCents,
    /** Depreciable portion (building and improvements, excluding land). */
    depreciableBasisCents: nonNegativeCents,
    usefulLifeMonths: monthsSchema.default(330),
    /** First month of depreciation (placed in service). */
    placedInServiceOn: isoDateSchema,
  }).strict().optional(),
  propertyManager: z.object({
    managed: z.boolean(),
    feeBps: bpsSchema.max(10_000).default(0),
    /** Days after month end that collected funds are remitted. */
    remittanceLagDays: daysSchema.default(10),
  }).strict().default({ managed: false, feeBps: 0, remittanceLagDays: 10 }),
}).strict();
export type PropertyAssumption = z.infer<typeof propertyAssumptionSchema>;

export const UNIT_STATUSES = ["occupied", "vacant", "offline"] as const;
export const unitAssumptionSchema = z.object({
  unitId: forecastLocalIdSchema,
  propertyId: forecastLocalIdSchema,
  label: labelSchema,
  status: z.enum(UNIT_STATUSES),
  /** Current contract rent (occupied units). Includes any subsidy portion. */
  currentRentCents: nonNegativeCents.default("0"),
  /** Housing-assistance portion of current rent; the tenant owes the rest. */
  subsidyCents: nonNegativeCents.default("0"),
  /** Housing-assistance portion expected on future new leases. */
  newLeaseSubsidyCents: nonNegativeCents.default("0"),
  marketRentCents: nonNegativeCents,
  /** Current lease end (occupied). Omit for month-to-month. */
  leaseEndOn: isoDateSchema.optional(),
  /** Vacant units: date the unit is rent ready (defaults to cutoff + make-ready days). */
  availableOn: isoDateSchema.optional(),
  /** Offline units: the project whose completion makes the unit ready. */
  projectId: forecastLocalIdSchema.optional(),
  /** Deposit for new leases; defaults to depositMonths x rent. */
  depositCents: nonNegativeCents.optional(),
  renewOnExpiry: z.boolean().optional(),
}).strict();
export type UnitAssumption = z.infer<typeof unitAssumptionSchema>;

export const expenseAssumptionSchema = z.object({
  id: forecastLocalIdSchema,
  label: labelSchema,
  category: z.enum(EXPENSE_CATEGORIES),
  propertyId: forecastLocalIdSchema.optional(),
  amountCents: nonNegativeCents,
  frequency: z.enum(RECURRENCES),
  firstOn: isoDateSchema,
  endOn: isoDateSchema.optional(),
  /** Days between incurring the cost (payable) and paying it. */
  paymentLagDays: daysSchema.default(0),
  annualGrowthBps: bpsSchema.default(0),
  /** Paid from lender escrow (restricted cash) instead of operating cash, e.g. escrowed taxes and insurance. */
  paidFromEscrow: z.boolean().default(false),
  /** Estimated labor; replaced week by week where approved time actuals exist. */
  laborEstimate: z.boolean().default(false),
  /** Retired items (e.g. the workbook's retired labor section) are never calculated. */
  retired: z.boolean().default(false),
  note: optionalNote,
}).strict();
export type ExpenseAssumption = z.infer<typeof expenseAssumptionSchema>;

export const projectAssumptionSchema = z.object({
  projectId: forecastLocalIdSchema,
  name: labelSchema,
  propertyId: forecastLocalIdSchema,
  /** Construction in progress already spent at the cutoff. */
  openingCipCents: nonNegativeCents.default("0"),
  /** Remaining cost to complete, including estimated labor. */
  remainingCostCents: nonNegativeCents,
  /** Portion of the remaining cost that is estimated labor. */
  laborEstimateCents: nonNegativeCents.default("0"),
  costStartOn: isoDateSchema,
  completionOn: isoDateSchema,
  paymentLagDays: daysSchema.default(30),
  retainageBps: bpsSchema.max(10_000).default(0),
  retainageReleaseDays: daysSchema.default(30),
  usefulLifeMonths: monthsSchema.default(330),
  /** Loan that funds a share of each cost installment as a draw. */
  drawLoanId: forecastLocalIdSchema.optional(),
  drawBps: bpsSchema.max(10_000).default(0),
  drawLagDays: daysSchema.default(14),
  retired: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (BigInt(value.laborEstimateCents) > BigInt(value.remainingCostCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["laborEstimateCents"], message: "Labor estimate cannot exceed the remaining cost" });
  }
  if (value.completionOn < value.costStartOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completionOn"], message: "Completion must follow the cost start" });
  }
});
export type ProjectAssumption = z.infer<typeof projectAssumptionSchema>;

export const DAY_COUNTS = ["30_360", "actual_360", "actual_365"] as const;
export const loanTermsSchema = z.object({
  label: labelSchema,
  lender: z.string().trim().min(1).max(160).optional(),
  /** Principal at the cutoff (existing loans) or gross funded amount (new loans). Null = unknown. */
  principalCents: nonNegativeCents.nullable(),
  /** Annual rate in basis points. */
  annualRateBps: bpsSchema,
  dayCount: z.enum(DAY_COUNTS).default("30_360"),
  paymentDay: z.number().int().min(1).max(31).default(1),
  firstPaymentOn: isoDateSchema,
  /** Interest only through this date (inclusive); amortizing after. */
  interestOnlyUntil: isoDateSchema.optional(),
  /** Amortization term for level payments; omit for interest only to maturity. */
  amortizationMonths: monthsSchema.max(480).optional(),
  maturityOn: isoDateSchema,
  /** Monthly tax/insurance escrow deposited to restricted cash with each payment. */
  escrowMonthlyCents: nonNegativeCents.default("0"),
}).strict();
export type LoanTerms = z.infer<typeof loanTermsSchema>;

export const loanAssumptionSchema = loanTermsSchema.extend({
  id: forecastLocalIdSchema,
  /** Existing company debt record this loan mirrors (company_investor_debt). */
  sourceDebtId: z.string().uuid().optional(),
  propertyId: forecastLocalIdSchema.optional(),
}).strict();
export type LoanAssumption = z.infer<typeof loanAssumptionSchema>;

export const refinanceAssumptionSchema = z.object({
  id: forecastLocalIdSchema,
  label: labelSchema,
  closeOn: isoDateSchema,
  payoffLoanIds: z.array(forecastLocalIdSchema).max(20).default([]),
  newLoan: loanTermsSchema.extend({ id: forecastLocalIdSchema, propertyId: forecastLocalIdSchema.optional() }).strict(),
  closingCostsCents: nonNegativeCents.default("0"),
  prepaymentCostsCents: nonNegativeCents.default("0"),
  /** Lender-required reserves funded from proceeds into restricted cash. */
  reserveCents: nonNegativeCents.default("0"),
}).strict();
export type RefinanceAssumption = z.infer<typeof refinanceAssumptionSchema>;

export const saleAssumptionSchema = z.object({
  id: forecastLocalIdSchema,
  label: labelSchema,
  propertyId: forecastLocalIdSchema,
  closeOn: isoDateSchema,
  priceCents: nonNegativeCents,
  sellingCostsCents: nonNegativeCents.default("0"),
  payoffLoanIds: z.array(forecastLocalIdSchema).max(20).default([]),
  /** Security deposits held for the property's tenants are transferred to the buyer. */
  transferDeposits: z.boolean().default(true),
}).strict();
export type SaleAssumption = z.infer<typeof saleAssumptionSchema>;

export const INVESTOR_FLOW_KINDS = ["distribution", "contribution", "investor_interest", "return_of_capital"] as const;
export const investorFlowSchema = z.object({
  id: forecastLocalIdSchema,
  label: labelSchema,
  kind: z.enum(INVESTOR_FLOW_KINDS),
  amountCents: nonNegativeCents,
  frequency: z.enum(RECURRENCES),
  firstOn: isoDateSchema,
  endOn: isoDateSchema.optional(),
}).strict();
export type InvestorFlow = z.infer<typeof investorFlowSchema>;

/** Owner/personal planning items: shown in a separate owner view, never in company statements. */
export const ownerItemSchema = z.object({
  id: forecastLocalIdSchema,
  label: labelSchema,
  /** Signed: positive is money in to the owner, negative is money out. */
  amountCents: centsSchema,
  frequency: z.enum(RECURRENCES),
  firstOn: isoDateSchema,
  endOn: isoDateSchema.optional(),
}).strict();
export type OwnerItem = z.infer<typeof ownerItemSchema>;

/** Approved time actuals that replace estimated labor in the same week. */
export const timeActualSchema = z.object({
  id: forecastLocalIdSchema,
  workedOn: isoDateSchema,
  projectId: forecastLocalIdSchema.optional(),
  expenseId: forecastLocalIdSchema.optional(),
  amountCents: nonNegativeCents,
  sourceId: z.string().trim().min(1).max(200),
}).strict().refine(value => (value.projectId === undefined) !== (value.expenseId === undefined), "Link a time actual to exactly one project or labor expense");
export type TimeActual = z.infer<typeof timeActualSchema>;

const overrideBase = {
  id: forecastLocalIdSchema,
  reason: z.string().trim().min(1).max(1000),
  /** Authenticated actor that set the override (stamped by the server). */
  author: z.string().trim().min(1).max(160),
  setOn: isoDateSchema,
};
export const forecastOverrideSchema = z.discriminatedUnion("kind", [
  z.object({ ...overrideBase, kind: z.literal("opening_balance"), item: openingItemKeySchema, amountCents: centsSchema, asOf: isoDateSchema }).strict(),
  z.object({ ...overrideBase, kind: z.literal("unit_rent"), unitId: forecastLocalIdSchema, month: isoMonthSchema, amountCents: nonNegativeCents }).strict(),
  z.object({ ...overrideBase, kind: z.literal("expense_amount"), expenseId: forecastLocalIdSchema, month: isoMonthSchema, amountCents: nonNegativeCents }).strict(),
]);
export type ForecastOverride = z.infer<typeof forecastOverrideSchema>;
/** Payload shape for forecast.override.set: the server stamps author and date. */
export const forecastOverrideInputSchema = z.discriminatedUnion("kind", [
  z.object({ id: forecastLocalIdSchema, kind: z.literal("opening_balance"), item: openingItemKeySchema, amountCents: centsSchema, asOf: isoDateSchema }).strict(),
  z.object({ id: forecastLocalIdSchema, kind: z.literal("unit_rent"), unitId: forecastLocalIdSchema, month: isoMonthSchema, amountCents: nonNegativeCents }).strict(),
  z.object({ id: forecastLocalIdSchema, kind: z.literal("expense_amount"), expenseId: forecastLocalIdSchema, month: isoMonthSchema, amountCents: nonNegativeCents }).strict(),
]);
export type ForecastOverrideInput = z.infer<typeof forecastOverrideInputSchema>;

function uniqueBy<T>(key: (item: T) => string, label: string) {
  return (items: readonly T[], context: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const value = key(item);
      if (seen.has(value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `Duplicate ${label} ${value}` });
      seen.add(value);
    });
  };
}

export const forecastAssumptionsSchema = z.object({
  schemaVersion: z.literal(FORECAST_ASSUMPTIONS_SCHEMA_VERSION),
  currency: currencyCodeSchema,
  /** Opening position as-of date (end of day). Forecast events start the next day. */
  actualsCutoff: isoDateSchema,
  leasing: leasingDefaultsSchema,
  properties: z.array(propertyAssumptionSchema).max(500).default([]).superRefine(uniqueBy(item => item.propertyId, "property")),
  units: z.array(unitAssumptionSchema).max(5_000).default([]).superRefine(uniqueBy(item => item.unitId, "unit")),
  expenses: z.array(expenseAssumptionSchema).max(2_000).default([]).superRefine(uniqueBy(item => item.id, "expense")),
  projects: z.array(projectAssumptionSchema).max(500).default([]).superRefine(uniqueBy(item => item.projectId, "project")),
  loans: z.array(loanAssumptionSchema).max(500).default([]).superRefine(uniqueBy(item => item.id, "loan")),
  refinances: z.array(refinanceAssumptionSchema).max(100).default([]).superRefine(uniqueBy(item => item.id, "refinance")),
  sales: z.array(saleAssumptionSchema).max(100).default([]).superRefine(uniqueBy(item => item.id, "sale")),
  investorFlows: z.array(investorFlowSchema).max(1_000).default([]).superRefine(uniqueBy(item => item.id, "investor flow")),
  ownerItems: z.array(ownerItemSchema).max(1_000).default([]).superRefine(uniqueBy(item => item.id, "owner item")),
  timeActuals: z.array(timeActualSchema).max(20_000).default([]).superRefine(uniqueBy(item => item.id, "time actual")),
  overrides: z.array(forecastOverrideSchema).max(2_000).default([]).superRefine(uniqueBy(item => item.id, "override")),
  note: optionalNote,
}).strict().superRefine((value, context) => {
  const properties = new Set(value.properties.map(item => item.propertyId));
  const projects = new Set(value.projects.map(item => item.projectId));
  const loans = new Set([...value.loans.map(item => item.id), ...value.refinances.map(item => item.newLoan.id)]);
  if (loans.size !== value.loans.length + value.refinances.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refinances"], message: "Refinance loan IDs must not repeat existing loan IDs" });
  }
  const expenses = new Set(value.expenses.map(item => item.id));
  const units = new Set(value.units.map(item => item.unitId));
  value.units.forEach((unit, index) => {
    if (!properties.has(unit.propertyId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "propertyId"], message: `Unknown property ${unit.propertyId}` });
    if (unit.status === "offline" && (!unit.projectId || !projects.has(unit.projectId))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "projectId"], message: "Offline units need a project in this scenario" });
    if (BigInt(unit.subsidyCents) > BigInt(unit.currentRentCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "subsidyCents"], message: "Subsidy cannot exceed rent" });
    if (BigInt(unit.newLeaseSubsidyCents) > BigInt(unit.marketRentCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "newLeaseSubsidyCents"], message: "Subsidy cannot exceed market rent" });
  });
  value.expenses.forEach((item, index) => {
    if (item.propertyId && !properties.has(item.propertyId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["expenses", index, "propertyId"], message: `Unknown property ${item.propertyId}` });
    if (item.endOn && item.endOn < item.firstOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["expenses", index, "endOn"], message: "End must follow the first date" });
  });
  value.projects.forEach((item, index) => {
    if (!properties.has(item.propertyId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["projects", index, "propertyId"], message: `Unknown property ${item.propertyId}` });
    if (item.drawLoanId && !loans.has(item.drawLoanId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["projects", index, "drawLoanId"], message: `Unknown loan ${item.drawLoanId}` });
  });
  value.refinances.forEach((refinance, index) => {
    for (const loanId of refinance.payoffLoanIds) if (!loans.has(loanId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["refinances", index, "payoffLoanIds"], message: `Unknown loan ${loanId}` });
  });
  value.sales.forEach((sale, index) => {
    if (!properties.has(sale.propertyId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sales", index, "propertyId"], message: `Unknown property ${sale.propertyId}` });
    for (const loanId of sale.payoffLoanIds) if (!loans.has(loanId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sales", index, "payoffLoanIds"], message: `Unknown loan ${loanId}` });
  });
  const soldProperties = value.sales.map(sale => sale.propertyId);
  if (new Set(soldProperties).size !== soldProperties.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sales"], message: "A property can be sold once per scenario" });
  [...value.loans, ...value.refinances.map(item => item.newLoan)].forEach((loan, index) => {
    if (loan.maturityOn < loan.firstPaymentOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["loans", index, "maturityOn"], message: "Maturity must follow the first payment" });
  });
  value.timeActuals.forEach((item, index) => {
    if (item.projectId && !projects.has(item.projectId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["timeActuals", index, "projectId"], message: `Unknown project ${item.projectId}` });
    if (item.expenseId && !expenses.has(item.expenseId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["timeActuals", index, "expenseId"], message: `Unknown expense ${item.expenseId}` });
  });
  value.overrides.forEach((item, index) => {
    if (item.kind === "unit_rent" && !units.has(item.unitId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["overrides", index, "unitId"], message: `Unknown unit ${item.unitId}` });
    if (item.kind === "expense_amount" && !expenses.has(item.expenseId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["overrides", index, "expenseId"], message: `Unknown expense ${item.expenseId}` });
  });
  const openingOverrides = value.overrides.filter(item => item.kind === "opening_balance").map(item => item.kind === "opening_balance" ? item.item : "");
  if (new Set(openingOverrides).size !== openingOverrides.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["overrides"], message: "One opening balance override per item" });
  if (value.leasing.collectionsBps + value.leasing.badDebtBps > 10_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["leasing", "badDebtBps"], message: "Collections plus bad debt cannot exceed 100%" });
  }
});
export type ForecastAssumptions = z.infer<typeof forecastAssumptionsSchema>;
export type ForecastAssumptionsInput = z.input<typeof forecastAssumptionsSchema>;

/** A minimal valid document for a new scenario. */
export function emptyForecastAssumptions(actualsCutoff: string, currency = "USD"): ForecastAssumptions {
  return forecastAssumptionsSchema.parse({ schemaVersion: 1, currency, actualsCutoff, leasing: {} });
}
