import { useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";

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
  leasingFactResolved,
  leasingLabel,
  propertyDisplayName,
  sortApplicationsByDate,
  type LeasingRegisterFilters,
} from "./leasing-model";
import {
  APPLICATION_STATUS_GROUPS,
  applicationGroupCounts,
  applicationsInPropertySelection,
  applicationStatusTone,
  filterApplicationsByGroup,
  type ApplicationStatusGroup,
} from "./applications-view-model";
import { formatDate, formatLabel } from "./display";
import { RowMenu, type RowMenuItem } from "./ops-ui";
import { Segmented } from "../../workspaces/page";
import { displayPersonName, formatTableDate } from "../../../lib/rent-ops-formatters";
import { PROPERTY_MISSING_LABEL, UNIT_MISSING_LABEL } from "@shared/review-cases/display-labels";
import "./leasing.css";
import "./applications-workspace.css";

export type EditAction = (action: QuickAction, values?: FormValues) => void;

/** Register-only filters. Property, status and search come from the global filter bar. */
interface ApplicationFilterState {
  unitId: string;
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

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function knownDate(value: string | undefined, knowledge?: string): string {
  const fact = leasingFact(value, knowledge);
  return leasingFactResolved(value, knowledge) ? formatTableDate(value) ?? formatDate(value) : fact;
}

function statusClass(status?: string, knowledge?: string): string {
  const tone = applicationStatusTone(status, knowledge);
  return tone ? `rm-status rm-status--${tone}` : "rm-status";
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

function unitOptions(snapshot: AdminSnapshot, propertyIds: readonly string[]): Array<[string, string]> {
  return snapshot.snapshot.units
    .filter((unit) => !propertyIds.length || (!!unit.propertyId && propertyIds.includes(unit.propertyId)))
    .map((unit) => [unit.id ?? "", unit.unitNumber ?? UNIT_MISSING_LABEL] as [string, string])
    .filter(([id]) => Boolean(id));
}

function selectedPropertyIds(filters: ViewFilters): string[] {
  if (filters.propertyIds?.length) return [...filters.propertyIds];
  return filters.propertyId && filters.propertyId !== "all" ? [filters.propertyId] : [];
}

function displayStatus(application: AdminApplicationView): string {
  return applicationStatusLabel(application.status, application.statusKnowledge);
}

function applicantName(application: AdminApplicationView): string {
  return displayPersonName(applicationDisplayName(application)) || applicationDisplayName(application);
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
  onReview: (applicationId: string) => void;
  busy: string | undefined;
  setBusy: (value: string | undefined) => void;
}

function ApplicationActions({ application, snapshot, onChanged, onEdit, onError, onReview, busy, setBusy }: ApplicationActionsProps) {
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const applicantLabel = applicantName(application);
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

  const menuItems: RowMenuItem[] = [];
  if (currentStatus === "approved" && !application.convertedTenancyId) menuItems.push({ label: "Convert to tenancy…", disabled: rowBusy, onSelect: convert });
  if (!application.convertedTenancyId) menuItems.push({ label: application.unitId ? "Change unit" : "Assign unit", disabled: rowBusy || !id, onSelect: () => { setStatusOpen(false); setAssignmentOpen((open) => !open); } });
  menuItems.push({ label: "Request information", disabled: rowBusy || !id, onSelect: () => { void requestInformation(); } });
  if (statusChoices.length > 1) menuItems.push({ label: "Change status…", disabled: rowBusy || !id, onSelect: () => { setAssignmentOpen(false); setStatusOpen((open) => !open); } });

  return <div className="rm-apps-row-actions" onClick={(event) => event.stopPropagation()}>
    <div className="rm-apps-action-line">
      <button type="button" className="rm-button rm-apps-review" disabled={!id} onClick={() => { if (id) onReview(id); }}>Review</button>
      <RowMenu label={`Actions for ${applicantLabel}`} items={menuItems} />
    </div>
    {statusOpen && <div className="rm-apps-inline-form">
      <label className="rm-apps-field"><span>Status</span><select aria-label={`Application status for ${applicantLabel}`} value={currentStatus} disabled={rowBusy} onChange={(event) => { setStatusOpen(false); void changeStatus(event.target.value); }}><option value={currentStatus}>{displayStatus(application)}</option>{statusChoices.filter((status) => status !== currentStatus).map((status) => <option key={status} value={status}>{formatLabel(status)}</option>)}</select></label>
      <button type="button" className="rm-button" disabled={rowBusy} onClick={() => setStatusOpen(false)}>Cancel</button>
    </div>}
    {assignmentOpen && <div className="rm-apps-inline-form">
      <label className="rm-apps-field"><span>Property</span><select aria-label="Application property" value={assignmentProperty} disabled={rowBusy} onChange={(event) => { setAssignmentProperty(event.target.value); setAssignmentUnit(""); }}><option value="">Choose property</option>{snapshot.snapshot.properties.map((property) => <option key={property.id} value={property.id}>{property.name ?? PROPERTY_MISSING_LABEL}</option>)}</select></label>
      <label className="rm-apps-field"><span>Unit</span><select aria-label="Application unit" value={assignmentUnit} disabled={rowBusy || !assignmentProperty} onChange={(event) => setAssignmentUnit(event.target.value)}><option value="">Choose unit</option>{assignedUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.unitNumber ?? UNIT_MISSING_LABEL}</option>)}</select></label>
      <button type="button" className="rm-button" disabled={rowBusy || !assignmentProperty || !assignmentUnit} onClick={() => { void assignUnit(); }}>Save assignment</button>
      <button type="button" className="rm-button" disabled={rowBusy} onClick={() => setAssignmentOpen(false)}>Cancel</button>
    </div>}
  </div>;
}

function ApplicationFilterRow({ snapshot, filters, propertyIds, group, counts, onChange, onGroup }: { snapshot: AdminSnapshot; filters: ApplicationFilterState; propertyIds: readonly string[]; group: ApplicationStatusGroup; counts: Record<ApplicationStatusGroup, number>; onChange: (next: ApplicationFilterState) => void; onGroup: (group: ApplicationStatusGroup) => void }) {
  const units = unitOptions(snapshot, propertyIds);
  return <div className="rm-apps-filters" aria-label="Application filters">
    <Segmented label="Application status" value={group} onChange={onGroup} options={APPLICATION_STATUS_GROUPS.map(([key, text]) => [key, `${text} · ${counts[key]}`] as const)} />
    <label className="rm-apps-field"><span>Unit</span><select value={filters.unitId} onChange={(event) => onChange({ ...filters, unitId: event.target.value })}><option value="all">All units</option>{units.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="rm-apps-field"><span>From</span><input type="date" value={filters.fromDate} max={filters.toDate || undefined} onChange={(event) => onChange({ ...filters, fromDate: event.target.value })} /></label>
    <label className="rm-apps-field"><span>Through</span><input type="date" value={filters.toDate} min={filters.fromDate || undefined} onChange={(event) => onChange({ ...filters, toDate: event.target.value })} /></label>
    {(filters.unitId !== "all" || filters.fromDate || filters.toDate) && <button type="button" className="rm-button rm-apps-clear" onClick={() => onChange({ ...filters, unitId: "all", fromDate: "", toDate: "" })}>Clear</button>}
  </div>;
}

function ContactCell({ application }: { application: AdminApplicationView }) {
  const facts = ([["Email", application.email, application.emailKnowledge], ["Phone", application.phone, application.phoneKnowledge]] as const)
    .filter(([, value]) => typeof value === "string" && value.trim());
  if (!facts.length) return <span className="rm-muted" title="No contact recorded">—</span>;
  return <span className="rm-apps-contact">{facts.map(([kind, value, knowledge]) => {
    const unverified = !leasingFactResolved(value, knowledge);
    return <span key={kind} className="rm-apps-contact-line">{value}{unverified && <span className="rm-apps-unverified" role="img" aria-label={`${kind} not verified`} title={`${kind} not verified`}><AlertTriangle aria-hidden="true" /></span>}</span>;
  })}</span>;
}

export function ApplicationsWorkspace({ snapshot, filters, onChanged, onEdit }: { snapshot: AdminSnapshot; filters: ViewFilters; onChanged: () => void; onEdit: EditAction }) {
  const [filterState, setFilterState] = useState<ApplicationFilterState>({ unitId: "all", fromDate: "", toDate: "" });
  const [group, setGroup] = useState<ApplicationStatusGroup>("all");
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | undefined>(() => typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("record") ?? undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const propertyIds = useMemo(() => selectedPropertyIds(filters), [filters.propertyId, filters.propertyIds]);
  const propertyKey = propertyIds.join("\u001f");

  // A unit chosen for another property selection no longer applies.
  useEffect(() => { setFilterState((current) => current.unitId === "all" ? current : { ...current, unitId: "all" }); }, [propertyKey]);

  const registerFilters: LeasingRegisterFilters = useMemo(() => ({
    propertyScope: filters.propertyScope,
    propertyId: propertyIds.length === 1 ? propertyIds[0] : "all",
    unitId: filterState.unitId,
    status: applicationStatusFilter(filters.status, snapshot.applicants),
    search: filters.search,
    fromDate: filterState.fromDate,
    toDate: filterState.toDate,
  }), [filterState, filters.propertyScope, filters.status, filters.search, propertyKey, snapshot.applicants]);
  const scopedApplications = useMemo(() => applicationsInPropertySelection(sortApplicationsByDate(filterApplications(snapshot.applicants, snapshot, registerFilters)), propertyIds.length > 1 ? propertyIds : undefined), [registerFilters, snapshot, propertyKey]);
  const groupCounts = useMemo(() => applicationGroupCounts(scopedApplications), [scopedApplications]);
  const visibleApplications = useMemo(() => filterApplicationsByGroup(scopedApplications, group), [scopedApplications, group]);
  const rows = useMemo<ApplicationGridRow[]>(() => visibleApplications.map((application, index) => ({
    application,
    recordKey: applicationRecordKey(application, index),
    name: applicantName(application),
    submittedOn: applicationDateValue(application),
    status: application.status,
    property: propertyDisplayName(snapshot, application.propertyId),
    unit: application.unitId ? applicationUnitDisplayName(snapshot, application) : "",
  })), [snapshot, visibleApplications]);
  const selectedSummary = selectedApplicationId ? visibleApplications.find((application) => application.id === selectedApplicationId) : undefined;
  useEffect(() => {
    if (selectedApplicationId && !selectedSummary) setSelectedApplicationId(undefined);
  }, [selectedApplicationId, selectedSummary]);

  const columns = useMemo<GridColumn<ApplicationGridRow>[]>(() => [
    { key: "name", label: "Applicant", width: "16rem", render: (row) => {
      const personId = applicationTenantPersonId(snapshot, row.application);
      return personId ? <EntityLink personId={personId}>{row.name}</EntityLink> : <button type="button" className="rm-apps-name" disabled={!row.application.id} onClick={() => row.application.id && setSelectedApplicationId(row.application.id)}>{row.name}</button>;
    }, sortValue: (row) => row.name },
    { key: "submittedOn", label: "Submitted", render: (row) => knownDate(row.submittedOn, row.application.submittedOn ? row.application.submittedOnKnowledge : "unknown"), sortValue: (row) => row.submittedOn ?? "" },
    { key: "status", label: "Status", render: (row) => <span className="rm-apps-status"><span className={statusClass(row.status, row.application.statusKnowledge)}>{displayStatus(row.application)}</span>{row.application.convertedTenancyId && <span className="rm-muted">Converted</span>}</span>, sortValue: (row) => row.status ?? "" },
    { key: "property", label: "Property", render: (row) => row.property, sortValue: (row) => row.property },
    { key: "unit", label: "Unit", render: (row) => row.unit || <span className="rm-muted">Unassigned</span>, sortValue: (row) => row.unit },
    { key: "contact", label: "Contact", render: (row) => <ContactCell application={row.application} />, sortValue: (row) => `${row.application.email ?? ""} ${row.application.phone ?? ""}` },
    { key: "actions", label: "", width: "9rem", render: (row) => <ApplicationActions application={row.application} snapshot={snapshot} onChanged={onChanged} onEdit={onEdit} onError={(message) => { setError(message); }} onReview={setSelectedApplicationId} busy={busy} setBusy={setBusy} /> },
  ], [busy, onChanged, onEdit, snapshot]);

  return <section className="rm-panel rm-leasing-workspace rm-apps-workspace" aria-labelledby="rm-applications-title">
    <header className="rm-apps-heading"><h2 id="rm-applications-title">Applications</h2><span className="rm-muted">{visibleApplications.length} {visibleApplications.length === 1 ? "application" : "applications"}</span></header>
    {error && <div className="rm-error" role="alert"><AlertCircle aria-hidden="true" />{error}<button type="button" className="rm-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    <ApplicationFilterRow snapshot={snapshot} filters={filterState} propertyIds={propertyIds} group={group} counts={groupCounts} onChange={setFilterState} onGroup={setGroup} />
    <DataGrid<ApplicationGridRow> rows={rows} columns={columns} getRowKey={(row, index) => row.recordKey || applicationRecordKey(row.application, index)} onRow={(row) => { if (row.application.id) setSelectedApplicationId(row.application.id); }} pageSize={25} emptyMessage="No applications match these filters." caption="Application register" summaryLabel="application" initialSort={{ key: "submittedOn", direction: "desc" }} storageKey="rm-applications" />
    {selectedApplicationId && selectedSummary && <ApplicationCaseDetail key={selectedApplicationId} applicationId={selectedApplicationId} tenantPersonId={applicationTenantPersonId(snapshot,selectedSummary)} summary={selectedSummary} onClose={() => { setSelectedApplicationId(undefined); onChanged(); }} />}
  </section>;
}

/**
 * Compatibility entry point for the compact shell while it migrates from
 * global search/status props to the shared ViewFilters contract.
 */
export default ApplicationsWorkspace;
