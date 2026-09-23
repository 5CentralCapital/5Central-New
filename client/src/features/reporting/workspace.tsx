import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileDown, Printer, Search, Trash2 } from "lucide-react";
import type { CompanyContextOrganization } from "@shared/company/context";
import type { ReportEntry, ReportPackage, ReportPackageItem, ReportPackageRun, ReportPage, ReportPreset, ReportRunRequest } from "@shared/reporting";
import { describeReportPeriod, formatReportTotal, formatReportValue, reportStatusLabel, reportTotalLabel } from "@shared/reporting/format";
import { reportingApi, ReportingApiError } from "./api";
import { ReportSetup } from "./setup";
import { describeAppliedFilters } from "./setup-model";
import type { ReportPackageSaveRequest, ReportPresetSaveRequest } from "./types";
import { packageItemFromRequest, packageRunSummary, runtimeStatusLabel, type PackageDraft } from "./workspace-model";
import "./reporting.css";

const CATEGORY_LABELS: Readonly<Record<string, string>> = { financial: "Financial", rental: "Rental", tasks: "Tasks and work", projects: "Projects", investors: "Investors and owners", forecast: "Forecast" };

function requestFromPreset(preset: ReportPreset): ReportRunRequest {
  const current = preset.current;
  return { reportId: current.reportId, definitionVersion: current.definitionVersion, scope: current.scope, filters: current.filters, period: current.period, basis: current.basis, currency: current.currency, consolidation: current.consolidation, forecast: current.forecast, columns: current.columns.length ? current.columns : undefined, sort: current.sort.length ? current.sort : undefined };
}

function requestFromPackageItem(item: ReportPackageItem): ReportRunRequest {
  return { reportId: item.reportId, definitionVersion: item.definitionVersion, scope: item.scope, filters: item.filters, period: item.period, basis: item.basis, currency: item.currency, consolidation: item.consolidation, forecast: item.forecast, columns: item.columns.length ? item.columns : undefined, sort: item.sort.length ? item.sort : undefined };
}

function errorMessage(error: unknown, fallback: string): string { return error instanceof ReportingApiError || error instanceof Error ? error.message : fallback; }

async function downloadExport(organizationId: string, runId: string, format: "csv" | "json" | "html"): Promise<void> {
  const job = await reportingApi.export(organizationId, runId, format);
  if (job.content === null) return;
  const url = URL.createObjectURL(new Blob([job.content], { type: job.contentType }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = job.fileName; anchor.click();
  URL.revokeObjectURL(url);
}

async function printRun(organizationId: string, runId: string): Promise<void> {
  const job = await reportingApi.export(organizationId, runId, "html");
  if (job.content === null) return;
  const url = URL.createObjectURL(new Blob([job.content], { type: "text/html" }));
  const view = window.open(url, "_blank", "noopener");
  if (!view) { const anchor = document.createElement("a"); anchor.href = url; anchor.download = job.fileName; anchor.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Result({ organizationId, page, applied, title, onPage }: { organizationId: string; page: ReportPage; applied: readonly string[]; title: string; onPage: (page: ReportPage) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const next = async () => { if (!page.nextCursor) return; setLoading(true); try { onPage(await reportingApi.page(organizationId, page.runId, page.nextCursor)); } catch (nextError) { setError(errorMessage(nextError, "The next page could not be loaded.")); } finally { setLoading(false); } };
  const run = (work: () => Promise<void>) => { setError(undefined); void work().catch(workError => setError(errorMessage(workError, "The export could not be created."))); };
  const incomplete = page.coverage.filter(item => item.state !== "complete");
  const numeric = (type: string) => type === "money" || type === "integer" || type === "decimal" || type === "percent";
  return <section className="reporting-result" aria-label={`${title} results`}>
    <div className="reporting-result-bar">
      <div><strong>{page.totalRows.toLocaleString("en-US")} row{page.totalRows === 1 ? "" : "s"}</strong>{applied.length > 0 && <span className="reporting-applied">{applied.join(" · ")}</span>}</div>
      <div className="reporting-result-actions">
        <button type="button" className="reporting-quiet-button" onClick={() => run(() => printRun(organizationId, page.runId))}><Printer size={15} aria-hidden="true" />Print</button>
        <button type="button" className="reporting-quiet-button" onClick={() => run(() => downloadExport(organizationId, page.runId, "csv"))}><FileDown size={15} aria-hidden="true" />CSV</button>
        <button type="button" className="reporting-quiet-button" onClick={() => run(() => downloadExport(organizationId, page.runId, "json"))}>JSON</button>
        <button type="button" className="reporting-quiet-button" onClick={() => run(() => downloadExport(organizationId, page.runId, "html"))}>HTML</button>
      </div>
    </div>
    {error && <div className="reporting-error" role="alert">{error}</div>}
    {page.totals.length > 0 && <dl className="reporting-totals" aria-label="Report totals">{page.totals.map(total => <div key={total.key} className={total.state === "complete" ? "" : "is-incomplete"}><dt>{reportTotalLabel(total.key)}</dt><dd>{formatReportTotal(total)}{total.state !== "complete" && <small>{reportStatusLabel(total.state)}</small>}</dd></div>)}</dl>}
    {(incomplete.length > 0 || page.missingData.length > 0) && <details className="reporting-notice">
      <summary>{incomplete.length ? "Source coverage is incomplete" : "Some data is missing"}</summary>
      <ul>{incomplete.map(item => <li key={`coverage:${item.source}`}>{reportStatusLabel(item.source)}: {item.reason ?? reportStatusLabel(item.state)}</li>)}{page.missingData.map((item, index) => <li key={`${item.code}:${index}`}>{item.message}</li>)}</ul>
    </details>}
    {page.rows.length === 0
      ? <div className="reporting-empty-state"><h3>No rows</h3><p>No records matched this setup.</p></div>
      : <div className="reporting-table-wrap" tabIndex={0} aria-label={`${title} table`}><table><thead><tr>{page.columns.map(column => <th key={column.id} scope="col" className={numeric(column.type) ? "is-numeric" : ""}>{column.label}</th>)}</tr></thead><tbody>{page.rows.map(row => <tr key={row.rowId}>{page.columns.map(column => <td key={column.id} className={numeric(column.type) ? "is-numeric" : ""}>{formatReportValue(row.values[column.id], column, row.values)}</td>)}</tr>)}</tbody></table></div>}
    {page.nextCursor && <button type="button" className="reporting-quiet-button reporting-more" onClick={() => void next()} disabled={loading}>{loading ? "Loading…" : "Show more rows"}</button>}
  </section>;
}

function PackageRunView({ run, entries, onOpen }: { run: ReportPackageRun; entries: readonly ReportEntry[]; onOpen: (runId: string, title: string) => void }) {
  const summary = packageRunSummary(run);
  return <section className="reporting-package-run" aria-label="Package run">
    <header><h3>{summary.label}</h3><span className={`reporting-badge ${summary.complete ? "is-complete" : "is-incomplete"}`}>{summary.complete ? "Complete" : "Incomplete"}</span></header>
    <table><thead><tr><th scope="col">Report</th><th scope="col">Status</th><th scope="col" className="is-numeric">Rows</th><th scope="col">Detail</th><th scope="col"><span className="reporting-sr-only">Open</span></th></tr></thead>
      <tbody>{run.itemRuns.map(item => {
        const title = item.title ?? entries.find(entry => entry.id === item.reportId)?.title ?? item.itemId;
        const status = item.state === "failed" ? "Failed" : item.completeness === "complete" ? "Complete" : "Incomplete";
        return <tr key={item.itemId}><td>{title}</td><td><span className={`reporting-badge ${status === "Complete" ? "is-complete" : status === "Failed" ? "is-failed" : "is-incomplete"}`}>{status}</span></td><td className="is-numeric">{item.rowCount ?? "—"}</td><td>{item.reason ?? ""}</td><td>{item.runId && <button type="button" className="reporting-quiet-button" onClick={() => onOpen(item.runId!, title)}>View</button>}</td></tr>;
      })}</tbody>
    </table>
  </section>;
}

function PackageEditor({ organizationId, draft, entries, latestRequest, onChange, onSaved, onCancel }: { organizationId: string; draft: PackageDraft; entries: readonly ReportEntry[]; latestRequest?: ReportRunRequest; onChange: (draft: PackageDraft) => void; onSaved: () => void; onCancel: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const titleFor = (reportId: string) => entries.find(entry => entry.id === reportId)?.title ?? reportId;
  const move = (index: number, delta: number) => { const items = [...draft.items]; const [item] = items.splice(index, 1); items.splice(index + delta, 0, item!); onChange({ ...draft, items }); };
  const save = async () => {
    if (!draft.name.trim()) { setError("Name the package."); return; }
    if (!draft.items.length) { setError("Add at least one report."); return; }
    setSaving(true); setError(undefined);
    try {
      const request: ReportPackageSaveRequest = { ...(draft.id ? { id: draft.id, expectedRevision: draft.revision } : {}), name: draft.name.trim(), visibility: draft.visibility, items: draft.items };
      await reportingApi.savePackage(organizationId, request);
      onSaved();
    } catch (saveError) { setError(errorMessage(saveError, "The package could not be saved.")); } finally { setSaving(false); }
  };
  return <section className="reporting-package-editor" aria-label="Package editor">
    <div className="reporting-package-editor-head">
      <label className="reporting-field"><span className="reporting-field-label">Package name</span><input value={draft.name} onChange={event => onChange({ ...draft, name: event.currentTarget.value })} /></label>
      <label className="reporting-check"><input type="checkbox" checked={draft.visibility === "shared"} onChange={event => onChange({ ...draft, visibility: event.currentTarget.checked ? "shared" : "private" })} />Share with the company</label>
    </div>
    {draft.items.length === 0 ? <p className="reporting-inline-note">Run a report, then add it here.</p> : <ol className="reporting-package-items">{draft.items.map((item, index) => <li key={item.id ?? `${item.reportId}-${index}`}>
      <div><strong>{item.title ?? titleFor(item.reportId)}</strong><small>{describeReportPeriod(item.period)}</small></div>
      <div className="reporting-row-actions">
        <button type="button" className="reporting-icon-button" aria-label={`Move ${item.title ?? titleFor(item.reportId)} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
        <button type="button" className="reporting-icon-button" aria-label={`Move ${item.title ?? titleFor(item.reportId)} down`} disabled={index === draft.items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
        <button type="button" className="reporting-icon-button" aria-label={`Remove ${item.title ?? titleFor(item.reportId)}`} onClick={() => onChange({ ...draft, items: draft.items.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
      </div>
    </li>)}</ol>}
    {error && <div className="reporting-error" role="alert">{error}</div>}
    <div className="reporting-setup-actions">
      <button type="button" className="reporting-quiet-button" disabled={!latestRequest} onClick={() => latestRequest && onChange({ ...draft, items: [...draft.items, packageItemFromRequest(latestRequest, titleFor(latestRequest.reportId), draft.items)] })}>Add Current Report</button>
      <button type="button" className="reporting-quiet-button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save Package"}</button>
      <button type="button" className="reporting-quiet-button" onClick={onCancel} disabled={saving}>Cancel</button>
    </div>
  </section>;
}

function SavedReports({ organizationId, entries, latestRequest, onApply, onOpenRun }: { organizationId: string; entries: readonly ReportEntry[]; latestRequest?: ReportRunRequest; onApply: (request: ReportRunRequest) => void; onOpenRun: (runId: string, title: string) => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"setups" | "packages">("setups");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const [draft, setDraft] = useState<PackageDraft>();
  const [packageRun, setPackageRun] = useState<ReportPackageRun>();
  const [running, setRunning] = useState<string>();
  const presets = useQuery({ queryKey: ["company-reporting", "presets", organizationId], queryFn: ({ signal }) => reportingApi.listPresets(organizationId, signal), staleTime: 5_000, retry: false });
  const packages = useQuery({ queryKey: ["company-reporting", "packages", organizationId], queryFn: ({ signal }) => reportingApi.listPackages(organizationId, signal), staleTime: 5_000, retry: false, enabled: tab === "packages" });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["company-reporting"] });
  const savePreset = async () => {
    if (!latestRequest) { setMessage("Run a report before saving its setup."); return; }
    if (!name.trim()) { setMessage("Name the setup."); return; }
    const request: ReportPresetSaveRequest = { name: name.trim(), visibility: "private", reportId: latestRequest.reportId, definitionVersion: latestRequest.definitionVersion, scope: latestRequest.scope, filters: latestRequest.filters, period: latestRequest.period, basis: latestRequest.basis, currency: latestRequest.currency, consolidation: latestRequest.consolidation, forecast: latestRequest.forecast, columns: latestRequest.columns, sort: latestRequest.sort };
    try { await reportingApi.savePreset(organizationId, request); setName(""); setMessage("Setup saved."); refresh(); } catch (error) { setMessage(errorMessage(error, "The setup could not be saved.")); }
  };
  const runPackage = async (pkg: ReportPackage) => {
    setRunning(pkg.id); setMessage(undefined);
    try { setPackageRun(await reportingApi.runPackage(organizationId, pkg.id)); } catch (error) { setMessage(errorMessage(error, "The package could not be run.")); } finally { setRunning(undefined); }
  };
  return <section className="reporting-saved" aria-label="Saved reports">
    <div className="reporting-segmented" role="tablist" aria-label="Saved report views">
      <button type="button" role="tab" aria-selected={tab === "setups"} className={tab === "setups" ? "is-selected" : ""} onClick={() => setTab("setups")}>Saved setups</button>
      <button type="button" role="tab" aria-selected={tab === "packages"} className={tab === "packages" ? "is-selected" : ""} onClick={() => setTab("packages")}>Packages</button>
    </div>
    {message && <p className="reporting-inline-note" role="status">{message}</p>}
    {tab === "setups" ? <div role="tabpanel">
      <div className="reporting-saved-row"><input aria-label="Setup name" placeholder="Setup name" value={name} onChange={event => setName(event.currentTarget.value)} /><button type="button" className="reporting-quiet-button" onClick={() => void savePreset()} disabled={!latestRequest}>Save Setup</button></div>
      {presets.isLoading ? <p className="reporting-inline-note">Loading…</p> : presets.error ? <p className="reporting-inline-note">Saved setups could not be loaded.</p> : presets.data?.length ? <ul className="reporting-saved-list">{presets.data.map(preset => <li key={preset.id}><button type="button" className="reporting-link" onClick={() => onApply(requestFromPreset(preset))}>{preset.name}</button><small>{entries.find(entry => entry.id === preset.reportId)?.title ?? preset.reportId} · {describeReportPeriod(preset.current.period)}</small></li>)}</ul> : <p className="reporting-inline-note">No saved setups.</p>}
    </div> : <div role="tabpanel">
      {draft ? <PackageEditor organizationId={organizationId} draft={draft} entries={entries} latestRequest={latestRequest} onChange={setDraft} onCancel={() => setDraft(undefined)} onSaved={() => { setDraft(undefined); setMessage("Package saved."); refresh(); }} />
        : <div className="reporting-saved-row"><button type="button" className="reporting-quiet-button" onClick={() => setDraft({ name: "", visibility: "private", items: latestRequest ? [packageItemFromRequest(latestRequest, entries.find(entry => entry.id === latestRequest.reportId)?.title ?? latestRequest.reportId, [])] : [] })}>New Package</button></div>}
      {packages.isLoading ? <p className="reporting-inline-note">Loading…</p> : packages.error ? <p className="reporting-inline-note">Packages could not be loaded.</p> : packages.data?.length ? <ul className="reporting-saved-list">{packages.data.map(pkg => <li key={pkg.id}>
        <span><strong>{pkg.name}</strong><small>{pkg.items.length} report{pkg.items.length === 1 ? "" : "s"} · Revision {pkg.revision}</small></span>
        <span className="reporting-row-actions">
          <button type="button" className="reporting-quiet-button" onClick={() => setDraft({ id: pkg.id, revision: pkg.revision, name: pkg.name, visibility: pkg.visibility, items: pkg.items.map(item => ({ ...item })) })}>Edit</button>
          <button type="button" className="reporting-quiet-button" onClick={() => onApply(requestFromPackageItem(pkg.items[0]!))}>Open first</button>
          <button type="button" className="reporting-quiet-button" onClick={() => void runPackage(pkg)} disabled={running === pkg.id}>{running === pkg.id ? "Running…" : "Run"}</button>
        </span>
      </li>)}</ul> : !draft && <p className="reporting-inline-note">No packages.</p>}
      {packageRun && <PackageRunView run={packageRun} entries={entries} onOpen={onOpenRun} />}
    </div>}
  </section>;
}

export function ReportingWorkspace({ identity, organization, initialReportId, initialPresetId, onNavigate, onOpenLegacy: _onOpenLegacy }: { identity: string; organization: CompanyContextOrganization; initialReportId?: string; initialPresetId?: string; onNavigate?: (organizationId: string, reportId?: string) => void; onOpenLegacy?: (reportId: string) => void }) {
  const catalog = useQuery({ queryKey: ["company-reporting", "catalog", identity, organization.id], queryFn: ({ signal }) => reportingApi.catalog(organization.id, signal), staleTime: 30_000, retry: false });
  const entries = catalog.data ?? [];
  const [selectedId, setSelectedId] = useState(initialReportId ?? "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<{ page: ReportPage; applied: string[]; title: string }>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>();
  const [savedOpen, setSavedOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState<ReportRunRequest>();
  const [setupRevision, setSetupRevision] = useState(0);
  const selected = entries.find(entry => entry.id === selectedId) ?? entries.find(entry => entry.id === initialReportId) ?? entries.find(entry => entry.executable) ?? entries[0];
  const grouped = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const matches = entries.filter(entry => !term || `${entry.title} ${CATEGORY_LABELS[entry.category] ?? entry.category}`.toLocaleLowerCase().includes(term));
    return Object.keys(CATEGORY_LABELS).map(category => ({ category, items: matches.filter(entry => entry.category === category) })).filter(group => group.items.length);
  }, [entries, search]);
  const choose = (entry: ReportEntry) => { setSelectedId(entry.id); setLastRequest(undefined); setPage(undefined); setError(undefined); onNavigate?.(organization.id, entry.id); };
  const run = async (request: ReportRunRequest, labels: Readonly<Record<string, string>> = {}) => {
    setLastRequest(request); setRunning(true); setError(undefined); setPage(undefined);
    try {
      const result = await reportingApi.run(organization.id, request);
      const entry = entries.find(item => item.id === request.reportId);
      setPage({ page: result.page, applied: entry ? [describeReportPeriod(request.period), ...describeAppliedFilters(entry, request, organization, labels)] : [describeReportPeriod(request.period)], title: entry?.title ?? request.reportId });
    } catch (nextError) { setError(nextError); } finally { setRunning(false); }
  };
  const applySavedRequest = (request: ReportRunRequest) => { setSelectedId(request.reportId); setLastRequest(request); setSetupRevision(value => value + 1); setPage(undefined); setError(undefined); onNavigate?.(organization.id, request.reportId); };
  // A saved setup opened from Reporting › Saved reports is applied once, exactly as saved.
  const initialPreset = useQuery({ queryKey: ["company-reporting", "presets", organization.id], queryFn: ({ signal }) => reportingApi.listPresets(organization.id, signal), staleTime: 5_000, retry: false, enabled: Boolean(initialPresetId) });
  const appliedPreset = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialPresetId || appliedPreset.current === initialPresetId || !initialPreset.data) return;
    const preset = initialPreset.data.find(item => item.id === initialPresetId);
    appliedPreset.current = initialPresetId;
    if (preset) applySavedRequest(requestFromPreset(preset));
  }, [initialPresetId, initialPreset.data]);
  const openRun = async (runId: string, title: string) => {
    setError(undefined);
    try { setPage({ page: await reportingApi.page(organization.id, runId), applied: [], title }); } catch (nextError) { setError(nextError); }
  };
  if (catalog.isLoading) return <div className="reporting-state" role="status">Loading reports…</div>;
  if (catalog.error) return <div className="reporting-empty-state" role="alert"><h3>Reports Unavailable</h3><p>{catalog.error instanceof Error ? catalog.error.message : "The report library could not be loaded."}</p><button type="button" className="reporting-quiet-button" onClick={() => void catalog.refetch()}>Try Again</button></div>;
  return <div className="reporting-workspace">
    <aside className="reporting-library" aria-label="Report library">
      <div className="reporting-library-header">
        <h2>Reports</h2>
        <label className="reporting-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search reports" placeholder="Search" value={search} onChange={event => setSearch(event.currentTarget.value)} /></label>
        <button type="button" className="reporting-quiet-button" aria-expanded={savedOpen} onClick={() => setSavedOpen(value => !value)}>{savedOpen ? "Hide Saved" : "Saved and Packages"}</button>
      </div>
      <nav className="reporting-list" aria-label="Reports">{grouped.map(group => <div key={group.category} className="reporting-list-group"><h3>{CATEGORY_LABELS[group.category]}</h3>{group.items.map(entry => <button type="button" aria-current={entry.id === selected?.id ? "page" : undefined} className={entry.id === selected?.id ? "is-selected" : ""} key={`${entry.id}:${entry.version}`} onClick={() => choose(entry)}><span>{entry.title}</span>{!entry.executable && <span className={`reporting-status is-${entry.runtimeStatus}`}>{runtimeStatusLabel(entry.runtimeStatus)}</span>}</button>)}</div>)}{!grouped.length && <p className="reporting-inline-note">No matching reports.</p>}</nav>
    </aside>
    <main className="reporting-main">
      {savedOpen && <SavedReports organizationId={organization.id} entries={entries} latestRequest={lastRequest} onApply={applySavedRequest} onOpenRun={(runId, title) => void openRun(runId, title)} />}
      {selected ? <>
        <header className="reporting-heading"><div><span className="reporting-kicker">{CATEGORY_LABELS[selected.category] ?? reportStatusLabel(selected.category)}</span><h1>{selected.title}</h1></div></header>
        {selected.executable
          ? <ReportSetup key={`${selected.id}:${setupRevision}`} entry={selected} organization={organization} initialRequest={lastRequest} onRun={(request, labels) => void run(request, labels)} running={running} />
          : <div className="reporting-empty-state"><h3>{runtimeStatusLabel(selected.runtimeStatus)}</h3><p>{selected.runtimeReason ?? "This report cannot run yet."}</p><button type="button" className="reporting-quiet-button" onClick={() => void catalog.refetch()}>Check Again</button></div>}
        {error !== undefined && <div className="reporting-error" role="alert">{errorMessage(error, "The report could not be run.")}</div>}
        {page && <Result organizationId={organization.id} page={page.page} applied={page.applied} title={page.title} onPage={next => setPage(current => current ? { ...current, page: { ...next, rows: [...current.page.rows, ...next.rows] } } : current)} />}
      </> : <div className="reporting-empty-state"><h3>No Reports</h3><p>No reports are available for this company.</p></div>}
    </main>
  </div>;
}
