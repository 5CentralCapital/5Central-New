import type {
  AdminPersonView,
  AdminPropertyView,
  AdminTenancyView,
  AdminUnitView,
  ApiFilters,
  ReportKey,
  ViewFilters,
} from "../types";
import { getReportFilterDefinition, type ReportFilterDefinition } from "@shared/report-filter-definitions";
import {
  defaultReportOccupancy,
  defaultReportTenantStatus,
  filterReportLocalRows,
  isOccupancyReport,
  isTenantStatusReport,
  reportQueryFilters,
  validateReportPeriod,
  type ReportBalanceFilter,
  type ReportLocalFilters,
} from "./report-model";

export interface ReportSetupDirectory {
  properties: readonly AdminPropertyView[];
  units: readonly AdminUnitView[];
  people: readonly AdminPersonView[];
  tenancies: readonly AdminTenancyView[];
}

export type ReportSetupValue = string | string[];

/** The editable report form. Applied values are kept separately by the view. */
export interface ReportSetupState {
  propertyScope: "active" | "all";
  propertyIds: string[];
  asOfDate: string;
  month: string;
  fromDate: string;
  toDate: string;
  values: Record<string, ReportSetupValue>;
}

export type ReportSetupField = ReportFilterDefinition;

const PROPERTY_NAMES = new Set(["property", "propertyId", "propertyIds", "propertyScope"]);
const DATE_NAMES = new Set(["asOfDate", "asOf", "reportDate", "month", "reportMonth", "fromDate", "toDate"]);

function cloneValue(value: ReportSetupValue): ReportSetupValue {
  return Array.isArray(value) ? [...value] : value;
}

function cloneValues(values: Record<string, ReportSetupValue>): Record<string, ReportSetupValue> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cloneValue(value)]));
}

function selectedProperties(filters: Pick<ViewFilters, "propertyId" | "propertyIds">): string[] {
  return filters.propertyIds?.length
    ? Array.from(new Set(filters.propertyIds)).sort()
    : filters.propertyId && filters.propertyId !== "all" ? [filters.propertyId] : [];
}

function stringValue(values: Record<string, ReportSetupValue>, names: readonly string[], fallback = ""): string {
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string") return value;
  }
  return fallback;
}

function arrayValue(values: Record<string, ReportSetupValue>, names: readonly string[]): string[] {
  for (const name of names) {
    const value = values[name];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value === "string" && value && value !== "all") return [value];
  }
  return [];
}

function optionDefault(field: ReportSetupField): ReportSetupValue {
  if (field.default !== undefined) return cloneValue(field.default as ReportSetupValue);
  if (field.kind === "multi_select") return [];
  return field.kind === "text" || field.kind === "reference" ? "" : "all";
}

function inheritedDefault(field: ReportSetupField, filters: ViewFilters, key: ReportKey): ReportSetupValue | undefined {
  const name = field.name;
  if (name === "status") return filters.status && filters.status !== "all" ? filters.status : undefined;
  if (["balance", "balanceStatus"].includes(name)) return filters.balanceStatus;
  if (["tenantStatus", "tenancyStatus"].includes(name)) return filters.tenantStatus ?? defaultReportTenantStatus(key);
  if (name === "occupancy") return defaultReportOccupancy(key, filters.status);
  if (name === "readiness") return filters.readiness?.[0];
  if (name === "search") return filters.search || undefined;
  return undefined;
}

function validInheritedDefault(field: ReportSetupField, value: ReportSetupValue | undefined): ReportSetupValue | undefined {
  if (value === undefined || !field.options?.length) return value;
  const allowed = new Set(field.options.map(option => option.value));
  if (Array.isArray(value)) return value.filter(item => allowed.has(item));
  return allowed.has(value) ? value : undefined;
}

function usesPropertyField(field: ReportSetupField): boolean {
  return field.reference === "property" || PROPERTY_NAMES.has(field.name);
}

function usesDateField(field: ReportSetupField): boolean {
  return Boolean(field.dateSemantics) || field.kind === "date" && DATE_NAMES.has(field.name);
}

function dateMode(field: ReportSetupField): "as_of" | "report_month" | "activity_range" | undefined {
  const mode = field.dateSemantics && typeof field.dateSemantics === "object" ? field.dateSemantics.mode : undefined;
  if (mode) return mode;
  if (field.name === "month") return "report_month";
  if (field.name === "fromDate" || field.name === "toDate") return "activity_range";
  if (field.kind === "date" && DATE_NAMES.has(field.name)) return "as_of";
  return undefined;
}

export function reportFilterDefinitions(key: ReportKey): readonly ReportSetupField[] {
  return getReportFilterDefinition(key) ?? [];
}

export function createInitialReportSetup(key: ReportKey, filters: ViewFilters, directory?: ReportSetupDirectory): ReportSetupState {
  const asOfDate = filters.asOfDate;
  const definitions = reportFilterDefinitions(key);
  const values: Record<string, ReportSetupValue> = {};
  for (const field of definitions) {
    if (usesPropertyField(field) || usesDateField(field)) continue;
    // Metadata presets are the portable report contract. Workspace status is
    // only a fallback when a report has no explicit preset for that field.
    const metadataDefault = field.default !== undefined ? optionDefault(field) : undefined;
    const inherited = validInheritedDefault(field, inheritedDefault(field, filters, key));
    values[field.name] = cloneValue(metadataDefault ?? inherited ?? optionDefault(field));
  }
  const propertyIds = selectedProperties(filters).filter(id => {
    if (!directory) return true;
    const property = directory.properties.find(candidate => candidate.id === id);
    return !!property && (filters.propertyScope === "all" || property.state === "active");
  });
  const state: ReportSetupState = {
    propertyScope: filters.propertyScope,
    propertyIds,
    asOfDate,
    month: asOfDate.slice(0, 7),
    fromDate: `${asOfDate.slice(0, 7)}-01`,
    toDate: asOfDate,
    values,
  };
  return normalizeReportSetup(key, state, directory);
}

/** Remove references that are outside the selected portfolio or known directory. */
export function normalizeReportSetup(key: ReportKey, state: ReportSetupState, directory?: ReportSetupDirectory): ReportSetupState {
  const properties = directory?.properties ?? [];
  const allowedProperties = new Set(properties
    .filter(property => property.id && (state.propertyScope === "all" || property.state === "active"))
    .map(property => property.id!));
  const propertyIds = Array.from(new Set(state.propertyIds)).filter(id => !properties.length || allowedProperties.has(id)).sort();
  const values = cloneValues(state.values);
  const selectedPropertyIds = new Set(propertyIds);
  const referenceValues = (reference: ReportSetupField["reference"]): string[] => reportFilterDefinitions(key)
    .filter(field => field.reference === reference)
    .flatMap(field => {
      const value = values[field.name];
      return Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
    });
  const selectedUnitIds = new Set(referenceValues("unit"));
  const units = directory?.units.filter(unit => unit.id && unit.propertyId && allowedProperties.has(unit.propertyId) && (!selectedPropertyIds.size || selectedPropertyIds.has(unit.propertyId))) ?? [];
  const unitIds = new Set(units.map(unit => unit.id!));
  const scopedTenancies = directory?.tenancies.filter(tenancy => tenancy.id && (!tenancy.propertyId || allowedProperties.has(tenancy.propertyId)) && (!selectedPropertyIds.size || !!tenancy.propertyId && selectedPropertyIds.has(tenancy.propertyId)) && (!selectedUnitIds.size || !!tenancy.unitId && selectedUnitIds.has(tenancy.unitId))) ?? [];
  const tenancyIds = new Set(scopedTenancies.map(tenancy => tenancy.id!).filter(Boolean));
  const tenancyPersonIds = new Set(scopedTenancies.map(tenancy => tenancy.primaryPersonId).filter((id): id is string => !!id));
  const hasPropertyOrUnitRestriction = state.propertyScope === "active" || selectedPropertyIds.size > 0 || selectedUnitIds.size > 0;
  const people = hasPropertyOrUnitRestriction ? tenancyPersonIds : new Set(directory?.people.map(person => person.id).filter((id): id is string => !!id));
  for (const field of reportFilterDefinitions(key)) {
    if (field.reference === "unit" && directory) {
      const value = values[field.name];
      if (Array.isArray(value)) values[field.name] = value.filter(id => unitIds.has(id));
      else if (typeof value === "string" && value && !unitIds.has(value)) values[field.name] = "";
    }
    if (field.reference === "person" && directory) {
      const value = values[field.name];
      if (Array.isArray(value)) values[field.name] = value.filter(id => people.has(id));
      else if (typeof value === "string" && value && !people.has(value)) values[field.name] = "";
    }
    if (field.reference === "tenancy" && directory) {
      const value = values[field.name];
      if (Array.isArray(value)) values[field.name] = value.filter(id => tenancyIds.has(id));
      else if (typeof value === "string" && value && !tenancyIds.has(value)) values[field.name] = "";
    }
  }
  return { ...state, propertyIds, values };
}

export function updateReportSetup(
  key: ReportKey,
  state: ReportSetupState,
  changes: Partial<ReportSetupState>,
  directory?: ReportSetupDirectory,
): ReportSetupState {
  return normalizeReportSetup(key, { ...state, ...changes, values: changes.values ? cloneValues(changes.values) : cloneValues(state.values) }, directory);
}

function fieldValue(state: ReportSetupState, field: ReportSetupField): ReportSetupValue {
  if (dateMode(field) === "as_of") return state.asOfDate;
  if (dateMode(field) === "report_month") return state.month;
  if (field.name === "fromDate") return state.fromDate;
  if (field.name === "toDate") return state.toDate;
  if (field.name === "propertyScope") return state.propertyScope;
  if (usesPropertyField(field)) return state.propertyIds;
  return state.values[field.name] ?? optionDefault(field);
}

export function reportSetupFieldValue(state: ReportSetupState, field: ReportSetupField): ReportSetupValue {
  return cloneValue(fieldValue(state, field));
}

function firstReferenceValue(state: ReportSetupState, fields: readonly ReportSetupField[], reference: ReportSetupField["reference"]): string | undefined {
  const field = fields.find(candidate => candidate.reference === reference);
  if (!field) return undefined;
  const value = fieldValue(state, field);
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

function stringField(state: ReportSetupState, definitions: readonly ReportSetupField[], names: readonly string[], fallback = ""): string {
  for (const field of definitions) {
    if (!names.includes(field.name)) continue;
    const value = fieldValue(state, field);
    if (typeof value === "string") return value;
  }
  return fallback;
}

function arrayField(state: ReportSetupState, definitions: readonly ReportSetupField[], names: readonly string[]): string[] {
  for (const field of definitions) {
    if (!names.includes(field.name)) continue;
    const value = fieldValue(state, field);
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value && value !== "all") return [value];
  }
  return [];
}

/** Build exactly the ApiFilters used for the applied report request. */
export function reportSetupQueryFilters(key: ReportKey, state: ReportSetupState): ApiFilters {
  const definitions = reportFilterDefinitions(key);
  const hasField = (name: string) => definitions.some(field => field.name === name);
  const statuses = arrayField(state, definitions, ["status"]);
  const occupancy = arrayField(state, definitions, ["occupancy"]);
  const readiness = arrayField(state, definitions, ["readiness"]);
  const listing = arrayField(state, definitions, ["listing"]);
  const balance = stringField(state, definitions, ["balance", "balanceStatus"], "all") as ReportBalanceFilter;
  const tenantStatus = stringField(state, definitions, ["tenantStatus", "tenancyStatus"], defaultReportTenantStatus(key));
  const status = statuses[0] ?? "all";
  const search = stringField(state, definitions, ["search", "text"]);
  const view: ViewFilters = {
    propertyScope: state.propertyScope,
    propertyId: state.propertyIds.length === 1 ? state.propertyIds[0] : "all",
    propertyIds: [...state.propertyIds],
    asOfDate: state.asOfDate,
    status,
    search,
    balanceStatus: hasField("balanceStatus") ? balance : undefined,
    tenantStatus: hasField("tenantStatus") ? tenantStatus as ViewFilters["tenantStatus"] : undefined,
    readiness: hasField("readiness") ? readiness : undefined,
  };
  const query = reportQueryFilters(view, key, { asOfDate: state.asOfDate, month: state.month, fromDate: state.fromDate, toDate: state.toDate });
  if (occupancy.length && hasField("occupancy")) query.occupancy = occupancy;
  if (listing.length && hasField("listing")) query.listing = listing;
  if (readiness.length && hasField("readiness")) query.readiness = readiness;
  if (statuses.length && hasField("status")) query.status = statuses;
  // Rent roll is server-searchable in the shared filter contract. Its old
  // local-only behavior remains compatible, but the applied request must
  // still carry the exact submitted search term.
  if (hasField("search") && search.trim()) query.search = search.trim();
  const unitId = firstReferenceValue(state, definitions, "unit");
  const tenancyId = firstReferenceValue(state, definitions, "tenancy");
  const personId = firstReferenceValue(state, definitions, "person");
  if (unitId) query.unitId = unitId;
  if (tenancyId) query.tenancyId = tenancyId;
  if (personId) query.personId = personId;
  return query;
}

export function reportSetupLocalFilters(key: ReportKey, state: ReportSetupState): ReportLocalFilters {
  void key;
  void state;
  // Every submitted setup field is server-applied. Keep this object neutral so
  // CSV/print cannot silently narrow or widen the visible result locally.
  return {
    occupancy: "all",
    readiness: "all",
    listing: "all",
    balance: "all",
    tenancyStatus: "all",
  };
}

export function reportSetupSearch(key: ReportKey, state: ReportSetupState): string {
  return stringField(state, reportFilterDefinitions(key), ["search", "text"]);
}

export function validateReportSetup(key: ReportKey, state: ReportSetupState): string | undefined {
  const periodError = validateReportPeriod(key, state.asOfDate, state.month, state.fromDate, state.toDate);
  if (periodError) return periodError;
  for (const field of reportFilterDefinitions(key)) {
    const value = fieldValue(state, field);
    const empty = Array.isArray(value) ? value.length === 0 : !value;
    if ((field as ReportSetupField & { required?: boolean }).required && empty) return `${field.label} is required.`;
    if (field.options?.length && !empty) {
      const allowed = new Set(field.options.map(option => option.value));
      const values = Array.isArray(value) ? value : [value];
      if (values.some(item => item !== "all" && !allowed.has(item))) return `Choose a valid ${field.label.toLowerCase()}.`;
    }
  }
  return undefined;
}

export function reportSetupToUrlValue(state: ReportSetupState): string {
  return JSON.stringify(state);
}

export function reportSetupUrlKey(key: ReportKey): string {
  return `rf_${key}`;
}

export function reportSetupEqual(left: ReportSetupState | undefined, right: ReportSetupState | undefined): boolean {
  if (!left || !right) return left === right;
  return reportSetupToUrlValue(left) === reportSetupToUrlValue(right);
}

export function reportSetupFromUrlValue(key: ReportKey, raw: string | null, fallback: ReportSetupState, directory?: ReportSetupDirectory): ReportSetupState {
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const candidate = value as Partial<ReportSetupState>;
    if (candidate.propertyScope !== "active" && candidate.propertyScope !== "all") return fallback;
    if (!Array.isArray(candidate.propertyIds) || !candidate.propertyIds.every(item => typeof item === "string")) return fallback;
    if (typeof candidate.asOfDate !== "string" || typeof candidate.month !== "string" || typeof candidate.fromDate !== "string" || typeof candidate.toDate !== "string") return fallback;
    if (!candidate.values || typeof candidate.values !== "object" || Array.isArray(candidate.values)) return fallback;
    const restoredValues: Record<string, ReportSetupValue> = {};
    for (const [name, fieldValue] of Object.entries(candidate.values as Record<string, unknown>)) {
      if (typeof fieldValue === "string") restoredValues[name] = fieldValue;
      else if (Array.isArray(fieldValue) && fieldValue.every(item => typeof item === "string")) restoredValues[name] = [...fieldValue] as string[];
    }
    return normalizeReportSetup(key, {
      propertyScope: candidate.propertyScope,
      propertyIds: [...candidate.propertyIds],
      asOfDate: candidate.asOfDate,
      month: candidate.month,
      fromDate: candidate.fromDate,
      toDate: candidate.toDate,
      values: restoredValues,
    }, directory);
  } catch {
    return fallback;
  }
}

/** Kept as a named helper for tests and callers that need local narrowing. */
export function applyReportSetupLocalFilters(rows: readonly import("../types").ReportRow[], key: ReportKey, state: ReportSetupState): import("../types").ReportRow[] {
  return filterReportLocalRows(rows, key, reportSetupLocalFilters(key, state));
}

export function isReportSetupDateField(field: ReportSetupField): boolean {
  return usesDateField(field);
}

export function isReportSetupPropertyField(field: ReportSetupField): boolean {
  return usesPropertyField(field);
}
