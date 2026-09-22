import { useMemo, useState, type FormEvent } from "react";
import type { CompanyContextOrganization } from "@shared/company/context";
import { currencyCodeSchema, isoDateSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema, type CurrencyCode } from "@shared/company";
import { isoMonthSchema } from "@shared/rent-ops-contracts";
import { reportRunRequestSchema, type ReportEntry, type ReportPeriod, type ReportRunRequest, type ReportingFilterDefinition } from "@shared/reporting";
import { workspaceToday } from "../rent-ops/workspace/workspace-date";

interface SetupProps {
  readonly entry: ReportEntry;
  readonly organization: CompanyContextOrganization;
  readonly onRun: (request: ReportRunRequest) => void;
  readonly running: boolean;
  readonly initialRequest?: ReportRunRequest;
}

function today(): string { return workspaceToday(); }
function month(): string { return today().slice(0, 7); }
function periodFor(entry: ReportEntry, from: string, through: string, asOf: string, reportMonth: string): ReportPeriod {
  if (entry.period === "range") return { mode: "range", fromDate: isoDateSchema.parse(from), toDate: isoDateSchema.parse(through) };
  if (entry.period === "month") return { mode: "month", month: isoMonthSchema.parse(reportMonth) };
  if (entry.period === "as_of") return { mode: "as_of", asOfDate: isoDateSchema.parse(asOf) };
  return { mode: "custom", ...(asOf ? { asOfDate: isoDateSchema.parse(asOf) } : {}), ...(from ? { fromDate: isoDateSchema.parse(from) } : {}), ...(through ? { toDate: isoDateSchema.parse(through) } : {}), ...(reportMonth ? { month: isoMonthSchema.parse(reportMonth) } : {}) };
}

function initialFilter(filter: ReportingFilterDefinition): unknown {
  if (filter.default !== undefined) return Array.isArray(filter.default) ? [...filter.default] : filter.default;
  return filter.multiple ? [] : "";
}

const scopeFilterNames = new Set(["legalEntityIds", "propertyIds", "unitIds", "tenantIds", "tenancyIds", "ownerIds", "investorIds", "projectIds", "vendorIds", "staffIds"]);

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function isPeriodFilter(entry: ReportEntry, filter: ReportingFilterDefinition): boolean {
  if (entry.period === "as_of") return filter.name === "asOfDate";
  if (entry.period === "range") return filter.name === "fromDate" || filter.name === "toDate";
  if (entry.period === "month") return filter.name === "month";
  return filter.dateMode !== undefined;
}

function visibleReferenceOptions(filter: ReportingFilterDefinition, organization: CompanyContextOrganization): { value: string; label: string }[] {
  if (filter.reference === "legal_entity") return organization.entities.map(entity => ({ value: entity.id, label: entity.name }));
  if (filter.reference === "property") return organization.entities.flatMap(entity => entity.properties.map(property => ({ value: property.id, label: `${property.name} · ${entity.name}` })));
  if (filter.reference === "unit") return organization.entities.flatMap(entity => entity.properties.flatMap(property => property.units.map(unit => ({ value: unit.id, label: `${property.name} · ${unit.unitNumber}` }))));
  return [];
}

function FilterControl({ filter, value, onChange, organization }: { filter: ReportingFilterDefinition; value: unknown; onChange: (value: unknown) => void; organization: CompanyContextOrganization }) {
  const referenceOptions = visibleReferenceOptions(filter, organization);
  if (filter.kind === "reference" && !filter.options && referenceOptions.length === 0) return <span className="reporting-filter-unavailable">Named {filter.label.toLowerCase()} selections are unavailable.</span>;
  if (filter.kind === "date") return <input type="date" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  if (filter.kind === "month") return <input type="month" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  if (filter.kind === "boolean") return <input type="checkbox" checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />;
  if (filter.options || referenceOptions.length) {
    const options = filter.options ?? referenceOptions;
    if (filter.multiple || filter.kind === "multi_select") {
      const selected = Array.isArray(value) ? value.map(String) : [];
      return <select multiple value={selected} size={Math.min(5, Math.max(2, options.length))} onChange={event => onChange(Array.from(event.currentTarget.selectedOptions, option => option.value))}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
    }
    return <select value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)}><option value="">Choose {filter.label.toLowerCase()}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  }
  if (filter.kind === "money" || filter.kind === "number") return <input inputMode="decimal" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  return <input value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
}

export function ReportSetup({ entry, organization, onRun, running, initialRequest }: SetupProps) {
  const firstEntity = organization.entities[0];
  const seededRequest = initialRequest?.reportId === entry.id ? initialRequest : undefined;
  const seededPeriod = seededRequest?.period;
  const todayValue = today();
  const [entityIds, setEntityIds] = useState<string[]>(() => [...(seededRequest?.scope.legalEntityIds ?? [])]);
  const [propertyIds, setPropertyIds] = useState<string[]>(() => [...(seededRequest?.scope.propertyIds ?? [])]);
  const [from, setFrom] = useState(() => seededPeriod?.mode === "range" ? seededPeriod.fromDate : seededPeriod?.mode === "custom" ? seededPeriod.fromDate ?? `${todayValue.slice(0, 4)}-01-01` : `${todayValue.slice(0, 4)}-01-01`);
  const [through, setThrough] = useState(() => seededPeriod?.mode === "range" ? seededPeriod.toDate : seededPeriod?.mode === "custom" ? seededPeriod.toDate ?? todayValue : todayValue);
  const [asOf, setAsOf] = useState(() => seededPeriod?.mode === "as_of" ? seededPeriod.asOfDate : seededPeriod?.mode === "custom" ? seededPeriod.asOfDate ?? todayValue : todayValue);
  const [reportMonth, setReportMonth] = useState(() => seededPeriod?.mode === "month" ? seededPeriod.month : seededPeriod?.mode === "custom" ? seededPeriod.month ?? month() : month());
  const [basis, setBasis] = useState<ReportRunRequest["basis"]>(() => seededRequest?.basis ?? (entry.basis.includes("cash") ? "cash" : "operational"));
  const [currency, setCurrency] = useState(() => seededRequest?.currency ?? firstEntity?.currency ?? "USD");
  const [filters, setFilters] = useState<Record<string, unknown>>(() => Object.fromEntries(entry.filters.map(filter => [filter.name, seededRequest && Object.prototype.hasOwnProperty.call(seededRequest.filters, filter.name) ? seededRequest.filters[filter.name] : initialFilter(filter)])));
  const availableEntities = useMemo(() => organization.entities.filter(entity => entityIds.includes(entity.id)), [organization.entities, entityIds]);
  const update = (name: string, value: unknown) => setFilters(current => ({ ...current, [name]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextFilters = { ...filters, ...(propertyIds.length ? { propertyIds } : {}), ...(entry.filters.some(filter => filter.name === "basis") ? { basis } : {}), ...(entry.filters.some(filter => filter.name === "currency") ? { currency } : {}) };
    const request: ReportRunRequest = { reportId: entry.id, definitionVersion: entry.version, scope: { organizationId: organizationIdSchema.parse(organization.id), legalEntityIds: entityIds.map(value => legalEntityIdSchema.parse(value)), propertyIds: propertyIds.map(value => propertyReferenceIdSchema.parse(value)), unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] }, filters: nextFilters, period: periodFor(entry, from, through, asOf, reportMonth), basis, currency: basis === "cash" || basis === "accrual" ? currencyCodeSchema.parse(currency) as CurrencyCode : null, columns: undefined, sort: undefined };
    onRun(request);
  };
  return <form className="reporting-setup" onSubmit={submit}><div className="reporting-setup-grid"><fieldset><legend>Scope</legend><label>Legal entities<select multiple value={entityIds} size={Math.min(4, Math.max(2, organization.entities.length))} onChange={event => { const selected = Array.from(event.currentTarget.selectedOptions, option => option.value); setEntityIds(selected); setPropertyIds([]); const entity = organization.entities.find(candidate => candidate.id === selected[0]); if (entity) setCurrency(entity.currency); }}>{organization.entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label><label>Properties<select multiple value={propertyIds} size={Math.min(5, Math.max(2, availableEntities.flatMap(entity => entity.properties).length || 2))} onChange={event => setPropertyIds(Array.from(event.currentTarget.selectedOptions, option => option.value))}>{availableEntities.flatMap(entity => entity.properties.map(property => <option key={property.id} value={property.id}>{property.name} · {entity.name}</option>))}</select></label></fieldset><fieldset><legend>Period</legend>{entry.period === "range" && <><label>From<input type="date" value={from} onChange={event => setFrom(event.currentTarget.value)} /></label><label>Through<input type="date" value={through} onChange={event => setThrough(event.currentTarget.value)} /></label></>}{entry.period === "month" && <label>Month<input type="month" value={reportMonth} onChange={event => setReportMonth(event.currentTarget.value)} /></label>}{entry.period === "as_of" && <label>As of<input type="date" value={asOf} onChange={event => setAsOf(event.currentTarget.value)} /></label>}{entry.period === "custom" && <><label>From<input type="date" value={from} onChange={event => setFrom(event.currentTarget.value)} /></label><label>Through<input type="date" value={through} onChange={event => setThrough(event.currentTarget.value)} /></label><label>As of<input type="date" value={asOf} onChange={event => setAsOf(event.currentTarget.value)} /></label></>}</fieldset><fieldset><legend>Report filters</legend>{entry.filters.filter(filter => !["legalEntityIds", "propertyIds"].includes(filter.name) && !isPeriodFilter(entry, filter)).map(filter => <label key={filter.name}>{filter.label}<FilterControl filter={filter} value={filters[filter.name]} onChange={value => update(filter.name, value)} organization={organization} /></label>)}{(entry.basis.includes("cash") || entry.basis.includes("accrual")) && <><label>Basis<select value={basis} onChange={event => setBasis(event.currentTarget.value as ReportRunRequest["basis"])}>{entry.basis.filter(value => value === "cash" || value === "accrual").map(value => <option key={value}>{value}</option>)}</select></label><label>Currency<input value={currency} maxLength={3} onChange={event => setCurrency(event.currentTarget.value.toUpperCase())} /></label></>}</fieldset></div><button className="reporting-primary" type="submit" disabled={running || !entityIds.length}>{running ? "Running…" : "Run report"}</button></form>;
}
