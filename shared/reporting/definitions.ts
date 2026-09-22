import { getReportCatalog, type ReportCatalogEntry } from "../report-catalog";
import { getReportFilterDefinition } from "../report-filter-definitions";
import {
  parseReportDefinition,
  type ReportColumn,
  type ReportDefinition,
  type ReportingBasis,
  type ReportingFilterDefinition,
  type ReportingPeriodMode,
  type ReportingScopeKind,
} from "./contracts";

const column = (id: string, label: string, type: ReportColumn["type"], options: Partial<ReportColumn> = {}): ReportColumn => ({ id, label, type, sortable: false, filterable: false, sensitive: false, ...options });
const reference = (name: string, label: string, family: ReportingFilterDefinition["reference"], multiple = true): ReportingFilterDefinition => ({ name, kind: "reference", label, reference: family, multiple, required: false });
const text = (name: string, label: string, options: Partial<ReportingFilterDefinition> = {}): ReportingFilterDefinition => ({ name, kind: "text", label, multiple: false, required: false, ...options });
const date = (name: string, label: string, dateMode: "as_of" | "report_month" | "activity_range", options: Partial<ReportingFilterDefinition> = {}): ReportingFilterDefinition => ({ name, kind: dateMode === "report_month" ? "month" : "date", label, dateMode, multiple: false, required: true, ...options });
const select = (name: string, label: string, values: readonly string[], options: Partial<ReportingFilterDefinition> = {}): ReportingFilterDefinition => ({ name, kind: "select", label, options: values.map(value => ({ value, label: value.replaceAll("_", " ") })), multiple: false, required: false, ...options });
const multi = (name: string, label: string, values: readonly string[]): ReportingFilterDefinition => ({ name, kind: "multi_select", label, options: values.map(value => ({ value, label: value.replaceAll("_", " ") })), multiple: true, required: false });

const entities = (): ReportingFilterDefinition[] => [reference("legalEntityIds", "Legal entities", "legal_entity"), reference("propertyIds", "Properties", "property")];
const periodFilters = (period: ReportingPeriodMode): ReportingFilterDefinition[] => period === "as_of"
  ? [date("asOfDate", "As of date", "as_of")]
  : period === "range"
    ? [date("fromDate", "Activity from", "activity_range", { exclusiveGroup: "report_period", pairedWith: "toDate" }), date("toDate", "Activity through", "activity_range", { exclusiveGroup: "report_period", pairedWith: "fromDate" })]
    : period === "month" ? [date("month", "Report month", "report_month")] : [date("asOfDate", "As of date", "as_of", { required: false })];

function plannedFilters(entry: ReportCatalogEntry): readonly ReportingFilterDefinition[] {
  const filters = [...entities(), ...periodFilters(entry.period as ReportingPeriodMode)];
  if (entry.category === "financial") return [...filters, select("basis", "Accounting basis", ["cash", "accrual"], { required: true }), text("currency", "Currency", { required: true }), reference("accountIds", "Accounts", "account"), select("grouping", "Grouping", ["none", "month", "quarter", "year"], { default: "none" })];
  if (entry.category === "forecast") return [...filters, text("currency", "Currency", { required: true }), text("scenarioId", "Scenario", { required: true }), text("inputVersion", "Input version", { required: true }), text("modelVersion", "Model version", { required: true })];
  if (entry.category === "investors") return [...filters, reference("investorIds", "Investors", "investor"), text("currency", "Currency", { required: true }), multi("status", "Status", ["expected", "qbo_posted", "bank_settled", "reversed"])];
  if (entry.category === "projects") return [...filters, reference("projectIds", "Projects", "project"), reference("vendorIds", "Vendors", "vendor"), multi("status", "Status", ["planned", "in_progress", "complete", "blocked", "cancelled"]), text("search", "Search")];
  if (entry.category === "tasks") return [...filters, reference("projectIds", "Projects", "project"), reference("staffIds", "Assignees", "staff"), reference("vendorIds", "Vendors", "vendor"), multi("status", "Status", ["open", "in_progress", "complete", "blocked", "cancelled"]), text("search", "Search")];
  return [...filters, reference("unitIds", "Units", "unit"), reference("tenantIds", "Tenants", "tenant"), text("search", "Search")];
}

function plannedScopes(entry: ReportCatalogEntry): readonly ReportingScopeKind[] {
  if (entry.category === "financial") return ["organization", "legal_entity", "property"];
  if (entry.category === "projects") return ["organization", "legal_entity", "property", "project", "vendor"];
  if (entry.category === "investors") return ["organization", "legal_entity", "property", "owner", "investor"];
  if (entry.category === "tasks") return ["organization", "property", "project", "staff", "vendor"];
  if (entry.category === "forecast") return ["organization", "legal_entity", "property", "project", "owner", "investor"];
  return ["organization", "property", "unit", "tenant", "tenancy"];
}

function plannedBasis(entry: ReportCatalogEntry): readonly ReportingBasis[] {
  if (entry.category === "financial") return entry.source === "combined" ? ["cash", "accrual", "mixed"] : ["cash", "accrual"];
  if (entry.category === "forecast") return ["mixed"];
  if (entry.category === "investors" || entry.category === "projects") return ["operational", "mixed"];
  return ["operational"];
}

const dependencyOverrides: Readonly<Record<string, readonly string[]>> = {
  "balance-sheet-by-fund-type": ["verified_quickbooks_books", "approved_fund_mapping"],
  "balance-sheet-consolidated": ["verified_quickbooks_books", "approved_elimination_version"],
  "budget-vs-actual": ["verified_quickbooks_books", "approved_budget_version"],
  "general-ledger-consolidated": ["verified_quickbooks_books", "approved_elimination_version"],
  "income-statement-by-unit": ["verified_quickbooks_books", "approved_allocation_version"],
  "income-statement-consolidated": ["verified_quickbooks_books", "approved_elimination_version"],
  "property-statement": ["verified_quickbooks_books", "effective_property_entity_mapping"],
  "trial-balance-consolidated": ["verified_quickbooks_books", "approved_elimination_version"],
  "leasing-agent": ["rental_operational_records", "agent_attribution"],
  "tenant-vehicles": ["authorized_vehicle_records"],
  "vendor-details": ["vendor_records", "verified_quickbooks_books"],
  "work-sessions": ["time_entries"],
  "portfolio-financials": ["verified_quickbooks_books", "effective_property_entity_mapping"],
  "property-t12": ["verified_quickbooks_books", "effective_property_entity_mapping"],
  "accounts-receivable": ["verified_quickbooks_books", "rental_operational_records"],
  "contractor-exposure": ["verified_quickbooks_books", "approved_commitments"],
  "project-performance": ["verified_quickbooks_books", "approved_project_budgets"],
  "rehab-benchmark": ["verified_completed_costs", "approved_scope_quantities"],
  "cash-position": ["verified_quickbooks_books", "bank_observations", "cash_reconciliation"],
  "cash-forecast-13-week": ["verified_actuals", "versioned_forecast_inputs"],
  "operating-growth-plan": ["verified_actuals", "versioned_forecast_inputs"],
  "debt-refinance": ["verified_quickbooks_books", "debt_agreements", "versioned_forecast_inputs"],
  "exit-scenarios": ["verified_actuals", "versioned_forecast_inputs"],
  "investor-owner-activity": ["verified_quickbooks_books", "effective_owner_agreements"],
  "lender-management-package": ["verified_book_reports", "rental_operational_records", "required_templates"],
};

function mapExistingFilter(item: ReturnType<typeof getReportFilterDefinition> extends readonly (infer T)[] | undefined ? T : never): ReportingFilterDefinition {
  const kind = item.kind === "multi_select" ? "multi_select" : item.kind === "reference" ? "reference" : item.kind === "date" ? "date" : item.kind === "month" ? "month" : item.kind;
  return {
    name: item.name, kind, label: item.label, ...(item.options ? { options: item.options } : {}), ...(item.reference ? { reference: item.reference } : {}),
    multiple: Boolean(item.multiple || item.kind === "multi_select"), required: false, ...(item.default !== undefined ? { default: item.default } : {}),
    ...(item.dateSemantics ? { dateMode: item.dateSemantics.mode, pairedWith: item.dateSemantics.pairedWith } : {}), ...(item.exclusiveGroup ? { exclusiveGroup: item.exclusiveGroup } : {}),
  } as ReportingFilterDefinition;
}

function existingDefinition(entry: ReportCatalogEntry): ReportDefinition {
  const filters = (getReportFilterDefinition(entry.id as never) ?? []).map(mapExistingFilter);
  return parseReportDefinition({ id: entry.id, version: "1", title: entry.title, category: entry.category, availability: "available", source: "rental", period: entry.period, basis: ["operational"], actuality: "actual", scopes: ["organization", "property", "unit", "tenant", "tenancy"], requiredSources: entry.requiredSources, filters, columns: [column("row", "Report row", "json")], supportedExports: ["csv", "json", "html"], drilldownKinds: [], engineKey: "rental.operational", dependencies: [] });
}

function plannedDefinition(entry: ReportCatalogEntry): ReportDefinition {
  const dependency = dependencyOverrides[entry.id] ?? entry.requiredSources;
  const engineKey = `${entry.source}.${entry.id}`;
  return parseReportDefinition({ id: entry.id, version: "1", title: entry.title, category: entry.category, availability: "planned", source: entry.source, period: entry.period, basis: plannedBasis(entry), actuality: entry.category === "forecast" ? "actual_and_forecast" : "actual", scopes: plannedScopes(entry), requiredSources: dependency, filters: plannedFilters(entry), columns: [column("row", "Report row", "json")], supportedExports: ["csv", "json", "html"], drilldownKinds: ["source"], engineKey, dependencies: dependency });
}

export function getReportingDefinitions(): readonly ReportDefinition[] {
  const entries = getReportCatalog().reports;
  return Object.freeze(entries.map(entry => entry.availability === "available" ? existingDefinition(entry) : plannedDefinition(entry)));
}
export function getReportingDefinition(id: string, version = "1"): ReportDefinition | undefined { return getReportingDefinitions().find(definition => definition.id === id && definition.version === version); }
export const REPORTING_PLANNED_REPORT_COUNT = 42;
export const REPORTING_AVAILABLE_RENTAL_COUNT = 11;
