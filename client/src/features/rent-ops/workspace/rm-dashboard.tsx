import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { loadDashboardCash, loadDashboardTrends, loadRentOpsReport } from "../api";
import { useRentOpsAuth } from "../auth-ui";
import type { DashboardWorkspaceProps } from "./dashboard-workspace";
import { EntityLink, RecordLink } from "./entity-link";
import { createReportViewModel, formatReportValue, readReportValue, reportQueryFilters, reportQueryKey } from "./report-model";
import { workspaceApiFilters, workspacePropertyMatches } from "./workspace-state";
import { DashboardChart } from "./dashboard-chart";
import { useReportSearch } from "./use-report-search";
import "./rm-dashboard.css";

type Row = Record<string, unknown>;
type Column = { key: string; label: string; number?: boolean; render?: (row: Row) => ReactNode };
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const money = (value: unknown) => numeric(value) ? formatReportValue(value, "currency") : "—";
const text = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);

function Panel({ title, className = "", children, onOpen }: { title: string; className?: string; children: ReactNode; onOpen?: () => void }) {
  return <section className={`rmd-panel ${className}`} aria-label={title}><header className="rmd-panel-header"><h2>{title}</h2>{onOpen && <button type="button" onClick={onOpen} title={`Open ${title}`} aria-label={`Open ${title}`}><ArrowUpRight size={13} /></button>}</header>{children}</section>;
}
function Table({ rows, columns, empty = "No records.", footer }: { rows?: Row[]; columns: Column[]; empty?: string; footer?: ReactNode }) {
  const [sort, setSort] = useState<{ key: string; direction: number }>();
  const ordered = useMemo(() => !sort ? rows : [...(rows ?? [])].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (numeric(left) && numeric(right) ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })) * sort.direction;
  }), [rows, sort]);
  return <><div className="rmd-table-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} className={column.number ? "number" : ""} aria-sort={sort?.key === column.key ? sort.direction === 1 ? "ascending" : "descending" : "none"}><button type="button" onClick={() => setSort(current => ({ key: column.key, direction: current?.key === column.key ? -current.direction : 1 }))}>{column.label}{sort?.key === column.key ? sort.direction === 1 ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>
    {!rows ? <tr><td colSpan={columns.length} className="rmd-empty">Loading…</td></tr> : !ordered?.length ? <tr><td colSpan={columns.length} className="rmd-empty">{empty}</td></tr> : ordered.map((row, index) => <tr key={String(row.id ?? row.unitId ?? row.propertyId ?? "row") + index}>{columns.map(column => <td key={column.key} className={column.number ? "number" : ""}>{column.render ? column.render(row) : text(row[column.key])}</td>)}</tr>)}
  </tbody></table></div>{footer && <div className="rmd-table-total">{footer}</div>}</>;
}
function Notes({ identity }: { identity: string }) {
  const key = `rent-ops-dashboard-note:${identity}`;
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { try { const note = localStorage.getItem(key) ?? ""; setValue(note); setSaved(note); } catch { setValue(""); setSaved(""); } setMessage(""); }, [key]);
  return <Panel title="Notes" className="rmd-notes"><textarea aria-label="Dashboard notes" placeholder="Add a dashboard note…" value={value} onChange={event => { setValue(event.target.value); setMessage(""); }} maxLength={10000} /><div className="rmd-note-actions"><span role="status">{message || "This browser"}</span><button type="button" disabled={value === saved} onClick={() => { try { localStorage.setItem(key, value); setSaved(value); setMessage("Saved in this browser"); } catch { setMessage("Could not save. Try again."); } }}>Save</button><button type="button" disabled={value === saved} onClick={() => { setValue(saved); setMessage(""); }}>Cancel</button></div></Panel>;
}

export function RmDashboard({ snapshot, filters, onReport, onOpenTenant, onOpenUnit, onOpenProperty, previews, refreshing = false }: DashboardWorkspaceProps) {
  const auth = useRentOpsAuth();
  const enabled = auth.status === "authenticated" && !!auth.user?.id;
  const identity = auth.user?.id ?? "";
  const apiFilters = workspaceApiFilters(filters);
  const { debouncedSearch, searchPending } = useReportSearch(filters.search);
  const bundled = !!previews && !filters.search.trim() && filters.status === "all";
  const reports = ["rent-roll", "delinquency", "collected-income", "applicant-pipeline", "occupancy"] as const;
  const requests = useQueries({ queries: reports.map(report => {
    const query = reportQueryFilters({ ...filters, search: debouncedSearch }, report, { asOfDate: filters.asOfDate });
    return { queryKey: reportQueryKey(report, query, identity), queryFn: ({ signal }: { signal: AbortSignal }) => loadRentOpsReport(report, query, signal), enabled: enabled && !searchPending && !(bundled && (report === "rent-roll" || report === "delinquency")), staleTime: 30_000, gcTime: 300_000, retry: false };
  }) });
  const rowsFor = (report: typeof reports[number]): Row[] | undefined => {
    if (searchPending) return undefined;
    const raw = bundled && (report === "rent-roll" || report === "delinquency") ? previews![report] : requests[reports.indexOf(report)].data;
    return raw ? createReportViewModel(report, raw, snapshot).displayRows.map(row => ({ ...row, ...Object.fromEntries(["propertyId", "unitId", "personId", "tenancyId", "currentPersonId", "futurePersonId", "occupancy", "operationalBalanceCents", "actualMoveInOn", "expectedMoveOutOn"].map(key => [key, readReportValue(row.__source, key)])) })) : undefined;
  };
  const rentRoll = rowsFor("rent-roll");
  const dueRows = rowsFor("delinquency")?.filter(row => !numeric(row.operationalBalanceCents) || row.operationalBalanceCents > 0).sort((a, b) => (numeric(b.operationalBalanceCents) ? b.operationalBalanceCents : -1) - (numeric(a.operationalBalanceCents) ? a.operationalBalanceCents : -1));
  const receiptRows = rowsFor("collected-income");
  const receiptGroups = new Map<string, Row>();
  for (const row of receiptRows ?? []) {
    if (row.category !== "base_rent") continue;
    const key = `${row.personId}:${row.propertyId}:${row.paymentOn}`;
    const previous = receiptGroups.get(key);
    receiptGroups.set(key, previous ? { ...previous, amountCents: numeric(previous.amountCents) && numeric(row.amountCents) ? previous.amountCents + row.amountCents : null } : row);
  }
  const receipts = receiptRows ? Array.from(receiptGroups.values()).sort((a, b) => text(b.paymentOn).localeCompare(text(a.paymentOn))) : undefined;
  const recentFrom = new Date(`${filters.asOfDate}T12:00:00Z`); recentFrom.setUTCDate(recentFrom.getUTCDate() - 30);
  const applications = rowsFor("applicant-pipeline")?.filter(row => typeof row.submittedOn === "string" && row.submittedOn >= recentFrom.toISOString().slice(0, 10) && row.submittedOn <= filters.asOfDate).sort((a, b) => text(b.submittedOn).localeCompare(text(a.submittedOn)));
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
  const trends = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-trends", identity, apiFilters], queryFn: ({ signal }) => loadDashboardTrends(apiFilters, signal), enabled, staleTime: 60_000, gcTime: 300_000, retry: false });
  const cash = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-cash", identity], queryFn: ({ signal }) => loadDashboardCash(signal), enabled, staleTime: 60_000, gcTime: 60_000, retry: false });
  const propertyLink = (row: Row) => <RecordLink kind="property" recordId={String(row.propertyId ?? "")} onOpen={onOpenProperty}>{text(row.propertyName)}</RecordLink>;
  const unitLink = (row: Row) => <RecordLink kind="unit" recordId={String(row.unitId ?? "")} onOpen={onOpenUnit}>{text(row.unitNumber)}</RecordLink>;
  const personLink = (row: Row) => <EntityLink personId={String(row.currentPersonId ?? row.personId ?? row.futurePersonId ?? "")} onOpen={onOpenTenant}>{text(row.tenantName ?? row.currentTenantName ?? row.futureTenantName)}</EntityLink>;
  const propertyColumn: Column = { key: "propertyName", label: "Property", render: propertyLink };
  const unitColumn: Column = { key: "unitNumber", label: "Unit", render: unitLink };
  const amountColumn = (key: string, label: string): Column => ({ key, label, number: true, render: row => money(row[key]) });
  const total = (rows: Row[] | undefined, key: string) => !rows || rows.some(row => !numeric(row[key])) ? undefined : rows.reduce((sum, row) => sum + Number(row[key]), 0);
  const movements = snapshot.snapshot.tenancies.flatMap(tenancy => {
    const property = snapshot.snapshot.properties.find(property => property.id === tenancy.propertyId);
    if (!property || filters.propertyScope === "active" && property.state !== "active" || !workspacePropertyMatches(filters, property.id)) return [];
    const monthStart = `${filters.asOfDate.slice(0, 7)}-01`;
    const inMonth = (date?: string) => !!date && date >= monthStart && date <= filters.asOfDate;
    const confirmed = (knowledge?: string | null) => knowledge === undefined || knowledge === "manual" || knowledge === "source";
    const future = tenancy.status === "future";
    const moveIn = future ? confirmed(tenancy.plannedMoveInKnowledge) ? tenancy.plannedMoveInOn ?? (tenancy.actualMoveInKnowledge === undefined ? tenancy.actualMoveInOn : undefined) : undefined : confirmed(tenancy.actualMoveInKnowledge) ? tenancy.actualMoveInOn : undefined;
    const moveOut = confirmed(tenancy.actualMoveOutKnowledge) ? tenancy.actualMoveOutOn : undefined;
    const expectedOut = (tenancy.status === "notice" || tenancy.noticeOn && confirmed(tenancy.noticeKnowledge)) && confirmed(tenancy.expectedMoveOutKnowledge) ? tenancy.expectedMoveOutOn : undefined;
    if (!(future && moveIn && moveIn > filters.asOfDate) && !(["current", "notice"].includes(tenancy.status ?? "") && inMonth(moveIn)) && !inMonth(moveOut) && !expectedOut) return [];
    const unit = snapshot.snapshot.units.find(unit => unit.id === tenancy.unitId);
    const person = snapshot.snapshot.people.find(person => person.id === tenancy.primaryPersonId);
    if (filters.search && !`${property.name} ${unit?.unitNumber} ${person?.firstName} ${person?.lastName}`.toLowerCase().includes(filters.search.trim().toLowerCase())) return [];
    return [{ id: tenancy.id, propertyId: property.id, propertyName: property.name, unitId: unit?.id, unitNumber: unit?.unitNumber,
      moveIn: moveIn ? `${moveIn}${future ? " (expected)" : ""}` : undefined,
      actualMoveOutOn: moveOut, expectedMoveOutOn: expectedOut }];
  });
  const errors = requests.flatMap((request, index) => request.error && !(bundled && index < 2) ? [reports[index]] : []);
  const cashReady = cash.data?.state === "ready" ? cash.data : undefined;
  return <section className="rm-dashboard-workspace rmd-dashboard" aria-label="Rent Operations dashboard">
    {errors.length > 0 && <div className="rmd-load-error" role="alert">Some tables could not be loaded. <button onClick={() => { requests.forEach(request => { if (request.error) void request.refetch(); }); }}>Retry</button></div>}
    <div className="rmd-top-grid">
      {cashReady ? <Panel title="Cash Account" className="rmd-cash"><Table rows={[cashReady]} columns={[{ key: "name", label: "Account", render: row => <>{text(row.name)} · {text(row.mask)}</> }, amountColumn("currentCents", "Balance")]} /><div className="rmd-cash-available"><span>Available</span><strong>{money(cashReady.availableCents)}</strong></div><div className="rmd-cash-date">Company cash · {new Date(cashReady.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}<button type="button" title="Refresh cash balance" aria-label="Refresh cash balance" disabled={cash.isFetching} onClick={() => void cash.refetch()}><RefreshCw size={12} /></button></div></Panel>
      : <Panel title="Rent Roll by Property" className="rmd-cash" onOpen={() => onReport("rent-roll")}><Table rows={propertyRows} columns={[propertyColumn, { key: "rent", label: "Base rent", number: true, render: row => row.rentUnknown || row.unknown ? "Needs review" : money(row.rent) }]} footer={<><span>Occupied base rent</span><strong>{propertyRows?.some(row => row.rentUnknown || row.unknown) ? "Needs review" : money(total(propertyRows, "rent"))}</strong></>} /></Panel>}
      <Panel title="Vacancy by Property" className="rmd-vacancy-property" onOpen={() => onReport("occupancy")}><Table rows={propertyRows} columns={[propertyColumn, { key: "vacant", label: "Vacant", number: true }, { key: "unitCount", label: "Units", number: true }, { key: "vacancyRate", label: "% Vacant", number: true, render: row => row.unknown ? "—" : `${(100 * Number(row.vacant) / Number(row.unitCount)).toFixed(0)}%` }]} footer={<><span>Total vacant</span><strong>{total(propertyRows, "vacant") ?? "—"} / {total(propertyRows, "unitCount") ?? "—"}</strong></>} /></Panel>
      <Panel title="Delinquency List" className="rmd-delinquency" onOpen={() => onReport("delinquency")}><Table rows={dueRows} empty="No balances due." columns={[{ key: "tenantName", label: "Name", render: personLink }, propertyColumn, unitColumn, { ...amountColumn("operationalBalanceCents", "Amount"), render: row => numeric(row.operationalBalanceCents) ? <EntityLink personId={String(row.personId ?? "")} tab="ledger" onOpen={onOpenTenant}>{money(row.operationalBalanceCents)}</EntityLink> : "Needs review" }]} footer={<><span>{dueRows?.length ?? "—"} accounts</span><strong>{dueRows?.some(row => !numeric(row.operationalBalanceCents)) ? "Total needs review" : money(total(dueRows, "operationalBalanceCents"))}</strong></>} /></Panel>
      <Notes identity={identity} />
      <Panel title="Posted Rent Receipts" className="rmd-receipts" onOpen={() => onReport("collected-income")}><Table rows={receipts} empty="No posted rent receipts this month." columns={[{ key: "tenantName", label: "Tenant", render: personLink }, { key: "paymentOn", label: "Date" }, amountColumn("amountCents", "Amount")]} footer={<><span>{filters.asOfDate.slice(0, 7)}</span><strong>{money(total(receipts, "amountCents"))}</strong></>} /></Panel>
      <Panel title="Occupancy by Property" className="rmd-occupancy-property" onOpen={() => onReport("occupancy")}><Table rows={propertyRows} columns={[propertyColumn, { key: "occupied", label: "Occupied", number: true }, { key: "preleased", label: "Preleased", number: true }, { key: "unknown", label: "Unknown", number: true }]} footer={<><span>Occupied units</span><strong>{total(propertyRows, "occupied") ?? "—"} / {total(propertyRows, "unitCount") ?? "—"}</strong></>} /></Panel>
    </div>
    <div className="rmd-trend-grid">{(["vacancy", "occupancy", "rent"] as const).map(metric => <DashboardChart key={metric} metric={metric} data={trends.data} loading={trends.isFetching} error={trends.error?.message} onRetry={() => void trends.refetch()} />)}</div>
    <div className="rmd-bottom-grid">
      <Panel title="Vacancy List" onOpen={() => onReport("occupancy")}><Table rows={vacancy} empty="No vacant units." columns={[propertyColumn, unitColumn, { key: "type", label: "Type" }, amountColumn("marketRentCents", "Rent"), { key: "daysVacant", label: "Days vacant", number: true }]} footer={<span>{vacancy?.length ?? "—"} vacant units · {total(propertyRows, "preleased") ?? "—"} preleased</span>} /></Panel>
      <Panel title="Move In / Move Out List" onOpen={() => onReport("lease-expiration")}><Table rows={movements} empty="No moves recorded for this period." columns={[propertyColumn, unitColumn, { key: "moveIn", label: "Move in" }, { key: "actualMoveOutOn", label: "Move out" }, { key: "expectedMoveOutOn", label: "Expected out" }]} /></Panel>
      <Panel title="Recent Online Applications" onOpen={() => onReport("applicant-pipeline")}><Table rows={applications} empty="No applications submitted in the last 30 days." columns={[{ key: "submittedOn", label: "Date" }, { key: "displayName", label: "Applicant" }, propertyColumn, { key: "status", label: "Status", render: row => text(row.status).replaceAll("_", " ") }]} /></Panel>
    </div>
    {refreshing && <div className="rmd-refreshing" role="status">Refreshing dashboard…</div>}
  </section>;
}
