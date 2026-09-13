import { useEffect, useMemo, useState } from "react";
import { AlertCircle, MapPin, Search, UserRound } from "lucide-react";

import { APPLICATION_STATUS_TRANSITIONS } from "../../../../../shared/application-status-transitions";
import {
  currentLocalIsoDate,
  postRentOpsMutation,
} from "../api";
import { ApplicationCaseDetail } from "../application-case-detail";
import { handleRentOpsMutationError, RENT_OPS_CONFLICT_NOTICE } from "../ui";
import type { FormValues, QuickAction } from "../form-payload";
import type { AdminApplicationView, AdminSnapshot, ViewFilters } from "../types";
import {EntityLink} from "./entity-link";
import { DataGrid, type GridColumn } from "./grid";
import {
  applicationDateValue,
  applicationTenantPersonId,
  applicationDisplayName,
  applicationRecordKey,
  applicationStatusLabel,
  applicationUnitDisplayName,
  filterApplications,
  leasingFact,
  leasingLabel,
  propertyDisplayName,
  sortApplicationsByDate,
  type LeasingRegisterFilters,
} from "./leasing-model";
import { formatDate, formatLabel } from "./display";
import "./leasing.css";

export type EditAction = (action: QuickAction, values?: FormValues) => void;

interface ApplicationFilterState {
  propertyId: string;
  unitId: string;
  status: string;
  search: string;
  fromDate: string;
  toDate: string;
}

interface ApplicationGridRow extends Record<string, unknown> {
  application: AdminApplicationView;
  recordKey: string;
  name: string;
  submittedOn?: string;
  status?: string;
  property: string;
  unit: string;
}

function initialFilterState(filters: ViewFilters): ApplicationFilterState {
  return {
    propertyId: filters.propertyId || "all",
    unitId: "all",
    status: filters.status || "all",
    search: filters.search || "",
    fromDate: "",
    toDate: "",
  };
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function knownDate(value: string | undefined, knowledge?: string): string {
  const fact = leasingFact(value, knowledge);
  return fact === "Unknown" || fact === "Needs review" ? fact : formatDate(value);
}

function statusClass(status?: string): string {
  const value = normalized(status);
  return value ? `rm-status rm-status-${value}` : "rm-status rm-status-unknown";
}

function propertyOptions(snapshot: AdminSnapshot, scope: ViewFilters["propertyScope"]): Array<[string, string]> {
  return snapshot.snapshot.properties
    .filter((property) => scope !== "active" || property.state === "active")
    .map((property) => [property.id ?? "", property.name ?? "Needs review"] as [string, string])
    .filter(([id]) => Boolean(id));
}

function statusOptions(applications: readonly AdminApplicationView[]): string[] {
  const values = new Set<string>();
  for (const application of applications) {
    const current = normalized(application.status);
    if (current) values.add(current);
    else values.add("unknown");
    for (const next of APPLICATION_STATUS_TRANSITIONS[current as keyof typeof APPLICATION_STATUS_TRANSITIONS] ?? []) values.add(next);
  }
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function applicationStatusFilter(value: string | undefined, applications: readonly AdminApplicationView[]): string {
  const requested = normalized(value);
  if (!requested || requested === "all") return "all";
  return statusOptions(applications).includes(requested) ? requested : "all";
}

function unitOptions(snapshot: AdminSnapshot, propertyId: string): Array<[string, string]> {
  return snapshot.snapshot.units
    .filter((unit) => propertyId === "all" || unit.propertyId === propertyId)
    .map((unit) => [unit.id ?? "", unit.unitNumber ?? "Needs review"] as [string, string])
    .filter(([id]) => Boolean(id));
}

function displayStatus(application: AdminApplicationView): string {
  return applicationStatusLabel(application.status, application.statusKnowledge);
}

function applicationDate(application: AdminApplicationView): string {
  return knownDate(applicationDateValue(application), application.submittedOnKnowledge);
}

function mutationError(cause: unknown, onConflict: () => void, setError: (message: string) => void): void {
  handleRentOpsMutationError(cause, onConflict, setError);
}

interface ApplicationActionsProps {
  application: AdminApplicationView;
  snapshot: AdminSnapshot;
  onChanged: () => void;
  onEdit: EditAction;
  onError: (message: string) => void;
  busy: string | undefined;
  setBusy: (value: string | undefined) => void;
}

function ApplicationActions({ application, snapshot, onChanged, onEdit, onError, busy, setBusy }: ApplicationActionsProps) {
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentProperty, setAssignmentProperty] = useState(application.propertyId ?? "");
  const [assignmentUnit, setAssignmentUnit] = useState(application.unitId ?? "");

  useEffect(() => {
    setAssignmentProperty(application.propertyId ?? "");
    setAssignmentUnit(application.unitId ?? "");
  }, [application.propertyId, application.unitId]);

  const id = application.id;
  const currentStatus = normalized(application.status);
  const statusChoices = currentStatus
    ? Array.from(new Set([currentStatus, ...(APPLICATION_STATUS_TRANSITIONS[currentStatus as keyof typeof APPLICATION_STATUS_TRANSITIONS] ?? [])]))
    : [];
  const rowBusy = busy?.startsWith(`${id ?? "missing"}:`) === true;
  const assignedUnits = snapshot.snapshot.units.filter((unit) => unit.propertyId === assignmentProperty);

  async function changeStatus(nextStatus: string): Promise<void> {
    if (!id || !nextStatus || nextStatus === currentStatus || rowBusy) return;
    const decision = nextStatus === "approved" || nextStatus === "declined";
    const note = decision ? window.prompt(`Add the manual ${leasingLabel(nextStatus).toLowerCase()} decision note:`) : "";
    if (decision && note == null) return;
    if (!window.confirm(`Change this application from ${displayStatus(application)} to ${leasingLabel(nextStatus)}?`)) return;
    setBusy(`${id}:status`);
    try {
      const result = await postRentOpsMutation({
        action: "update-application-status",
        payload: { applicationId: id, revision: application.recordRevision ?? 1, status: nextStatus, note: note?.trim() || undefined },
      });
      if (!result.ok) throw new Error(result.message ?? "The application status could not be updated.");
      onChanged();
    } catch (cause) {
      mutationError(cause, () => { onError(RENT_OPS_CONFLICT_NOTICE); onChanged(); }, onError);
    } finally {
      setBusy(undefined);
    }
  }

  async function assignUnit(): Promise<void> {
    if (!id || !assignmentProperty || !assignmentUnit || rowBusy) return;
    setBusy(`${id}:assignment`);
    try {
      const result = await postRentOpsMutation({
        action: "assign-application-unit",
        payload: { applicationId: id, revision: application.recordRevision ?? 1, propertyId: assignmentProperty, unitId: assignmentUnit },
      });
      if (!result.ok) throw new Error(result.message ?? "The application unit could not be assigned.");
      setAssignmentOpen(false);
      onChanged();
    } catch (cause) {
      mutationError(cause, () => { onError(RENT_OPS_CONFLICT_NOTICE); onChanged(); }, onError);
    } finally {
      setBusy(undefined);
    }
  }

  function convert(): void {
    if (!id || currentStatus !== "approved" || application.convertedTenancyId || rowBusy) return;
    if (!window.confirm("Convert this approved application to one future tenancy? Review the unit and lease terms in the editor before saving.")) return;
    onEdit("convert-application", {
      applicationId: id,
      propertyId: application.propertyId,
      unitId: application.unitId,
    });
  }

  async function requestInformation(): Promise<void> {
    if (!id || rowBusy) return;
    // This is deliberately a user-invoked requirement action. It creates a
    // dated requirement record; it never sends an email, text, or other
    // notification implicitly.
    const label = window.prompt("What information is missing?");
    if (!label?.trim()) return;
    setBusy(`${id}:requirement`);
    try {
      const result = await postRentOpsMutation({
        action: "save-application-requirement",
        payload: { applicationId: id, key: `missing-${Date.now()}`, label: label.trim(), status: "requested", requestedOn: currentLocalIsoDate() },
      });
      if (!result.ok) throw new Error(result.message ?? "The missing-information request could not be added.");
      onChanged();
    } catch (cause) {
      mutationError(cause, () => { onError(RENT_OPS_CONFLICT_NOTICE); onChanged(); }, onError);
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="rm-leasing-row-actions" onClick={(event) => event.stopPropagation()}>
    <div className="rm-leasing-action-line">
      {statusChoices.length > 0 ? <label className="rm-field rm-leasing-status-field"><span className="sr-only">Application status</span><select aria-label={`Application status for ${applicationDisplayName(application)}`} className={statusClass(application.status)} value={currentStatus} disabled={rowBusy} onChange={(event) => { void changeStatus(event.target.value); }}><option value={currentStatus}>{displayStatus(application)}</option>{statusChoices.filter((status) => status !== currentStatus).map((status) => <option key={status} value={status}>{formatLabel(status)}</option>)}</select></label> : <span className={statusClass(application.status)}>{displayStatus(application)}</span>}
      {currentStatus === "approved" && !application.convertedTenancyId && <button type="button" className="rm-button rm-button-primary" disabled={rowBusy} onClick={convert}>Convert</button>}
      {application.convertedTenancyId && <span className="rm-muted">Converted</span>}
    </div>
    <div className="rm-leasing-action-line">
      {!application.convertedTenancyId && <button type="button" className="rm-button" disabled={rowBusy || !id} onClick={() => setAssignmentOpen((open) => !open)}>{application.unitId ? "Change unit" : "Assign unit"}</button>}
      <button type="button" className="rm-button" disabled={rowBusy || !id} onClick={() => { void requestInformation(); }}>Request information</button>
    </div>
    {assignmentOpen && <div className="rm-leasing-assignment rm-form-grid">
      <label className="rm-field">Property<select aria-label="Application property" value={assignmentProperty} disabled={rowBusy} onChange={(event) => { setAssignmentProperty(event.target.value); setAssignmentUnit(""); }}><option value="">Choose property</option>{snapshot.snapshot.properties.map((property) => <option key={property.id} value={property.id}>{property.name ?? "Needs review"}</option>)}</select></label>
      <label className="rm-field">Unit<select aria-label="Application unit" value={assignmentUnit} disabled={rowBusy || !assignmentProperty} onChange={(event) => setAssignmentUnit(event.target.value)}><option value="">Choose unit</option>{assignedUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.unitNumber ?? "Needs review"}</option>)}</select></label>
      <div className="rm-leasing-assignment-buttons"><button type="button" className="rm-button rm-button-primary" disabled={rowBusy || !assignmentProperty || !assignmentUnit} onClick={() => { void assignUnit(); }}>Save assignment</button><button type="button" className="rm-button" disabled={rowBusy} onClick={() => setAssignmentOpen(false)}>Cancel</button></div>
    </div>}
  </div>;
}

function ApplicationFilterBar({ snapshot, filters, applications, onChange }: { snapshot: AdminSnapshot; filters: ApplicationFilterState; applications: readonly AdminApplicationView[]; onChange: (next: ApplicationFilterState) => void }) {
  const properties = propertyOptions(snapshot, "all");
  const units = unitOptions(snapshot, filters.propertyId);
  const statuses = statusOptions(applications);
  return <div className="rm-toolbar rm-leasing-toolbar" aria-label="Application filters">
    <label className="rm-field"><span>Property</span><select value={filters.propertyId} onChange={(event) => onChange({ ...filters, propertyId: event.target.value, unitId: "all" })}><option value="all">All properties</option>{properties.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="rm-field"><span>Unit</span><select value={filters.unitId} onChange={(event) => onChange({ ...filters, unitId: event.target.value })}><option value="all">All units</option>{units.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="rm-field"><span>Status</span><select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}><option value="all">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{formatLabel(status)}</option>)}</select></label>
    <label className="rm-field"><span>Date from</span><input type="date" value={filters.fromDate} onChange={(event) => onChange({ ...filters, fromDate: event.target.value })} /></label>
    <label className="rm-field"><span>Date through</span><input type="date" value={filters.toDate} onChange={(event) => onChange({ ...filters, toDate: event.target.value })} /></label>
    <label className="rm-field rm-leasing-search"><span>Search name, contact, property, unit</span><Search aria-hidden="true" /><input type="search" value={filters.search} placeholder="Search applications" onChange={(event) => onChange({ ...filters, search: event.target.value })} /></label>
  </div>;
}

export function ApplicationsWorkspace({ snapshot, filters, onChanged, onEdit }: { snapshot: AdminSnapshot; filters: ViewFilters; onChanged: () => void; onEdit: EditAction }) {
  const [filterState, setFilterState] = useState<ApplicationFilterState>(() => ({ ...initialFilterState(filters), status: applicationStatusFilter(filters.status, snapshot.applicants) }));
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | undefined>(() => typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("record") ?? undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    setFilterState((current) => ({
      ...current,
      propertyId: filters.propertyId || current.propertyId || "all",
      status: applicationStatusFilter(filters.status, snapshot.applicants) || current.status || "all",
      search: filters.search,
    }));
  }, [filters.propertyId, filters.search, filters.status, snapshot.applicants]);

  const registerFilters: LeasingRegisterFilters = useMemo(() => ({
    propertyScope: filters.propertyScope,
    propertyId: filters.propertyId !== "all" ? filters.propertyId : filterState.propertyId,
    unitId: filterState.unitId,
    status: filterState.status,
    search: filterState.search,
    fromDate: filterState.fromDate,
    toDate: filterState.toDate,
  }), [filterState, filters.propertyScope, filters.propertyId]);
  const visibleApplications = useMemo(() => sortApplicationsByDate(filterApplications(snapshot.applicants, snapshot, registerFilters)), [registerFilters, snapshot]);
  const rows = useMemo<ApplicationGridRow[]>(() => visibleApplications.map((application, index) => ({
    application,
    recordKey: applicationRecordKey(application, index),
    name: applicationDisplayName(application),
    submittedOn: applicationDateValue(application),
    status: application.status,
    property: propertyDisplayName(snapshot, application.propertyId),
    unit: applicationUnitDisplayName(snapshot, application),
  })), [snapshot, visibleApplications]);
  const selectedSummary = selectedApplicationId ? visibleApplications.find((application) => application.id === selectedApplicationId) : undefined;
  useEffect(() => {
    if (selectedApplicationId && !selectedSummary) setSelectedApplicationId(undefined);
  }, [selectedApplicationId, selectedSummary]);

  const columns = useMemo<GridColumn<ApplicationGridRow>[]>(() => [
    { key: "name", label: "Applicant", width: "18rem", render: (row) => <div className="rm-leasing-record-link"><UserRound aria-hidden="true" />{applicationTenantPersonId(snapshot,row.application)?<><EntityLink personId={applicationTenantPersonId(snapshot,row.application)}>{row.name}</EntityLink><button type="button" className="rm-button" onClick={()=>row.application.id&&setSelectedApplicationId(row.application.id)}>Application</button></>:<button type="button" disabled={!row.application.id} onClick={()=>row.application.id&&setSelectedApplicationId(row.application.id)}>{row.name}</button>}</div>, sortValue: (row) => row.name },
    { key: "submittedOn", label: "Submitted / created", render: (row) => knownDate(row.submittedOn, row.application.submittedOn ? row.application.submittedOnKnowledge : "unknown"), sortValue: (row) => row.submittedOn ?? "" },
    { key: "status", label: "Status", render: (row) => <span className={statusClass(row.status)}>{displayStatus(row.application)}</span>, sortValue: (row) => row.status ?? "" },
    { key: "property", label: "Property", render: (row) => <span className="rm-leasing-linked"><MapPin aria-hidden="true" />{row.property}</span>, sortValue: (row) => row.property },
    { key: "unit", label: "Unit", render: (row) => row.unit, sortValue: (row) => row.unit },
    { key: "contact", label: "Contact", render: (row) => <span className="rm-leasing-contact">{leasingFact(row.application.email, row.application.emailKnowledge)}<br />{leasingFact(row.application.phone, row.application.phoneKnowledge)}</span>, sortValue: (row) => `${row.application.email ?? ""} ${row.application.phone ?? ""}` },
    { key: "actions", label: "Actions", render: (row) => <ApplicationActions application={row.application} snapshot={snapshot} onChanged={onChanged} onEdit={onEdit} onError={(message) => { setError(message); }} busy={busy} setBusy={setBusy} /> },
  ], [busy, onChanged, onEdit, snapshot]);

  return <section className="rm-panel rm-leasing-workspace" aria-labelledby="rm-applications-title">
    <header className="rm-panel-title rm-leasing-heading"><div><h2 id="rm-applications-title">Applications</h2></div><div className="rm-leasing-count"><strong>{visibleApplications.length}</strong><span>matching cases</span></div></header>
    {error && <div className="rm-error" role="alert"><AlertCircle aria-hidden="true" />{error}<button type="button" className="rm-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    <ApplicationFilterBar snapshot={snapshot} filters={filterState} applications={snapshot.applicants} onChange={setFilterState} />
    <DataGrid<ApplicationGridRow> rows={rows} columns={columns} getRowKey={(row, index) => row.recordKey || applicationRecordKey(row.application, index)} pageSize={25} emptyMessage="No applications match these filters." caption="Application register" initialSort={{ key: "submittedOn", direction: "desc" }} storageKey="rm-applications" />
    {selectedApplicationId && selectedSummary && <ApplicationCaseDetail key={selectedApplicationId} applicationId={selectedApplicationId} tenantPersonId={applicationTenantPersonId(snapshot,selectedSummary)} summary={selectedSummary} onClose={() => { setSelectedApplicationId(undefined); onChanged(); }} />}
  </section>;
}

/**
 * Compatibility entry point for the compact shell while it migrates from
 * global search/status props to the shared ViewFilters contract.
 */
export default ApplicationsWorkspace;
