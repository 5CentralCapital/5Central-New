import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { loadDashboardCash, loadDashboardTrends, loadRentOpsReport, loadRentOpsWorkspaceCollection } from "../api";
import { useRentOpsAuth } from "../auth-ui";
import type { DashboardWorkspaceProps } from "./dashboard-workspace";
import { EntityLink, RecordLink, entityHref, shouldHandleEntityClick } from "./entity-link";
import { createReportViewModel, formatReportValue, overdueDateAbsentLabel, readReportValue, reportQueryFilters, reportQueryKey } from "./report-model";
import { workspaceApiFilters } from "./workspace-state";
import { DashboardChart } from "./dashboard-chart";
import { useReportSearch } from "./use-report-search";
import { recentOnlineApplications, dashboardMovements } from "./dashboard-tiles";
import { ApplicationCaseDetail } from "../application-case-detail";
import { dashboardKpis, splitDueRows } from "./dashboard-kpis";
import { rentalAttentionItems } from "./dashboard-attention";
import { Skeleton } from "./ops-ui";
import { displayPersonName, formatMonthLabel, formatTableDate, formatTimestamp } from "../../../lib/rent-ops-formatters";
import "./rm-dashboard.css";
import { UNKNOWN_AMOUNT_LABEL } from "@shared/review-cases/display-labels";

type Row = Record<string, unknown>;
type Column = { key: string; label: string; number?: boolean; render?: (row: Row) => ReactNode };
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const money = (value: unknown) => numeric(value) ? formatReportValue(value, "currency") : "—";
const text = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);

function Panel({ title, className = "", children, onOpen, action }: { title: string; className?: string; children: ReactNode; onOpen?: () => void; action?: ReactNode }) {
  return <section className={`rmd-panel ${className}`} aria-label={title}><header className="rmd-panel-header"><h2>{title}</h2>{action && <span className="rops-panel-action">{action}</span>}{onOpen && <button type="button" onClick={onOpen} title={`Open ${title}`} aria-label={`Open ${title}`}><ArrowUpRight size={13} /></button>}</header>{children}</section>;
}
function Table({ rows, columns, empty = "No records.", footer, limit, onMore, moreLabel }: { rows?: Row[]; columns: Column[]; empty?: string; footer?: ReactNode; limit?: number; onMore?: () => void; moreLabel?: (count: number) => string }) {
  const [sort, setSort] = useState<{ key: string; direction: number }>();
  const ordered = useMemo(() => !sort ? rows : [...(rows ?? [])].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (numeric(left) && numeric(right) ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })) * sort.direction;
  }), [rows, sort]);
  const shown = limit && ordered ? ordered.slice(0, limit) : ordered;
  const hidden = limit && ordered ? ordered.length - (shown?.length ?? 0) : 0;
  return <><div className="rmd-table-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} className={column.number ? "number" : ""} aria-sort={sort?.key === column.key ? sort.direction === 1 ? "ascending" : "descending" : "none"}><button type="button" onClick={() => setSort(current => ({ key: column.key, direction: current?.key === column.key ? -current.direction : 1 }))}>{column.label}{sort?.key === column.key ? sort.direction === 1 ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>
    {!rows ? <tr><td colSpan={columns.length} className="rmd-empty">Loading…</td></tr> : !ordered?.length ? <tr><td colSpan={columns.length} className="rmd-empty">{empty}</td></tr> : shown!.map((row, index) => <tr key={String(row.id ?? row.unitId ?? row.propertyId ?? "row") + index}>{columns.map(column => <td key={column.key} className={column.number ? "number" : ""}>{column.render ? column.render(row) : text(row[column.key])}</td>)}</tr>)}
  </tbody></table></div>{hidden > 0 && onMore && <div className="rops-table-more"><button type="button" className="rops-link" onClick={onMore}>{moreLabel ? moreLabel(ordered!.length) : `View all ${ordered!.length}`}</button></div>}{footer && <div className="rmd-table-total">{footer}</div>}</>;
}
function Notes({ identity }: { identity: string }) {
  const key = `rent-ops-dashboard-note:${identity}`;
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { try { const note = localStorage.getItem(key) ?? ""; setValue(note); setSaved(note); } catch { setValue(""); setSaved(""); } setMessage(""); }, [key]);
  return <Panel title="Notes" className="rmd-notes rops-dash-notes"><textarea aria-label="Dashboard notes" placeholder="Add a dashboard note…" value={value} onChange={event => { setValue(event.target.value); setMessage(""); }} maxLength={10000} /><div className="rmd-note-actions"><span role="status">{message || "Saved in this browser only"}</span><button type="button" disabled={value === saved} onClick={() => { try { localStorage.setItem(key, value); setSaved(value); setMessage("Saved in this browser"); } catch { setMessage("Could not save. Try again."); } }}>Save</button><button type="button" disabled={value === saved} onClick={() => { setValue(saved); setMessage(""); }}>Cancel</button></div></Panel>;
}

export function RmDashboard({ snapshot, filters, onReport, onOpenTenant, onOpenUnit, onOpenProperty, previews, refreshing = false, onManageMoves, companyPanels }: DashboardWorkspaceProps) {
  const auth = useRentOpsAuth();
  const enabled = auth.status === "authenticated" && !!auth.user?.id;
  const identity = auth.user?.id ?? "";
  const apiFilters = workspaceApiFilters(filters);
  const { debouncedSearch, searchPending } = useReportSearch(filters.search);
  const bundled = !!previews && !filters.search.trim() && filters.status === "all";
  const reports = ["rent-roll", "delinquency", "collected-income", "occupancy"] as const;
  const requests = useQueries({ queries: reports.map(report => {
    const query = reportQueryFilters({ ...filters, search: debouncedSearch }, report, { asOfDate: filters.asOfDate });
    return { queryKey: reportQueryKey(report, query, identity), queryFn: ({ signal }: { signal: AbortSignal }) => loadRentOpsReport(report, query, signal), enabled: enabled && !searchPending && !(bundled && (report === "rent-roll" || report === "delinquency")), staleTime: 30_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true };
  }) });
  const rowsFor = (report: typeof reports[number]): Row[] | undefined => {
    if (searchPending) return undefined;
    const raw = bundled && (report === "rent-roll" || report === "delinquency") ? previews![report] : requests[reports.indexOf(report)].data;
    return raw ? createReportViewModel(report, raw, snapshot).displayRows.map(row => ({ ...row, ...Object.fromEntries(["propertyId", "unitId", "personId", "tenancyId", "currentPersonId", "futurePersonId", "occupancy", "operationalBalanceCents", "actualMoveInOn", "expectedMoveOutOn", "oldestUnpaidRentOn"].map(key => [key, readReportValue(row.__source, key)])) })) : undefined;
  };
  const rentRoll = rowsFor("rent-roll");
  const dueRows = rowsFor("delinquency")?.filter(row => !numeric(row.operationalBalanceCents) || row.operationalBalanceCents > 0).sort((a, b) => (numeric(b.operationalBalanceCents) ? b.operationalBalanceCents : -1) - (numeric(a.operationalBalanceCents) ? a.operationalBalanceCents : -1));
  const dueSplit = dueRows ? splitDueRows(dueRows) : undefined;
  const receiptRows = rowsFor("collected-income");
  const receiptGroups = new Map<string, Row>();
  for (const row of receiptRows ?? []) {
    if (row.category !== "base_rent") continue;
    const key = `${row.personId ?? row.tenantName}:${row.propertyId}:${row.paymentOn}`;
    const previous = receiptGroups.get(key);
    receiptGroups.set(key, previous ? { ...previous, amountCents: numeric(previous.amountCents) && numeric(row.amountCents) ? previous.amountCents + row.amountCents : null } : row);
  }
  const receipts = receiptRows ? Array.from(receiptGroups.values()).sort((a, b) => text(b.paymentOn).localeCompare(text(a.paymentOn))) : undefined;
  const applicationQuery = useQuery({ queryKey: ["rent-ops-workspace", "collection", "applications", identity, filters.propertyScope, filters.propertyId, [...(filters.propertyIds ?? [])].sort(), filters.asOfDate], queryFn: ({ signal }) => loadRentOpsWorkspaceCollection("applications", apiFilters, signal), enabled, staleTime: 60_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true });
  const applications = applicationQuery.data ? recentOnlineApplications(applicationQuery.data, snapshot, filters) : undefined;
  const [applicationId, setApplicationId] = useState<string>();
  const selectedApplication = applications?.find(application => application.id === applicationId);
  const occupancy = rowsFor("occupancy");
  const daysVacant = new Map(occupancy?.map(row => [row.unitId, row.daysVacant]) ?? []);
  const vacancy = rentRoll?.filter(row => row.occupancy === "vacant" || row.occupancy === "future_preleased").map(row => {
    const unit = snapshot.snapshot.units.find(unit => unit.id === row.unitId);
    const layout = unit?.bedrooms != null && unit?.bathrooms != null ? `${unit.bedrooms}B/${unit.bathrooms}B` : unit?.bedrooms != null ? `${unit.bedrooms} bed` : unit?.bathrooms != null ? `${unit.bathrooms} bath` : "";
    return { ...row, daysVacant: daysVacant.get(row.unitId), type: layout || unit?.unitType };
  });
  const propertyRows = useMemo(() => {
    if (!rentRoll) return undefined;
    const groups = new Map<string, Row>();
    for (const row of rentRoll) {
      const id = String(row.propertyId);
      const group = groups.get(id) ?? { propertyId: id, propertyName: row.propertyName, unitCount: 0, occupied: 0, vacant: 0, unknown: 0, preleased: 0, rent: 0, rentUnknown: 0 };
      group.unitCount = Number(group.unitCount) + 1;
      if (row.occupancy === "current") { group.occupied = Number(group.occupied) + 1; if (numeric(row.baseRentCents)) group.rent = Number(group.rent) + row.baseRentCents; else group.rentUnknown = Number(group.rentUnknown) + 1; }
      else if (row.occupancy === "vacant" || row.occupancy === "future_preleased") { group.vacant = Number(group.vacant) + 1; if (row.occupancy === "future_preleased") group.preleased = Number(group.preleased) + 1; }
      else group.unknown = Number(group.unknown) + 1;
      groups.set(id, group);
    }
    return Array.from(groups.values()).map<Row>(row => ({ ...row, vacancyRate: row.unknown ? null : 100 * Number(row.vacant) / Number(row.unitCount) }));
  }, [rentRoll]);
  const trends = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-trends", identity, apiFilters], queryFn: ({ signal }) => loadDashboardTrends(apiFilters, signal), enabled, staleTime: 60_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true });
  const cash = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-cash", identity], queryFn: ({ signal }) => loadDashboardCash(signal), enabled, staleTime: 60_000, gcTime: 60_000, retry: false, refetchOnWindowFocus: true });
  const propertyLink = (row: Row) => <RecordLink kind="property" recordId={String(row.propertyId ?? "")} onOpen={onOpenProperty}>{text(row.propertyName)}</RecordLink>;
  const unitLink = (row: Row) => <RecordLink kind="unit" recordId={String(row.unitId ?? "")} onOpen={onOpenUnit}>{text(row.unitNumber)}</RecordLink>;
  const personLink = (row: Row) => <EntityLink personId={String(row.currentPersonId ?? row.personId ?? row.futurePersonId ?? "")} onOpen={onOpenTenant}>{text(row.tenantName ?? row.currentTenantName ?? row.futureTenantName)}</EntityLink>;
  const propertyColumn: Column = { key: "propertyName", label: "Property", render: propertyLink };
  const unitColumn: Column = { key: "unitNumber", label: "Unit", render: unitLink };
  const amountColumn = (key: string, label: string): Column => ({ key, label, number: true, render: row => money(row[key]) });
  const total = (rows: Row[] | undefined, key: string) => !rows || rows.some(row => !numeric(row[key])) ? undefined : rows.reduce((sum, row) => sum + Number(row[key]), 0);
  const movements = dashboardMovements(snapshot, filters);
  const errors = requests.flatMap((request, index) => request.error && !(bundled && index < 2) ? [reports[index]] : []);
  const cashReady = cash.data?.state === "ready" ? cash.data : undefined;
  const year = Number(filters.asOfDate.slice(0, 4));
  const shortDate = (value: unknown) => formatTableDate(value, year) ?? text(value);
  const attention = rentalAttentionItems({ dueRows, vacancy, movements, asOfDate: filters.asOfDate });
  const knownDue = dueRows?.filter(row => numeric(row.operationalBalanceCents));
  const unverifiedDue = dueRows ? dueRows.length - (knownDue?.length ?? 0) : 0;
  const vacancySorted = vacancy ? [...vacancy].sort((a, b) => (numeric(b.daysVacant) ? b.daysVacant : -1) - (numeric(a.daysVacant) ? a.daysVacant : -1)) : undefined;
  const longestVacancy = (propertyId: unknown) => {
    const days = ((vacancy ?? []) as Row[]).filter(row => row.propertyId === propertyId && numeric(row.daysVacant)).map(row => row.daysVacant as number);
    return days.length ? Math.max(...days) : undefined;
  };
  const kpis = dashboardKpis({ propertyRows, dueRows, receipts, period: filters.asOfDate.slice(0, 7) });
  const monthLabel = formatMonthLabel(filters.asOfDate.slice(0, 7)) ?? filters.asOfDate.slice(0, 7);
  const [metric, setMetric] = useState<"vacancy" | "occupancy" | "rent">("vacancy");
  return <section className="rm-dashboard-workspace rmd-dashboard rops-dash" aria-label="Dashboard">
    {errors.length > 0 && <div className="rmd-load-error" role="alert">Some tables could not be loaded. <button onClick={() => { requests.forEach(request => { if (request.error) void request.refetch(); }); }}>Retry</button></div>}
    <ul className="rops-kpis" aria-label="Portfolio summary">{kpis.map(kpi => <li key={kpi.key} className="rops-kpi" data-tone={kpi.tone}><span className="rops-kpi-label">{kpi.label}</span><strong className="rops-kpi-value">{kpi.tone === "loading" ? <Skeleton width="4.5em" label={`Loading ${kpi.label.toLowerCase()}`} /> : kpi.value}</strong>{kpi.share !== undefined && <span className="rops-kpi-meter" aria-hidden="true"><i style={{ width: `${Math.round(kpi.share * 100)}%` }} /></span>}<span className="rops-kpi-detail">{kpi.detail}</span></li>)}</ul>
    <div className="rops-dash-row rops-dash-row--attention">
      <Panel title="Needs attention" className="rops-dash-attention">
        <ul className="rops-attention" aria-label="Needs attention">
          {!dueRows && !vacancy ? <li className="rops-attention-row"><span className="rops-attention-stripe" /><span><Skeleton width="14em" /></span></li> : null}
          {attention.map(item => <li key={item.key} className="rops-attention-row" data-tone={item.tone}><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
            {item.key === "balances" && <button type="button" className="rm-button rm-button--small" onClick={() => onReport("delinquency")}>Open balances</button>}
            {item.key === "vacancy" && <button type="button" className="rm-button rm-button--small" onClick={() => onReport("occupancy")}>Open vacancies</button>}
            {item.key === "moves" && <button type="button" className="rm-button rm-button--small" onClick={() => onReport("lease-expiration")}>Plan turns</button>}
          </li>)}
          {companyPanels}
          {dueRows && vacancy && !attention.length && <li className="rops-attention-row" data-tone="positive"><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><small>No balances due, vacancies or upcoming moves.</small></span></li>}
        </ul>
      </Panel>
      <Panel title="Balances due" className="rops-dash-balances" onOpen={() => onReport("delinquency")}>
        <Table rows={knownDue} limit={6} empty="No balances due." onMore={() => onReport("delinquency")} moreLabel={count => `View all ${count + unverifiedDue}${unverifiedDue ? `, including ${unverifiedDue} not verified` : ""}`} columns={[
          { key: "tenantName", label: "Tenant", render: row => <span className="rops-cell-stack">{personLink(row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span> },
          { key: "oldestUnpaidRentOn", label: "Oldest", render: row => row.oldestUnpaidRentOn ? shortDate(row.oldestUnpaidRentOn) : overdueDateAbsentLabel((row.__source ?? row) as Row) },
          { ...amountColumn("operationalBalanceCents", "Amount"), render: row => <EntityLink personId={String(row.personId ?? "")} tab="ledger" onOpen={onOpenTenant}>{money(row.operationalBalanceCents)}</EntityLink> },
        ]} footer={dueSplit ? <><span>{dueSplit.knownCount} {dueSplit.knownCount === 1 ? "account" : "accounts"}{dueSplit.unverifiedCount ? ` · ${dueSplit.unverifiedCount} not verified` : ""}</span><strong>{money(dueSplit.knownCents)}</strong></> : undefined} />
      </Panel>
    </div>
    <div className="rops-dash-row">
      <Panel title="Units by property" className="rops-dash-units" onOpen={() => onReport("occupancy")}>
        {!propertyRows ? <p className="rmd-empty"><Skeleton width="12em" /></p> : !propertyRows.length ? <p className="rmd-empty">No units in the selected properties.</p> : <ul className="rops-unit-bars">
          {propertyRows.map(row => { const units = Number(row.unitCount) || 0; const occupied = Number(row.occupied) || 0; const longest = longestVacancy(row.propertyId); return <li key={String(row.propertyId)}>
            <span className="rops-cell-stack">{propertyLink(row)}<small>{Number(row.vacant) || 0} vacant{row.preleased ? ` · ${row.preleased} preleased` : ""}{longest !== undefined ? ` · longest ${longest} days` : ""}{row.unknown ? ` · ${row.unknown} unknown` : ""}</small></span>
            <span className="rops-unit-track" aria-hidden="true"><i style={{ width: `${units ? occupied / units * 100 : 0}%` }} /></span>
            <span className="number">{occupied} / {units}</span>
          </li>; })}
        </ul>}
        <div className="rmd-table-total"><button type="button" className="rops-link" onClick={() => onReport("occupancy")}>Vacancy list</button><strong>{total(propertyRows, "occupied") ?? "—"} / {total(propertyRows, "unitCount") ?? "—"} occupied</strong></div>
      </Panel>
      {cashReady ? <Panel title="Cash" className="rops-dash-cash">
        <table className="rops-cash-table"><tbody>
          <tr><td>{text(cashReady.name)} · {text(cashReady.mask)}<small>Current balance</small></td><td className="number">{money(cashReady.currentCents)}</td></tr>
          <tr><td>Available</td><td className="number"><strong>{money(cashReady.availableCents)}</strong></td></tr>
          <tr><td>Posted rent receipts · {monthLabel}</td><td className="number">{money(total(receipts, "amountCents"))}</td></tr>
        </tbody></table>
        <div className="rmd-table-total"><span>Checked {formatTimestamp(new Date(cashReady.checkedAt)) ?? ""}</span><button type="button" className="rops-link" title="Refresh cash balance" disabled={cash.isFetching} onClick={() => void cash.refetch()}><RefreshCw size={12} aria-hidden="true" /> Refresh</button></div>
      </Panel>
      : <Panel title="Rent roll by property" className="rops-dash-cash" onOpen={() => onReport("rent-roll")}><Table rows={propertyRows} columns={[propertyColumn, { key: "rent", label: "Base rent", number: true, render: row => row.rentUnknown || row.unknown ? UNKNOWN_AMOUNT_LABEL : money(row.rent) }]} footer={<><span>Occupied base rent</span><strong>{propertyRows?.some(row => row.rentUnknown || row.unknown) ? UNKNOWN_AMOUNT_LABEL : money(total(propertyRows, "rent"))}</strong></>} /></Panel>}
    </div>
    <div className="rops-dash-row rops-dash-row--wide">
      <DashboardChart metric={metric} onMetric={setMetric} data={trends.data} loading={trends.isFetching} error={trends.error?.message} onRetry={() => void trends.refetch()} />
    </div>
    <div className="rops-dash-row rops-dash-row--thirds">
      <Panel title="Vacancy list" onOpen={() => onReport("occupancy")}><Table rows={vacancySorted} limit={6} onMore={() => onReport("occupancy")} moreLabel={count => `View all ${count}`} empty="No vacant units." columns={[{ key: "unitNumber", label: "Unit", render: row => <span className="rops-cell-stack">{unitLink(row)}<small>{text(row.propertyName)}{row.type ? ` · ${text(row.type)}` : ""}</small></span> }, amountColumn("marketRentCents", "Rent"), { key: "daysVacant", label: "Days", number: true, render: row => numeric(row.daysVacant) ? String(row.daysVacant) : "—" }]} footer={<span>{vacancy?.length ?? "—"} vacant · {total(propertyRows, "preleased") ?? "—"} preleased</span>} /></Panel>
      <Panel title="Moves this month" onOpen={() => onReport("lease-expiration")} action={onManageMoves && <button type="button" className="rm-button rm-button--small" onClick={onManageMoves}>Record move</button>}><Table rows={movements} limit={6} onMore={() => onReport("lease-expiration")} moreLabel={count => `View all ${count}`} empty="No moves recorded for this month." columns={[{ key: "tenantName", label: "Tenant", render: row => <span className="rops-cell-stack">{personLink(row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span> }, { key: "date", label: "Date", render: row => shortDate(row.date) }, { key: "movement", label: "Move", render: row => <span className="rops-cell-stack"><span>{text(row.movement)}</span><small>{text(row.state)}</small></span> }]} footer={<span>{monthLabel} · completed and upcoming</span>} /></Panel>
      {applications && applications.length > 0 || applicationQuery.error ? <Panel title="Recent online applications" onOpen={() => onReport("applicant-pipeline")}><Table rows={applicationQuery.error ? [] : applications} limit={6} onMore={() => onReport("applicant-pipeline")} moreLabel={count => `View all ${count}`} empty={applicationQuery.error ? "Online applications could not be loaded." : "No online applications received in the last 30 days."} columns={[{ key: "displayName", label: "Applicant", render: row => <span className="rops-cell-stack"><a className="rm-entity-link" href={entityHref({ section: "applicants", recordId: String(row.id), tab: "summary", report: "applicant-pipeline" })} onClick={event => { if (shouldHandleEntityClick(event)) { event.preventDefault(); setApplicationId(String(row.id)); } }}>{displayPersonName(text(row.displayName))}</a><small>{text(row.propertyName)}</small></span> }, { key: "submittedOn", label: "Date", render: row => shortDate(row.submittedOn) }, { key: "status", label: "Status", render: row => text(row.status).replaceAll("_", " ") }]} /></Panel>
      : <Notes identity={identity} />}
    </div>
    {applications && applications.length > 0 && <div className="rops-dash-row rops-dash-row--thirds"><Notes identity={identity} /></div>}
    {applicationId && selectedApplication && <ApplicationCaseDetail key={applicationId} applicationId={applicationId} summary={selectedApplication} onClose={() => setApplicationId(undefined)} />}
    {refreshing && <div className="rmd-refreshing" role="status">Refreshing dashboard…</div>}
  </section>;
}
