import { useRecurringChargeTerms } from './use-recurring-charge-terms';
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Home, Pencil, Plus, Search } from "lucide-react";

import {EntityLink,RecordLink} from "./entity-link";
import { DataGrid, type GridColumn } from "./grid";
import { formatDate, formatLabel, formatMoney } from "./display";
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
  occupancyHistoryForProperty,
  occupancyHistoryForUnit,
  propertyUnitListItems,
  propertyUnits,
  recurringSchedulesForProperty,
  propertyUnitRecurringDisplay,
  recurringRecordCreateValues,
  recurringRecordSuccessorValues,
  recurringSchedulesForUnit,
  resolvePropertyUnitSelection,
  type OccupancyHistoryRecord,
  type PropertyUnitListItem,
  type PropertyUnitTab,
  type UnitRecurringRecord,
} from "./property-unit-model";
import type { FormValues, QuickAction } from "../form-payload";
import type { AdminPropertyView, AdminSnapshot, AdminUnitView, ViewFilters } from "../types";
import "./property-unit-records.css";
import { UnitReadinessBadge, UnitReadinessProvider, useUnitReadiness } from "./unit-readiness";
import { unitReadinessDisplay } from "./unit-readiness-model";

export type EditAction = (action: QuickAction, values?: FormValues) => void;

export interface PropertyUnitRecordsProps {
  snapshot: AdminSnapshot;
  readOnly?: boolean;
  filters: ViewFilters;
  selectedPropertyId?: string;
  selectedUnitId?: string;
  onSelect: (kind: "property" | "unit", id: string) => void;
  onEdit: EditAction;
  onSearchChange?: (search:string)=>void;
}

const TAB_LABELS: Record<PropertyUnitTab, string> = {
  general: "General",
  units: "Units",
  occupancy: "Occupancy",
  recurring: "Recurring",
  marketing: "Marketing",
};

type GridRow = Record<string, unknown>;

function label(value: unknown): string {
  if (value == null || value === "") return "Needs review";
  return formatLabel(String(value));
}

function date(value: unknown): string {
  if (value == null || value === "") return "Needs review";
  return formatDate(String(value));
}

function money(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Needs review";
  return formatMoney(value);
}

function value(value: unknown, knowledge?: unknown): string {
  if (value == null || value === "") return "Needs review";
  if (["unknown", "ambiguous", "inferred"].includes(String(knowledge ?? ""))) return "Needs review";
  return String(value);
}

function statusValue(valueToShow: unknown, knowledge?: unknown): ReactNode {
  const textValue = value(valueToShow, knowledge);
  return <span className={`rm-status ${textValue === "Needs review" ? "unknown" : String(valueToShow ?? "unknown")}`}>{textValue === "Needs review" ? textValue : label(textValue)}</span>;
}

function recordedOptionalStatus(status: unknown, knowledge?: unknown): boolean {
  const raw = typeof status === "string" ? status.trim().toLowerCase() : "";
  return Boolean(raw) && !["unknown", "ambiguous", "inferred", "needs_review", "needs review"].includes(raw) && !propertyUnitFieldUnverified(knowledge);
}

function optionalStatus(status: unknown, knowledge?: unknown, omitUnknown = false): ReactNode {
  return recordedOptionalStatus(status, knowledge) ? statusValue(status, knowledge) : omitUnknown ? null : <span className="rm-muted">Not recorded</span>;
}

function EmptyState({ message }: { message: string }) {
  return <div className="rm-empty rm-property-unit-empty"><Home aria-hidden="true" /><p>{message}</p></div>;
}

function Field({ label: fieldLabel, value: fieldValue, knowledge, required = false }: { label: string; value: ReactNode; knowledge?: unknown; required?: boolean }) {
  const empty = fieldValue == null || fieldValue === "";
  const display = empty ? required ? "Needs review" : "—" : typeof fieldValue === "string" || typeof fieldValue === "number" ? propertyUnitFieldValue(fieldValue) : fieldValue;
  const unverified = !empty && propertyUnitFieldUnverified(knowledge);
  return <div className="rm-field"><dt>{fieldLabel}</dt><dd className={empty && !required ? "rm-property-unit-absent" : undefined}>{display}{unverified && <small className="rm-property-unit-unverified">Unverified</small>}</dd></div>;
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rm-property-unit-group"><h3>{title}</h3><dl>{children}</dl></section>;
}

function RecordTabs({ tabs, selected, onSelect }: { tabs: PropertyUnitTab[]; selected: PropertyUnitTab; onSelect: (tab: PropertyUnitTab) => void }) {
  return <nav className="rm-tabs rm-property-unit-tabs" aria-label="Record sections" role="tablist">
    {tabs.map((tab) => <button type="button" role="tab" aria-selected={selected === tab} className={selected === tab ? "active" : ""} key={tab} onClick={() => onSelect(tab)}>{TAB_LABELS[tab]}</button>)}
  </nav>;
}

function RecordList({ rows, selected, search, onSearch, onSelect }: { rows: PropertyUnitListItem[]; selected?: { kind: "property" | "unit"; id?: string }; search: string; onSearch: (next: string) => void; onSelect: (kind: "property" | "unit", id: string) => void }) {
  return <aside className="rm-record-list rm-property-unit-list" aria-label="Properties and units">
    <div className="rm-property-unit-list-heading"><div><h2>Properties &amp; units</h2></div><span className="rm-muted">{rows.length} shown</span></div>
    <label className="rm-property-unit-search"><Search aria-hidden="true" /><span className="sr-only">Search properties and units</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search name, address, or unit" /></label>
    <div className="rm-property-unit-list-items">
      {rows.map((row) => {
        const active = selected?.kind === row.kind && selected.id === row.id && Boolean(row.id);
        const className = `rm-property-unit-list-row ${row.kind} ${active ? "selected" : ""}`;
        return <button type="button" className={className} key={row.key} disabled={!row.id} onClick={() => { if (row.id) onSelect(row.kind, row.id); }}>
          <span className="rm-property-unit-list-icon" aria-hidden="true">{row.kind === "property" ? <Building2 /> : <Home />}</span>
          <span className="rm-property-unit-list-copy"><strong>{row.title}</strong><small>{row.kind === "property" ? "Property" : "Unit"} · {row.subtitle}</small></span>
        </button>;
      })}
      {!rows.length && <EmptyState message="No properties or units match this search." />}
    </div>
  </aside>;
}

function PropertySummary({ property, units, unresolvedUnitCount, onEdit, onAddUnit }: { property: AdminPropertyView; units: AdminUnitView[]; unresolvedUnitCount: number; onEdit: EditAction; onAddUnit: () => void }) {
  const address = addressLines(property.address);
  return <header className="rm-property-unit-summary" data-testid="property-record" aria-labelledby="property-record-title">
    <div className="rm-property-unit-summary-heading">
      <div className="rm-property-unit-identity"><div className="rm-property-unit-title-row"><h2 id="property-record-title">{propertyUnitFieldValue(property.name)}</h2>{statusValue(property.state, property.stateKnowledge)}</div>{address.length > 0 && <address className="rm-property-unit-address">{address.join(", ")}</address>}<p className="rm-property-unit-context"><span>{units.length} {units.length === 1 ? "unit" : "units"}</span>{property.propertyType && <span>{label(property.propertyType)}</span>}{unresolvedUnitCount > 0 && <span className="rm-property-unit-unverified">{unresolvedUnitCount} unit link{unresolvedUnitCount === 1 ? "" : "s"} need review</span>}</p></div>
      <div className="rm-property-unit-actions">{property.id && <button type="button" className="rm-button" onClick={() => onEdit("save-property", buildPropertyEditValues(property))}><Pencil aria-hidden="true" /> Edit property</button>}{property.id && <button type="button" className="rm-button rm-button-primary" onClick={onAddUnit}><Plus aria-hidden="true" /> Add unit</button>}</div>
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

function UnitGrid({ units, onSelect, onEdit }: { units: AdminUnitView[]; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  const { occupancy } = useUnitReadiness();
  const rows: UnitGridRow[] = units.map((unit, index) => ({ id: unit.id ?? `unit:${index}`, unit }));
  const columns: GridColumn<UnitGridRow>[] = [
    { key: "unitNumber", label: "Unit", render: (row) => <RecordLink kind="unit" recordId={row.unit.id} onOpen={onSelect}>{value(row.unit.unitNumber, row.unit.unitNumberKnowledge)}</RecordLink>, sortValue: (row) => row.unit.unitNumber ?? "" },
    { key: "unitType", label: "Type", render: (row) => propertyUnitFieldValue(row.unit.unitType), sortValue: (row) => row.unit.unitType ?? "" },
    { key: "layout", label: "Layout", render: (row) => unitLayoutLabel(row.unit), sortValue: (row) => `${row.unit.bedrooms ?? ""}-${row.unit.bathrooms ?? ""}` },
    { key: "squareFeet", label: "Area", render: (row) => row.unit.squareFeet == null ? "—" : `${row.unit.squareFeet.toLocaleString()} sq ft`, sortValue: (row) => row.unit.squareFeet },
    { key: "marketRent", label: "Market rent", align: "right", render: (row) => row.unit.marketRentCents == null ? "—" : money(row.unit.marketRentCents), sortValue: (row) => row.unit.marketRentCents },
    { key: "readiness", label: "Readiness", render: (row) => <UnitReadinessBadge unit={row.unit} />, sortValue: (row) => unitReadinessDisplay(row.unit, occupancy.get(row.unit.id ?? "")).label },
    { key: "listing", label: "Listing", render: (row) => statusValue(row.unit.listing, row.unit.listingKnowledge), sortValue: (row) => row.unit.listing ?? "" },
    { key: "action", label: "", render: (row) => row.unit.id ? <button type="button" className="rm-button rm-button-small" onClick={(event) => { event.stopPropagation(); onEdit("save-unit", buildUnitEditValues(row.unit)); }}>Edit</button> : null },
  ];
  if (!rows.length) return <EmptyState message="No units are linked to this property." />;
  return <DataGrid<UnitGridRow> rows={rows} columns={columns} getRowKey={(row) => row.id} emptyMessage="No units are linked to this property." caption="Units at this property" storageKey="rm-property-units" />;
}

function PropertyUnits({ units, onSelect, onEdit }: { units: AdminUnitView[]; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><h3>Units</h3><span className="rm-muted">{units.length} total</span></div><UnitGrid units={units} onSelect={onSelect} onEdit={onEdit} /></section>;
}

type OccupancyGridRow = GridRow & { id: string; record: OccupancyHistoryRecord };

function occupancyLeaseLabel(record: OccupancyHistoryRecord): string {
  if (!record.lease) return "Needs review";
  if (record.lease.monthToMonth === true) return "Month to month";
  const start = record.lease.contractStartOn ? date(record.lease.contractStartOn) : "Needs review";
  const end = record.lease.contractEndOn ? date(record.lease.contractEndOn) : "Needs review";
  return `${start} → ${end}`;
}

function OccupancyGrid({ rows, onSelect }: { rows: OccupancyHistoryRecord[]; onSelect: (unitId: string) => void }) {
  const gridRows: OccupancyGridRow[] = rows.map((record, index) => ({ id: record.key || `occupancy:${index}`, record }));
  const columns: GridColumn<OccupancyGridRow>[] = [
    { key: "unit", label: "Unit", render: (row) => <RecordLink kind="unit" recordId={row.record.unit.id} onOpen={onSelect}>{value(row.record.unit.unitNumber, row.record.unit.unitNumberKnowledge)}</RecordLink>, sortValue: (row) => row.record.unit.unitNumber ?? "" },
    { key: "status", label: "Occupancy", render: (row) => statusValue(row.record.occupancyStatus), sortValue: (row) => row.record.occupancyStatus },
    { key: "resident", label: "Resident", render: (row) => <EntityLink personId={row.record.occupantName&&knownLink(row.record.tenancy?.primaryPersonId,row.record.tenancy?.primaryPersonLinkKnowledge)?row.record.tenancy?.primaryPersonId:undefined}>{row.record.occupantName ?? "Needs review"}</EntityLink>, sortValue: (row) => row.record.occupantName ?? "" },
    { key: "moveIn", label: "Move in", render: (row) => date(row.record.tenancy?.actualMoveInOn ?? row.record.tenancy?.plannedMoveInOn), sortValue: (row) => row.record.tenancy?.actualMoveInOn ?? row.record.tenancy?.plannedMoveInOn ?? "" },
    { key: "lease", label: "Lease term", render: (row) => occupancyLeaseLabel(row.record) },
    { key: "leaseStatus", label: "Lease status", render: (row) => statusValue(row.record.lease?.status, row.record.lease?.statusKnowledge), sortValue: (row) => row.record.lease?.status ?? "" },
  ];
  return <DataGrid<OccupancyGridRow> rows={gridRows} columns={columns} getRowKey={(row) => row.id} emptyMessage="No linked tenancy or lease history is available." caption="Known occupancy history" storageKey="rm-property-occupancy" />;
}

function unresolvedTenancyLinkCount(snapshot: AdminSnapshot, propertyId?: string): number {
  if (!propertyId) return 0;
  return snapshot.snapshot.tenancies.filter((tenancy) => tenancy.propertyId === propertyId && tenancy.unitId && !knownLink(tenancy.unitId, tenancy.unitLinkKnowledge)).length;
}

function PropertyOccupancy({ snapshot, property, units, onSelect }: { snapshot: AdminSnapshot; property: AdminPropertyView; units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  const rows = occupancyHistoryForProperty(snapshot, property.id);
  const { occupancy } = useUnitReadiness();
  const summary = {
    current: units.filter(unit => occupancy.get(unit.id ?? "") === "current").length,
    future: units.filter(unit => occupancy.get(unit.id ?? "") === "future_preleased").length,
    unknown: units.filter(unit => !occupancy.get(unit.id ?? "") || occupancy.get(unit.id ?? "") === "unknown").length,
  };
  const unresolved = unresolvedTenancyLinkCount(snapshot, property.id);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><h3>Occupancy history</h3><p>{summary.current} current · {summary.future} future preleased{summary.unknown > 0 && ` · ${summary.unknown} need review`}</p></div></div>{unresolved > 0 && <p className="rm-warning">{unresolved} tenancy link{unresolved === 1 ? "" : "s"} has an unresolved unit relationship. Occupancy is shown only from known linked records.</p>}<OccupancyGrid rows={rows} onSelect={onSelect} /></section>;
}

type RecurringGridRow = GridRow & { id: string; record: UnitRecurringRecord; interval: ReturnType<typeof propertyUnitRecurringDisplay> };

function RecurringGrid({ rows, caption, storageKey, asOfDate, snapshot, onEdit }: { snapshot: AdminSnapshot; onEdit: EditAction; rows: UnitRecurringRecord[]; caption: string; storageKey: string; asOfDate: string }) {
  const chargeTerms = useRecurringChargeTerms(rows.map(row => row.schedule.id), asOfDate);
  const gridRows: RecurringGridRow[] = rows.map((record, index) => ({ id: record.key || `schedule:${index}`, record, interval: propertyUnitRecurringDisplay(record, asOfDate) }));
  const columns: GridColumn<RecurringGridRow>[] = [
    { key: "relationship", label: "Scope", render: (row) => row.record.relationshipLabel, sortValue: (row) => row.record.relationship },
    { key: "category", label: "Category", render: (row) => label(row.record.schedule.category), sortValue: (row) => row.record.schedule.category ?? "" },
    { key: "description", label: "Description", render: (row) => value(row.record.schedule.description, row.record.schedule.descriptionKnowledge), sortValue: (row) => row.record.schedule.description ?? "" },
    { key: "amount", label: "Amount", align: "right", render: (row) => <EntityLink personId={row.record.schedule.personId} tab="charges">{money(row.record.schedule.amountCents)}</EntityLink>, sortValue: (row) => row.record.schedule.amountCents },
    { key: "chargeStarts", label: "Charge starts", render: (row) => chargeTerms.label(row.record.schedule.id, "start", row.record.schedule.scopeType) },
    { key: "leaseThrough", label: "Lease through", render: (row) => chargeTerms.label(row.record.schedule.id, "through", row.record.schedule.scopeType) },
    { key: "scheduledEnd", label: "Scheduled end", render: (row) => row.interval.effectiveTo ? date(row.interval.effectiveTo) : "—" },
    { key: "status", label: "Status", render: (row) => statusValue(row.interval.state, row.interval.state === "unknown" ? "unknown" : undefined), sortValue: (row) => row.interval.state },
    { key: "actions", label: "Actions", render: (row) => {
      const values = recurringRecordSuccessorValues(snapshot, row.record.schedule);
      const impact = row.record.schedule.scopeType === "property" ? "Shared property charge" : row.record.schedule.scopeType === "unit" ? "Shared unit charge" : "Tenant charge";
      return <div><small>{impact}</small><div className="rm-actions"><button className="rm-button" disabled={!values} onClick={() => { if (values) onEdit("replace-recurring-schedule", values); }}>Schedule change</button><button className="rm-button" disabled={!values} onClick={() => { if (values) onEdit("end-recurring-schedule", values); }}>End</button></div></div>;
    } },
  ];
  if (!gridRows.length) return <EmptyState message="No linked recurring schedules are available." />;
  return <DataGrid<RecurringGridRow> rows={gridRows} columns={columns} getRowKey={(row) => row.id} emptyMessage="No linked recurring schedules are available." caption={caption} storageKey={storageKey} />;
}

function PropertyRecurring({ snapshot, onEdit, asOfDate, property }: { snapshot: AdminSnapshot; onEdit: EditAction; asOfDate: string; property: AdminPropertyView }) {
  const rows = recurringSchedulesForProperty(snapshot, property.id);
  const createValues = recurringRecordCreateValues(snapshot, property.id);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><h3>Recurring schedules</h3><button className="rm-button rm-button-primary" disabled={!createValues} onClick={() => { if (createValues) onEdit("save-recurring-schedule", createValues); }}><Plus aria-hidden="true" /> Add recurring charge</button></div><RecurringGrid snapshot={snapshot} onEdit={onEdit} asOfDate={asOfDate} rows={rows} caption="Recurring schedules at this property" storageKey="rm-property-recurring" /></section>;
}

type MarketingGridRow = GridRow & { id: string; unit: AdminUnitView };

function MarketingGrid({ units, onSelect }: { units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  const { occupancy } = useUnitReadiness();
  const rows: MarketingGridRow[] = units.map((unit, index) => ({ id: unit.id ?? `marketing:${index}`, unit }));
  const columns: GridColumn<MarketingGridRow>[] = [
    { key: "unit", label: "Unit", render: (row) => <RecordLink kind="unit" recordId={row.unit.id} onOpen={onSelect}>{value(row.unit.unitNumber, row.unit.unitNumberKnowledge)}</RecordLink>, sortValue: (row) => row.unit.unitNumber ?? "" },
    { key: "readiness", label: "Readiness", render: (row) => <UnitReadinessBadge unit={row.unit} />, sortValue: (row) => unitReadinessDisplay(row.unit, occupancy.get(row.unit.id ?? "")).label },
    { key: "listing", label: "Listing", render: (row) => optionalStatus(row.unit.listing, row.unit.listingKnowledge), sortValue: (row) => row.unit.listing ?? "" },
    { key: "access", label: "Access notes", render: (row) => propertyUnitFieldValue(row.unit.accessNotes), sortValue: (row) => row.unit.accessNotes ?? "" },
  ];
  return <DataGrid<MarketingGridRow> rows={rows} columns={columns} getRowKey={(row) => row.id} emptyMessage="No unit marketing fields are available." caption="Unit readiness and listing" storageKey="rm-property-marketing" />;
}

function marketingCounts(units: AdminUnitView[], occupancy: Map<string, string>): string {
  const occupied = units.filter(unit => occupancy.get(unit.id ?? "") === "current").length;
  const allUnits = units;
  const pending = units.filter(unit => !occupancy.has(unit.id ?? "")).length;
  units = units.filter(unit => occupancy.has(unit.id ?? "") && occupancy.get(unit.id ?? "") !== "current");
  const count = (key: "readiness" | "listing", target: string) => (key === "listing" ? allUnits : units).filter((unit) => unit[key] === target && recordedOptionalStatus(unit[key], unit[key === "readiness" ? "readinessKnowledge" : "listingKnowledge"])).length;
  const readinessKnown = units.filter((unit) => recordedOptionalStatus(unit.readiness, unit.readinessKnowledge)).length;
  const listingKnown = allUnits.filter((unit) => recordedOptionalStatus(unit.listing, unit.listingKnowledge)).length;
  return [pending ? `${pending} occupancy pending` : undefined, `${occupied} occupied`, `${count("readiness", "ready")} ready`, `${count("readiness", "not_ready")} not ready`, `${count("readiness", "off_market")} off market`, units.length > readinessKnown ? `${units.length - readinessKnown} readiness not recorded` : undefined, `${count("listing", "listed")} listed`, `${count("listing", "unlisted")} unlisted`, allUnits.length > listingKnown ? `${allUnits.length - listingKnown} listing not recorded` : undefined].filter(Boolean).join(" · ");
}

function PropertyMarketing({ units, onSelect }: { units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  const { occupancy } = useUnitReadiness();
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><h3>Marketing readiness</h3><p>{marketingCounts(units, occupancy)}</p></div></div><MarketingGrid units={units} onSelect={onSelect} /></section>;
}

function PropertyRecord({ snapshot, asOfDate, property, activeTab, onTab, onSelect, onEdit }: { snapshot: AdminSnapshot; asOfDate: string; property: AdminPropertyView; activeTab: PropertyUnitTab; onTab: (tab: PropertyUnitTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const units = propertyUnits(snapshot, property.id);
  const allUnitsForProperty = snapshot.snapshot.units.filter((unit) => unit.propertyId === property.id);
  const unresolvedUnitCount = allUnitsForProperty.length - units.length;
  const tabs = availablePropertyTabs(snapshot, property);
  const tab = tabs.includes(activeTab) ? activeTab : "general";
  return <div className="rm-property-unit-detail"><PropertySummary property={property} units={units} unresolvedUnitCount={unresolvedUnitCount} onEdit={onEdit} onAddUnit={() => onEdit("save-unit", addUnitValues(property))} /><RecordTabs tabs={tabs} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content">
    {tab === "general" && <PropertyGeneral property={property} />}
    {tab === "units" && <PropertyUnits units={units} onSelect={(id) => onSelect("unit", id)} onEdit={onEdit} />}
    {tab === "occupancy" && <PropertyOccupancy snapshot={snapshot} property={property} units={units} onSelect={(id) => onSelect("unit", id)} />}
    {tab === "recurring" && <PropertyRecurring onEdit={onEdit} asOfDate={asOfDate} snapshot={snapshot} property={property} />}
    {tab === "marketing" && <PropertyMarketing units={units} onSelect={(id) => onSelect("unit", id)} />}
  </div></div>;
}

function UnitSummary({ unit, property, propertyUnitCount, onSelect, onEdit }: { unit: AdminUnitView; property?: AdminPropertyView; propertyUnitCount: number; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const layout = unitLayoutLabel(unit);
  return <header className="rm-property-unit-summary" data-testid="unit-record" aria-labelledby="unit-record-title">
    <div className="rm-property-unit-summary-heading"><div className="rm-property-unit-identity"><div className="rm-property-unit-title-row"><h2 id="unit-record-title">Unit {propertyUnitFieldValue(unit.unitNumber)}</h2>{<UnitReadinessBadge unit={unit} />}{optionalStatus(unit.listing, unit.listingKnowledge, true)}</div><p className="rm-property-unit-context">{property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{propertyUnitFieldValue(property.name)}</button> : <span>Property needs review</span>}<span>{propertyUnitCount} {propertyUnitCount === 1 ? "unit" : "units"}</span></p><p className="rm-property-unit-context">{layout !== "—" && <span>{layout}</span>}{unit.squareFeet != null && <span>{unit.squareFeet.toLocaleString()} sq ft</span>}{unit.unitType && <span>{unit.unitType}</span>}</p></div><div className="rm-property-unit-actions">{unit.id && <button type="button" className="rm-button" onClick={() => onEdit("save-unit", buildUnitEditValues(unit))}><Pencil aria-hidden="true" /> Edit unit</button>}{property?.id && <button type="button" className="rm-button rm-button-primary" onClick={() => onEdit("save-unit", addUnitValues(property))}><Plus aria-hidden="true" /> Add unit</button>}</div></div>
  </header>;
}

function UnitGeneral({ unit, property, onSelect }: { unit: AdminUnitView; property?: AdminPropertyView; onSelect: (kind: "property" | "unit", id: string) => void }) {
  return <div className="rm-property-unit-groups">
    <FieldGroup title="Unit details"><Field label="Unit" value={unit.unitNumber} knowledge={unit.unitNumberKnowledge} required /><Field label="Type" value={unit.unitType} knowledge={unit.unitTypeKnowledge} /><Field label="Bedrooms" value={unit.bedrooms} /><Field label="Bathrooms" value={unit.bathrooms} /><Field label="Area" value={unit.squareFeet == null ? undefined : `${unit.squareFeet.toLocaleString()} sq ft`} /><Field label="Property" value={property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{propertyUnitFieldValue(property.name)}</button> : undefined} required />{!knownLink(unit.propertyId, unit.propertyLinkKnowledge) && <Field label="Property relationship" value="Needs review" />}</FieldGroup>
    <FieldGroup title="Pricing and access"><Field label="Market rent" value={unit.marketRentCents == null ? undefined : money(unit.marketRentCents)} /><Field label="Default deposit" value={unit.defaultDepositCents == null ? undefined : money(unit.defaultDepositCents)} /><Field label="Amenities" value={unit.amenities?.length ? unit.amenities.join(", ") : undefined} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup>
  </div>;
}

function UnitOccupancy({ snapshot, unit, onSelect }: { snapshot: AdminSnapshot; unit: AdminUnitView; onSelect: (unitId: string) => void }) {
  const rows = occupancyHistoryForUnit(snapshot, unit);
  const hasKnownTenancy = rows.some((row) => row.tenancy);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><h3>Occupancy history</h3><p>{hasKnownTenancy ? "Linked tenancy and lease history" : "No known linked tenancy or lease history"}</p></div></div>{!hasKnownTenancy && <p className="rm-warning">No linked tenancy was found for this unit. Vacancy is not inferred from the absence of a tenancy or from market rent.</p>}<OccupancyGrid rows={rows} onSelect={onSelect} /></section>;
}

function UnitRecurring({ snapshot, onEdit, asOfDate, unit }: { snapshot: AdminSnapshot; onEdit: EditAction; asOfDate: string; unit: AdminUnitView }) {
  const rows = recurringSchedulesForUnit(snapshot, unit);
  const createValues = recurringRecordCreateValues(snapshot, unit.propertyId, unit);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><h3>Recurring schedules</h3><button className="rm-button rm-button-primary" disabled={!createValues} onClick={() => { if (createValues) onEdit("save-recurring-schedule", createValues); }}><Plus aria-hidden="true" /> Add recurring charge</button></div><RecurringGrid snapshot={snapshot} onEdit={onEdit} asOfDate={asOfDate} rows={rows} caption="Recurring schedules for this unit" storageKey="rm-unit-recurring" /></section>;
}

function UnitMarketing({ unit }: { unit: AdminUnitView }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-groups"><FieldGroup title="Listing and readiness"><Field label="Readiness" value={<UnitReadinessBadge unit={unit} />} /><Field label="Listing" value={optionalStatus(unit.listing, unit.listingKnowledge)} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup></div></section>;
}

function UnitRecord({ snapshot, asOfDate, unit, property, activeTab, onTab, onSelect, onEdit }: { snapshot: AdminSnapshot; asOfDate: string; unit: AdminUnitView; property?: AdminPropertyView; activeTab: PropertyUnitTab; onTab: (tab: PropertyUnitTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const units = propertyUnits(snapshot, property?.id);
  const tabs = availableUnitTabs(snapshot, unit);
  const tab = tabs.includes(activeTab) ? activeTab : "general";
  return <div className="rm-property-unit-detail"><UnitSummary unit={unit} property={property} propertyUnitCount={units.length} onSelect={onSelect} onEdit={onEdit} /><RecordTabs tabs={tabs} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content">
    {tab === "general" && <UnitGeneral unit={unit} property={property} onSelect={onSelect} />}
    {tab === "occupancy" && <UnitOccupancy snapshot={snapshot} unit={unit} onSelect={(id) => onSelect("unit", id)} />}
    {tab === "recurring" && <UnitRecurring onEdit={onEdit} asOfDate={asOfDate} snapshot={snapshot} unit={unit} />}
    {tab === "marketing" && <UnitMarketing unit={unit} />}
  </div></div>;
}

export function PropertyUnitRecords(props: PropertyUnitRecordsProps) {
  return <UnitReadinessProvider filters={props.filters} readOnly={props.readOnly ?? false}><PropertyUnitRecordsContent {...props} /></UnitReadinessProvider>;
}

function PropertyUnitRecordsContent({ snapshot, filters, selectedPropertyId, selectedUnitId, onSelect, onEdit, onSearchChange }: PropertyUnitRecordsProps) {
  const { occupancy } = useUnitReadiness();
  const [search, setSearch] = useState(filters.search ?? "");
  const [activeTab, setActiveTab] = useState<PropertyUnitTab>(()=>(new URLSearchParams(window.location.search).get("propertyTab")??"general") as PropertyUnitTab);
  useEffect(() => { setSearch(filters.search ?? ""); }, [filters.search]);

  const listRows = useMemo(() => propertyUnitListItems(snapshot, filters, search, occupancy), [snapshot, filters.propertyId, filters.propertyIds, filters.propertyScope, search, occupancy]);
  const selected = useMemo(() => resolvePropertyUnitSelection(snapshot, filters, selectedPropertyId, selectedUnitId, search, occupancy), [snapshot, filters.propertyId, filters.propertyIds, filters.propertyScope, selectedPropertyId, selectedUnitId, search, occupancy]);
  const changeTab=(tab:PropertyUnitTab)=>{setActiveTab(tab);const params=new URLSearchParams(window.location.search);params.set("propertyTab",tab);window.history.replaceState(window.history.state,"",`${window.location.pathname}?${params}`);};

  return <div className="rm-record-layout rm-property-unit-records">
    <RecordList rows={listRows} selected={selected ? { kind: selected.kind, id: selected.kind === "unit" ? selected.unit?.id : selected.property?.id } : undefined} search={search} onSearch={next=>{setSearch(next);onSearchChange?.(next);}} onSelect={onSelect} />
    <main className="rm-property-unit-main">
      {!selected && <section className="rm-panel"><EmptyState message="Select a property or unit record to continue." /></section>}
      {selected?.kind === "property" && selected.property && <PropertyRecord asOfDate={filters.asOfDate} snapshot={snapshot} property={selected.property} activeTab={activeTab} onTab={changeTab} onSelect={onSelect} onEdit={onEdit} />}
      {selected?.kind === "unit" && selected.unit && <UnitRecord asOfDate={filters.asOfDate} snapshot={snapshot} unit={selected.unit} property={selected.property} activeTab={activeTab} onTab={changeTab} onSelect={onSelect} onEdit={onEdit} />}
    </main>
  </div>;
}

export default PropertyUnitRecords;
