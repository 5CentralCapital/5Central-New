import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, Download, FileClock, FileText, Search } from "lucide-react";

import { downloadRentOpsDocument } from "../api";
import type { FormValues, QuickAction } from "../form-payload";
import type { AdminActivityView, AdminDocumentView, AdminSnapshot, ViewFilters } from "../types";
import { DataGrid, type GridColumn } from "./grid";
import {
  activityDateValue,
  activityRecordKey,
  canDownloadDocument,
  documentAvailabilityLabel,
  documentDateValue,
  documentRecordKey,
  filterActivities,
  filterDocuments,
  leasingFact,
  linkedRecordLabel,
  propertyDisplayName,
  sortActivitiesByDate,
  sortDocumentsByDate,
  unitDisplayName,
  type LeasingRegisterFilters,
} from "./leasing-model";
import { formatDate, formatLabel } from "./display";
import "./leasing.css";

export type DocumentsEditAction = (action: QuickAction, values?: FormValues) => void;

type DocumentsSection = "documents" | "activity";

interface RecordFilterState {
  propertyId: string;
  unitId: string;
  status: string;
  type: string;
  search: string;
  fromDate: string;
  toDate: string;
}

interface DocumentGridRow extends Record<string, unknown> {
  document: AdminDocumentView;
  recordKey: string;
  fileName: string;
  date?: string;
  type?: string;
  state?: string;
  availability: string;
  linked: string;
}

interface ActivityGridRow extends Record<string, unknown> {
  activity: AdminActivityView;
  recordKey: string;
  date?: string;
  type?: string;
  summary: string;
  actor: string;
  linked: string;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function initialFilterState(filters: ViewFilters): RecordFilterState {
  return {
    propertyId: filters.propertyId || "all",
    unitId: "all",
    status: "all",
    type: "all",
    search: filters.search || "",
    fromDate: "",
    toDate: "",
  };
}

function knownDate(value: string | undefined, knowledge?: string): string {
  const fact = leasingFact(value, knowledge);
  return fact === "Unknown" || fact === "Needs review" ? fact : formatDate(value);
}

function statusClass(value?: string): string {
  const status = normalized(value);
  return status ? `rm-status rm-status-${status}` : "rm-status rm-status-unknown";
}

function propertyOptions(snapshot: AdminSnapshot): Array<[string, string]> {
  return snapshot.snapshot.properties
    .map((property) => [property.id ?? "", property.name ?? "Needs review"] as [string, string])
    .filter(([id]) => Boolean(id));
}

function unitOptions(snapshot: AdminSnapshot, propertyId: string): Array<[string, string]> {
  return snapshot.snapshot.units
    .filter((unit) => propertyId === "all" || unit.propertyId === propertyId)
    .map((unit) => [unit.id ?? "", unit.unitNumber ?? "Needs review"] as [string, string])
    .filter(([id]) => Boolean(id));
}

function documentTypes(documents: readonly AdminDocumentView[]): string[] {
  const values = documents.map((document) => normalized(document.type));
  if (values.some((value) => !value)) values.push("unknown");
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function documentStates(documents: readonly AdminDocumentView[]): string[] {
  const values = documents.map((document) => normalized(document.state));
  if (values.some((value) => !value)) values.push("unknown");
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function activityTypes(activities: readonly AdminActivityView[]): string[] {
  const values = activities.map((activity) => normalized(activity.type));
  if (values.some((value) => !value)) values.push("unknown");
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "document";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DocumentsFilterBar({ snapshot, filters, documents, activities, section, onChange }: { snapshot: AdminSnapshot; filters: RecordFilterState; documents: readonly AdminDocumentView[]; activities: readonly AdminActivityView[]; section: DocumentsSection; onChange: (next: RecordFilterState) => void }) {
  const properties = propertyOptions(snapshot);
  const units = unitOptions(snapshot, filters.propertyId);
  const types = section === "documents" ? documentTypes(documents) : activityTypes(activities);
  const statuses = section === "documents" ? documentStates(documents) : [];
  return <div className="rm-toolbar rm-leasing-toolbar" aria-label={`${section} filters`}>
    <label className="rm-field"><span>Property</span><select value={filters.propertyId} onChange={(event) => onChange({ ...filters, propertyId: event.target.value, unitId: "all" })}><option value="all">All properties</option>{properties.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="rm-field"><span>Unit</span><select value={filters.unitId} onChange={(event) => onChange({ ...filters, unitId: event.target.value })}><option value="all">All units</option>{units.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {section === "documents" && <label className="rm-field"><span>State</span><select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}><option value="all">All states</option>{statuses.map((status) => <option key={status} value={status}>{formatLabel(status)}</option>)}</select></label>}
    <label className="rm-field"><span>Type</span><select value={filters.type} onChange={(event) => onChange({ ...filters, type: event.target.value })}><option value="all">All types</option>{types.map((type) => <option key={type} value={type}>{formatLabel(type)}</option>)}</select></label>
    <label className="rm-field"><span>Date from</span><input type="date" value={filters.fromDate} onChange={(event) => onChange({ ...filters, fromDate: event.target.value })} /></label>
    <label className="rm-field"><span>Date through</span><input type="date" value={filters.toDate} onChange={(event) => onChange({ ...filters, toDate: event.target.value })} /></label>
    <label className="rm-field rm-leasing-search"><span>Search records</span><Search aria-hidden="true" /><input type="search" value={filters.search} placeholder={section === "documents" ? "Search file or linked record" : "Search summary or actor"} onChange={(event) => onChange({ ...filters, search: event.target.value })} /></label>
  </div>;
}

function DownloadCell({ document: record, onError }: { document: AdminDocumentView; onError: (message: string) => void }) {
  const [downloading, setDownloading] = useState(false);
  const available = canDownloadDocument(record);
  async function download(): Promise<void> {
    if (!available || !record.id || downloading) return;
    setDownloading(true);
    try {
      const blob = await downloadRentOpsDocument(record.id);
      saveBlob(record.fileName ?? "document", blob);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Secure document download is unavailable.");
    } finally {
      setDownloading(false);
    }
  }
  return available ? <button type="button" className="rm-button rm-leasing-download" disabled={downloading} onClick={() => { void download(); }}><Download aria-hidden="true" />{downloading ? "Preparing" : "Download"}</button> : <span className="rm-muted">{documentAvailabilityLabel(record)}</span>;
}

export function DocumentsWorkspace({ snapshot, filters, onEdit, onChanged: _onChanged }: { snapshot: AdminSnapshot; filters: ViewFilters; onEdit: DocumentsEditAction; onChanged: () => void }) {
  const [section, setSection] = useState<DocumentsSection>("documents");
  const [filterState, setFilterState] = useState<RecordFilterState>(() => initialFilterState(filters));
  const [error, setError] = useState<string>();

  useEffect(() => {
    setFilterState((current) => ({
      ...current,
      propertyId: filters.propertyId || current.propertyId || "all",
      search: filters.search,
    }));
  }, [filters.propertyId, filters.search]);

  const recordFilters: LeasingRegisterFilters = useMemo(() => ({
    propertyScope: filters.propertyScope,
    propertyId: filters.propertyId !== "all" ? filters.propertyId : filterState.propertyId,
    unitId: filterState.unitId,
    status: section === "documents" ? filterState.status : "all",
    type: filterState.type,
    search: filterState.search,
    fromDate: filterState.fromDate,
    toDate: filterState.toDate,
  }), [filterState, filters.propertyScope, filters.propertyId, section]);
  const scopedDocuments = useMemo(() => filterDocuments(snapshot.documents, snapshot, { propertyScope: filters.propertyScope, propertyId: filters.propertyId }), [snapshot, filters.propertyScope, filters.propertyId]);
  const scopedActivities = useMemo(() => filterActivities(snapshot.activities, snapshot, { propertyScope: filters.propertyScope, propertyId: filters.propertyId }), [snapshot, filters.propertyScope, filters.propertyId]);
  const visibleDocuments = useMemo(() => sortDocumentsByDate(filterDocuments(snapshot.documents, snapshot, recordFilters)), [recordFilters, snapshot]);
  const visibleActivities = useMemo(() => sortActivitiesByDate(filterActivities(snapshot.activities, snapshot, recordFilters)), [recordFilters, snapshot]);
  const documentRows = useMemo<DocumentGridRow[]>(() => visibleDocuments.map((document, index) => ({
    document,
    recordKey: documentRecordKey(document, index),
    fileName: document.fileName ?? "Unknown document",
    date: documentDateValue(document),
    type: document.type,
    state: document.state,
    availability: documentAvailabilityLabel(document),
    linked: linkedRecordLabel(snapshot, document),
  })), [snapshot, visibleDocuments]);
  const activityRows = useMemo<ActivityGridRow[]>(() => visibleActivities.map((activity, index) => ({
    activity,
    recordKey: activityRecordKey(activity, index),
    date: activityDateValue(activity),
    type: activity.type,
    summary: activity.summary ?? "Unknown activity",
    actor: leasingFact(activity.actor, activity.actorKnowledge),
    linked: linkedRecordLabel(snapshot, activity),
  })), [snapshot, visibleActivities]);

  const documentColumns = useMemo<GridColumn<DocumentGridRow>[]>(() => [
    { key: "fileName", label: "Document", width: "18rem", render: (row) => <span className="rm-leasing-record-link"><FileText aria-hidden="true" />{row.fileName}</span>, sortValue: (row) => row.fileName },
    { key: "date", label: "Record date", render: (row) => knownDate(row.date, row.document.uploadedAt || row.document.verifiedAt ? undefined : "unknown"), sortValue: (row) => row.date ?? "" },
    { key: "type", label: "Type", render: (row) => <span className={statusClass(row.type)}>{leasingFact(row.type, row.document.type ? undefined : "unknown")}</span>, sortValue: (row) => row.type ?? "" },
    { key: "state", label: "State", render: (row) => <span className={statusClass(row.state)}>{leasingFact(row.state, row.document.state ? undefined : "unknown")}</span>, sortValue: (row) => row.state ?? "" },
    { key: "linked", label: "Linked record", render: (row) => <span className="rm-leasing-linked">{row.linked}</span>, sortValue: (row) => row.linked },
    { key: "availability", label: "File status", render: (row) => <span className="rm-leasing-availability">{row.availability}</span>, sortValue: (row) => row.availability },
    { key: "action", label: "Action", render: (row) => <DownloadCell document={row.document} onError={setError} /> },
  ], []);
  const activityColumns = useMemo<GridColumn<ActivityGridRow>[]>(() => [
    { key: "date", label: "Date", render: (row) => knownDate(row.date, row.activity.occurredAt ? row.activity.occurredAtKnowledge : "unknown"), sortValue: (row) => row.date ?? "" },
    { key: "type", label: "Type", render: (row) => <span className={statusClass(row.type)}>{leasingFact(row.type, row.activity.type ? row.activity.typeKnowledge : "unknown")}</span>, sortValue: (row) => row.type ?? "" },
    { key: "summary", label: "Activity", width: "22rem", render: (row) => <div><span className="rm-leasing-activity-summary"><Activity aria-hidden="true" />{row.summary}</span>{row.activity.detail && <details><summary>View details</summary><p style={{ whiteSpace: "pre-wrap" }}>{row.activity.detail}</p></details>}</div>, sortValue: (row) => row.summary },
    { key: "actor", label: "Actor", render: (row) => row.actor, sortValue: (row) => row.actor },
    { key: "linked", label: "Linked record", render: (row) => <span className="rm-leasing-linked">{row.linked}</span>, sortValue: (row) => row.linked },
  ], []);

  function addActivity(): void {
    onEdit("save-activity", {
      ...(filterState.propertyId !== "all" ? { propertyId: filterState.propertyId } : {}),
      ...(filterState.unitId !== "all" ? { unitId: filterState.unitId } : {}),
    });
  }

  const rowCount = section === "documents" ? visibleDocuments.length : visibleActivities.length;
  return <section className="rm-panel rm-leasing-workspace" aria-labelledby="rm-documents-title">
    <header className="rm-panel-title rm-leasing-heading"><div><span className="rm-muted">Records register</span><h2 id="rm-documents-title">Documents &amp; activity</h2><p>Document metadata stays separate from file availability. Activity remains a dated record tied to its available links.</p></div><button type="button" className="rm-button rm-button-primary" onClick={addActivity}><FileClock aria-hidden="true" />Add activity</button></header>
    <div className="rm-tabs rm-leasing-register-tabs" role="tablist" aria-label="Document and activity records"><button type="button" role="tab" aria-selected={section === "documents"} className={section === "documents" ? "active" : ""} onClick={() => { setSection("documents"); setFilterState((current) => ({ ...current, status: "all", type: "all" })); }}><FileText aria-hidden="true" />Documents <span>{scopedDocuments.length}</span></button><button type="button" role="tab" aria-selected={section === "activity"} className={section === "activity" ? "active" : ""} onClick={() => { setSection("activity"); setFilterState((current) => ({ ...current, status: "all", type: "all" })); }}><Activity aria-hidden="true" />Activity <span>{scopedActivities.length}</span></button></div>
    {error && <div className="rm-error" role="alert"><AlertCircle aria-hidden="true" />{error}<button type="button" className="rm-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    <DocumentsFilterBar snapshot={snapshot} filters={filterState} documents={scopedDocuments} activities={scopedActivities} section={section} onChange={setFilterState} />
    <div className="rm-leasing-register-meta"><span>{rowCount} matching {section === "documents" ? "documents" : "activities"}</span><span className="rm-muted">Showing a bounded page of loaded records</span></div>
    {section === "documents" ? <DataGrid<DocumentGridRow> rows={documentRows} columns={documentColumns} getRowKey={(row, index) => row.recordKey || documentRecordKey(row.document, index)} pageSize={25} emptyMessage="No documents match these filters." caption="Document register" initialSort={{ key: "date", direction: "desc" }} storageKey="rm-documents" /> : <DataGrid<ActivityGridRow> rows={activityRows} columns={activityColumns} getRowKey={(row, index) => row.recordKey || activityRecordKey(row.activity, index)} pageSize={25} emptyMessage="No activity matches these filters." caption="Activity register" initialSort={{ key: "date", direction: "desc" }} storageKey="rm-activity" />}
  </section>;
}

/**
 * Compatibility entry point for shells that still pass only their global
 * search value while the document register owns its detailed filters.
 */
export default DocumentsWorkspace;
