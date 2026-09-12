import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Home, Pencil, Plus, Search } from "lucide-react";

import { DataGrid, type GridColumn } from "./grid";
import { formatDate, formatLabel, formatMoney } from "./display";
import {
  addUnitValues,
  addressLines,
  availablePropertyTabs,
  availableUnitTabs,
  buildPropertyEditValues,
  buildUnitEditValues,
  formatAddress,
  knownLink,
  occupancyHistoryForProperty,
  occupancyHistoryForUnit,
  occupancySummaryForUnits,
  propertyUnitListItems,
  propertyUnits,
  recurringSchedulesForProperty,
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

export type EditAction = (action: QuickAction, values?: FormValues) => void;

export interface PropertyUnitRecordsProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  selectedPropertyId?: string;
  selectedUnitId?: string;
  onSelect: (kind: "property" | "unit", id: string) => void;
  onEdit: EditAction;
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

function EmptyState({ message }: { message: string }) {
  return <div className="rm-empty rm-property-unit-empty"><Home aria-hidden="true" /><p>{message}</p></div>;
}

function Field({ label: fieldLabel, value: fieldValue, knowledge }: { label: string; value: ReactNode; knowledge?: unknown }) {
  const display = fieldValue == null ? "Needs review" : typeof fieldValue === "string" ? value(fieldValue, knowledge) : fieldValue;
  return <div className="rm-field"><dt>{fieldLabel}</dt><dd>{display}</dd></div>;
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
    <div className="rm-property-unit-list-heading"><div><span className="rm-eyebrow">Records</span><h2>Properties &amp; units</h2></div><span className="rm-muted">{rows.length} shown</span></div>
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

function SummaryStat({ label: statLabel, value: statValue }: { label: string; value: ReactNode }) {
  return <div className="rm-stat"><span>{statLabel}</span><strong>{statValue}</strong></div>;
}

function PropertySummary({ property, units, unresolvedUnitCount, onEdit, onAddUnit }: { property: AdminPropertyView; units: AdminUnitView[]; unresolvedUnitCount: number; onEdit: EditAction; onAddUnit: () => void }) {
  const address = addressLines(property.address);
  return <section className="rm-record-summary rm-property-unit-summary" data-testid="property-record" aria-labelledby="property-record-title">
    <div className="rm-property-unit-summary-heading">
      <div><span className="rm-eyebrow">Property record</span><div className="rm-property-unit-title-row"><h2 id="property-record-title">{value(property.name, property.nameKnowledge)}</h2>{statusValue(property.state, property.stateKnowledge)}</div><address className="rm-property-unit-address">{address.map((line, index) => <span key={`${line}:${index}`}>{line}</span>)}</address></div>
      <div className="rm-actions rm-property-unit-actions"><span className="rm-property-unit-count">{units.length} {units.length === 1 ? "unit" : "units"}{unresolvedUnitCount ? ` · ${unresolvedUnitCount} needs review` : ""}</span>{property.id && <button type="button" className="rm-button rm-button-primary" onClick={onAddUnit}><Plus aria-hidden="true" /> Add unit</button>}{property.id && <button type="button" className="rm-button" onClick={() => onEdit("save-property", buildPropertyEditValues(property))}><Pencil aria-hidden="true" /> Edit property</button>}</div>
    </div>
    <div className="rm-dashboard-grid rm-property-unit-summary-stats"><SummaryStat label="Type" value={label(property.propertyType)} /><SummaryStat label="Operating contact" value={value(property.operatingContact, property.operatingContactKnowledge)} /><SummaryStat label="Address" value={formatAddress(property.address)} /></div>
  </section>;
}

function PropertyGeneral({ property, onEdit }: { property: AdminPropertyView; onEdit: EditAction }) {
  const address = property.address;
  return <div className="rm-property-unit-groups">
    <FieldGroup title="Property details"><Field label="Property name" value={property.name} knowledge={property.nameKnowledge} /><Field label="Property type" value={label(property.propertyType)} knowledge={property.propertyTypeKnowledge} /><Field label="Status" value={statusValue(property.state, property.stateKnowledge)} /><Field label="Operating contact" value={property.operatingContact} knowledge={property.operatingContactKnowledge} /></FieldGroup>
    <FieldGroup title="Address"><Field label="Street address" value={address?.line1} knowledge={property.addressKnowledge} /><Field label="Address line 2" value={address?.line2} knowledge={property.addressKnowledge} /><Field label="City" value={address?.city} knowledge={property.addressKnowledge} /><Field label="State" value={address?.state} knowledge={property.addressKnowledge} /><Field label="Postal code" value={address?.postalCode} knowledge={property.addressKnowledge} /></FieldGroup>
    {address?.line2 && <p className="rm-property-unit-follow-up">Address line 2 is displayed from the record. The existing property form does not expose a separate line 2 field.</p>}
    {property.id && <div className="rm-property-unit-section-actions"><button type="button" className="rm-button" onClick={() => onEdit("save-property", buildPropertyEditValues(property))}><Pencil aria-hidden="true" /> Edit property</button></div>}
  </div>;
}

type UnitGridRow = GridRow & { id: string; unit: AdminUnitView };

function UnitGrid({ units, onSelect, onEdit }: { units: AdminUnitView[]; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  const rows: UnitGridRow[] = units.map((unit, index) => ({ id: unit.id ?? `unit:${index}`, unit }));
  const columns: GridColumn<UnitGridRow>[] = [
    { key: "unitNumber", label: "Unit", render: (row) => value(row.unit.unitNumber, row.unit.unitNumberKnowledge), sortValue: (row) => row.unit.unitNumber ?? "" },
    { key: "unitType", label: "Type", render: (row) => value(row.unit.unitType, row.unit.unitTypeKnowledge), sortValue: (row) => row.unit.unitType ?? "" },
    { key: "layout", label: "Layout", render: (row) => `${row.unit.bedrooms == null ? "Needs review" : row.unit.bedrooms} bd · ${row.unit.bathrooms == null ? "Needs review" : row.unit.bathrooms} ba`, sortValue: (row) => `${row.unit.bedrooms ?? ""}-${row.unit.bathrooms ?? ""}` },
    { key: "squareFeet", label: "Area", render: (row) => row.unit.squareFeet == null ? "Needs review" : `${row.unit.squareFeet.toLocaleString()} sq ft`, sortValue: (row) => row.unit.squareFeet },
    { key: "marketRent", label: "Market rent", align: "right", render: (row) => money(row.unit.marketRentCents), sortValue: (row) => row.unit.marketRentCents },
    { key: "readiness", label: "Readiness", render: (row) => statusValue(row.unit.readiness, row.unit.readinessKnowledge), sortValue: (row) => row.unit.readiness ?? "" },
    { key: "listing", label: "Listing", render: (row) => statusValue(row.unit.listing, row.unit.listingKnowledge), sortValue: (row) => row.unit.listing ?? "" },
    { key: "action", label: "", render: (row) => row.unit.id ? <button type="button" className="rm-button rm-button-small" onClick={(event) => { event.stopPropagation(); onEdit("save-unit", buildUnitEditValues(row.unit)); }}>Edit</button> : null },
  ];
  if (!rows.length) return <EmptyState message="No units are linked to this property." />;
  return <DataGrid<UnitGridRow> rows={rows} columns={columns} getRowKey={(row) => row.id} onRow={(row) => { if (row.unit.id) onSelect(row.unit.id); }} emptyMessage="No units are linked to this property." caption="Units at this property" storageKey="rm-property-units" />;
}

function PropertyUnits({ property, units, onSelect, onEdit }: { property: AdminPropertyView; units: AdminUnitView[]; onSelect: (unitId: string) => void; onEdit: EditAction }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Inventory</span><h3>Units at this property</h3><p>Unit fields remain separate from occupancy and recurring billing facts.</p></div>{property.id && <button type="button" className="rm-button rm-button-primary" onClick={() => onEdit("save-unit", addUnitValues(property))}><Plus aria-hidden="true" /> Add unit</button>}</div><UnitGrid units={units} onSelect={onSelect} onEdit={onEdit} /></section>;
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
    { key: "unit", label: "Unit", render: (row) => value(row.record.unit.unitNumber, row.record.unit.unitNumberKnowledge), sortValue: (row) => row.record.unit.unitNumber ?? "" },
    { key: "status", label: "Occupancy", render: (row) => statusValue(row.record.occupancyStatus), sortValue: (row) => row.record.occupancyStatus },
    { key: "resident", label: "Resident", render: (row) => row.record.occupantName ?? "Needs review", sortValue: (row) => row.record.occupantName ?? "" },
    { key: "moveIn", label: "Move in", render: (row) => date(row.record.tenancy?.actualMoveInOn ?? row.record.tenancy?.plannedMoveInOn), sortValue: (row) => row.record.tenancy?.actualMoveInOn ?? row.record.tenancy?.plannedMoveInOn ?? "" },
    { key: "lease", label: "Lease term", render: (row) => occupancyLeaseLabel(row.record) },
    { key: "leaseStatus", label: "Lease status", render: (row) => statusValue(row.record.lease?.status, row.record.lease?.statusKnowledge), sortValue: (row) => row.record.lease?.status ?? "" },
  ];
  return <DataGrid<OccupancyGridRow> rows={gridRows} columns={columns} getRowKey={(row) => row.id} onRow={(row) => { if (row.record.unit.id) onSelect(row.record.unit.id); }} emptyMessage="No linked tenancy or lease history is available." caption="Known occupancy history" storageKey="rm-property-occupancy" />;
}

function unresolvedTenancyLinkCount(snapshot: AdminSnapshot, propertyId?: string): number {
  if (!propertyId) return 0;
  return snapshot.snapshot.tenancies.filter((tenancy) => tenancy.propertyId === propertyId && tenancy.unitId && !knownLink(tenancy.unitId, tenancy.unitLinkKnowledge)).length;
}

function PropertyOccupancy({ snapshot, property, units, onSelect }: { snapshot: AdminSnapshot; property: AdminPropertyView; units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  const rows = occupancyHistoryForProperty(snapshot, property.id);
  const summary = occupancySummaryForUnits(snapshot, units);
  const unresolved = unresolvedTenancyLinkCount(snapshot, property.id);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Known links</span><h3>Occupancy history</h3><p>{summary.current} current · {summary.future} future preleased · {summary.unknown} needs review</p></div></div>{unresolved > 0 && <p className="rm-warning">{unresolved} tenancy link{unresolved === 1 ? "" : "s"} has an unresolved unit relationship. Occupancy is shown only from known linked records.</p>}<OccupancyGrid rows={rows} onSelect={onSelect} /></section>;
}

type RecurringGridRow = GridRow & { id: string; record: UnitRecurringRecord };

function recurringStatus(active: boolean | null | undefined, knowledge?: unknown): ReactNode {
  if (active == null || ["unknown", "ambiguous", "inferred"].includes(String(knowledge ?? ""))) return <span className="rm-status unknown">Needs review</span>;
  return <span className={`rm-status ${active ? "active" : "inactive"}`}>{active ? "Active" : "Inactive"}</span>;
}

function RecurringGrid({ rows, caption, storageKey }: { rows: UnitRecurringRecord[]; caption: string; storageKey: string }) {
  const gridRows: RecurringGridRow[] = rows.map((record, index) => ({ id: record.key || `schedule:${index}`, record }));
  const columns: GridColumn<RecurringGridRow>[] = [
    { key: "relationship", label: "Scope", render: (row) => row.record.relationshipLabel, sortValue: (row) => row.record.relationship },
    { key: "category", label: "Category", render: (row) => label(row.record.schedule.category), sortValue: (row) => row.record.schedule.category ?? "" },
    { key: "description", label: "Description", render: (row) => value(row.record.schedule.description, row.record.schedule.descriptionKnowledge), sortValue: (row) => row.record.schedule.description ?? "" },
    { key: "amount", label: "Amount", align: "right", render: (row) => money(row.record.schedule.amountCents), sortValue: (row) => row.record.schedule.amountCents },
    { key: "effectiveFrom", label: "Effective", render: (row) => date(row.record.schedule.effectiveFrom), sortValue: (row) => row.record.schedule.effectiveFrom ?? "" },
    { key: "effectiveTo", label: "Through", render: (row) => date(row.record.schedule.effectiveTo), sortValue: (row) => row.record.schedule.effectiveTo ?? "" },
    { key: "status", label: "Status", render: (row) => recurringStatus(row.record.schedule.active, row.record.schedule.activeKnowledge), sortValue: (row) => row.record.schedule.active == null ? -1 : row.record.schedule.active ? 1 : 0 },
  ];
  if (!gridRows.length) return <EmptyState message="No linked recurring schedules are available." />;
  return <DataGrid<RecurringGridRow> rows={gridRows} columns={columns} getRowKey={(row) => row.id} emptyMessage="No linked recurring schedules are available." caption={caption} storageKey={storageKey} />;
}

function PropertyRecurring({ snapshot, property }: { snapshot: AdminSnapshot; property: AdminPropertyView }) {
  const rows = recurringSchedulesForProperty(snapshot, property.id);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Billing links</span><h3>Recurring schedules</h3><p>Property, unit, and tenant-linked schedules stay labeled by scope.</p></div></div><RecurringGrid rows={rows} caption="Recurring schedules at this property" storageKey="rm-property-recurring" /></section>;
}

type MarketingGridRow = GridRow & { id: string; unit: AdminUnitView };

function MarketingGrid({ units, onSelect }: { units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  const rows: MarketingGridRow[] = units.map((unit, index) => ({ id: unit.id ?? `marketing:${index}`, unit }));
  const columns: GridColumn<MarketingGridRow>[] = [
    { key: "unit", label: "Unit", render: (row) => value(row.unit.unitNumber, row.unit.unitNumberKnowledge), sortValue: (row) => row.unit.unitNumber ?? "" },
    { key: "readiness", label: "Readiness", render: (row) => statusValue(row.unit.readiness, row.unit.readinessKnowledge), sortValue: (row) => row.unit.readiness ?? "" },
    { key: "listing", label: "Listing", render: (row) => statusValue(row.unit.listing, row.unit.listingKnowledge), sortValue: (row) => row.unit.listing ?? "" },
    { key: "access", label: "Access notes", render: (row) => value(row.unit.accessNotes), sortValue: (row) => row.unit.accessNotes ?? "" },
  ];
  return <DataGrid<MarketingGridRow> rows={rows} columns={columns} getRowKey={(row) => row.id} onRow={(row) => { if (row.unit.id) onSelect(row.unit.id); }} emptyMessage="No unit marketing fields are available." caption="Unit readiness and listing" storageKey="rm-property-marketing" />;
}

function marketingCounts(units: AdminUnitView[]): string {
  const count = (key: "readiness" | "listing", target: string) => units.filter((unit) => unit[key] === target).length;
  const readinessKnown = units.filter((unit) => unit.readiness !== undefined && unit.readiness !== null).length;
  const listingKnown = units.filter((unit) => unit.listing !== undefined && unit.listing !== null).length;
  return `${count("readiness", "ready")} ready · ${count("readiness", "not_ready")} not ready · ${count("readiness", "off_market")} off market · ${units.length - readinessKnown} readiness needs review · ${count("listing", "listed")} listed · ${count("listing", "unlisted")} unlisted · ${units.length - listingKnown} listing needs review`;
}

function PropertyMarketing({ units, onSelect }: { units: AdminUnitView[]; onSelect: (unitId: string) => void }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Availability facts</span><h3>Marketing readiness</h3><p>{marketingCounts(units)}</p></div></div><MarketingGrid units={units} onSelect={onSelect} /></section>;
}

function PropertyRecord({ snapshot, property, activeTab, onTab, onSelect, onEdit }: { snapshot: AdminSnapshot; property: AdminPropertyView; activeTab: PropertyUnitTab; onTab: (tab: PropertyUnitTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const units = propertyUnits(snapshot, property.id);
  const allUnitsForProperty = snapshot.snapshot.units.filter((unit) => unit.propertyId === property.id);
  const unresolvedUnitCount = allUnitsForProperty.length - units.length;
  const tabs = availablePropertyTabs(snapshot, property);
  const tab = tabs.includes(activeTab) ? activeTab : "general";
  return <div className="rm-record-detail rm-property-unit-detail"><PropertySummary property={property} units={units} unresolvedUnitCount={unresolvedUnitCount} onEdit={onEdit} onAddUnit={() => onEdit("save-unit", addUnitValues(property))} /><RecordTabs tabs={tabs} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content">
    {tab === "general" && <PropertyGeneral property={property} onEdit={onEdit} />}
    {tab === "units" && <PropertyUnits property={property} units={units} onSelect={(id) => onSelect("unit", id)} onEdit={onEdit} />}
    {tab === "occupancy" && <PropertyOccupancy snapshot={snapshot} property={property} units={units} onSelect={(id) => onSelect("unit", id)} />}
    {tab === "recurring" && <PropertyRecurring snapshot={snapshot} property={property} />}
    {tab === "marketing" && <PropertyMarketing units={units} onSelect={(id) => onSelect("unit", id)} />}
  </div></div>;
}

function UnitSummary({ unit, property, propertyUnitCount, onSelect, onEdit }: { unit: AdminUnitView; property?: AdminPropertyView; propertyUnitCount: number; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  return <section className="rm-record-summary rm-property-unit-summary" data-testid="unit-record" aria-labelledby="unit-record-title">
    <div className="rm-property-unit-summary-heading"><div><span className="rm-eyebrow">Unit record</span><div className="rm-property-unit-title-row"><h2 id="unit-record-title">{value(unit.unitNumber, unit.unitNumberKnowledge)}</h2>{statusValue(unit.readiness, unit.readinessKnowledge)}{statusValue(unit.listing, unit.listingKnowledge)}</div><p className="rm-property-unit-context">{property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{value(property.name, property.nameKnowledge)}</button> : "Property needs review"} · {propertyUnitCount} {propertyUnitCount === 1 ? "unit" : "units"}</p></div><div className="rm-actions rm-property-unit-actions">{unit.id && <button type="button" className="rm-button rm-button-primary" onClick={() => onEdit("save-unit", buildUnitEditValues(unit))}><Pencil aria-hidden="true" /> Edit unit</button>}{property?.id && <button type="button" className="rm-button" onClick={() => onEdit("save-unit", addUnitValues(property))}><Plus aria-hidden="true" /> Add unit</button>}</div></div>
    <div className="rm-dashboard-grid rm-property-unit-summary-stats"><SummaryStat label="Unit type" value={value(unit.unitType, unit.unitTypeKnowledge)} /><SummaryStat label="Market rent" value={money(unit.marketRentCents)} /><SummaryStat label="Default deposit" value={money(unit.defaultDepositCents)} /><SummaryStat label="Area" value={unit.squareFeet == null ? "Needs review" : `${unit.squareFeet.toLocaleString()} sq ft`} /></div>
  </section>;
}

function UnitGeneral({ unit, property, onSelect, onEdit }: { unit: AdminUnitView; property?: AdminPropertyView; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  return <div className="rm-property-unit-groups">
    <FieldGroup title="Unit details"><Field label="Unit name / number" value={unit.unitNumber} knowledge={unit.unitNumberKnowledge} /><Field label="Unit type" value={unit.unitType} knowledge={unit.unitTypeKnowledge} /><Field label="Bedrooms" value={unit.bedrooms == null ? "Needs review" : String(unit.bedrooms)} /><Field label="Bathrooms" value={unit.bathrooms == null ? "Needs review" : String(unit.bathrooms)} /><Field label="Square feet" value={unit.squareFeet == null ? "Needs review" : `${unit.squareFeet.toLocaleString()} sq ft`} /></FieldGroup>
    <FieldGroup title="Pricing defaults"><Field label="Market rent" value={money(unit.marketRentCents)} /><Field label="Default deposit" value={money(unit.defaultDepositCents)} /></FieldGroup>
    <FieldGroup title="Amenities and access"><Field label="Amenities" value={unit.amenities?.length ? unit.amenities.join(", ") : "Needs review"} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup>
    <FieldGroup title="Linked property"><Field label="Property" value={property?.id ? <button type="button" className="rm-link-button" onClick={() => onSelect("property", property.id!)}>{value(property.name, property.nameKnowledge)}</button> : "Needs review"} /><Field label="Property relationship" value={knownLink(unit.propertyId, unit.propertyLinkKnowledge) ? "Known" : "Needs review"} /></FieldGroup>
    {unit.id && <div className="rm-property-unit-section-actions"><button type="button" className="rm-button" onClick={() => onEdit("save-unit", buildUnitEditValues(unit))}><Pencil aria-hidden="true" /> Edit unit</button></div>}
  </div>;
}

function UnitOccupancy({ snapshot, unit, onSelect }: { snapshot: AdminSnapshot; unit: AdminUnitView; onSelect: (unitId: string) => void }) {
  const rows = occupancyHistoryForUnit(snapshot, unit);
  const hasKnownTenancy = rows.some((row) => row.tenancy);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Known links</span><h3>Occupancy history</h3><p>{hasKnownTenancy ? "Linked tenancy and lease history" : "No known linked tenancy or lease history"}</p></div></div>{!hasKnownTenancy && <p className="rm-warning">No linked tenancy was found for this unit. Vacancy is not inferred from the absence of a tenancy or from market rent.</p>}<OccupancyGrid rows={rows} onSelect={onSelect} /></section>;
}

function UnitRecurring({ snapshot, unit }: { snapshot: AdminSnapshot; unit: AdminUnitView }) {
  const rows = recurringSchedulesForUnit(snapshot, unit);
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Billing links</span><h3>Recurring schedules</h3><p>Direct unit schedules and inherited property schedules are labeled separately.</p></div></div>{rows.length === 0 && <p className="rm-warning">No linked recurring schedule is available. Missing billing data remains unresolved.</p>}<RecurringGrid rows={rows} caption="Recurring schedules for this unit" storageKey="rm-unit-recurring" /></section>;
}

function UnitMarketing({ unit }: { unit: AdminUnitView }) {
  return <section className="rm-property-unit-tab-panel"><div className="rm-property-unit-panel-heading"><div><span className="rm-eyebrow">Availability facts</span><h3>Marketing</h3><p>Readiness and listing are shown as recorded for this unit.</p></div></div><div className="rm-property-unit-groups"><FieldGroup title="Listing and readiness"><Field label="Readiness" value={statusValue(unit.readiness, unit.readinessKnowledge)} /><Field label="Listing" value={statusValue(unit.listing, unit.listingKnowledge)} /><Field label="Access notes" value={unit.accessNotes} /></FieldGroup></div></section>;
}

function UnitRecord({ snapshot, unit, property, activeTab, onTab, onSelect, onEdit }: { snapshot: AdminSnapshot; unit: AdminUnitView; property?: AdminPropertyView; activeTab: PropertyUnitTab; onTab: (tab: PropertyUnitTab) => void; onSelect: (kind: "property" | "unit", id: string) => void; onEdit: EditAction }) {
  const units = propertyUnits(snapshot, property?.id);
  const tabs = availableUnitTabs(snapshot, unit);
  const tab = tabs.includes(activeTab) ? activeTab : "general";
  return <div className="rm-record-detail rm-property-unit-detail"><UnitSummary unit={unit} property={property} propertyUnitCount={units.length} onSelect={onSelect} onEdit={onEdit} /><RecordTabs tabs={tabs} selected={tab} onSelect={onTab} /><div className="rm-property-unit-tab-content">
    {tab === "general" && <UnitGeneral unit={unit} property={property} onSelect={onSelect} onEdit={onEdit} />}
    {tab === "occupancy" && <UnitOccupancy snapshot={snapshot} unit={unit} onSelect={(id) => onSelect("unit", id)} />}
    {tab === "recurring" && <UnitRecurring snapshot={snapshot} unit={unit} />}
    {tab === "marketing" && <UnitMarketing unit={unit} />}
  </div></div>;
}

export function PropertyUnitRecords({ snapshot, filters, selectedPropertyId, selectedUnitId, onSelect, onEdit }: PropertyUnitRecordsProps) {
  const [search, setSearch] = useState(filters.search ?? "");
  const [activeTab, setActiveTab] = useState<PropertyUnitTab>("general");
  useEffect(() => { setSearch(filters.search ?? ""); }, [filters.search]);

  const listRows = useMemo(() => propertyUnitListItems(snapshot, filters, search), [snapshot, filters.propertyId, filters.propertyScope, search]);
  const selected = useMemo(() => resolvePropertyUnitSelection(snapshot, filters, selectedPropertyId, selectedUnitId, search), [snapshot, filters.propertyId, filters.propertyScope, selectedPropertyId, selectedUnitId, search]);
  useEffect(() => { setActiveTab("general"); }, [selected?.kind, selected?.property?.id, selected?.unit?.id]);

  return <div className="rm-record-layout rm-property-unit-records">
    <RecordList rows={listRows} selected={selected ? { kind: selected.kind, id: selected.kind === "unit" ? selected.unit?.id : selected.property?.id } : undefined} search={search} onSearch={setSearch} onSelect={onSelect} />
    <main className="rm-main rm-property-unit-main">
      {!selected && <section className="rm-panel"><EmptyState message="Select a property or unit record to continue." /></section>}
      {selected?.kind === "property" && selected.property && <PropertyRecord snapshot={snapshot} property={selected.property} activeTab={activeTab} onTab={setActiveTab} onSelect={onSelect} onEdit={onEdit} />}
      {selected?.kind === "unit" && selected.unit && <UnitRecord snapshot={snapshot} unit={selected.unit} property={selected.property} activeTab={activeTab} onTab={setActiveTab} onSelect={onSelect} onEdit={onEdit} />}
    </main>
  </div>;
}

export default PropertyUnitRecords;
