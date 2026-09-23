import { getReportCatalog, type ReportCatalogEntry } from "../report-catalog";
import { getReportFilterDefinition } from "../report-filter-definitions";
import { WORK_ORDER_CATEGORIES, WORK_ORDER_PRIORITIES } from "../work-orders/contracts";
import { WORK_ORDER_STATUSES } from "../work-orders/transitions";
import {
  parseReportDefinition,
  type ReportColumn,
  type ReportDefinition,
  type ReportSetup,
  type ReportingBasis,
  type ReportingFilterDefinition,
  type ReportingPeriodMode,
  type ReportingScopeKind,
} from "./contracts";

const column = (id: string, label: string, type: ReportColumn["type"], options: Partial<ReportColumn> = {}): ReportColumn => ({ id, label, type, sortable: false, filterable: false, sensitive: false, ...options });
const reference = (name: string, label: string, family: ReportingFilterDefinition["reference"], multiple = true): ReportingFilterDefinition => ({ name, kind: "reference", label, reference: family, multiple, required: false });
const text = (name: string, label: string, options: Partial<ReportingFilterDefinition> = {}): ReportingFilterDefinition => ({ name, kind: "text", label, multiple: false, required: false, ...options });
const optionLabel = (value: string): string => value.replaceAll("_", " ").replace(/^./, character => character.toUpperCase());
const select = (name: string, label: string, values: readonly string[], options: Partial<ReportingFilterDefinition> = {}): ReportingFilterDefinition => ({ name, kind: "select", label, options: values.map(value => ({ value, label: optionLabel(value) })), multiple: false, required: false, ...options });
const multi = (name: string, label: string, values: readonly string[], labels: Readonly<Record<string, string>> = {}): ReportingFilterDefinition => ({ name, kind: "multi_select", label, options: values.map(value => ({ value, label: labels[value] ?? optionLabel(value) })), multiple: true, required: false });

const search = text("search", "Search");
const accounts = reference("accountIds", "Accounts", "account");
const grouping = select("grouping", "Columns", ["none", "month", "quarter", "year"], { default: "none" });
const projects = reference("projectIds", "Projects", "project");
const units = reference("unitIds", "Units", "unit");
const tenants = reference("tenantIds", "Tenants", "tenant");
const investors = reference("investorIds", "Investors", "investor");
const taskStatus = multi("status", "Status", ["open", "in_progress", "complete", "blocked", "cancelled"]);
const projectStatus = multi("status", "Status", ["planned", "in_progress", "complete", "blocked", "cancelled"]);
/** Matches InvestorActivity.status exactly; the engine filters on these values. */
export const INVESTOR_ACTIVITY_STATUS_FILTER_VALUES = ["planned", "due", "manual_recorded", "qbo_posted", "bank_settled", "review_required", "reversed"] as const;
const investorStatus = multi("status", "Status", INVESTOR_ACTIVITY_STATUS_FILTER_VALUES, { qbo_posted: "Posted in QuickBooks", bank_settled: "Bank settled", manual_recorded: "Recorded manually", review_required: "Payment unverified" });

const FINANCIAL_SCOPES: readonly ReportingScopeKind[] = ["organization", "legal_entity", "property"];

interface ReportSpec {
  readonly engineKey: string;
  readonly basis: readonly ReportingBasis[];
  readonly scopes: readonly ReportingScopeKind[];
  readonly filters: readonly ReportingFilterDefinition[];
  readonly setup: ReportSetup;
  readonly requiredSources?: readonly string[];
  readonly drilldownKinds?: readonly string[];
}

const setup = (entityScope: ReportSetup["entityScope"], propertyScope: boolean, extra: Partial<ReportSetup> = {}): ReportSetup => ({ entityScope, propertyScope, forecastScenario: false, consolidation: false, ...extra });

const nativeQbo = (filters: readonly ReportingFilterDefinition[]): ReportSpec => ({
  engineKey: "quickbooks.native-reports", basis: ["cash", "accrual"], scopes: ["organization", "legal_entity"], filters,
  setup: setup("exactly_one", false), requiredSources: ["verified_quickbooks_connection"], drilldownKinds: [],
});
const combinedFinancial = (filters: readonly ReportingFilterDefinition[], requiredSources: readonly string[], options: { propertyScope?: boolean; consolidated?: boolean; scopes?: readonly ReportingScopeKind[] } = {}): ReportSpec => ({
  engineKey: "combined.financial", basis: ["cash", "accrual"], scopes: options.scopes ?? (options.propertyScope === false ? ["organization", "legal_entity"] : FINANCIAL_SCOPES), filters,
  setup: setup("one_or_more", options.propertyScope !== false && !options.consolidated, { consolidation: Boolean(options.consolidated) }), requiredSources, drilldownKinds: ["source"],
});
// Forecasts are company-wide: organization scope only, no entity or property choice.
const forecast = (requiredSources: readonly string[]): ReportSpec => ({
  engineKey: "combined.forecast", basis: ["mixed"], scopes: ["organization"], filters: [],
  setup: setup("optional", false, { forecastScenario: true }), requiredSources, drilldownKinds: [],
});
const rentalExpanded = (filters: readonly ReportingFilterDefinition[] = [units, tenants, search]): ReportSpec => ({
  engineKey: "rental.operational-expanded", basis: ["operational"], scopes: ["organization", "legal_entity", "property", "unit", "tenant", "tenancy"], filters,
  setup: setup("optional", true), requiredSources: ["rental_operational_records"], drilldownKinds: [],
});
const tasks = (filters: readonly ReportingFilterDefinition[]): ReportSpec => ({
  engineKey: "company.tasks", basis: ["operational"], scopes: ["organization", "legal_entity", "property", "project"], filters,
  setup: setup("optional", true), requiredSources: ["company_project_tasks"], drilldownKinds: [],
});
const projectSpec = (requiredSources: readonly string[]): ReportSpec => ({
  engineKey: "combined.projects", basis: ["mixed"], scopes: ["organization", "legal_entity", "property", "project"], filters: [projects, projectStatus, search],
  setup: setup("optional", true), requiredSources, drilldownKinds: [],
});

/**
 * One definition per non-rental-transport report. Filters list only fields
 * the registered engine honors: period, basis and currency travel as request
 * fields (never duplicated as filters), forecast versions travel in
 * `request.forecast`, and consolidation policy in `request.consolidation`.
 */
const REPORT_SPECS: Readonly<Record<string, ReportSpec>> = {
  "balance-sheet": nativeQbo([accounts, grouping]),
  "cash-flow-statement": nativeQbo([grouping]),
  "general-ledger": nativeQbo([accounts]),
  "income-statement": nativeQbo([accounts, grouping]),
  "income-statement-detailed": nativeQbo([accounts, grouping]),
  "trial-balance": nativeQbo([accounts]),
  "balance-sheet-by-fund-type": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_fund_mapping"]),
  "balance-sheet-consolidated": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_account_mapping", "approved_elimination_version"], { consolidated: true }),
  "budget-vs-actual": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_budget_version"]),
  "general-ledger-consolidated": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_account_mapping", "approved_elimination_version"], { consolidated: true }),
  "income-statement-by-unit": combinedFinancial([units, accounts], ["quickbooks_accounting_mirror", "approved_unit_allocation_version"], { scopes: ["organization", "legal_entity", "property", "unit"] }),
  "income-statement-consolidated": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_account_mapping", "approved_elimination_version"], { consolidated: true }),
  "trial-balance-consolidated": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "approved_account_mapping", "approved_elimination_version"], { consolidated: true }),
  "portfolio-financials": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "effective_property_entity_mapping"]),
  "property-t12": combinedFinancial([accounts], ["quickbooks_accounting_mirror", "effective_property_entity_mapping"]),
  "accounts-receivable": { ...combinedFinancial([], ["quickbooks_accounting_mirror", "quickbooks_receivables_source"]), basis: ["accrual"] },
  "accounts-payable": { ...combinedFinancial([], ["quickbooks_accounting_mirror"]), basis: ["accrual"] },
  "cash-position": combinedFinancial([], ["quickbooks_accounting_mirror", "bank_observations"]),
  "property-statement": {
    engineKey: "combined.property-statement", basis: ["cash", "accrual"], scopes: ["organization", "legal_entity", "property"], filters: [],
    setup: setup("one_or_more", true), requiredSources: ["rental_operational_records", "pm_settlements", "quickbooks_accounting_mirror", "effective_property_entity_mapping"], drilldownKinds: ["source"],
  },
  "rental-owner-statement": {
    engineKey: "combined.owner-statements", basis: ["mixed"], scopes: ["organization", "legal_entity", "property"], filters: [search],
    setup: setup("optional", true), requiredSources: ["pm_settlements"], drilldownKinds: ["line"],
  },
  "rental-owner-ending-balances": {
    engineKey: "combined.owner-statements", basis: ["mixed"], scopes: ["organization", "legal_entity", "property"], filters: [search],
    setup: setup("optional", true), requiredSources: ["pm_settlements"], drilldownKinds: [],
  },
  "current-tenants": rentalExpanded(),
  "rent-paid": rentalExpanded(),
  "renters-insurance": rentalExpanded(),
  "tenant-vehicles": rentalExpanded(),
  "unit-listings": rentalExpanded([units, search]),
  "leasing-agent": {
    engineKey: "rental.leasing-agent", basis: ["operational"], scopes: ["organization", "legal_entity", "property"], filters: [search],
    setup: setup("optional", true), requiredSources: ["rental_operational_records", "application_activity_attribution"], drilldownKinds: [],
  },
  "completed-tasks": tasks([projects, taskStatus, search]),
  "open-tasks": tasks([projects, taskStatus, search]),
  "tasks-performance": tasks([projects, taskStatus, search]),
  "vendor-details": tasks([projects, search]),
  "work-orders": {
    engineKey: "company.work-orders", basis: ["operational"], scopes: ["organization", "legal_entity", "property", "unit"],
    filters: [multi("status", "Status", WORK_ORDER_STATUSES), multi("priority", "Priority", WORK_ORDER_PRIORITIES), multi("category", "Type", WORK_ORDER_CATEGORIES, { hvac: "HVAC", turnover: "Turnover / make-ready" }), text("assignedTo", "Assignee"), search],
    setup: setup("optional", true), requiredSources: ["company_work_orders"], drilldownKinds: [],
  },
  "work-sessions": {
    engineKey: "company.time", basis: ["operational"], scopes: ["organization", "legal_entity", "property", "project"], filters: [projects, search],
    setup: setup("one_or_more", true), requiredSources: ["quickbooks_time_entries"], drilldownKinds: [],
  },
  "contractor-exposure": projectSpec(["company_projects", "approved_project_commitments"]),
  "project-performance": projectSpec(["company_projects", "approved_project_budgets", "quickbooks_accounting_mirror"]),
  "rehab-benchmark": projectSpec(["company_projects", "verified_completed_costs", "approved_scope_quantities"]),
  "investor-owner-activity": {
    engineKey: "combined.investors", basis: ["mixed"], scopes: ["organization", "legal_entity", "property", "investor"], filters: [investors, investorStatus],
    setup: setup("optional", true), requiredSources: ["company_investor_obligations_and_payments"], drilldownKinds: [],
  },
  "cash-forecast-13-week": forecast(["verified_actuals", "approved_forecast_scenario"]),
  "operating-growth-plan": forecast(["verified_actuals", "approved_forecast_scenario"]),
  "debt-refinance": forecast(["debt_agreements", "approved_forecast_scenario"]),
  "exit-scenarios": forecast(["verified_actuals", "approved_forecast_scenario"]),
  "lender-management-package": {
    engineKey: "combined.lender-package", basis: ["mixed"], scopes: ["organization", "legal_entity"], filters: [],
    setup: setup("one_or_more", false), requiredSources: ["frozen_report_runs", "lender_package_template"], drilldownKinds: [],
  },
};

function mapExistingFilter(item: ReturnType<typeof getReportFilterDefinition> extends readonly (infer T)[] | undefined ? T : never): ReportingFilterDefinition {
  const kind = item.kind === "multi_select" ? "multi_select" : item.kind === "reference" ? "reference" : item.kind === "date" ? "date" : item.kind === "month" ? "month" : item.kind;
  return {
    name: item.name, kind, label: item.label, ...(item.options ? { options: item.options } : {}), ...(item.reference ? { reference: item.reference } : {}),
    multiple: Boolean(item.multiple || item.kind === "multi_select"), required: false, ...(item.default !== undefined ? { default: item.default } : {}),
    ...(item.dateSemantics ? { dateMode: item.dateSemantics.mode, pairedWith: item.dateSemantics.pairedWith } : {}), ...(item.exclusiveGroup ? { exclusiveGroup: item.exclusiveGroup } : {}),
  } as ReportingFilterDefinition;
}

/**
 * Filter names that would repeat the report period. The period is chosen once
 * in setup and travels as `request.period`, so these are never filter fields.
 * A secondary date that does not repeat the period (for example the
 * tenant-status date of a month report) remains an optional filter.
 */
export function periodFilterNamesFor(period: ReportingPeriodMode): readonly string[] {
  if (period === "as_of") return ["asOfDate"];
  if (period === "month") return ["month"];
  if (period === "range") return ["fromDate", "toDate", "month"];
  return ["asOfDate", "fromDate", "toDate", "month"];
}

function rentalTransportDefinition(entry: ReportCatalogEntry): ReportDefinition {
  const repeated = new Set(periodFilterNamesFor(entry.period));
  const filters = (getReportFilterDefinition(entry.id as never) ?? []).filter(item => !repeated.has(item.name)).map(mapExistingFilter)
    .map(filter => filter.name === "asOfDate" ? { ...filter, label: "Status as of" } : filter);
  return parseReportDefinition({ id: entry.id, version: "1", title: entry.title, category: entry.category, source: "rental", setup: setup("optional", true), period: entry.period, basis: ["operational"], actuality: "actual", scopes: ["organization", "legal_entity", "property", "unit", "tenant", "tenancy"], requiredSources: entry.requiredSources, filters, columns: [column("row", "Report row", "json")], supportedExports: ["csv", "json", "html"], drilldownKinds: [], engineKey: "rental.operational", dependencies: [] });
}

function companyDefinition(entry: ReportCatalogEntry): ReportDefinition {
  const spec = REPORT_SPECS[entry.id];
  if (!spec) throw new Error(`Report ${entry.id} has no reporting definition`);
  const requiredSources = spec.requiredSources ?? entry.requiredSources;
  return parseReportDefinition({ id: entry.id, version: "1", title: entry.title, category: entry.category, source: entry.source, setup: spec.setup, period: entry.period, basis: spec.basis, actuality: entry.category === "forecast" ? "actual_and_forecast" : "actual", scopes: spec.scopes, requiredSources, filters: spec.filters, columns: [column("row", "Report row", "json")], supportedExports: ["csv", "json", "html"], drilldownKinds: spec.drilldownKinds ?? [], engineKey: spec.engineKey, dependencies: requiredSources });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

let cachedDefinitions: readonly ReportDefinition[] | null = null;
export function getReportingDefinitions(): readonly ReportDefinition[] {
  if (!cachedDefinitions) {
    const entries = getReportCatalog().reports;
    cachedDefinitions = Object.freeze(entries.map(entry => deepFreeze(entry.availability === "available" ? rentalTransportDefinition(entry) : companyDefinition(entry))));
  }
  return cachedDefinitions;
}
export function getReportingDefinition(id: string, version = "1"): ReportDefinition | undefined { return getReportingDefinitions().find(definition => definition.id === id && definition.version === version); }
/** Reports served by the legacy rental transport as well as the company service. */
export const REPORTING_RENTAL_TRANSPORT_COUNT = 11;
export const REPORTING_TOTAL_REPORT_COUNT = 53;
