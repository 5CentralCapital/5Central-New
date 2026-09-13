import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { loadRentOpsReport } from "../api";
import type { AdminSnapshot, ApiFilters, ReportKey } from "../types";
import { REPORT_PERIODS, getReportConfig, isTenantStatusReport, type ReportLocalFilters } from "./report-model";
import { brandedReportCsv, brandedReportHtml, exportPeriodLabel, exportPropertyOptions, initialExportPropertyScope, exportQueryFilters, exportSelectionError, prepareReportExport, printReportDocument, type ReportExportSelection } from "./report-export";
import "./report-export.css";

export interface ReportExportDialogProps {
  report: ReportKey;
  snapshot: AdminSnapshot;
  queryFilters: ApiFilters;
  format: "csv" | "print";
  onClose: () => void;
  localFilters?: ReportLocalFilters;
  search?: string;
  extraColumns?: string[];
  sort?: { key: string; direction: "asc" | "desc" };
}
export function ReportExportDialog(props: ReportExportDialogProps) {
  const { report, snapshot, queryFilters, format, onClose } = props;
  const [selection, setSelection] = useState<ReportExportSelection>(() => ({
    propertyScope: initialExportPropertyScope(queryFilters, snapshot),
    propertyIds: queryFilters.propertyIds ?? (queryFilters.propertyId && queryFilters.propertyId !== "all" ? [queryFilters.propertyId] : []),
    asOfDate: queryFilters.asOfDate ?? "", month: queryFilters.month ?? queryFilters.asOfDate?.slice(0, 7) ?? "",
    fromDate: queryFilters.fromDate ?? `${queryFilters.asOfDate?.slice(0, 7)}-01`, toDate: queryFilters.toDate ?? queryFilters.asOfDate ?? "",
    tenantStatus: queryFilters.tenantStatus ?? "current",
  }));
  const [keepSearch, setKeepSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const running = useRef(false);
  const mode = REPORT_PERIODS[report];
  const error = exportSelectionError(report, selection);
  const properties = exportPropertyOptions(snapshot, selection.propertyScope);
  const change = <K extends keyof ReportExportSelection>(key: K, value: ReportExportSelection[K]) => setSelection(current => ({ ...current, [key]: value }));
  async function runExport() {
    if (error || running.current) return;
    running.current = true; setBusy(true); setFailure(undefined);
    try {
      // Always request the chosen scope and period from the server; never relabel the current grid.
      const rows = await loadRentOpsReport(report, exportQueryFilters(report, { ...queryFilters, search: keepSearch ? queryFilters.search : undefined }, selection));
      const result = prepareReportExport(report, rows, snapshot, selection, { ...props, search: keepSearch ? props.search : "" });
      const header = { title: getReportConfig(report).label,
        properties: selection.propertyIds.length ? selection.propertyIds.map(id => properties.find(property => property.id === id)?.name ?? id).join(" · ") : selection.propertyScope === "active" ? "All active properties" : "All properties",
        period: exportPeriodLabel(report, selection),
        tenantStatus: isTenantStatusReport(report) ? `${selection.tenantStatus.charAt(0).toUpperCase()}${selection.tenantStatus.slice(1)} tenants` : undefined };
      if (format === "csv") {
        const url = URL.createObjectURL(new Blob([brandedReportCsv(header, result)], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `5central-${report}-${mode === "range" ? `${selection.fromDate}-through-${selection.toDate}` : mode === "month" ? selection.month : selection.asOfDate}.csv`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await printReportDocument(brandedReportHtml(header, result));
      onClose();
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : "The report could not be exported. Try again."); }
    finally { running.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="rm-export-dialog">
    <DialogTitle>Export {getReportConfig(report).label}</DialogTitle>
    <DialogDescription>Choose properties and dates for your {format === "csv" ? "CSV" : "print or PDF"} report.</DialogDescription>
    <form onSubmit={event => { event.preventDefault(); void runExport(); }}>
      <fieldset disabled={busy}><legend>Properties</legend>
        <label className="rm-export-check"><input type="checkbox" checked={!selection.propertyIds.length} onChange={() => change("propertyIds", [])} />{selection.propertyScope === "active" ? "All active properties" : "All properties"}</label>
        <label className="rm-export-check"><input type="checkbox" checked={selection.propertyScope === "all"} onChange={event => { const scope = event.target.checked ? "all" : "active"; const allowed = exportPropertyOptions(snapshot, scope).map(property => property.id); setSelection(current => ({ ...current, propertyScope: scope, propertyIds: current.propertyIds.filter(id => allowed.includes(id)) })); }} />Include inactive properties</label>
        <div className="rm-export-properties">{properties.map(property => <label className="rm-export-check" key={property.id}><input type="checkbox" checked={selection.propertyIds.includes(property.id!)} onChange={event => change("propertyIds", event.target.checked ? [...selection.propertyIds, property.id!] : selection.propertyIds.filter(id => id !== property.id))} />{property.name ?? property.id}</label>)}</div>
      </fieldset>
      <fieldset disabled={busy} className="rm-export-dates"><legend>Report dates</legend>
        {mode === "as-of" && <label>As of<input required type="date" value={selection.asOfDate} onChange={event => change("asOfDate", event.target.value)} /></label>}
        {mode === "month" && <><label>Month<input required type="month" value={selection.month} max={selection.asOfDate.slice(0, 7)} onChange={event => change("month", event.target.value)} /></label><label>As of<input required type="date" value={selection.asOfDate} onChange={event => change("asOfDate", event.target.value)} /></label></>}
        {mode === "range" && <><label>From<input required type="date" value={selection.fromDate} max={selection.toDate} onChange={event => change("fromDate", event.target.value)} /></label><label>Through (inclusive)<input required type="date" value={selection.toDate} min={selection.fromDate} onChange={event => setSelection(current => ({ ...current, toDate: event.target.value, asOfDate: event.target.value }))} /></label></>}
      </fieldset>
      {isTenantStatusReport(report) && <label>Tenant status<select disabled={busy} value={selection.tenantStatus} onChange={event => change("tenantStatus", event.target.value as ReportExportSelection["tenantStatus"])}><option value="current">Current tenants</option><option value="all">All tenants</option><option value="former">Former tenants</option><option value="future">Future tenants</option><option value="unknown">Unverified status</option></select></label>}
      {(props.search || queryFilters.search) && <label className="rm-export-check"><input type="checkbox" disabled={busy} checked={keepSearch} onChange={event => setKeepSearch(event.target.checked)} />Keep search: {props.search || queryFilters.search}</label>}
      {Object.entries({ Occupancy: props.localFilters?.occupancy ?? queryFilters.occupancy?.join(", "), Readiness: props.localFilters?.readiness ?? queryFilters.readiness?.join(", "), Listing: props.localFilters?.listing ?? queryFilters.listing?.join(", "), Balance: props.localFilters?.balance ?? queryFilters.balanceStatus }).some(([, value]) => value && value !== "all") && <p className="text-sm">Current view: {Object.entries({ Occupancy: props.localFilters?.occupancy ?? queryFilters.occupancy?.join(", "), Readiness: props.localFilters?.readiness ?? queryFilters.readiness?.join(", "), Listing: props.localFilters?.listing ?? queryFilters.listing?.join(", "), Balance: props.localFilters?.balance ?? queryFilters.balanceStatus }).filter(([, value]) => value && value !== "all").map(([label, value]) => `${label}: ${value?.replaceAll("_", " ")}`).join(" · ")}</p>}
      {(error || failure) && <p role="alert" className="rm-error">{error ?? failure}</p>}
      <div className="rm-export-actions"><button className="rm-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="rm-button rm-export-submit" type="submit" disabled={busy || !!error}>{busy ? "Preparing report…" : format === "csv" ? "Download CSV" : "Print / Save PDF"}</button></div>
    </form>
  </DialogContent></Dialog>;
}
