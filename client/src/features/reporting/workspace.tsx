import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContextOrganization } from "@shared/company/context";
import type { ReportEntry, ReportPackage, ReportPackageRun, ReportPage, ReportPreset, ReportRunRequest } from "@shared/reporting";
import { reportingApi, ReportingApiError } from "./api";
import { ReportSetup } from "./setup";
import type { ReportPackageSaveRequest, ReportPresetSaveRequest } from "./types";
import "./reporting.css";

function label(value: string): string { return value.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function display(value: unknown, type: string, currency?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "money" && typeof value === "string" && /^-?\d+$/.test(value)) { const negative = value.startsWith("-"); const cents = BigInt(value); const absolute = (negative ? -cents : cents).toString().padStart(3, "0"); return `${negative ? "-" : ""}${currency ?? "USD"} ${absolute.slice(0, -2)}.${absolute.slice(-2)}`; }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function requestFromPreset(preset: ReportPreset): ReportRunRequest {
  const current = preset.current;
  return { reportId: current.reportId, definitionVersion: current.definitionVersion, scope: current.scope, filters: current.filters, period: current.period, basis: current.basis, currency: current.currency, consolidation: current.consolidation, forecast: current.forecast, columns: current.columns.length ? current.columns : undefined, sort: current.sort.length ? current.sort : undefined };
}

function packageInputFromRequest(request: ReportRunRequest, name: string): ReportPackageSaveRequest {
  return {
    name,
    visibility: "private",
    items: [{ id: `${request.reportId}-1`, title: request.reportId, reportId: request.reportId, definitionVersion: request.definitionVersion, scope: request.scope, filters: request.filters, period: request.period, basis: request.basis, currency: request.currency, consolidation: request.consolidation ?? null, forecast: request.forecast ?? null, columns: request.columns ?? [], sort: request.sort ?? [] }],
  };
}

function Result({ organizationId, page, onPage }: { organizationId: string; page: ReportPage; onPage: (page: ReportPage) => void }) {
  const [loading, setLoading] = useState(false);
  const next = async () => { if (!page.nextCursor) return; setLoading(true); try { onPage(await reportingApi.page(organizationId, page.runId, page.nextCursor)); } finally { setLoading(false); } };
  const exportRun = async (format: "csv" | "json" | "html") => { const job = await reportingApi.export(organizationId, page.runId, format); if (job.content === null) return; const blob = new Blob([job.content], { type: job.contentType }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = job.fileName; anchor.click(); URL.revokeObjectURL(url); };
  return <section className="reporting-result"><div className="reporting-result-toolbar"><span>{page.totalRows.toLocaleString()} rows</span><div><button type="button" onClick={() => void exportRun("csv")}>CSV</button><button type="button" onClick={() => void exportRun("json")}>JSON</button><button type="button" onClick={() => void exportRun("html")}>HTML</button>{page.nextCursor && <button type="button" onClick={() => void next()} disabled={loading}>{loading ? "Loading…" : "Next page"}</button>}</div></div>{page.coverage.some(item => item.state !== "complete") && <div className="reporting-notice" role="status">Some source coverage is incomplete. Review coverage before using this report.</div>}{page.missingData.map(item => <div className="reporting-notice" role="status" key={`${item.code}:${item.message}`}>{item.message}</div>)}<div className="reporting-table-wrap"><table><thead><tr>{page.columns.map(column => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{page.rows.map(row => <tr key={row.rowId}>{page.columns.map(column => <td key={column.id}>{display(row.values[column.id], column.type, undefined)}</td>)}</tr>)}</tbody></table></div></section>;
}

function SavedReports({ organizationId, open, latestRequest, onApply }: { organizationId: string; open: boolean; latestRequest?: ReportRunRequest; onApply: (request: ReportRunRequest) => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const [packageRun, setPackageRun] = useState<ReportPackageRun>();
  const [refresh, setRefresh] = useState(0);
  const presets = useQuery({ queryKey: ["company-reporting", "presets", organizationId, refresh], queryFn: ({ signal }) => reportingApi.listPresets(organizationId, signal), enabled: open, staleTime: 5_000, retry: false });
  const packages = useQuery({ queryKey: ["company-reporting", "packages", organizationId, refresh], queryFn: ({ signal }) => reportingApi.listPackages(organizationId, signal), enabled: open, staleTime: 5_000, retry: false });
  const savePreset = async () => {
    if (!latestRequest || !name.trim()) { setMessage("Run a report before saving its setup."); return; }
    const request: ReportPresetSaveRequest = { name: name.trim(), visibility: "private", reportId: latestRequest.reportId, definitionVersion: latestRequest.definitionVersion, scope: latestRequest.scope, filters: latestRequest.filters, period: latestRequest.period, basis: latestRequest.basis, currency: latestRequest.currency, consolidation: latestRequest.consolidation, forecast: latestRequest.forecast, columns: latestRequest.columns, sort: latestRequest.sort };
    try { await reportingApi.savePreset(organizationId, request); setName(""); setMessage("Saved"); setRefresh(value => value + 1); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save setup."); }
  };
  const savePackage = async () => {
    if (!latestRequest || !name.trim()) { setMessage("Run a report before saving a package."); return; }
    try { await reportingApi.savePackage(organizationId, packageInputFromRequest(latestRequest, name.trim())); setName(""); setMessage("Saved"); setRefresh(value => value + 1); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save package."); }
  };
  const runPackage = async (pkg: ReportPackage) => {
    try { setPackageRun(await reportingApi.runPackage(organizationId, pkg.id)); setMessage("Package run saved"); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not run package."); }
  };
  if (!open) return null;
  return <section className="reporting-saved" aria-label="Saved report setups"><div className="reporting-saved-actions"><input aria-label="Saved setup or package name" placeholder="Name" value={name} onChange={event => setName(event.currentTarget.value)} /><button type="button" onClick={() => void savePreset()} disabled={!latestRequest}>Save setup</button><button type="button" onClick={() => void savePackage()} disabled={!latestRequest}>Save package</button></div>{message && <div className="reporting-notice" role="status">{message}</div>}<div className="reporting-saved-columns"><div><h3>Saved setups</h3>{presets.isLoading ? <span>Loading…</span> : presets.error ? <span>Could not load setups.</span> : presets.data?.length ? <ul>{presets.data.map(preset => <li key={preset.id}><button type="button" onClick={() => onApply(requestFromPreset(preset))}>{preset.name}</button><span>Revision {preset.revision}</span></li>)}</ul> : <span>No saved setups.</span>}</div><div><h3>Packages</h3>{packages.isLoading ? <span>Loading…</span> : packages.error ? <span>Could not load packages.</span> : packages.data?.length ? <ul>{packages.data.map(pkg => <li key={pkg.id}><span>{pkg.name}</span><button type="button" onClick={() => void runPackage(pkg)}>Run</button><span>{pkg.items.length} report{pkg.items.length === 1 ? "" : "s"}</span></li>)}</ul> : <span>No saved packages.</span>}{packageRun && <div className="reporting-notice" role="status">Package {packageRun.state}. {packageRun.itemRuns.filter(item => item.state === "failed").length} failed.</div>}</div></div></section>;
}

export function ReportingWorkspace({ identity, organization, initialReportId, onNavigate, onOpenLegacy }: { identity: string; organization: CompanyContextOrganization; initialReportId?: string; onNavigate?: (organizationId: string, reportId?: string) => void; onOpenLegacy?: (reportId: string) => void }) {
  const catalog = useQuery({ queryKey: ["company-reporting", "catalog", identity, organization.id], queryFn: ({ signal }) => reportingApi.catalog(organization.id, signal), staleTime: 30_000, retry: false });
  const entries = catalog.data ?? [];
  const first = entries.find(entry => entry.id === initialReportId) ?? entries[0];
  const [selectedId, setSelectedId] = useState(initialReportId ?? "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<ReportPage>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>();
  const [savedOpen, setSavedOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState<ReportRunRequest>();
  const [setupRevision, setSetupRevision] = useState(0);
  const selected = entries.find(entry => entry.id === selectedId) ?? first;
  const filtered = useMemo(() => entries.filter(entry => !search.trim() || `${entry.title} ${entry.category}`.toLowerCase().includes(search.trim().toLowerCase())), [entries, search]);
  const run = async (request: ReportRunRequest) => { setLastRequest(request); setRunning(true); setError(undefined); setPage(undefined); try { const result = await reportingApi.run(organization.id, request); setPage(result.page); } catch (nextError) { setError(nextError); } finally { setRunning(false); } };
  const applySavedRequest = (request: ReportRunRequest) => { setSelectedId(request.reportId); setLastRequest(request); setSetupRevision(value => value + 1); setPage(undefined); setError(undefined); onNavigate?.(organization.id, request.reportId); };
  if (catalog.isLoading) return <div className="reporting-state" role="status">Loading reports…</div>;
  if (catalog.error) return <div className="reporting-state reporting-error" role="alert">{catalog.error instanceof Error ? catalog.error.message : "Report library could not be loaded."}</div>;
  return <div className="reporting-workspace"><aside className="reporting-library"><div className="reporting-library-header"><h2>Reports</h2><input aria-label="Search reports" placeholder="Search reports" value={search} onChange={event => setSearch(event.currentTarget.value)} /><button type="button" className="reporting-saved-toggle" onClick={() => setSavedOpen(value => !value)}>{savedOpen ? "Hide saved" : "Saved setups"}</button></div><div className="reporting-list">{filtered.map(entry => <button type="button" className={entry.id === selected?.id ? "is-selected" : ""} key={`${entry.id}:${entry.version}`} onClick={() => { setSelectedId(entry.id); setLastRequest(undefined); setPage(undefined); setError(undefined); onNavigate?.(organization.id, entry.id); }}>{entry.title}<span className={`reporting-status ${entry.executable ? "is-ready" : ""}`}>{entry.executable ? "Ready" : entry.runtimeStatus === "blocked" ? "Unavailable" : "Planned"}</span></button>)}</div></aside><main className="reporting-main"><SavedReports organizationId={organization.id} open={savedOpen} latestRequest={lastRequest} onApply={applySavedRequest} />{selected ? <><header className="reporting-heading"><div><span className="reporting-kicker">{label(selected.category)}</span><h1>{selected.title}</h1></div>{selected.executable ? null : <span className="reporting-unavailable">{selected.runtimeReason ?? "This report is not available yet."}</span>}</header>{selected.executable ? <ReportSetup key={`${selected.id}:${setupRevision}`} entry={selected} organization={organization} initialRequest={lastRequest} onRun={run} running={running} /> : <div className="reporting-empty">This report needs its listed source coverage and executable engine before it can run.</div>}{error && <div className="reporting-error" role="alert">{error instanceof ReportingApiError ? error.message : "Report could not be run."}</div>}{page && <Result organizationId={organization.id} page={page} onPage={setPage} />}</> : <div className="reporting-empty">Choose a report.</div>}</main></div>;
}
