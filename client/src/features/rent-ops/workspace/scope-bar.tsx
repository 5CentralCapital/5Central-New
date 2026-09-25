import { useEffect, useRef } from "react";
import { RefreshCw, Search } from "lucide-react";
import { formatLongDate, formatTimestamp } from "../../../lib/rent-ops-formatters";
import type { ViewFilters } from "../types";
import { selectedWorkspaceProperties } from "./workspace-state";

/*
 * The one scope bar for rental pages (design audit S1–S3): portfolio and
 * properties in one picker, the as-of date with Today inside its picker,
 * an optional status, search, and a quiet "Updated … Refresh" line.
 * Pages add only their own filters; they never repeat these controls.
 */

interface PropertyOption { id?: string | null; name?: string | null }
type Scope = Partial<Pick<ViewFilters, "propertyScope" | "propertyId" | "propertyIds">>;

/** Close an open <details> popover when the pointer goes down outside it or Escape is pressed. */
function useDismissableDetails() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const node = ref.current;
      if (!node?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        node.open = false;
        node.querySelector("summary")?.focus();
        return;
      }
      if (!node.contains(event.target as Node)) node.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  return ref;
}

export function scopeSummary(filters: ViewFilters, properties: readonly PropertyOption[]): string {
  const portfolio = filters.propertyScope === "all" ? "All imported" : "Active portfolio";
  const selected = selectedWorkspaceProperties(filters);
  const names = selected.length === 0 ? "All properties" : selected.length === 1 ? (properties.find(property => property.id === selected[0])?.name ?? "1 property") : `${selected.length} properties`;
  return `${portfolio} · ${names}`;
}

export function dateSummary(filters: ViewFilters): string {
  const label = formatLongDate(filters.asOfDate) ?? "Choose a date";
  return filters.asOfMode === "today" ? `${label} · Today` : label;
}

export function ScopeBar({ filters, properties, onScope, onDate, onToday, status, searchPlaceholder = "Search tenants, units, properties", onSearch, onRefresh, refreshing = false, updatedAt }: {
  filters: ViewFilters;
  properties: readonly PropertyOption[];
  onScope: (changes: Scope) => void;
  onDate: (date: string) => void;
  onToday: () => void;
  status?: { value: string; options: readonly (readonly string[])[]; onChange: (value: string) => void };
  searchPlaceholder?: string;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  updatedAt?: number;
}) {
  const scopeRef = useDismissableDetails();
  const dateRef = useDismissableDetails();
  const selected = selectedWorkspaceProperties(filters);
  const updated = updatedAt ? formatTimestamp(new Date(updatedAt)) : undefined;
  return <div className="rm-toolbar rm-workspace-toolbar rops-scope-bar" role="toolbar" aria-label="Workspace filters">
    <details className="rops-scope-picker" ref={scopeRef}>
      <summary aria-label={`Portfolio and properties: ${scopeSummary(filters, properties)}`}>{scopeSummary(filters, properties)}</summary>
      <div className="rops-scope-popover">
        <fieldset>
          <legend>Portfolio</legend>
          <label><input type="radio" name="rops-portfolio" checked={filters.propertyScope !== "all"} onChange={() => onScope({ propertyScope: "active", propertyId: "all", propertyIds: [] })} />Active portfolio</label>
          <label><input type="radio" name="rops-portfolio" checked={filters.propertyScope === "all"} onChange={() => onScope({ propertyScope: "all", propertyId: "all", propertyIds: [] })} />All imported properties</label>
        </fieldset>
        <fieldset>
          <legend>Properties</legend>
          <label><input type="checkbox" checked={!selected.length} onChange={() => onScope({ propertyId: "all", propertyIds: [] })} />All properties</label>
          {properties.map(property => property.id && <label key={property.id}><input type="checkbox" checked={selected.includes(property.id)} onChange={event => {
            const ids = event.target.checked ? [...selected, property.id!] : selected.filter(id => id !== property.id);
            onScope({ propertyIds: ids, propertyId: ids.length === 1 ? ids[0] : "all" });
          }} />{property.name ?? "Unnamed property"}</label>)}
        </fieldset>
      </div>
    </details>
    <details className="rops-scope-picker" ref={dateRef}>
      <summary aria-label={`As of ${dateSummary(filters)}`}>{dateSummary(filters)}</summary>
      <div className="rops-scope-popover rops-date-popover">
        <label className="rops-date-field">As of<input type="date" value={filters.asOfDate} onChange={event => { if (event.target.value) onDate(event.target.value); }} /></label>
        <button type="button" className="rm-button" aria-pressed={filters.asOfMode === "today"} onClick={() => { onToday(); if (dateRef.current) dateRef.current.open = false; }}>Today</button>
      </div>
    </details>
    {status && <select className="rops-scope-status" aria-label="Status" value={status.value} onChange={event => status.onChange(event.target.value)}>{status.options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>}
    <label className="rm-search rops-scope-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search records" placeholder={searchPlaceholder} value={filters.search} onChange={event => onSearch(event.target.value)} /></label>
    <button type="button" className="rops-scope-refresh" onClick={onRefresh} disabled={refreshing} aria-label="Refresh workspace" title="Refresh">
      <RefreshCw size={13} className={refreshing ? "spin" : ""} aria-hidden="true" />
      <span>{refreshing ? "Refreshing…" : updated ? `Updated ${updated}` : "Refresh"}</span>
    </button>
  </div>;
}
