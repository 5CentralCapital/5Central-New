/**
 * Output contract of the deterministic forecast engine (model fcst-1.0.0).
 * All monetary values are canonical signed cents strings.
 */
export const FORECAST_MODEL_VERSION = "fcst-1.0.0" as const;

export const FORECAST_ACCOUNT_TYPES = ["asset", "contra_asset", "liability", "equity", "income", "expense"] as const;
export type ForecastAccountType = (typeof FORECAST_ACCOUNT_TYPES)[number];
export type ForecastCashFlowClass = "cash" | "operating" | "investing" | "financing" | "income_statement";

export interface ForecastAccountDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: ForecastAccountType;
  /** Indirect cash-flow class of balance changes for balance-sheet accounts. */
  readonly cashFlowClass: ForecastCashFlowClass;
  /** Income-statement grouping. */
  readonly group?: "revenue" | "operating_expense" | "below_noi";
}

/** Chart of forecast accounts. Every event is a balanced journal over these. */
export const FORECAST_ACCOUNTS = [
  { key: "cash_operating", label: "Operating cash", type: "asset", cashFlowClass: "cash" },
  { key: "cash_restricted", label: "Restricted cash and reserves", type: "asset", cashFlowClass: "cash" },
  { key: "rent_receivable", label: "Tenant receivables", type: "asset", cashFlowClass: "operating" },
  { key: "subsidy_receivable", label: "Subsidy receivables", type: "asset", cashFlowClass: "operating" },
  { key: "pm_held_funds", label: "Funds held by property managers", type: "asset", cashFlowClass: "operating" },
  { key: "fixed_assets", label: "Property and improvements", type: "asset", cashFlowClass: "investing" },
  { key: "accumulated_depreciation", label: "Accumulated depreciation", type: "contra_asset", cashFlowClass: "operating" },
  { key: "cip", label: "Construction in progress", type: "asset", cashFlowClass: "investing" },
  { key: "accounts_payable", label: "Accounts payable", type: "liability", cashFlowClass: "operating" },
  { key: "project_payables", label: "Project payables", type: "liability", cashFlowClass: "investing" },
  { key: "retainage_payable", label: "Retainage payable", type: "liability", cashFlowClass: "investing" },
  { key: "deposits_held", label: "Security deposits held", type: "liability", cashFlowClass: "operating" },
  { key: "investor_payable", label: "Investor obligations due", type: "liability", cashFlowClass: "financing" },
  { key: "debt", label: "Loans payable", type: "liability", cashFlowClass: "financing" },
  { key: "opening_equity", label: "Opening equity", type: "equity", cashFlowClass: "financing" },
  { key: "contributed_capital", label: "Contributions", type: "equity", cashFlowClass: "financing" },
  { key: "distributions", label: "Distributions", type: "equity", cashFlowClass: "financing" },
  { key: "rental_income_tenant", label: "Rent – tenant portion", type: "income", cashFlowClass: "income_statement", group: "revenue" },
  { key: "rental_income_subsidy", label: "Rent – housing assistance", type: "income", cashFlowClass: "income_statement", group: "revenue" },
  { key: "concessions", label: "Concessions", type: "expense", cashFlowClass: "income_statement", group: "revenue" },
  { key: "bad_debt", label: "Bad debt", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "pm_fees", label: "Property management fees", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_utilities", label: "Utilities", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_insurance", label: "Insurance", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_property_tax", label: "Property taxes", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_payroll", label: "Payroll", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_repairs", label: "Repairs and maintenance", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_admin", label: "Administrative", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "opex_other", label: "Other operating", type: "expense", cashFlowClass: "income_statement", group: "operating_expense" },
  { key: "depreciation", label: "Depreciation", type: "expense", cashFlowClass: "income_statement", group: "below_noi" },
  { key: "interest_expense", label: "Interest", type: "expense", cashFlowClass: "income_statement", group: "below_noi" },
  { key: "financing_costs", label: "Financing and prepayment costs", type: "expense", cashFlowClass: "income_statement", group: "below_noi" },
  { key: "gain_on_sale", label: "Gain (loss) on sale", type: "income", cashFlowClass: "income_statement", group: "below_noi" },
] as const satisfies readonly ForecastAccountDefinition[];

export type ForecastAccountKey = (typeof FORECAST_ACCOUNTS)[number]["key"];
export const FORECAST_ACCOUNT_BY_KEY: Readonly<Record<string, ForecastAccountDefinition>> = Object.freeze(
  Object.fromEntries(FORECAST_ACCOUNTS.map(account => [account.key, account])),
);
export const BALANCE_SHEET_ACCOUNT_KEYS = FORECAST_ACCOUNTS.filter(account => account.cashFlowClass !== "income_statement").map(account => account.key);
export const INCOME_STATEMENT_ACCOUNT_KEYS = FORECAST_ACCOUNTS.filter(account => account.cashFlowClass === "income_statement").map(account => account.key);

export const CASH_CATEGORIES = [
  "tenant_receipts", "subsidy_receipts", "pm_remittances", "deposits", "operating_expenses", "payroll",
  "project_costs", "debt_service", "loan_proceeds", "loan_payoffs", "financing_costs", "sale_proceeds", "investor", "other",
] as const;
export type CashCategory = (typeof CASH_CATEGORIES)[number];
export const CASH_CATEGORY_LABELS: Readonly<Record<CashCategory, string>> = Object.freeze({
  tenant_receipts: "Tenant rent", subsidy_receipts: "Housing assistance", pm_remittances: "Manager remittances",
  deposits: "Security deposits", operating_expenses: "Operating costs", payroll: "Payroll and labor",
  project_costs: "Projects", debt_service: "Debt service", loan_proceeds: "Loan proceeds", loan_payoffs: "Loan payoffs",
  financing_costs: "Financing costs", sale_proceeds: "Sale proceeds", investor: "Investors", other: "Other",
});

export const FORECAST_EVENT_KINDS = [
  "rent_charge", "concession", "tenant_collection", "subsidy_collection", "bad_debt", "pm_remittance",
  "deposit_received", "deposit_returned", "deposit_transfer", "expense_incurred", "expense_paid", "labor_actual",
  "project_cost", "project_payment", "project_labor", "retainage_release", "project_draw", "project_complete",
  "depreciation", "loan_payment", "escrow_deposit", "loan_payoff", "loan_funding", "financing_cost", "reserve_funding",
  "sale", "investor_flow",
] as const;
export type ForecastEventKind = (typeof FORECAST_EVENT_KINDS)[number];

export interface ForecastEntry {
  /** Account key. */
  readonly a: string;
  /** Signed cents, debit positive. Entries of one event sum to zero. */
  readonly c: string;
  /** Sub-ledger (loan, property or project) where relevant. */
  readonly s?: string;
}

export interface ForecastEvent {
  /** Deterministic, stable across runs with the same inputs. */
  readonly id: string;
  readonly date: string;
  readonly kind: ForecastEventKind;
  readonly label: string;
  readonly cashCategory: CashCategory | null;
  readonly cashFlowClass: "operating" | "investing" | "financing";
  /** Modeled capital proceeds (refinance, sale, draws) are never actual cash. */
  readonly modeled: boolean;
  /** Assumption path that produced the event, e.g. `units[1A]`. */
  readonly ref: string;
  readonly propertyId?: string;
  readonly sourceIds?: readonly string[];
  readonly entries: readonly ForecastEntry[];
}

export type OpeningItemState = "sourced" | "manual" | "unknown" | "partial";
export interface ForecastOpeningItem {
  readonly key: string;
  readonly label: string;
  readonly amountCents: string | null;
  readonly asOf: string | null;
  readonly state: OpeningItemState;
  readonly source: string;
  readonly sourceIds: readonly string[];
  readonly note?: string;
  /** Memo items (e.g. commitments) are disclosed but are not balance-sheet balances. */
  readonly memo?: boolean;
}

export interface ForecastOpeningPosition {
  readonly asOf: string;
  readonly items: readonly ForecastOpeningItem[];
  readonly complete: boolean;
  /** Labels of items that could not be established; they are excluded, never zero. */
  readonly unknown: readonly string[];
  /** Opening balances by account (natural sign: debit balances for assets, credit balances for liabilities/equity). */
  readonly balances: Readonly<Record<string, string>>;
}

export interface ForecastWeekRow {
  readonly key: string;
  readonly start: string;
  readonly end: string;
  readonly openingCashCents: string;
  readonly inflowsCents: string;
  readonly outflowsCents: string;
  readonly netCents: string;
  readonly closingCashCents: string;
  readonly restrictedClosingCents: string;
  readonly availableClosingCents: string;
  /** Inflows that come from modeled capital events (refinance/sale proceeds, draws). */
  readonly modeledInflowsCents: string;
  readonly belowReserveFloor: boolean;
  /** Net cash by category (signed). */
  readonly categories: Readonly<Record<string, string>>;
}

export interface ForecastStatementLine { readonly key: string; readonly label: string; readonly cents: string }

export interface ForecastMonthRow {
  readonly key: string;
  readonly month: string;
  readonly start: string;
  readonly end: string;
  /** Natural sign: income positive, expense positive. */
  readonly income: Readonly<Record<string, string>>;
  readonly revenueCents: string;
  readonly operatingExpensesCents: string;
  readonly noiCents: string;
  readonly netIncomeCents: string;
  /** Closing balances, natural sign. retained_earnings is cumulative net income since the cutoff. */
  readonly balance: Readonly<Record<string, string>>;
  readonly totalAssetsCents: string;
  readonly totalLiabilitiesCents: string;
  readonly totalEquityCents: string;
  readonly cashFlow: {
    readonly openingCashCents: string;
    readonly netIncomeCents: string;
    readonly operating: readonly ForecastStatementLine[];
    readonly investing: readonly ForecastStatementLine[];
    readonly financing: readonly ForecastStatementLine[];
    readonly operatingCents: string;
    readonly investingCents: string;
    readonly financingCents: string;
    readonly indirectNetChangeCents: string;
    readonly direct: readonly ForecastStatementLine[];
    readonly directNetChangeCents: string;
    readonly closingCashCents: string;
  };
  readonly operations: {
    readonly unitDays: number;
    readonly occupiedUnitDays: number;
    readonly occupancyBps: number | null;
    readonly scheduledRentCents: string;
    readonly occupiedUnitsAtEnd: number;
    readonly unitsAtEnd: number;
  };
}

export interface ForecastLoanPayment {
  readonly date: string;
  readonly interestCents: string;
  readonly principalCents: string;
  readonly balanceCents: string;
  readonly kind: "scheduled" | "balloon" | "payoff" | "draw";
}

export interface ForecastLoanSchedule {
  readonly loanId: string;
  readonly label: string;
  readonly lender: string | null;
  readonly origin: "existing" | "refinance";
  readonly principalKnown: boolean;
  readonly openingPrincipalCents: string | null;
  readonly annualRateBps: number;
  readonly maturityOn: string;
  /** Balance due at maturity, even when maturity is beyond the view horizon. */
  readonly balloonCents: string | null;
  readonly fundedOn: string | null;
  readonly paidOffOn: string | null;
  readonly payments: readonly ForecastLoanPayment[];
}

export interface ForecastCoverageRow {
  readonly month: string;
  readonly noiCents: string;
  readonly debtServiceCents: string;
  /** NOI / scheduled debt service in basis points; null with no debt service. */
  readonly dscrBps: number | null;
}

export interface ForecastRefinanceResult {
  readonly id: string; readonly label: string; readonly closeOn: string;
  readonly grossProceedsCents: string; readonly payoffCents: string; readonly costsCents: string;
  readonly reservesCents: string; readonly netUsableCents: string; readonly modeled: true;
  readonly excluded: boolean;
}

export interface ForecastSaleResult {
  readonly id: string; readonly label: string; readonly propertyId: string; readonly closeOn: string;
  readonly priceCents: string; readonly sellingCostsCents: string; readonly netBookValueCents: string;
  readonly gainCents: string; readonly payoffCents: string; readonly depositsTransferredCents: string;
  readonly netProceedsCents: string; readonly modeled: true; readonly excluded: boolean;
}

export interface ForecastCheck { readonly code: string; readonly passed: boolean; readonly detail: string }
export interface ForecastWarning { readonly code: string; readonly message: string; readonly ref?: string }

export interface ForecastOwnerView {
  readonly weeks: readonly { readonly key: string; readonly netCents: string; readonly cumulativeCents: string }[];
  readonly months: readonly { readonly key: string; readonly netCents: string; readonly cumulativeCents: string }[];
}

export interface ForecastSummary {
  readonly minAvailableCashCents: string | null;
  readonly minAvailableWeek: string | null;
  readonly endingCashCents: string | null;
  readonly weeksBelowFloor: number;
  readonly totalNoiCents: string;
  readonly totalNetIncomeCents: string;
  readonly eventCount: number;
}

export interface ForecastResult {
  readonly modelVersion: string;
  readonly currency: string;
  readonly scenario: {
    readonly name: string; readonly kind: string; readonly startDate: string;
    readonly horizonWeeks: number; readonly horizonMonths: number; readonly reserveFloorCents: string;
  };
  readonly actualsCutoff: string;
  readonly calendarEnd: string;
  readonly rounding: "half_even";
  readonly completeness: "complete" | "partial";
  readonly opening: ForecastOpeningPosition;
  readonly weeks: readonly ForecastWeekRow[];
  readonly months: readonly ForecastMonthRow[];
  readonly debt: {
    readonly loans: readonly ForecastLoanSchedule[];
    readonly coverage: readonly ForecastCoverageRow[];
    readonly ladder: readonly { readonly year: string; readonly maturingCents: string; readonly scheduledPrincipalCents: string }[];
  };
  readonly capital: { readonly refinances: readonly ForecastRefinanceResult[]; readonly sales: readonly ForecastSaleResult[] };
  readonly owner: ForecastOwnerView | null;
  readonly checks: readonly ForecastCheck[];
  readonly warnings: readonly ForecastWarning[];
  readonly summary: ForecastSummary;
  readonly events: readonly ForecastEvent[];
}

/** API view of a result: the event calendar is served through explain/compare, not in bulk. */
export type ForecastResultView = Omit<ForecastResult, "events">;
