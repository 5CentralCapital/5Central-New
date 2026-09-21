import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, ChevronDown, Play, Search } from "lucide-react";
import type { ReportKey } from "../types";
import {
  isReportSetupDateField,
  isReportSetupPropertyField,
  reportFilterDefinitions,
  reportSetupFieldValue,
  validateReportSetup,
  type ReportSetupDirectory,
  type ReportSetupField,
  type ReportSetupState,
  type ReportSetupValue,
} from "./report-setup-model";
import { REPORT_PERIODS } from "./report-model";
import "./report-setup.css";

export interface ReportSetupProps {
  report: ReportKey;
  value: ReportSetupState;
  directory?: ReportSetupDirectory;
  allowAllScope?: boolean;
  hasAppliedRun?: boolean;
  onChange: (next: ReportSetupState) => void;
  onRun: (next: ReportSetupState) => void;
}

function optionLabel(field: ReportSetupField, value: string): string {
  return field.options?.find(option => option.value === value)?.label ?? value.replaceAll("_", " ");
}

function personLabel(person: ReportSetupDirectory["people"][number]): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return name || person.email || person.phone || person.id || "Tenant needs review";
}

function propertyLabel(property: ReportSetupDirectory["properties"][number]): string {
  return property.name || property.slug || property.id || "Property needs review";
}

function emptyReferenceSummary(field: ReportSetupField): string {
  if (field.reference === "property") return "All properties";
  if (field.reference === "unit") return "All units";
  if (field.reference === "tenancy") return "All tenancies";
  if (field.reference === "person") return "All tenants";
  return `All ${field.label.toLowerCase()}`;
}

function setupScopeProperties(directory: ReportSetupDirectory | undefined, scope: "active" | "all", allowAllScope: boolean): ReportSetupDirectory["properties"] {
  return (directory?.properties ?? []).filter(property => allowAllScope && scope === "all" || property.state === "active");
}

function selectedPropertySummary(value: ReportSetupState, directory: ReportSetupDirectory | undefined): string {
  if (!value.propertyIds.length) return value.propertyScope === "active" ? "All active properties" : "All properties";
  if (value.propertyIds.length === 1) return directory?.properties.find(property => property.id === value.propertyIds[0])?.name ?? "1 property";
  return `${value.propertyIds.length} properties`;
}

function referenceIds(value: ReportSetupState, name: string): Set<string> {
  const selected = value.values[name];
  if (Array.isArray(selected)) return new Set(selected.filter(Boolean));
  return selected ? new Set([selected]) : new Set();
}

function referenceOptions(field: ReportSetupField, value: ReportSetupState, directory?: ReportSetupDirectory): Array<{ value: string; label: string }> {
  if (!directory || !field.reference) return [];
  const propertyIds = new Set(value.propertyIds);
  const allowedPropertyIds = new Set(directory.properties.filter(property => value.propertyScope === "all" || property.state === "active").map(property => property.id));
  const selectedUnitIds = field.name === "unitId" ? new Set<string>() : referenceIds(value, "unitId");
  const propertyMatches = (propertyId: string | null | undefined) =>
    (!propertyId || allowedPropertyIds.has(propertyId)) && (!propertyIds.size || !!propertyId && propertyIds.has(propertyId));
  const tenancyMatches = (tenancy: ReportSetupDirectory["tenancies"][number]) =>
    !!tenancy.id && propertyMatches(tenancy.propertyId)
      && (!selectedUnitIds.size || !!tenancy.unitId && selectedUnitIds.has(tenancy.unitId));
  if (field.reference === "unit") {
    return directory.units
      .filter(unit => unit.id && propertyMatches(unit.propertyId))
      .sort((left, right) => `${left.unitNumber ?? ""}`.localeCompare(`${right.unitNumber ?? ""}`, undefined, { numeric: true }))
      .map(unit => ({ value: unit.id!, label: unit.unitNumber ? `${unit.unitNumber}${unit.propertyId ? ` · ${directory.properties.find(property => property.id === unit.propertyId)?.name ?? "Property"}` : ""}` : unit.id! }));
  }
  if (field.reference === "tenancy") {
    const properties = new Map(directory.properties.map(property => [property.id, property.name ?? property.id ?? "Property"]));
    const units = new Map(directory.units.map(unit => [unit.id, unit.unitNumber ?? unit.id ?? "Unit"]));
    return directory.tenancies.filter(tenancy => tenancyMatches(tenancy))
      .sort((left, right) => `${left.id}`.localeCompare(`${right.id}`))
      .map(tenancy => ({ value: tenancy.id!, label: `${properties.get(tenancy.propertyId) ?? "Property"} · ${units.get(tenancy.unitId) ?? "Unit"} · ${tenancy.status ?? "Needs review"}` }));
  }
  const hasParentRestriction = value.propertyScope !== "all" || propertyIds.size > 0 || selectedUnitIds.size > 0;
  if (!hasParentRestriction) {
    return directory.people.filter(person => person.id).sort((left, right) => personLabel(left).localeCompare(personLabel(right), undefined, { numeric: true })).map(person => ({ value: person.id!, label: personLabel(person) }));
  }
  const scopedPersonIds = new Set(directory.tenancies.filter(tenancy => tenancyMatches(tenancy)).map(tenancy => tenancy.primaryPersonId).filter((id): id is string => !!id));
  return directory.people.filter(person => person.id && scopedPersonIds.has(person.id)).sort((left, right) => personLabel(left).localeCompare(personLabel(right), undefined, { numeric: true })).map(person => ({ value: person.id!, label: personLabel(person) }));
}

function standardOptions(field: ReportSetupField): Array<{ value: string; label: string }> {
  const options = field.options ? [...field.options] : [];
  if (field.kind === "select" && !options.some(option => option.value === "all")) options.unshift({ value: "all", label: `All ${field.label.toLowerCase()}` });
  return options;
}

export function ReportSetup({ report, value, directory, allowAllScope = true, hasAppliedRun = false, onChange, onRun }: ReportSetupProps) {
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const pickerRefs = useRef(new Map<string, HTMLDetailsElement>());
  const summaryRefs = useRef(new Map<string, HTMLElement>());
  const definitions = reportFilterDefinitions(report);
  const error = validateReportSetup(report, value);
  const scopeProperties = setupScopeProperties(directory, value.propertyScope, allowAllScope);
  const selectedProperties = new Set(value.propertyIds);
  const selectedValues = (field: ReportSetupField): string[] => {
    const current = reportSetupFieldValue(value, field);
    return Array.isArray(current) ? current : current ? [current] : [];
  };
  const hasRange = REPORT_PERIODS[report] === "range" || definitions.some(field => field.dateSemantics?.mode === "activity_range");
  // A range report may advertise a month alias for discovery. Its execution
  // contract is still the range, so keep the controls mutually exclusive.
  const hasMonth = REPORT_PERIODS[report] === "month";
  const asOfField = definitions.find(field => field.dateSemantics?.mode === "as_of");
  const rangeFields = definitions.filter(field => field.dateSemantics?.mode === "activity_range");
  const monthField = definitions.find(field => field.dateSemantics?.mode === "report_month");

  useEffect(() => {
    if (!openPicker) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const picker = pickerRefs.current.get(openPicker);
      if (!picker || !event.target || picker.contains(event.target as Node)) return;
      setOpenPicker(null);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [openPicker]);

  const update = (changes: Partial<ReportSetupState>) => onChange({ ...value, ...changes, values: changes.values ? { ...changes.values } : { ...value.values } });
  const updateValue = (field: ReportSetupField, fieldValue: ReportSetupValue) => update({ values: { ...value.values, [field.name]: fieldValue } });
  const changeScope = (scope: "active" | "all") => {
    const available = new Set(setupScopeProperties(directory, scope, allowAllScope).map(property => property.id));
    const propertyIds = value.propertyIds.filter(id => !directory || available.has(id));
    update({ propertyScope: scope, propertyIds });
  };
  const toggleProperty = (propertyId: string, checked: boolean) => update({ propertyIds: checked ? [...value.propertyIds, propertyId].sort() : value.propertyIds.filter(id => id !== propertyId) });
  const toggleMulti = (field: ReportSetupField, selected: string, checked: boolean) => {
    const current = selectedValues(field).filter(item => item !== "all");
    updateValue(field, checked ? Array.from(new Set([...current, selected])) : current.filter(item => item !== selected));
  };
  const run = () => {
    if (error) return;
    onRun(allowAllScope ? value : { ...value, propertyScope: "active" });
  };

  const restoreSummaryFocus = (pickerId: string) => {
    const restore = () => summaryRefs.current.get(pickerId)?.focus();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(restore);
    else restore();
  };
  const handlePickerKeyDown = (pickerId: string, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpenPicker(current => current === pickerId ? null : current);
    restoreSummaryFocus(pickerId);
  };
  const picker = (pickerId: string, label: string, summary: string, menu: ReactNode) => {
    const menuId = `report-filter-${report}-${pickerId}-options`;
    return <details
      className="rm-report-setup-picker"
      open={openPicker === pickerId}
      ref={node => { if (node) pickerRefs.current.set(pickerId, node); else pickerRefs.current.delete(pickerId); }}
      onKeyDown={event => handlePickerKeyDown(pickerId, event)}
    >
      <summary
        ref={node => { if (node) summaryRefs.current.set(pickerId, node); else summaryRefs.current.delete(pickerId); }}
        aria-label={`${label}: ${summary}`}
        aria-controls={menuId}
        onClick={event => { event.preventDefault(); setOpenPicker(current => current === pickerId ? null : pickerId); }}
      ><span>{summary}</span><ChevronDown size={15} aria-hidden="true" /></summary>
      <div id={menuId} className="rm-report-setup-picker-menu">{menu}</div>
    </details>;
  };

  const renderField = (field: ReportSetupField) => {
    if (isReportSetupPropertyField(field) || isReportSetupDateField(field)) return null;
    const current = reportSetupFieldValue(value, field);
    if (field.reference) {
      const options = referenceOptions(field, value, directory);
      if (field.multiple || field.kind === "multi_select") {
        const selected = selectedValues(field);
        const summary = selected.length ? `${selected.length} selected` : emptyReferenceSummary(field);
        return <div className="rm-report-setup-field" data-report-filter={field.name} key={field.name}><span className="rm-report-setup-label">{field.label}</span>{picker(`${field.name}`, field.label, summary, options.map(option => <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => toggleMulti(field, option.value, event.target.checked)} />{option.label}</label>))}</div>;
      }
      return <label className="rm-report-setup-field" data-report-filter={field.name} key={field.name}><span className="rm-report-setup-label">{field.label}</span><select name={field.name} value={typeof current === "string" ? current : current[0] ?? ""} onChange={event => updateValue(field, event.target.value)}><option value="">{emptyReferenceSummary(field)}</option>{options.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
    }
    if (field.kind === "text") return <label className="rm-report-setup-field rm-report-setup-field--wide" data-report-filter={field.name} key={field.name}><span className="rm-report-setup-label"><Search size={14} aria-hidden="true" />{field.label}</span><input name={field.name} type="search" value={typeof current === "string" ? current : ""} placeholder={field.label} onChange={event => updateValue(field, event.target.value)} /></label>;
    if (field.kind === "multi_select") {
      const selected = selectedValues(field).filter(item => item !== "all");
      const options = standardOptions(field);
      const summary = selected.length ? selected.map(item => optionLabel(field, item)).join(", ") : `All ${field.label.toLowerCase()}`;
      return <div className="rm-report-setup-field" data-report-filter={field.name} key={field.name}><span className="rm-report-setup-label">{field.label}</span>{picker(`${field.name}`, field.label, summary, options.filter(option => option.value !== "all").map(option => <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => toggleMulti(field, option.value, event.target.checked)} />{option.label}</label>))}</div>;
    }
    const options = standardOptions(field);
    return <label className="rm-report-setup-field" data-report-filter={field.name} key={field.name}><span className="rm-report-setup-label">{field.label}</span><select name={field.name} value={typeof current === "string" ? current : current[0] ?? "all"} onChange={event => updateValue(field, event.target.value)}>{options.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
  };

  return <section className="rm-report-setup" data-report-setup="true" aria-label={`${report} report settings`}>
    <div className="rm-report-setup-heading"><h2>Filters</h2></div>
    <div className="rm-report-setup-grid">
      <fieldset className="rm-report-setup-group rm-report-setup-group--scope"><legend>Scope</legend>
        <label className="rm-report-setup-field" data-report-filter="propertyScope"><span className="rm-report-setup-label">Portfolio</span><select name="propertyScope" value={allowAllScope ? value.propertyScope : "active"} onChange={event => changeScope(event.target.value as "active" | "all")}><option value="active">Active portfolio</option>{allowAllScope && <option value="all">All properties</option>}</select></label>
        <div className="rm-report-setup-field" data-report-filter="propertyIds"><span className="rm-report-setup-label">Properties</span>{picker("propertyIds", "Properties", selectedPropertySummary(value, directory), <><label><input type="checkbox" checked={!value.propertyIds.length} onChange={() => update({ propertyIds: [] })} />{value.propertyScope === "active" ? "All active properties" : "All properties"}</label>{scopeProperties.map(property => <label key={property.id}><input type="checkbox" checked={selectedProperties.has(property.id!)} onChange={event => toggleProperty(property.id!, event.target.checked)} />{propertyLabel(property)}</label>)}</>)}</div>
      </fieldset>
      <fieldset className="rm-report-setup-group rm-report-setup-group--period"><legend>Period</legend>
        {asOfField && <label className="rm-report-setup-field" data-report-filter="asOfDate"><span className="rm-report-setup-label"><CalendarDays size={14} aria-hidden="true" />{asOfField.label}</span><input name="asOfDate" type="date" value={value.asOfDate} onChange={event => update({ asOfDate: event.target.value })} /></label>}
        {!asOfField && <label className="rm-report-setup-field" data-report-filter="asOfDate"><span className="rm-report-setup-label"><CalendarDays size={14} aria-hidden="true" />As of date</span><input name="asOfDate" type="date" value={value.asOfDate} onChange={event => update({ asOfDate: event.target.value })} /></label>}
        {hasMonth && monthField && <label className="rm-report-setup-field" data-report-filter="month"><span className="rm-report-setup-label"><CalendarDays size={14} aria-hidden="true" />{monthField.label}</span><input name="month" type="month" value={value.month} max={value.asOfDate.slice(0, 7)} onChange={event => update({ month: event.target.value })} /></label>}
        {hasRange && <><label className="rm-report-setup-field" data-report-filter="fromDate"><span className="rm-report-setup-label"><CalendarDays size={14} aria-hidden="true" />{rangeFields.find(field => field.name === "fromDate")?.label ?? "Activity from"}</span><input name="fromDate" type="date" value={value.fromDate} max={value.toDate} onChange={event => update({ fromDate: event.target.value })} /></label><label className="rm-report-setup-field" data-report-filter="toDate"><span className="rm-report-setup-label"><CalendarDays size={14} aria-hidden="true" />{rangeFields.find(field => field.name === "toDate")?.label ?? "Activity through"}</span><input name="toDate" type="date" value={value.toDate} min={value.fromDate} max={value.asOfDate} onChange={event => update({ toDate: event.target.value })} /></label></>}
      </fieldset>
      {definitions.filter(field => !isReportSetupDateField(field) && !isReportSetupPropertyField(field)).length > 0 && <fieldset className="rm-report-setup-group rm-report-setup-group--filters"><legend>Filters</legend><div className="rm-report-setup-filter-grid">{definitions.map(renderField)}</div></fieldset>}
    </div>
    {error && <p className="rm-report-setup-error" role="alert">{error}</p>}
    <div className="rm-report-setup-actions"><button type="button" className="rm-button rm-button-primary rm-report-setup-run" disabled={!!error} onClick={run}><Play size={14} aria-hidden="true" />{hasAppliedRun ? "Update report" : "Run report"}</button></div>
  </section>;
}

export default ReportSetup;
