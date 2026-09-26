import { PropertyRecurringPanel } from './property-recurring-panel';
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Home, Pencil, Plus, Search } from "lucide-react";
import { RowMenu, Skeleton } from "./ops-ui";
import { useRentalReport } from "../../workspaces/rental-reports";
import { readReportValue } from "./report-model";

import {EntityLink,RecordLink} from "./entity-link";
import { DataGrid, type GridColumn } from "./grid";
import { ListTotals, exactCentsMetric } from "./list-totals";
import { summarizeExactCents } from "./list-totals-model";
import { formatDate, formatLabel, formatMoney } from "./display";
import { DATE_MISSING_LABEL, PROPERTY_MISSING_LABEL, STATUS_UNVERIFIED_LABEL, UNIT_MISSING_LABEL, UNKNOWN_AMOUNT_LABEL, UNVERIFIED_LABEL, missingLabel } from "@shared/review-cases/display-labels";
import {
  addUnitValues,
  addressLines,
  availablePropertyTabs,
  availableUnitTabs,
  buildPropertyEditValues,
  buildUnitEditValues,
  propertyUnitFieldValue,
  propertyUnitFieldUnverified,
  unitLayoutLabel,
  knownLink,
  propertyUnitListItems,
  propertyUnits,
  resolvePropertyUnitSelection,
  type PropertyUnitListItem,
  type PropertyUnitTab,
} from "./property-unit-model";
import type { FormValues, QuickAction } from "../form-payload";
import type { AdminPropertyView, AdminSnapshot, AdminUnitView, ViewFilters } from "../types";
import "./property-unit-records.css";
import { PropertyOccupancyPanel } from "./property-occupancy-panel";
import { UnitReadinessBadge, UnitReadinessProvider, useUnitReadiness } from "./unit-readiness";
import { recordedUnitReadiness, unitOccupancyCell } from "./unit-readiness-model";
import type { ReportKey } from "../types";
import { canonicalPropertyTab, PROPERTY_RECORD_TABS, PROPERTY_RECORD_TAB_LABELS, type PropertyRecordTab } from "../../workspaces/property-record-model";
import { PropertyFinancials } from "../../workspaces/property-financials";
import { PropertyDocumentsTab, PropertyProjectsTab, PropertyWorkOrdersTab } from "../../workspaces/property-record-tabs";

export type EditAction = (action: QuickAction, values?: FormValues) => void;

export interface PropertyUnitRecordsProps {
  snapshot: AdminSnapshot;
  readOnly?: boolean;
  filters: ViewFilters;
  selectedPropertyId?: string;
  selectedUnitId?: string;
  onSelect: (kind: "property" | "unit", id: string) => void;
  onEdit: EditAction;
  /** Optional dedicated company property setup flow; editing existing properties still uses onEdit. */
  onAddPropertySetup?: () => void;
  onSearchChange?: (search:string)=>void;
  /** Company context for the connected property tabs (financials, projects, work orders, documents). */
  identity: string;
  organizationId?: string;
  onOpenProject: (organizationId: string, projectId?: string) => void;
  onOpenWorkOrder: (organizationId: string, workOrderId?: string) => void;
  onOpenReport: (report: ReportKey) => void;
}

type PropertyLinks = Pick<PropertyUnitRecordsProps, "identity" | "organizationId" | "onOpenProject" | "onOpenWorkOrder" | "onOpenReport">;

const TAB_LABELS: Record<PropertyUnitTab, string> = {
  general: "General",
  units: "Units",
  occupancy: "Occupancy",
  recurring: "Recurring",
  marketing: "Marketing",
};

type GridRow = Record<string, unknown>;

function label(value: unknown): string {
  if (value == null || value === "") return UNVERIFIED_LABEL;
  return formatLabel(String(value));
}

function date(value: unknown): string {
  if (value == null || value === "") return DATE_MISSING_LABEL;
  return formatDate(String(value));
}

function money(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNKNOWN_AMOUNT_LABEL;
  return formatMoney(value);
}

function knownValue(value: unknown, knowledge?: unknown): boolean {
  return value != null && value !== "" && !["unknown", "ambiguous", "inferred"].includes(String(knowledge ?? ""));
}

/** A value, or what is wrong with it: `missing` when absent, "Unverified" when its knowledge is uncertain. */
function value(value: unknown, knowledge?: unknown, missing = UNVERIFIED_LABEL): string {
  if (value == null || value === "") return missing;
  if (!knownValue(value, knowledge)) return UNVERIFIED_LABEL;
  return String(value);
}

function statusValue(valueToShow: unknown, knowledge?: unknown): ReactNode {
  const known = knownValue(valueToShow, knowledge);
  return <span className={`rm-status ${known ? String(valueToShow) : "unknown"}`}>{known ? label(String(valueToShow)) : STATUS_UNVERIFIED_LABEL}</span>;
}

function recordedOptionalStatus(status: unknown, knowledge?: unknown): boolean {
  // Source placeholder statuses (including "needs_review", spaced or not) are not recorded statuses.
  const raw = typeof status === "string" ? status.trim().toLowerCase().replace(/\s+/g, "_") : "";
  return Boolean(raw) && !["unknown", "ambiguous", "inferred", "needs_review"].includes(raw) && !propertyUnitFieldUnverified(knowledge);
}

function optionalStatus(status: unknown, knowledge?: unknown, omitUnknown = false): ReactNode {
  return recordedOptionalStatus(status, knowledge) ? statusValue(status, knowledge) : omitUnknown ? null : <span className="rm-muted">Not recorded</span>;
}

function EmptyState({ message }: { message: string }) {
  return <div className="rm-empty rm-property-unit-empty"><Home aria-hidden="true" /><p>{message}</p></div>;
}

function Field({ label: fieldLabel, value: fieldValue, knowledge, required = false }: { label: string; value: ReactNode; knowledge?: unknown; required?: boolean }) {
  const empty = fieldValue == null || fieldValue === "";
  const display = empty ? required ? missingLabel(fieldLabel) : "—" : typeof fieldValue === "string" || typeof fieldValue === "number" ? propertyUnitFieldValue(fieldValue) : fieldValue;
  const unverified = !empty && propertyUnitFieldUnverified(knowledge);
  return <div className="rm-field"><dt>{fieldLabel}</dt><dd className={empty && !required ? "rm-property-unit-absent" : undefined}>{display}{unverified && <small className="rm-property-unit-unverified">Unverified</small>}</dd></div>;
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rm-property-unit-group"><h3>{title}</h3><dl>{children}</dl></section>;
}

function RecordTabs<T extends string>({ tabs, selected, onSelect, labels }: { tabs: readonly T[]; selected: T; onSelect: (tab: T) => void; labels: Record<T, string> }) {
  return <nav className="rm-tabs rm-property-unit-tabs" aria-label="Record sections" role="tablist" onKeyDown={(event) => {
    // Arrow keys move between tabs, as in the platform tab pattern.
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.indexOf(selected);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault(); onSelect(next);
    requestAnimationFrame(() => (event.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus());
  }}>
    {tabs.map((tab) => <button type="button" role="tab" data-tab={tab} tabIndex={selected === tab ? 0 : -1} aria-selected={selected === tab} className={selected === tab ? "active" : ""} key={tab} onClick={() => onSelect(tab)}>{labels[tab]}</button>)}
  </nav>;
}

function RecordList({ rows, selected, search, onSearch, onSelect, onAddProperty }: { rows: PropertyUnitListItem[]; selected?: { kind: "property" | "unit"; id?: string }; search: string; onSearch: (next: string) => void; onSelect: (kind: "property" | "unit", id: string) => void; onAddProperty?: () => void }) {
  return <aside className="rm-record-list rm-property-unit-list" aria-label="Properties and units">
    <div className="rm-property-unit-list-heading"><div><h2>Properties &amp; units</h2></div><span className="rm-property-unit-list-tools"><span className="rm-muted">{rows.length} shown</span>{onAddProperty && <button type="button" className="rm-property-unit-icon-button" aria-label="Add property" title="Add property" onClick={onAddProperty}><Plus aria-hidden="true" /></button>}</span></div>
    <label className="rm-property-unit-search"><Search aria-hidden="true" /><span className="sr-only">Search properties and units</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search properties and units" /></label>
    <div className="rm-property-unit-list-items">
      {rows.map((row) => {
        const active = selected?.kind === row.kind && selected.id === row.id && Boolean(row.id);
        const className = `rm-property-unit-list-row ${row.kind} ${active ? "selected" : ""}`;
        return <button type="button" className={className} key={row.key} disabled={!row.id} onClick={() => { if (row.id) onSelect(row.kind, row.id); }}>
          <span className="rm-property-unit-list-icon" aria-hidden="true">{row.kind === "property" ? <Building2 /> : <Home />}</span>
          <span className="rm-property-unit-list-copy"><strong>{row.title}</strong><small>{row.kind === "property" ? row.subtitle : ["Unit", row.subtitle].filter(Boolean).join(" · ")}</small></span>
        </button>;
      })}
      {!rows.length && <EmptyState message="No properties or units match this search." />}
    </div>
    <ListTotals totalCount={rows.length} itemLabel="property or unit record" />
  </aside>;
}

function PropertySummary({ property, units, unresolvedUnitCount, onEdit, onAddUnit }: { property: AdminPropertyView; units: AdminUnitView[]; unresolvedUnitCount: number; onEdit: EditAction; onAddUnit: () => void }) {
  const address = addressLines(property.address);
  return <header className="rm-property-unit-summary" data-testid="property-record" aria-labelledby="property-record-title">
    <div className="rm-property-unit-summary-heading">
      <div className="rm-property-unit-identity"><div className="rm-property-unit-title-row"><h2 id="property-record-title">{propertyUnitFieldValue(property.name)}</h2>{statusValue(property.state, property.stateKnowledge)}</div>{address.length > 0 && <address className="rm-property-unit-address">{address.join(", ")}</address>}<p className="rm-property-unit-context"><span>{units.length} {units.length === 1 ? "unit" : "units"}</span>{property.propertyType && <span>{label(property.propertyType)}</span>}{unresolvedUnitCount > 0 && <span className="rm-property-unit-unverified">{unresolvedUnitCount} unit link{unresolvedUnitCount === 1 ? "" : "s"} unverified</span>}</p></div>
      <div className="rm-property-unit-actions">{property.id && <button type="button" className="rm-button rm-button-primary" onClick={onAddUnit}><Plus aria-hidden="true" /> Add unit</button>}{property.id && <RowMenu label="Property actions" items={[{ label: "Edit property", onSelect: () => onEdit("save-property", buildPropertyEditValues(property)) }]} />}</div>
    </div>
  </header>;
}

function ContactValue({ contact }: { contact: string }) {
  return <>{contact.split(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i).map((part, index) => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(part) ? <a key={index} className="rm-link-button" href={`mailto:${part}`}>{part}</a> : part)}</>;
}

function PropertyGeneral({ property }: { property: AdminPropertyView }) {
  const address = property.address;
  return <div className="rm-property-unit-groups">
    <FieldGroup title="Property details"><Field label="Name" value={property.name} knowledge={property.nameKnowledge} required /><Field label="Type" value={property.propertyType ? label(property.propertyType) : undefined} knowledge={property.propertyTypeKnowledge} /><Field label="Status" value={statusValue(property.state, property.stateKnowledge)} /><Field label="Operating contact" value={property.operatingContact ? <ContactValue contact={property.operatingContact} /> : undefined} knowledge={property.operatingContactKnowledge} /></FieldGroup>
    <FieldGroup title="Address"><Field label="Street" value={address?.line1} knowledge={property.addressKnowledge} />{address?.line2 && <Field label="Address line 2" value={address.line2} knowledge={property.addressKnowledge} />}<Field label="City" value={address?.city} /><Field label="State" value={address?.state} /><Field label="Postal code" value={address?.postalCode} /></FieldGroup>
  </div>;
}

type UnitGridRow = GridRow & { id: string; unit: AdminUnitView };

/** Days vacant per unit from the occupancy report (the same source as the vacancy list). */
function useDaysVacant(identity: string, filters: ViewFilters): Map<string, number> {
  const report = useRentalReport(identity, "occupancy", filters, { asOfDate: filters.asOfDate });
  return useMemo(() => new Map((report.isError ? [] : report.data ?? []).flatMap((row) => {
    const unitId = readReportValue(row, "unitId");
    const days = readReportValue(row, "daysVacant");
    return typeof unitId === "string" && typeof days === "number" ? [[unitId, days] as const] : [];
  })), [report.data, report.isError]);
}

function listingValue(unit: AdminUnitView): ReactNode {
  const listing = unit.listing?.trim().toLowerCase();
  if (!listing || listing === "unlisted" || !recordedOptionalStatus(unit.listing, unit.listingKnowledge)) return <span className="rm-muted" title={listing && listing !== "unlisted" ? "Listing not verified" : "Not listed"}>—</span>;
  return <span className="rm-status">{label(unit.listing)}</span>;
}

function UnitGrid({ units, identity, filters, onSelect, onEdit }: { units: AdminUnitView[]; identity: string; filters: ViewFilters; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  const { occupancy, occupancyReady, occupancyError, open } = useUnitReadiness();
  const daysVacant = useDaysVacant(identity, filters);
  const rows: UnitGridRow[] = units.map((unit, index) => ({ id: unit.id ?? `unit:${index}`, unit }));
  const occupancyOf = (row: UnitGridRow) => unitOccupancyCell(occupancy.get(row.unit.id ?? ""), daysVacant.get(row.unit.id ?? ""));
  const columns: GridColumn<UnitGridRow>[] = [
    { key: "unitNumber", label: "Unit", render: (row) => <RecordLink kind="unit" recordId={row.unit.id} onOpen={onSelect}>{value(row.unit.unitNumber, row.unit.unitNumberKnowledge, UNIT_MISSING_LABEL)}</RecordLink>, sortValue: (row) => row.unit.unitNumber ?? "" },
    { key: "occupancy", label: "Occupancy", render: (row) => {
      const cell = occupancyOf(row);
      if (cell) return <span className={`rm-status${cell.tone === "neutral" ? "" : ` rm-status--${cell.tone}`}`}>{cell.label}</span>;
      if (!occupancyReady && !occupancyError) return <Skeleton width="5em" label="Loading occupancy" />;
      return <span className="rm-muted" title="Occupancy is not available for this unit">—</span>;
    }, sortValue: (row) => occupancyOf(row)?.label ?? "" },
    { key: "unitType", label: "Type", render: (row) => propertyUnitFieldValue(row.unit.unitType), sortValue: (row) => row.unit.unitType ?? "" },
    { key: "layout", label: "Layout", render: (row) => unitLayoutLabel(row.unit), sortValue: (row) => `${row.unit.bedrooms ?? ""}-${row.unit.bathrooms ?? ""}` },
    { key: "squareFeet", label: "Area", render: (row) => row.unit.squareFeet == null ? "—" : `${row.unit.squareFeet.toLocaleString()} sq ft`, sortValue: (row) => row.unit.squareFeet },
    { key: "marketRent", label: "Market rent", align: "right", render: (row) => row.unit.marketRentCents == null ? "—" : money(row.unit.marketRentCents), sortValue: (row) => row.unit.marketRentCents },
    { key: "readiness", label: "Readiness", render: (row) => recordedUnitReadiness(row.unit, occupancy.get(row.unit.id ?? "")) ? <UnitReadinessBadge unit={row.unit} /> : <span className="rm-muted" title="Readiness not recorded">—</span>, sortValue: (row) => recordedUnitReadiness(row.unit, occupancy.get(row.unit.id ?? ""))?.label ?? "" },
    { key: "listing", label: "Listing", render: (row) => listingValue(row.unit), sortValue: (row) => row.unit.listing ?? "" },
    { key: "action", label: "", width: 72, render: (row) => row.unit.id ? <RowMenu label={`Actions for unit ${row.unit.unitNumber ?? ""}`.trim()} items={[
      { label: "Edit unit", onSelect: () => onEdit("save-unit", buildUnitEditValues(row.unit)) },
      { label: "Set readiness…", onSelect: () => open(row.unit) },
    ]} /> : null },
  ];
  if (!rows.length) return <EmptyState message="No units are linked to this property." />;
  return <DataGrid<UnitGridRow> rows={rows} columns={columns} getRowKey={(row) => row.id} onRow={(row) => { if (row.unit.id) onSelect(row.unit.id); }} emptyMessage="No units are linked to this property." caption="Units at this property" summaryLabel="unit" getFooterMetrics={(visibleRows) => [exactCentsMetric("Potential monthly market rent", summarizeExactCents(visibleRows.map((row) => row.unit.marketRentCents)))]} storageKey="rm-property-units" />;
}

function PropertyUnits({ units, identity, filters, onSelect, onEdit }: { units: AdminUnitView[]; identity: string; filters: ViewFilters; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><h3>Units</h3><span className="rm-muted">{units.length} total</span></div><UnitGrid units={units} identity={identity} filters={filters} onSelect={onSelect} onEdit={onEdit} /></section>;
}

function unresolvedTenancyLinkCount(snapshot: AdminSnapshot, propertyId?: string): number {
  if (!propertyId) return 0;
  return snapshot.snapshot.tenancies.filter((tenancy) => tenancy.propertyId === propertyId && tenancy.unitId && !knownLink(tenancy.unitId, tenancy.unitLinkKnowledge)).length;
}

function PropertyOccupancy({ snapshot, property, units, asOfDate, onSelect }: { snapshot: AdminSnapshot; property: AdminPropertyView; units: AdminUnitView[]; asOfDate: string; onSelect: (unitId: string) => void }) {
  return <PropertyOccupancyPanel key={property.id} snapshot={snapshot} units={units} asOfDate={asOfDate} onSelect={onSelect} unresolvedLinks={unresolvedTenancyLinkCount(snapshot, property.id)} />;
}

function PropertyRecord({ snapshot, asOfDate, filters, readOnly, property, activeTab, onTab, onSelect, onEdit, links }: { snapshot: AdminSnapshot; asOfDate: string; filters: ViewFilters; readOnly?: boolean; property: AdminPropertyView; activeTab: PropertyRecordTab; onTab: (tab: PropertyRecordTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction; links: PropertyLinks }) {
  const units = propertyUnits(snapshot, property.id);
  const allUnitsForProperty = snapshot.snapshot.units.filter((unit) => unit.propertyId === property.id);
  const unresolvedUnitCount = allUnitsForProperty.length - units.length;
  const tab = activeTab;
  return <div className="rm-property-unit-detail"><PropertySummary property={property} units={units} unresolvedUnitCount={unresolvedUnitCount} onEdit={onEdit} onAddUnit={() => onEdit("save-unit", addUnitValues(property))} /><RecordTabs tabs={PROPERTY_RECORD_TABS} labels={PROPERTY_RECORD_TAB_LABELS} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content" role="tabpanel" aria-label={PROPERTY_RECORD_TAB_LABELS[tab]}>
    {tab === "overview" && <><PropertyGeneral property={property} /><PropertyUnits units={units} identity={links.identity} filters={filters} onSelect={(id) => onSelect("unit", id)} onEdit={onEdit} /></>}
    {tab === "rent-roll" && <>{(units.length > 0 || availablePropertyTabs(snapshot, property).includes("occupancy")) && <PropertyOccupancy asOfDate={asOfDate} snapshot={snapshot} property={property} units={units} onSelect={(id) => onSelect("unit", id)} />}<PropertyRecurringPanel key={`property:${property.id}`} onEdit={onEdit} asOfDate={asOfDate} snapshot={snapshot} property={property} readOnly={readOnly} /></>}
    {tab === "financials" && property.id && <PropertyFinancials identity={links.identity} propertyId={property.id} asOfDate={asOfDate} organizationId={links.organizationId} onOpenProject={links.onOpenProject} onOpenReport={links.onOpenReport} />}
    {tab === "projects" && property.id && <PropertyProjectsTab identity={links.identity} propertyId={property.id} organizationId={links.organizationId} onOpenProject={links.onOpenProject} onNewProject={organizationId => links.onOpenProject(organizationId)} />}
    {tab === "work-orders" && property.id && <PropertyWorkOrdersTab identity={links.identity} propertyId={property.id} organizationId={links.organizationId} onOpenWorkOrder={links.onOpenWorkOrder} />}
    {tab === "documents" && property.id && <PropertyDocumentsTab identity={links.identity} propertyId={property.id} organizationId={links.organizationId} snapshot={snapshot} asOfDate={asOfDate} />}
  </div></div>;
}

function UnitSummary({ unit, property, propertyUnitCount, onSelect, onEdit }: { unit: AdminUnitView; property?: AdminPropertyView; propertyUnitCount: number; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const layout = unitLayoutLabel(unit);
  return <header className="rm-property-unit-summary rm-unit-summary" data-testid="unit-record" aria-labelledby="unit-record-title">
    <div className="rm-property-unit-summary-heading">
      <div className="rm-property-unit-identity">
        <div className="rm-property-unit-title-row"><h2 id="unit-record-title">Unit {propertyUnitFieldValue(unit.unitNumber)}</h2><UnitReadinessBadge unit={unit} />{optionalStatus(unit.listing, unit.listingKnowledge, true)}</div>
        <p className="rm-property-unit-context rm-unit-property-context">{property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{propertyUnitFieldValue(property.name)}</button> : <span>{PROPERTY_MISSING_LABEL}</span>}<span>{propertyUnitCount} {propertyUnitCount === 1 ? "unit" : "units"}</span></p>
        <dl className="rm-unit-summary-facts">
          {layout !== "—" && <div><dt>Layout</dt><dd>{layout}</dd></div>}
          {unit.squareFeet != null && <div><dt>Area</dt><dd>{unit.squareFeet.toLocaleString()} sq ft</dd></div>}
          {unit.unitType && <div><dt>Type</dt><dd>{unit.unitType}</dd></div>}
        </dl>
      </div>
      <div className="rm-property-unit-actions">{unit.id && <button type="button" className="rm-button" onClick={() => onEdit("save-unit", buildUnitEditValues(unit))}><Pencil aria-hidden="true" /> Edit unit</button>}{property?.id && <button type="button" className="rm-button rm-button-primary" onClick={() => onEdit("save-unit", addUnitValues(property))}><Plus aria-hidden="true" /> Add unit</button>}</div>
    </div>
  </header>;
}

function UnitGeneral({ unit, property, onSelect }: { unit: AdminUnitView; property?: AdminPropertyView; onSelect: (kind: "property" | "unit", id: string) => void }) {
  return <div className="rm-property-unit-groups rm-unit-general-groups">
    <FieldGroup title="Unit details"><Field label="Unit" value={unit.unitNumber} knowledge={unit.unitNumberKnowledge} required /><Field label="Type" value={unit.unitType} knowledge={unit.unitTypeKnowledge} /><Field label="Bedrooms" value={unit.bedrooms} /><Field label="Bathrooms" value={unit.bathrooms} /><Field label="Area" value={unit.squareFeet == null ? undefined : `${unit.squareFeet.toLocaleString()} sq ft`} /><Field label="Property" value={property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{propertyUnitFieldValue(property.name)}</button> : undefined} required />{!knownLink(unit.propertyId, unit.propertyLinkKnowledge) && <Field label="Property relationship" value={UNVERIFIED_LABEL} />}</FieldGroup>
    <FieldGroup title="Pricing and access"><Field label="Market rent" value={unit.marketRentCents == null ? undefined : money(unit.marketRentCents)} /><Field label="Default deposit" value={unit.defaultDepositCents == null ? undefined : money(unit.defaultDepositCents)} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup>
    <section className="rm-property-unit-group rm-unit-amenities" aria-labelledby="unit-amenities-title">
      <h3 id="unit-amenities-title">Amenities</h3>
      {unit.amenities?.length ? <ul>{unit.amenities.map((amenity, index) => <li key={`${amenity}-${index}`}>{amenity}</li>)}</ul> : <p className="rm-muted">No amenities recorded</p>}
    </section>
  </div>;
}

function UnitOccupancy({ snapshot, unit, asOfDate, onSelect }: { snapshot: AdminSnapshot; unit: AdminUnitView; asOfDate: string; onSelect: (unitId: string) => void }) {
  return <PropertyOccupancyPanel key={unit.id} snapshot={snapshot} units={[unit]} asOfDate={asOfDate} onSelect={onSelect} />;
}

function UnitMarketing({ unit }: { unit: AdminUnitView }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-groups"><FieldGroup title="Listing and readiness"><Field label="Readiness" value={<UnitReadinessBadge unit={unit} />} /><Field label="Listing" value={optionalStatus(unit.listing, unit.listingKnowledge)} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup></div></section>;
}

function UnitRecord({ snapshot, asOfDate, readOnly, unit, property, activeTab, onTab, onSelect, onEdit }: { snapshot: AdminSnapshot; asOfDate: string; readOnly?: boolean; unit: AdminUnitView; property?: AdminPropertyView; activeTab: PropertyUnitTab; onTab: (tab: PropertyUnitTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const units = propertyUnits(snapshot, property?.id);
  const tabs = availableUnitTabs(snapshot, unit);
  const tab = tabs.includes(activeTab) ? activeTab : "general";
  return <div className="rm-property-unit-detail"><UnitSummary unit={unit} property={property} propertyUnitCount={units.length} onSelect={onSelect} onEdit={onEdit} /><RecordTabs tabs={tabs} labels={TAB_LABELS} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content" role="tabpanel" aria-label={TAB_LABELS[tab]}>
    {tab === "general" && <UnitGeneral unit={unit} property={property} onSelect={onSelect} />}
    {tab === "occupancy" && <UnitOccupancy asOfDate={asOfDate} snapshot={snapshot} unit={unit} onSelect={(id) => onSelect("unit", id)} />}
    {tab === "recurring" && (property ? <PropertyRecurringPanel key={`unit:${unit.id}`} onEdit={onEdit} asOfDate={asOfDate} snapshot={snapshot} property={property} unit={unit} readOnly={readOnly} /> : <EmptyState message="The unit’s property link is missing, so recurring charges cannot be shown." />)}
    {tab === "marketing" && <UnitMarketing unit={unit} />}
  </div></div>;
}

export function PropertyUnitRecords(props: PropertyUnitRecordsProps) {
  return <UnitReadinessProvider filters={props.filters} readOnly={props.readOnly ?? false}><PropertyUnitRecordsContent {...props} /></UnitReadinessProvider>;
}

function PropertyUnitRecordsContent({ snapshot, readOnly, filters, selectedPropertyId, selectedUnitId, onSelect, onEdit, onAddPropertySetup, onSearchChange, identity, organizationId, onOpenProject, onOpenWorkOrder, onOpenReport }: PropertyUnitRecordsProps) {
  const links: PropertyLinks = { identity, organizationId, onOpenProject, onOpenWorkOrder, onOpenReport };
  const { occupancy } = useUnitReadiness();
  const [search, setSearch] = useState(filters.search ?? "");
  const [activeTab, setActiveTab] = useState<string>(()=>new URLSearchParams(window.location.search).get("propertyTab")??"overview");
  useEffect(() => { setSearch(filters.search ?? ""); }, [filters.search]);

  const listRows = useMemo(() => propertyUnitListItems(snapshot, filters, search, occupancy), [snapshot, filters.propertyId, filters.propertyIds, filters.propertyScope, search, occupancy]);
  const selected = useMemo(() => resolvePropertyUnitSelection(snapshot, filters, selectedPropertyId, selectedUnitId, search, occupancy), [snapshot, filters.propertyId, filters.propertyIds, filters.propertyScope, selectedPropertyId, selectedUnitId, search, occupancy]);
  const changeTab=(tab:string)=>{setActiveTab(tab);const params=new URLSearchParams(window.location.search);params.set("propertyTab",tab);window.history.replaceState(window.history.state,"",`${window.location.pathname}?${params}`);};

  return <div className="rm-record-layout rm-property-unit-records">
    <RecordList rows={listRows} selected={selected ? { kind: selected.kind, id: selected.kind === "unit" ? selected.unit?.id : selected.property?.id } : undefined} search={search} onSearch={next=>{setSearch(next);onSearchChange?.(next);}} onSelect={onSelect} onAddProperty={readOnly ? undefined : onAddPropertySetup ?? (() => onEdit("save-property"))} />
    <main className="rm-property-unit-main">
      {!selected && <section className="rm-panel"><EmptyState message="Select a property or unit record to continue." /></section>}
      {selected?.kind === "property" && selected.property && <PropertyRecord readOnly={readOnly} asOfDate={filters.asOfDate} filters={filters} snapshot={snapshot} property={selected.property} activeTab={canonicalPropertyTab(activeTab)} onTab={changeTab} onSelect={onSelect} onEdit={onEdit} links={links} />}
      {selected?.kind === "unit" && selected.unit && <UnitRecord readOnly={readOnly} asOfDate={filters.asOfDate} snapshot={snapshot} unit={selected.unit} property={selected.property} activeTab={activeTab as PropertyUnitTab} onTab={changeTab} onSelect={onSelect} onEdit={onEdit} />}
    </main>
  </div>;
}

export default PropertyUnitRecords;
