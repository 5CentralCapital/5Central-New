// Widget registry for the dashboard. Every widget declares the sizes it can
// take and renders itself for the size it was given; the grid never scrolls a
// widget that was built to fit. The rental widgets below read the one object
// the dashboard assembles (rm-dashboard.tsx); the company-side widgets load
// their own data when placed (dashboard-sources.ts).
import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { daysBetween, displayPersonName, formatTableDate, formatTimestamp } from "../../../lib/rent-ops-formatters";
import { EntityLink, RecordLink, entityHref, shouldHandleEntityClick } from "./entity-link";
import { formatReportValue, overdueDateAbsentLabel } from "./report-model";
import { DashboardChart } from "./dashboard-chart";
import { formatExactDollars, type DashboardKpi } from "./dashboard-kpis";
import { Skeleton } from "./ops-ui";
import { UNKNOWN_AMOUNT_LABEL } from "@shared/review-cases/display-labels";
import {
  Bars, Empty, LIST_ROW, Rows, TABLE_ROW, TILE, Table, Tile, bankingNetCents, bankingStateNotice, dollars, fitRows, money, numeric, pct, text,
  type Column, type DashboardData, type Row, type WidgetCategory, type WidgetDefinition,
} from "./dashboard-kit";
import { TENANT_WIDGETS } from "./dashboard-widgets-tenants";
import { UNIT_WIDGETS } from "./dashboard-widgets-units";
import { CASH_WIDGETS } from "./dashboard-widgets-cash";
import { ACCOUNTING_WIDGETS } from "./dashboard-widgets-accounting";
import { QUICKBOOKS_WIDGETS } from "./dashboard-widgets-quickbooks";
import { PROJECT_WIDGETS } from "./dashboard-widgets-projects";
import { OVERVIEW_WIDGETS } from "./dashboard-widgets-overview";

export * from "./dashboard-kit";

function Notes({ identity }: { identity: string }) {
  const key = `rent-ops-dashboard-note:${identity}`;
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { try { const note = localStorage.getItem(key) ?? ""; setValue(note); setSaved(note); } catch { setValue(""); setSaved(""); } setMessage(""); }, [key]);
  return <div className="rmd-notes rops-dash-notes ops-notes"><textarea aria-label="Dashboard notes" placeholder="Add a dashboard note…" value={value} onChange={event => { setValue(event.target.value); setMessage(""); }} maxLength={10000} /><div className="rmd-note-actions"><span role="status">{message || "Saved in this browser only"}</span><button type="button" disabled={value === saved} onClick={() => { try { localStorage.setItem(key, value); setSaved(value); setMessage("Saved in this browser"); } catch { setMessage("Could not save. Try again."); } }}>Save</button><button type="button" disabled={value === saved} onClick={() => { setValue(saved); setMessage(""); }}>Cancel</button></div></div>;
}

/* ---------- helpers over the dashboard rows ---------- */

const total = (rows: Row[] | undefined, key: string) => !rows || rows.some(row => !numeric(row[key])) ? undefined : rows.reduce((sum, row) => sum + Number(row[key]), 0);
const propertyLink = (data: DashboardData, row: Row) => <RecordLink kind="property" recordId={String(row.propertyId ?? "")} onOpen={data.onOpenProperty}>{text(row.propertyName)}</RecordLink>;
const unitLink = (data: DashboardData, row: Row) => <RecordLink kind="unit" recordId={String(row.unitId ?? "")} onOpen={data.onOpenUnit}>{text(row.unitNumber)}</RecordLink>;
const personLink = (data: DashboardData, row: Row) => <EntityLink personId={String(row.currentPersonId ?? row.personId ?? row.futurePersonId ?? "")} onOpen={data.onOpenTenant}>{text(row.tenantName ?? row.currentTenantName ?? row.futureTenantName)}</EntityLink>;
const shortDate = (data: DashboardData, value: unknown) => formatTableDate(value, data.year) ?? text(value);
const amountColumn = (key: string, label: string): Column => ({ key, label, number: true, render: row => money(row[key]) });

type Grouped<T> = T & { propertyId: string; propertyName: string };
function groupBy<T extends object>(rows: readonly Row[], seed: () => T, fold: (group: Grouped<T>, row: Row) => void): Grouped<T>[] {
  const groups = new Map<string, Grouped<T>>();
  for (const row of rows) {
    const id = String(row.propertyId ?? row.propertyName ?? "");
    let group = groups.get(id);
    if (!group) { group = { ...seed(), propertyId: id, propertyName: text(row.propertyName) }; groups.set(id, group); }
    fold(group, row);
  }
  return Array.from(groups.values());
}

function kpiTile(kpi: DashboardKpi | undefined, big: boolean) {
  if (!kpi) return <Skeleton width="6em" />;
  return <Tile label={big ? undefined : kpi.label} big={big} tone={kpi.tone} meter={kpi.share} value={kpi.tone === "loading" ? <Skeleton width="4em" label={`Loading ${kpi.label.toLowerCase()}`} /> : kpi.value} detail={kpi.detail} />;
}

const kpiWidget = (id: string, key: DashboardKpi["key"], name: string, description: string, category: WidgetCategory): WidgetDefinition => ({
  id, category, name, description, sizes: ["S", "M"], defaultSize: "S",
  render: ({ data, metrics }) => kpiTile(data.kpis.find(kpi => kpi.key === key), metrics.size === "S"),
});

/* ---------- registry ---------- */

const RENTAL_WIDGETS: readonly WidgetDefinition[] = [
  kpiWidget("kpi-occupancy", "occupancy", "Occupancy", "Occupied share of units in the selected properties", "units"),
  kpiWidget("kpi-rent", "rent", "Occupied base rent", "Monthly base rent on current tenancies", "units"),
  kpiWidget("kpi-collected", "receipts", "Rent collected", "Posted rent receipts this month against base rent", "rent"),
  kpiWidget("kpi-due", "due", "Balances due", "Known balances owed by current tenants", "rent"),
  {
    id: "attention", category: "company", name: "Needs attention", description: "Balances, long vacancies, moves and company items, ranked", sizes: ["MT", "XT", "L", "XL"], defaultSize: "XT", scrolls: true,
    render: ({ data }) => <ul className="rops-attention" aria-label="Needs attention">
      {!data.dueRows && !data.vacancy ? <li className="rops-attention-row"><span className="rops-attention-stripe" /><span><Skeleton width="14em" /></span></li> : null}
      {data.attention.map(item => <li key={item.key} className="rops-attention-row" data-tone={item.tone}><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
        {item.key === "balances" && <button type="button" className="rm-button rm-button--small" onClick={() => data.onReport("delinquency")}>Open balances</button>}
        {item.key === "vacancy" && <button type="button" className="rm-button rm-button--small" onClick={() => data.onReport("occupancy")}>Open vacancies</button>}
        {item.key === "moves" && <button type="button" className="rm-button rm-button--small" onClick={() => data.onReport("lease-expiration")}>Plan turns</button>}
      </li>)}
      {data.companyPanels}
      {data.dueRows && data.vacancy && !data.attention.length && <li className="rops-attention-row" data-tone="positive"><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><small>No balances due, vacancies or upcoming moves.</small></span></li>}
    </ul>,
  },
  {
    id: "balances", category: "rent", name: "Balances due", description: "Tenants with a known balance, oldest unpaid month and amount", sizes: ["L", "XL", "F6"], defaultSize: "L", open: data => () => data.onReport("delinquency"),
    render: ({ data, metrics }) => <Table rows={data.knownDue} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No balances due." onMore={() => data.onReport("delinquency")} moreLabel={count => `View all ${count + data.unverifiedDue}${data.unverifiedDue ? `, including ${data.unverifiedDue} not verified` : ""}`} columns={[
      { key: "tenantName", label: "Tenant", render: row => <span className="rops-cell-stack">{personLink(data, row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span> },
      ...(metrics.w >= 8 ? [{ key: "oldestUnpaidRentOn", label: "Oldest", render: (row: Row) => row.oldestUnpaidRentOn ? shortDate(data, row.oldestUnpaidRentOn) : overdueDateAbsentLabel((row.__source ?? row) as Row) }] : []),
      { ...amountColumn("operationalBalanceCents", "Amount"), render: row => <EntityLink personId={String(row.personId ?? "")} tab="ledger" onOpen={data.onOpenTenant}>{money(row.operationalBalanceCents)}</EntityLink> },
    ]} footer={data.dueSplit ? <><span>{data.dueSplit.knownCount} {data.dueSplit.knownCount === 1 ? "account" : "accounts"}{data.dueSplit.unverifiedCount ? ` · ${data.dueSplit.unverifiedCount} not verified` : ""}</span><strong>{money(data.dueSplit.knownCents)}</strong></> : undefined} />,
  },
  {
    id: "units-by-property", category: "units", name: "Units by property", description: "Occupied of total per property with the longest vacancy", sizes: ["MT", "L", "XT"], defaultSize: "MT", open: data => () => data.onReport("occupancy"),
    render: ({ data, metrics }) => {
      const rows = data.propertyRows;
      const longest = (propertyId: unknown) => { const days = (data.vacancy ?? []).filter(row => row.propertyId === propertyId && numeric(row.daysVacant)).map(row => row.daysVacant as number); return days.length ? Math.max(...days) : undefined; };
      return <>{!rows ? <p className="rmd-empty"><Skeleton width="12em" /></p> : !rows.length ? <p className="rmd-empty">No units in the selected properties.</p> : <ul className="rops-unit-bars">
        {rows.slice(0, fitRows(metrics, 48, 40)).map(row => { const units = Number(row.unitCount) || 0; const occupied = Number(row.occupied) || 0; const long = longest(row.propertyId); return <li key={String(row.propertyId)}>
          <span className="rops-cell-stack">{propertyLink(data, row)}<small>{Number(row.vacant) || 0} vacant{row.preleased ? ` · ${row.preleased} preleased` : ""}{long !== undefined ? ` · longest ${long} days` : ""}{row.unknown ? ` · ${row.unknown} unknown` : ""}</small></span>
          <span className="rops-unit-track" aria-hidden="true"><i style={{ width: `${units ? occupied / units * 100 : 0}%` }} /></span>
          <span className="number">{occupied} / {units}</span>
        </li>; })}
      </ul>}
      <div className="rmd-table-total"><button type="button" className="rops-link" onClick={() => data.onReport("occupancy")}>Vacancy list</button><strong>{total(rows, "occupied") ?? "—"} / {total(rows, "unitCount") ?? "—"} occupied</strong></div></>;
    },
  },
  {
    id: "vacancy-list", category: "units", name: "Vacancy list", description: "Vacant units with market rent and days vacant", sizes: ["L", "XL", "F6"], defaultSize: "L", open: data => () => data.onReport("occupancy"),
    render: ({ data, metrics }) => <Table rows={data.vacancySorted} limit={fitRows(metrics, TABLE_ROW, 40)} onMore={() => data.onReport("occupancy")} moreLabel={count => `View all ${count}`} empty="No vacant units." columns={[{ key: "unitNumber", label: "Unit", render: row => <span className="rops-cell-stack">{unitLink(data, row)}<small>{text(row.propertyName)}{row.type ? ` · ${text(row.type)}` : ""}</small></span> }, amountColumn("marketRentCents", "Rent"), { key: "daysVacant", label: "Days", number: true, render: row => numeric(row.daysVacant) ? String(row.daysVacant) : "—" }]} footer={<span>{data.vacancy?.length ?? "—"} vacant · {total(data.propertyRows, "preleased") ?? "—"} preleased</span>} />,
  },
  {
    id: "moves", category: "rent", name: "Moves this month", description: "Completed and upcoming move-ins and move-outs", sizes: ["MT", "L", "XL"], defaultSize: "L", open: data => () => data.onReport("lease-expiration"),
    render: ({ data, metrics }) => <Table rows={data.movements} limit={fitRows(metrics, TABLE_ROW, 40)} onMore={() => data.onReport("lease-expiration")} moreLabel={count => `View all ${count}`} empty="No moves recorded for this month." columns={[{ key: "tenantName", label: "Tenant", render: row => <span className="rops-cell-stack">{personLink(data, row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span> }, { key: "date", label: "Date", render: row => shortDate(data, row.date) }, { key: "movement", label: "Move", render: row => <span className="rops-cell-stack"><span>{text(row.movement)}</span><small>{text(row.state)}</small></span> }]} footer={<><span>{data.monthLabel} · completed and upcoming</span>{data.onManageMoves && <button type="button" className="rops-link" onClick={data.onManageMoves}>Record move</button>}</>} />,
  },
  {
    id: "applications", category: "rent", name: "Recent online applications", description: "Applications received in the last 30 days", sizes: ["MT", "L", "XL"], defaultSize: "L", open: data => () => data.onReport("applicant-pipeline"),
    render: ({ data, metrics }) => <Table rows={data.applicationsError ? [] : data.applications} limit={fitRows(metrics, TABLE_ROW, 12)} onMore={() => data.onReport("applicant-pipeline")} moreLabel={count => `View all ${count}`} empty={data.applicationsError ? "Online applications could not be loaded." : "No online applications received in the last 30 days."} columns={[{ key: "displayName", label: "Applicant", render: row => <span className="rops-cell-stack"><a className="rm-entity-link" href={entityHref({ section: "applicants", recordId: String(row.id), tab: "summary", report: "applicant-pipeline" })} onClick={event => { if (shouldHandleEntityClick(event)) { event.preventDefault(); data.onOpenApplication(String(row.id)); } }}>{displayPersonName(text(row.displayName))}</a><small>{text(row.propertyName)}</small></span> }, { key: "submittedOn", label: "Date", render: row => shortDate(data, row.submittedOn) }, { key: "status", label: "Status", render: row => text(row.status).replaceAll("_", " ") }]} />,
  },
  {
    id: "trend", category: "units", name: "Trends", description: "Vacant, occupied or rent roll over the last 12 months", sizes: ["XT", "XL", "FT", "F"], defaultSize: "XL", bare: true,
    render: ({ data }) => <DashboardChart metric={data.trends.metric} onMetric={data.trends.setMetric} data={data.trends.data} loading={data.trends.loading} error={data.trends.error} onRetry={data.trends.retry} />,
  },
  {
    id: "receipts", category: "rent", name: "Rent received", description: "Posted rent receipts this month, newest first", sizes: ["L", "XL", "F6"], defaultSize: "L", open: data => () => data.onReport("collected-income"),
    render: ({ data, metrics }) => <Table rows={data.receipts} limit={fitRows(metrics, TABLE_ROW, 40)} onMore={() => data.onReport("collected-income")} moreLabel={count => `View all ${count}`} empty={`No rent receipts posted in ${data.monthLabel}.`} columns={[{ key: "tenantName", label: "Tenant", render: row => <span className="rops-cell-stack">{personLink(data, row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span> }, { key: "paymentOn", label: "Date", render: row => shortDate(data, row.paymentOn) }, amountColumn("amountCents", "Amount")]} footer={<><span>{data.receipts?.length ?? "—"} receipts · {data.monthLabel}</span><strong>{money(total(data.receipts, "amountCents"))}</strong></>} />,
  },
  {
    id: "occupancy-by-property", category: "units", name: "Occupancy by property", description: "Occupied share per property", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => !data.propertyRows ? <Skeleton width="10em" /> : <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={data.propertyRows.map(row => { const units = Number(row.unitCount) || 0, occupied = Number(row.occupied) || 0; const share = units ? occupied / units : 0; return { key: String(row.propertyId), label: propertyLink(data, row), detail: `${occupied} of ${units}`, value: row.unknown ? UNKNOWN_AMOUNT_LABEL : pct(share), tone: !row.unknown && share < 0.75 ? "critical" as const : undefined }; })} />,
  },
  {
    id: "collections-by-property", category: "rent", name: "Collections by property", description: "Rent received this month against occupied base rent", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.propertyRows || !data.receipts) return <Skeleton width="10em" />;
      const received = new Map(groupBy(data.receipts, () => ({ cents: 0, known: true }), (group, row) => { if (numeric(row.amountCents)) group.cents += row.amountCents; else group.known = false; }).map(group => [group.propertyId, group] as const));
      const items = data.propertyRows.map(row => { const got = received.get(String(row.propertyId)); const rent = Number(row.rent) || 0; const unknown = !!row.rentUnknown || !!row.unknown || (got && !got.known); const share = rent > 0 && got ? Math.min(1, got.cents / rent) : 0; return { key: String(row.propertyId), label: propertyLink(data, row), detail: got ? `${dollars(got.cents)} of ${dollars(rent)}` : `none posted of ${dollars(rent)}`, value: unknown ? UNKNOWN_AMOUNT_LABEL : pct(share), tone: !unknown && share < 0.5 ? "critical" as const : undefined }; }).sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
      return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={items} />;
    },
  },
  {
    id: "delinquency-aging", category: "rent", name: "Balance aging", description: "Known balances by how old the oldest unpaid month is", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.knownDue) return <Skeleton width="10em" />;
      const buckets = [["Under 30 days", 0], ["30–60 days", 0], ["60–90 days", 0], ["90+ days", 0], ["No date", 0]] as Array<[string, number]>;
      for (const row of data.knownDue) { const days = daysBetween(row.oldestUnpaidRentOn, data.filters.asOfDate); const index = days === undefined ? 4 : days < 30 ? 0 : days < 60 ? 1 : days < 90 ? 2 : 3; buckets[index][1] += Number(row.operationalBalanceCents) || 0; }
      const items = buckets.filter(([, cents], index) => cents > 0 || index < 4).map(([label, cents], index) => ({ key: label, label, value: cents, tone: index >= 2 && cents > 0 ? "critical" as const : undefined }));
      return <>{metrics.size !== "S" && <Tile label="Balances due" value={data.dueSplit ? formatExactDollars(data.dueSplit.knownCents) : "—"} detail={data.dueSplit ? `${data.dueSplit.knownCount} accounts${data.dueSplit.unverifiedCount ? ` · ${data.dueSplit.unverifiedCount} not verified` : ""}` : undefined} tone={data.dueSplit?.knownCents ? "attention" : "normal"} />}<Bars items={items} limit={fitRows(metrics, LIST_ROW, metrics.size === "S" ? 0 : TILE, 1)} /></>;
    },
  },
  {
    id: "due-by-property", category: "rent", name: "Balances by property", description: "Known balances summed per property with the account count", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.knownDue) return <Skeleton width="10em" />;
      const groups = groupBy(data.knownDue, () => ({ cents: 0, count: 0 }), (group, row) => { group.cents += Number(row.operationalBalanceCents) || 0; group.count += 1; });
      const items = groups.sort((a, b) => b.cents - a.cents).map(group => ({ key: group.propertyId, label: <>{group.propertyName} <small>{group.count}</small></>, value: group.cents, tone: "critical" as const }));
      return items.length ? <Bars items={items} limit={fitRows(metrics, LIST_ROW, 0)} /> : <Empty title="No balances due" />;
    },
  },
  {
    id: "vacancy-cost", category: "units", name: "Vacancy cost", description: "Market rent on vacant units per month, by property", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.vacancy) return <Skeleton width="10em" />;
      const vacant = data.vacancy.filter(row => row.occupancy !== "future_preleased");
      const known = vacant.every(row => numeric(row.marketRentCents));
      const sum = vacant.reduce((acc, row) => acc + (numeric(row.marketRentCents) ? row.marketRentCents : 0), 0);
      const groups = groupBy(vacant, () => ({ cents: 0, count: 0 }), (group, row) => { group.cents += numeric(row.marketRentCents) ? row.marketRentCents : 0; group.count += 1; });
      const items = groups.sort((a, b) => b.cents - a.cents).map(group => ({ key: group.propertyId, label: <>{group.propertyName} <small>{group.count}</small></>, value: group.cents }));
      return <><Tile label="Per month" big={metrics.size === "S"} value={vacant.length ? `${known ? "" : "≥ "}${dollars(sum)}` : "$0"} detail={`${vacant.length} vacant units · ${dollars(sum * 12)} a year`} />{metrics.size !== "S" && <Bars items={items} limit={fitRows(metrics, LIST_ROW, TILE, 1)} />}</>;
    },
  },
  {
    id: "days-vacant", category: "units", name: "Days vacant", description: "Vacant units grouped by how long they have sat", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.vacancy) return <Skeleton width="10em" />;
      const vacant = data.vacancy.filter(row => row.occupancy !== "future_preleased");
      const withDays = vacant.filter(row => numeric(row.daysVacant)).map(row => row.daysVacant as number);
      const average = withDays.length ? Math.round(withDays.reduce((a, b) => a + b, 0) / withDays.length) : undefined;
      const buckets = [["Under 30", 0], ["30–90", 0], ["90–180", 0], ["180+", 0], ["Not recorded", 0]] as Array<[string, number]>;
      for (const row of vacant) { const days = row.daysVacant; if (!numeric(days)) buckets[4][1] += 1; else if (days < 30) buckets[0][1] += 1; else if (days < 90) buckets[1][1] += 1; else if (days < 180) buckets[2][1] += 1; else buckets[3][1] += 1; }
      return <><Tile label="Average" big={metrics.size === "S"} value={average === undefined ? "—" : `${average} days`} detail={withDays.length ? `across ${withDays.length} units with a date` : "no vacancy dates recorded"} />{metrics.size !== "S" && <Bars items={buckets.filter(([, n], i) => n > 0 || i < 4).map(([label, n], index) => ({ key: label, label, value: n, tone: index >= 2 && n > 0 ? "critical" as const : undefined }))} format={value => `${value} units`} limit={fitRows(metrics, LIST_ROW, TILE, 1)} />}</>;
    },
  },
  {
    id: "unit-mix", category: "units", name: "Unit mix", description: "Bedrooms across the selected units and how many are occupied", sizes: ["S", "M"], defaultSize: "S",
    render: ({ data, metrics }) => {
      if (!data.rentRoll) return <Skeleton width="10em" />;
      const occupancy = new Map(data.rentRoll.map(row => [String(row.unitId), row.occupancy]));
      const inScope = data.snapshot.snapshot.units.filter(unit => unit.id && occupancy.has(String(unit.id)));
      const groups = new Map<string, { units: number; occupied: number }>();
      for (const unit of inScope) { const key = unit.bedrooms == null ? "Not recorded" : `${unit.bedrooms} bed`; const group = groups.get(key) ?? { units: 0, occupied: 0 }; group.units += 1; if (occupancy.get(String(unit.id)) === "current") group.occupied += 1; groups.set(key, group); }
      const items = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([label, group]) => ({ key: label, label, detail: `${group.units} units`, value: `${group.occupied} / ${group.units} · ${pct(group.occupied / group.units)}` }));
      return items.length ? <Rows items={items} limit={fitRows(metrics, LIST_ROW, 0)} /> : <Empty title="No unit records" />;
    },
  },
  {
    id: "rent-vs-market", category: "units", name: "Rent vs market", description: "In-place base rent against market rent on occupied units", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (!data.rentRoll) return <Skeleton width="10em" />;
      const occupied = data.rentRoll.filter(row => row.occupancy === "current" && numeric(row.baseRentCents) && numeric(row.marketRentCents) && row.marketRentCents > 0);
      if (!occupied.length) return <Empty title="No market rents recorded">Add market rent on units to compare.</Empty>;
      const groups = groupBy(occupied, () => ({ rent: 0, market: 0 }), (group, row) => { group.rent += row.baseRentCents as number; group.market += row.marketRentCents as number; });
      const rent = occupied.reduce((a, row) => a + (row.baseRentCents as number), 0), market = occupied.reduce((a, row) => a + (row.marketRentCents as number), 0);
      return <><Tile label="In place vs market" big={metrics.size === "S"} value={pct(rent / market)} detail={`${dollars(rent)} of ${dollars(market)} · ${dollars(market - rent)} loss to lease`} />{metrics.size !== "S" && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={groups.map(group => ({ key: group.propertyId, label: group.propertyName, detail: `${dollars(group.rent)} / ${dollars(group.market)}`, value: pct(group.rent / group.market), tone: group.rent / group.market < 0.9 ? "critical" as const : undefined }))} />}</>;
    },
  },
  {
    id: "cash", category: "cash", name: "Cash", description: "Operating account balance from the bank, with this month's rent receipts", sizes: ["M", "MT", "S"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (data.cash.error) return <Empty title="Cash balance unavailable"><span>The cash balance could not be loaded.</span><button type="button" className="rops-link" disabled={data.cash.fetching} onClick={data.cash.refetch}>Retry</button></Empty>;
      const cash = data.cash.data;
      if (!cash) return <Skeleton width="8em" />;
      if (cash.state !== "ready") return <Empty title={cash.state === "unconfigured" ? "No bank connected" : "Bank balance unavailable"}><span>{cash.state === "unconfigured" ? "Connect the operating account under Accounting › Banking." : "The bank did not answer. Try again in a few minutes."}</span><button type="button" className="rops-link" disabled={data.cash.fetching} onClick={data.cash.refetch}>Retry</button></Empty>;
      const receipts = total(data.receipts, "amountCents");
      return <>
        <Tile label={`Available · ${text(cash.name)} ··${cash.mask}`} big={metrics.size === "S"} value={money(cash.availableCents)} detail={metrics.size === "S" ? `${money(cash.currentCents)} current` : undefined} />
        {metrics.size !== "S" && <Rows items={[{ key: "current", label: "Current balance", value: money(cash.currentCents) }, { key: "processing", label: "Payments in processing", value: numeric(cash.currentCents) && numeric(cash.availableCents) ? money(cash.currentCents - cash.availableCents) : "—", tone: "muted" }, { key: "receipts", label: `Posted rent receipts · ${data.monthLabel}`, value: receipts === undefined ? "—" : money(receipts) }]} limit={fitRows(metrics, LIST_ROW, TILE, 1)} />}
        <div className="rmd-table-total ops-widget-foot"><span>Checked {formatTimestamp(new Date(cash.checkedAt)) ?? ""}</span><button type="button" className="rops-link" title="Refresh cash balance" disabled={data.cash.fetching} onClick={data.cash.refetch}><RefreshCw size={12} aria-hidden="true" /> Refresh</button></div>
      </>;
    },
  },
  {
    id: "bank-activity", category: "cash", name: "Bank activity", description: "Latest transactions on the connected accounts", sizes: ["L", "XL", "F6"], defaultSize: "L", scrolls: false,
    render: ({ data, metrics }) => {
      const banking = data.banking;
      if (banking.error) return <Empty title="Bank activity unavailable"><button type="button" className="rops-link" onClick={banking.refetch}>Retry</button></Empty>;
      if (!banking.data) return <Skeleton width="10em" />;
      if (banking.data.state === "unconfigured") return <Empty title="No bank connected">Connect an account under Accounting › Banking.</Empty>;
      const notice = bankingStateNotice(banking.data.state, "Bank activity");
      if (notice) return <Empty title={notice.title}><span>{notice.detail}</span><button type="button" className="rops-link" disabled={banking.loading} onClick={banking.refetch}>Retry</button></Empty>;
      const rows: Row[] = banking.data.connections.flatMap(connection => connection.transactions.map(transaction => ({ id: transaction.id, date: transaction.date, description: transaction.description, amountCents: transaction.amountCents, pending: transaction.pending, account: connection.accounts.find(account => account.id === transaction.accountId)?.mask ?? "" }))).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 30)} empty="No transactions in the window." columns={[{ key: "description", label: "Description", render: row => <span className="rops-cell-stack"><span>{text(row.description)}</span>{row.pending ? <small>Pending</small> : null}</span> }, { key: "date", label: "Date", render: row => shortDate(data, row.date) }, { key: "amountCents", label: "Amount", number: true, render: row => <span data-tone={numeric(row.amountCents) && row.amountCents < 0 ? "positive" : undefined}>{numeric(row.amountCents) ? `${row.amountCents < 0 ? "+" : "−"}${formatReportValue(Math.abs(row.amountCents), "currency")}` : "—"}</span> }]} footer={<span>{banking.data.fromDate} → {banking.data.throughDate}</span>} />;
    },
  },
  {
    id: "money-in-out", category: "cash", name: "Money in and out", description: "Deposits and payments on the connected accounts over the banking window", sizes: ["S", "M", "MT"], defaultSize: "M",
    render: ({ data, metrics }) => {
      if (data.banking.error) return <Empty title="Money in and out unavailable"><span>The bank activity read could not be loaded.</span><button type="button" className="rops-link" disabled={data.banking.loading} onClick={data.banking.refetch}>Retry</button></Empty>;
      const banking = data.banking.data;
      if (!banking) return <Skeleton width="10em" />;
      if (banking.state === "unconfigured") return <Empty title="No bank connected" />;
      const notice = bankingStateNotice(banking.state, "Money in and out");
      if (notice) return <Empty title={notice.title}><span>{notice.detail}</span><button type="button" className="rops-link" disabled={data.banking.loading} onClick={data.banking.refetch}>Retry</button></Empty>;
      const transactions = banking.connections.flatMap(connection => connection.transactions).filter(transaction => numeric(transaction.amountCents) && !transaction.pending);
      const inflow = transactions.filter(t => (t.amountCents as number) < 0).reduce((a, t) => a - (t.amountCents as number), 0);
      const outflow = transactions.filter(t => (t.amountCents as number) > 0).reduce((a, t) => a + (t.amountCents as number), 0);
      const net = bankingNetCents(banking)!;
      const biggest = [...transactions].sort((a, b) => Math.abs(b.amountCents as number) - Math.abs(a.amountCents as number)).slice(0, fitRows(metrics, LIST_ROW, TILE, 1));
      return <><Tile label={`Net · ${banking.fromDate} → ${banking.throughDate}`} big={metrics.size === "S"} value={`${net < 0 ? "−" : "+"}${dollars(Math.abs(net))}`} detail={`${dollars(inflow)} in · ${dollars(outflow)} out`} tone={net < 0 ? "attention" : "normal"} />
        {metrics.size !== "S" && <Rows items={biggest.map(t => ({ key: t.id, label: t.description, detail: shortDate(data, t.date), value: `${(t.amountCents as number) < 0 ? "+" : "−"}${dollars(Math.abs(t.amountCents as number))}`, tone: (t.amountCents as number) < 0 ? "positive" as const : undefined }))} />}</>;
    },
  },
  {
    id: "company", category: "company", name: "Company items", description: "Investor payments, loan maturities, work due and records to review", sizes: ["MT", "L", "XT"], defaultSize: "MT", scrolls: true,
    render: ({ data }) => data.companyPanels ? <ul className="rops-attention" aria-label="Company items">{data.companyPanels}</ul> : <Empty title="No company access">Company items appear for organization members.</Empty>,
  },
  {
    id: "notes", category: "company", name: "Notes", description: "A scratchpad saved in this browser", sizes: ["S", "M", "MT", "L"], defaultSize: "M",
    render: ({ data }) => <Notes identity={data.identity} />,
  },
];

/** Every widget, in library order. */
export const WIDGETS: readonly WidgetDefinition[] = [
  ...RENTAL_WIDGETS, ...OVERVIEW_WIDGETS, ...TENANT_WIDGETS, ...UNIT_WIDGETS, ...CASH_WIDGETS, ...ACCOUNTING_WIDGETS, ...QUICKBOOKS_WIDGETS, ...PROJECT_WIDGETS,
];
const BY_ID = new Map(WIDGETS.map(widget => [widget.id, widget] as const));
export const widgetById = (id: string) => BY_ID.get(id);
