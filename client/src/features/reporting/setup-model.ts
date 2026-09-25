import { formatLongDate, formatMonthLabel } from "../../lib/rent-ops-formatters";
import type { CompanyContextOrganization } from "@shared/company/context";
import {
  periodFilterNamesFor,
  reportReferenceKindForFilter,
  reportRunRequestSchema,
  type ReportEntry,
  type ReportPeriod,
  type ReportRunRequest,
  type ReportingFilterDefinition,
} from "@shared/reporting";

/** A forecast scenario as offered in setup. Version strings never appear as form fields. */
export interface ForecastScenarioOption {
  readonly scenarioId: string;
  readonly name: string;
  /** The approved snapshot ID: reports read only a scenario's approved snapshot. */
  readonly inputVersion: string | null;
  readonly modelVersion: string | null;
  readonly state: string;
}

/** Forecast input pinned by a saved preset; it applies only while that scenario stays selected. */
export interface ForecastPin { readonly scenarioId: string; readonly inputVersion: string; readonly modelVersion: string }

export interface ReportSetupState {
  readonly entityIds: readonly string[];
  readonly propertyIds: readonly string[];
  readonly from: string;
  readonly through: string;
  readonly asOf: string;
  readonly month: string;
  /** Only for custom-period reports. */
  readonly customMode: "range" | "as_of";
  readonly basis: ReportRunRequest["basis"];
  readonly currency: string;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly scenarioId: string;
  readonly forecastPin?: ForecastPin | null;
  /** "" means no eliminations. */
  readonly eliminationVersion: string;
}

export interface ReportSetupError { readonly field: string; readonly message: string }
export type ReportSetupBuildResult = { readonly ok: true; readonly request: ReportRunRequest } | { readonly ok: false; readonly errors: readonly ReportSetupError[] };

/** Scope choices live in the Scope section; these filter names only mirror it. */
const SCOPE_MIRROR_FILTERS = new Set(["legalEntityIds", "propertyIds", "propertyId"]);

export function isFinancialBasis(entry: Pick<ReportEntry, "basis">): boolean {
  return entry.basis.includes("cash") || entry.basis.includes("accrual");
}

/** Filters shown in the report-specific Filters section. */
export function visibleSetupFilters(entry: Pick<ReportEntry, "filters" | "period">): readonly ReportingFilterDefinition[] {
  const repeated = new Set(periodFilterNamesFor(entry.period));
  return entry.filters.filter(filter => !SCOPE_MIRROR_FILTERS.has(filter.name) && !repeated.has(filter.name));
}

/** Reference filters answered from the company context instead of the server. */
export function isLocalReference(filter: ReportingFilterDefinition): boolean {
  return filter.kind === "reference" && (filter.reference === "unit" || filter.reference === "property" || filter.reference === "legal_entity");
}

export function serverReferenceKind(filter: ReportingFilterDefinition) {
  return filter.kind === "reference" && !isLocalReference(filter) ? reportReferenceKindForFilter(filter) : null;
}

function emptyFilterValue(filter: ReportingFilterDefinition): unknown {
  if (filter.default !== undefined) return Array.isArray(filter.default) ? [...filter.default] : filter.default;
  return filter.multiple || filter.kind === "multi_select" ? [] : "";
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function firstOfYear(today: string): string { return `${today.slice(0, 4)}-01-01`; }

export function initialSetupState(entry: ReportEntry, organization: CompanyContextOrganization, today: string, seeded?: ReportRunRequest): ReportSetupState {
  const seed = seeded?.reportId === entry.id ? seeded : undefined;
  const period = seed?.period;
  const defaultEntities = entry.setup.entityScope === "optional" ? [] : organization.entities.slice(0, 1).map(entity => entity.id);
  const entityIds = seed ? [...seed.scope.legalEntityIds] : defaultEntities;
  const firstEntity = organization.entities.find(entity => entity.id === entityIds[0]) ?? organization.entities[0];
  const financialBases = entry.basis.filter(value => value === "cash" || value === "accrual");
  const filters: Record<string, unknown> = {};
  for (const filter of visibleSetupFilters(entry)) filters[filter.name] = seed && Object.prototype.hasOwnProperty.call(seed.filters, filter.name) ? seed.filters[filter.name] : emptyFilterValue(filter);
  return {
    entityIds,
    propertyIds: seed ? [...seed.scope.propertyIds] : [],
    from: period?.mode === "range" ? period.fromDate : period?.mode === "custom" && period.fromDate ? period.fromDate : firstOfYear(today),
    through: period?.mode === "range" ? period.toDate : period?.mode === "custom" && period.toDate ? period.toDate : today,
    asOf: period?.mode === "as_of" ? period.asOfDate : period?.mode === "custom" && period.asOfDate ? period.asOfDate : today,
    month: period?.mode === "month" ? period.month : today.slice(0, 7),
    customMode: period?.mode === "custom" ? (period.fromDate || period.toDate ? "range" : "as_of") : entry.id === "work-orders" ? "as_of" : "range",
    basis: seed?.basis ?? financialBases[0] ?? entry.basis[0] ?? "operational",
    currency: seed?.currency ?? firstEntity?.currency ?? "USD",
    filters,
    scenarioId: seed?.forecast?.scenarioId ?? "",
    // A saved preset reruns the exact forecast input it pinned.
    forecastPin: seed?.forecast ? { scenarioId: seed.forecast.scenarioId, inputVersion: seed.forecast.inputVersion, modelVersion: seed.forecast.modelVersion } : null,
    eliminationVersion: seed?.consolidation?.eliminationPolicy === "approved_version" ? seed.consolidation.eliminationVersion ?? "" : "",
  };
}

/** Entities changed: drop property and unit choices that no longer apply. */
export function withEntities(state: ReportSetupState, organization: CompanyContextOrganization, entityIds: readonly string[]): ReportSetupState {
  const properties = new Set(organization.entities.filter(entity => !entityIds.length || entityIds.includes(entity.id)).flatMap(entity => entity.properties.map(property => property.id)));
  const propertyIds = state.propertyIds.filter(id => properties.has(id));
  const entity = organization.entities.find(item => item.id === entityIds[0]);
  return withProperties({ ...state, entityIds: [...entityIds], currency: entity?.currency ?? state.currency }, organization, propertyIds);
}

/** Properties changed: clear unit selections outside them. */
export function withProperties(state: ReportSetupState, organization: CompanyContextOrganization, propertyIds: readonly string[]): ReportSetupState {
  const units = new Set(availableUnits(organization, state.entityIds, propertyIds).map(unit => unit.value));
  const filters: Record<string, unknown> = { ...state.filters };
  for (const name of ["unitIds", "unitId"]) {
    const value = filters[name];
    if (Array.isArray(value)) filters[name] = value.filter(item => typeof item === "string" && units.has(item));
    else if (typeof value === "string" && value && !units.has(value)) filters[name] = "";
  }
  return { ...state, propertyIds: [...propertyIds], filters };
}

export function availableProperties(organization: CompanyContextOrganization, entityIds: readonly string[]): { value: string; label: string }[] {
  return organization.entities.filter(entity => !entityIds.length || entityIds.includes(entity.id)).flatMap(entity => entity.properties.map(property => ({ value: property.id, label: organization.entities.length > 1 ? `${property.name} · ${entity.name}` : property.name })));
}

export function availableUnits(organization: CompanyContextOrganization, entityIds: readonly string[], propertyIds: readonly string[]): { value: string; label: string }[] {
  return organization.entities.filter(entity => !entityIds.length || entityIds.includes(entity.id)).flatMap(entity => entity.properties.filter(property => !propertyIds.length || propertyIds.includes(property.id)).flatMap(property => property.units.map(unit => ({ value: unit.id, label: `${property.name} · ${unit.unitNumber}` }))));
}

export function periodForState(entry: Pick<ReportEntry, "period">, state: ReportSetupState): ReportPeriod {
  if (entry.period === "range") return { mode: "range", fromDate: state.from as never, toDate: state.through as never };
  if (entry.period === "month") return { mode: "month", month: state.month as never };
  if (entry.period === "as_of") return { mode: "as_of", asOfDate: state.asOf as never };
  return state.customMode === "as_of" ? { mode: "custom", asOfDate: state.asOf as never } : { mode: "custom", fromDate: state.from as never, toDate: state.through as never };
}

/** Normalize the forecasting service's scenario list; unknown shapes yield nothing. */
export function normalizeForecastScenarios(payload: unknown): ForecastScenarioOption[] {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items) ? (payload as { items: unknown[] }).items : [];
  const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  return list.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const approved = (item.approvedSnapshot && typeof item.approvedSnapshot === "object" ? item.approvedSnapshot : undefined) as Record<string, unknown> | undefined;
    const scenarioId = text(item.scenarioId ?? item.id);
    const name = text(item.name) ?? scenarioId;
    if (!scenarioId || !name) return [];
    const state = text(item.state ?? item.status) ?? "unknown";
    // Reports read only the approved snapshot, never a newer draft or the latest run.
    const inputVersion = text(item.approvedSnapshotId ?? approved?.id);
    const modelVersion = inputVersion ? text(approved?.modelVersion ?? item.modelVersion) : null;
    return [{ scenarioId, name, state, inputVersion, modelVersion }];
  });
}

/** Scenarios a report can run: approved, with a pinned approved snapshot and model version. */
export function runnableScenarios(scenarios: readonly ForecastScenarioOption[]): ForecastScenarioOption[] {
  return scenarios.filter(item => item.state === "approved" && item.inputVersion && item.modelVersion);
}

/**
 * Build the run request exactly as the UI submits it. Hidden setup sections
 * contribute nothing; the chosen period is the only date authority.
 */
export function buildReportRunRequest(entry: ReportEntry, organization: CompanyContextOrganization, state: ReportSetupState, scenarios: readonly ForecastScenarioOption[] = []): ReportSetupBuildResult {
  const errors: ReportSetupError[] = [];
  // Organization-only reports (forecasts) never carry an entity selection.
  const entityIds = entry.scopes.includes("legal_entity") ? state.entityIds.filter(id => organization.entities.some(entity => entity.id === id)) : [];
  if (entry.setup.entityScope === "exactly_one" && entityIds.length !== 1) errors.push({ field: "legalEntityIds", message: "Choose one legal entity." });
  if (entry.setup.entityScope === "one_or_more" && !entityIds.length) errors.push({ field: "legalEntityIds", message: "Choose at least one legal entity." });
  const propertyIds = entry.setup.propertyScope ? state.propertyIds.filter(id => availableProperties(organization, entityIds).some(option => option.value === id)) : [];
  const period = periodForState(entry, state);
  if (period.mode === "range" && (!state.from || !state.through)) errors.push({ field: "period", message: "Choose a start and end date." });
  if (period.mode === "range" && state.from && state.through && state.through < state.from) errors.push({ field: "period", message: "The end date is before the start date." });
  if (period.mode === "custom" && state.customMode === "range" && state.from && state.through && state.through < state.from) errors.push({ field: "period", message: "The end date is before the start date." });
  if ((period.mode === "as_of" || (period.mode === "custom" && state.customMode === "as_of")) && !state.asOf) errors.push({ field: "period", message: "Choose a date." });
  if (period.mode === "month" && !state.month) errors.push({ field: "period", message: "Choose a month." });
  const financial = isFinancialBasis(entry);
  const basis: ReportRunRequest["basis"] = financial ? (entry.basis.includes(state.basis) ? state.basis : entry.basis[0]!) : entry.basis[0]!;
  const currency = financial ? state.currency.trim().toUpperCase() : null;
  if (financial && !/^[A-Z]{3}$/.test(currency ?? "")) errors.push({ field: "currency", message: "Enter a three-letter currency code." });
  const filters: Record<string, unknown> = {};
  const repeated = new Set(periodFilterNamesFor(entry.period));
  for (const filter of entry.filters) {
    if (repeated.has(filter.name)) continue;
    if (filter.name === "propertyIds") { if (propertyIds.length) filters.propertyIds = [...propertyIds]; continue; }
    if (filter.name === "legalEntityIds") { if (entityIds.length) filters.legalEntityIds = [...entityIds]; continue; }
    if (filter.name === "propertyId") continue;
    const value = state.filters[filter.name];
    if (isEmpty(value)) {
      if (filter.required) errors.push({ field: filter.name, message: `Choose ${filter.label.toLowerCase()}.` });
      continue;
    }
    filters[filter.name] = typeof value === "string" ? value.trim() : value;
  }
  let forecast: ReportRunRequest["forecast"] = null;
  if (entry.setup.forecastScenario) {
    const scenario = runnableScenarios(scenarios).find(item => item.scenarioId === state.scenarioId);
    if (!scenario) errors.push({ field: "forecast", message: "Choose an approved forecast scenario." });
    else {
      const pin = state.forecastPin && state.forecastPin.scenarioId === scenario.scenarioId ? state.forecastPin : null;
      forecast = pin ? { scenarioId: pin.scenarioId, inputVersion: pin.inputVersion, modelVersion: pin.modelVersion } : { scenarioId: scenario.scenarioId, inputVersion: scenario.inputVersion!, modelVersion: scenario.modelVersion! };
    }
  }
  let consolidation: ReportRunRequest["consolidation"] = null;
  if (entry.setup.consolidation && currency) {
    consolidation = state.eliminationVersion
      ? { entityIds: entityIds as never, currency: currency as never, ownershipPolicy: "full_control", eliminationPolicy: "approved_version", eliminationVersion: state.eliminationVersion, translationPolicy: "none" }
      : { entityIds: entityIds as never, currency: currency as never, ownershipPolicy: "full_control", eliminationPolicy: "none", translationPolicy: "none" };
  }
  if (errors.length) return { ok: false, errors };
  const candidate = {
    reportId: entry.id, definitionVersion: entry.version,
    scope: { organizationId: organization.id, legalEntityIds: entityIds, propertyIds, unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] },
    filters, period, basis, currency,
    ...(entry.setup.consolidation ? { consolidation } : {}),
    ...(entry.setup.forecastScenario ? { forecast } : {}),
  };
  const parsed = reportRunRequestSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(issue => ({ field: issue.path.join(".") || "request", message: issue.message })) };
  return { ok: true, request: parsed.data };
}

/** Compact "applied filters" labels shown with an executed result. */
export function describeAppliedFilters(entry: ReportEntry, request: ReportRunRequest, organization: CompanyContextOrganization, labels: Readonly<Record<string, string>> = {}): string[] {
  const items: string[] = [];
  const entityNames = request.scope.legalEntityIds.map(id => organization.entities.find(entity => entity.id === id)?.name ?? "Entity");
  if (entityNames.length) items.push(entityNames.join(", "));
  if (request.scope.propertyIds.length) items.push(request.scope.propertyIds.length === 1 ? availableProperties(organization, []).find(option => option.value === request.scope.propertyIds[0])?.label ?? "1 property" : `${request.scope.propertyIds.length} properties`);
  if (request.basis === "cash" || request.basis === "accrual") items.push(`${request.basis === "cash" ? "Cash" : "Accrual"} basis`);
  if (request.consolidation) items.push(request.consolidation.eliminationPolicy === "approved_version" ? "With approved eliminations" : "No eliminations");
  for (const filter of visibleSetupFilters(entry)) {
    const value = request.filters[filter.name];
    if (isEmpty(value) || (filter.default !== undefined && JSON.stringify(value) === JSON.stringify(filter.default))) continue;
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const localOptions = filter.reference === "unit" ? availableUnits(organization, [], []) : filter.reference === "property" ? availableProperties(organization, []) : [];
    const dateLabel = (item: string) => filter.kind === "date" ? formatLongDate(item) : filter.kind === "month" ? formatMonthLabel(item) : undefined;
    const display = values.map(item => labels[`${filter.name}:${item}`] ?? filter.options?.find(option => option.value === item)?.label ?? localOptions.find(option => option.value === item)?.label ?? dateLabel(item) ?? (filter.kind === "reference" ? null : item));
    // Record IDs are never shown; an unnamed reference is summarized by count.
    items.push(`${filter.label}: ${display.length > 2 || display.some(item => item === null) ? `${display.length} selected` : display.join(", ")}`);
  }
  return items;
}
