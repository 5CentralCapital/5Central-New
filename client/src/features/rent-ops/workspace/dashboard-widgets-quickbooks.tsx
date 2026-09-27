// QuickBooks widgets: sync health, P&L and balance sheet by entity (native
// QuickBooks reports, year to date), margins, the chart of accounts, vendors,
// customers, recent transactions and sync exceptions. An entity whose report
// is incomplete shows "Unavailable"; totals then say they cover the rest.
import React from "react";
import { financialFigure, type DashboardReport } from "../../accounting/dashboard-model";
import {
  Bars, Empty, Failed, Foot, LIST_ROW, Loading, Rows, SIZESETS, Stack, StatStrip, TABLE_ROW, TILE, Table, Tile,
  centsNumber, companyOpener, fitRows, humanLabel, isSmall, pct, shortDay, sumCents, wholeCents,
  type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { useFinancialReports, useMirrors, useQboEntities, useQboTransactions, type QboEntity } from "./dashboard-sources";
import { useCompanyGate } from "./dashboard-widgets-overview";
import type { AccountingMirrorKind } from "../../accounting/types";

/** Gate for QuickBooks widgets: company access, health read, at least one connected entity. */
function useQboGate(data: WidgetContext["data"]) {
  const { gate } = useCompanyGate(data);
  const { entities, health } = useQboEntities(data);
  const blocked = gate ?? (health.error ? <Failed title="QuickBooks status unavailable" error={health.error} retry={() => void health.refetch()} />
    : !entities ? <Loading label="Loading QuickBooks" />
    : !entities.length ? <Empty title="QuickBooks not connected">Connect an entity under Accounting › Connections.</Empty> : null);
  return { entities: entities ?? [], health, gate: blocked };
}

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 60 ? `${Math.max(0, minutes)} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};

function Sync({ data, metrics }: WidgetContext) {
  const { entities, gate } = useQboGate(data);
  if (gate) return gate;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={entities.map(entity => {
    const health = entity.health;
    const issues = health.openSyncExceptions + health.jobs.dead;
    return { key: entity.scope.legalEntityId, label: entity.name, detail: `${entity.scope.environment === "sandbox" ? "Sandbox · " : ""}synced ${ago(health.lastSuccessfulSyncAt)}${issues ? ` · ${issues} issues` : ""}`, value: humanLabel(health.freshness), tone: health.freshness === "current" ? "positive" as const : "critical" as const };
  })} />;
}

type Figures = { entity: QboEntity; report?: DashboardReport; loading: boolean; error: unknown };
const value = (row: Figures, group: string) => row.loading ? undefined : financialFigure(row.report, group);
function total(rows: Figures[], group: string) {
  const values = rows.map(row => value(row, group));
  const known = values.filter((entry): entry is string => typeof entry === "string");
  return { cents: sumCents(known), complete: known.length === values.length, missing: values.length - known.length };
}
const totalText = (result: ReturnType<typeof total>) => `${wholeCents(result.cents)}${result.complete ? "" : "*"}`;

function usePnl(data: WidgetContext["data"]) { return useFinancialReports(data, "income-statement"); }
function useBalance(data: WidgetContext["data"]) { return useFinancialReports(data, "balance-sheet"); }

function PnlByEntity({ data, metrics }: WidgetContext) {
  const { gate } = useQboGate(data);
  const pnl = usePnl(data);
  if (gate) return gate;
  const rows: Row[] = pnl.rows.map(row => ({ id: row.entity.scope.legalEntityId, name: row.entity.name, loading: row.loading, income: value(row, "Income"), expenses: value(row, "Expenses"), noi: value(row, "NetOperatingIncome"), net: value(row, "NetIncome") }));
  const money = (key: string) => (row: Row) => row.loading ? "…" : row[key] === null ? "Unavailable" : <span data-tone={(centsNumber(row[key] as string) ?? 0) < 0 ? "critical" : undefined}>{wholeCents(row[key] as string)}</span>;
  const net = total(pnl.rows, "NetIncome");
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} columns={[
    { key: "name", label: "Entity" },
    { key: "income", label: "Income", number: true, render: money("income") },
    ...(metrics.w >= 8 ? [{ key: "expenses", label: "Opex", number: true, render: money("expenses") }] : []),
    { key: "noi", label: "Operating", number: true, render: money("noi") },
    { key: "net", label: "Net income", number: true, render: money("net") },
  ]} footer={<><span>Year to date · cash basis · QuickBooks</span><strong>{pnl.loading ? "…" : totalText(net)}</strong></>} onMore={companyOpener(data, "accounting", { accountingView: "overview" })} />;
}

function FigureByEntity({ data, metrics, group, label, signed = false }: WidgetContext & { group: string; label: string; signed?: boolean }) {
  const { gate } = useQboGate(data);
  const pnl = usePnl(data);
  if (gate) return gate;
  const result = total(pnl.rows, group);
  return <><Tile label={`${label} · YTD`} big={isSmall(metrics)} value={pnl.loading ? "…" : totalText(result)} tone={signed && (centsNumber(result.cents) ?? 0) < 0 ? "attention" : undefined} detail={result.missing && !pnl.loading ? `${result.missing} entit${result.missing === 1 ? "y" : "ies"} unavailable` : `${pnl.rows.length} entities`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={pnl.rows.map(row => { const cents = centsNumber(value(row, group)); return { key: row.entity.scope.legalEntityId, label: row.entity.name, value: cents ?? 0, display: row.loading ? "…" : cents === undefined ? "Unavailable" : wholeCents(cents), tone: signed && cents !== undefined && cents < 0 ? "critical" as const : undefined }; })} />}</>;
}

function Margin({ data, metrics }: WidgetContext) {
  const { gate } = useQboGate(data);
  const pnl = usePnl(data);
  if (gate) return gate;
  const income = total(pnl.rows, "Income"), noi = total(pnl.rows, "NetOperatingIncome");
  const share = (a?: number, b?: number) => a !== undefined && b ? a / b : undefined;
  const overall = income.complete && noi.complete ? share(centsNumber(noi.cents), centsNumber(income.cents)) : undefined;
  return <><Tile label="Operating margin · YTD" big={isSmall(metrics)} value={pnl.loading ? "…" : overall === undefined ? "Unavailable" : pct(overall)} meter={overall !== undefined ? Math.max(0, overall) : undefined} detail="Operating income ÷ income" />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} format={amount => `${Math.round(amount)}%`} items={pnl.rows.map(row => { const margin = share(centsNumber(value(row, "NetOperatingIncome")), centsNumber(value(row, "Income"))); return { key: row.entity.scope.legalEntityId, label: row.entity.name, value: margin === undefined ? 0 : margin * 100, display: margin === undefined ? "—" : pct(margin), tone: margin !== undefined && margin < 0 ? "critical" as const : undefined }; })} />}</>;
}

function BalanceByEntity({ data, metrics }: WidgetContext) {
  const { gate } = useQboGate(data);
  const balance = useBalance(data);
  if (gate) return gate;
  const rows: Row[] = balance.rows.map(row => ({ id: row.entity.scope.legalEntityId, name: row.entity.name, loading: row.loading, assets: value(row, "TotalAssets"), liabilities: value(row, "Liabilities"), equity: value(row, "Equity") }));
  const money = (key: string) => (row: Row) => row.loading ? "…" : row[key] === null ? "Unavailable" : wholeCents(row[key] as string);
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} columns={[
    { key: "name", label: "Entity" },
    { key: "assets", label: "Assets", number: true, render: money("assets") },
    { key: "liabilities", label: "Liabilities", number: true, render: money("liabilities") },
    { key: "equity", label: "Equity", number: true, render: money("equity") },
  ]} footer={<><span>As of {shortDay(data.filters.asOfDate)} · QuickBooks</span><strong>{balance.loading ? "…" : `${totalText(total(balance.rows, "TotalAssets"))} assets`}</strong></>} />;
}

function BalanceMix({ data, metrics }: WidgetContext) {
  const { gate } = useQboGate(data);
  const balance = useBalance(data);
  if (gate) return gate;
  if (balance.loading) return <Loading />;
  const liabilities = total(balance.rows, "Liabilities"), equity = total(balance.rows, "Equity"), assets = total(balance.rows, "TotalAssets");
  return <><StatStrip metrics={metrics} min={110} items={[{ key: "assets", label: "Assets", value: totalText(assets) }, { key: "liabilities", label: "Liabilities", value: totalText(liabilities) }, { key: "equity", label: "Equity", value: totalText(equity) }]} />
    {metrics.h > 2 && liabilities.complete && equity.complete && <Stack format={amount => wholeCents(amount)} parts={[{ key: "liabilities", label: "Debt & liabilities", value: centsNumber(liabilities.cents) ?? 0, tone: "critical" }, { key: "equity", label: "Equity", value: Math.max(0, centsNumber(equity.cents) ?? 0), tone: "positive" }]} />}</>;
}

function Mirror({ data, metrics, kind, label }: WidgetContext & { kind: AccountingMirrorKind; label: string }) {
  const { gate } = useQboGate(data);
  const mirrors = useMirrors(data, kind);
  if (gate) return gate;
  if (mirrors.loading) return <Loading />;
  const active = mirrors.rows.flatMap(row => (row.mirrors ?? []).filter(item => item.active).map(item => ({ ...item, entity: row.entity.name })));
  const failed = mirrors.rows.filter(row => row.error).length;
  if (kind === "accounts") {
    const types = new Map<string, number>();
    for (const account of active) types.set(humanLabel(account.accountType ?? "Other"), (types.get(humanLabel(account.accountType ?? "Other")) ?? 0) + 1);
    return <><Tile label="Active accounts" big={isSmall(metrics)} value={String(active.length)} detail={`${mirrors.rows.length} entities${failed ? ` · ${failed} unavailable` : ""}`} />
      {!isSmall(metrics) && <Bars format={count => String(count)} limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={Array.from(types.entries()).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ key: type, label: type, value: count }))} />}</>;
  }
  const names = Array.from(new Map(active.map(item => [item.displayName.toLowerCase(), item] as const)).values()).sort((a, b) => (b.providerUpdatedAt ?? "").localeCompare(a.providerUpdatedAt ?? ""));
  return <><Tile label={`Active ${label.toLowerCase()}`} big={isSmall(metrics)} value={String(names.length)} detail={`across ${mirrors.rows.length} entities${failed ? ` · ${failed} unavailable` : ""}`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={names.map(item => ({ key: `${item.entity}-${item.providerObjectId}`, label: item.displayName, detail: item.entity, value: item.providerUpdatedAt ? shortDay(item.providerUpdatedAt) : "", tone: "muted" as const }))} />}</>;
}

function Transactions({ data, metrics }: WidgetContext) {
  const { gate } = useQboGate(data);
  const transactions = useQboTransactions(data);
  if (gate) return gate;
  if (transactions.loading) return <Loading />;
  const rows: Row[] = transactions.items.filter(item => item.postedOn).sort((a, b) => String(b.postedOn).localeCompare(String(a.postedOn))).map((item, index) => ({ id: `${item.source.objectId}-${item.source.lineId}-${index}`, date: item.postedOn, description: item.description ?? humanLabel(item.transactionType), type: humanLabel(item.transactionType), entity: item.entityName, amount: item.amountCents }));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No mirrored transactions." onMore={companyOpener(data, "accounting", { accountingView: "transactions" })} columns={[
    { key: "description", label: "Transaction", render: row => <span className="rops-cell-stack"><span>{String(row.description)}</span><small>{String(row.type)} · {String(row.entity)}</small></span> },
    { key: "date", label: "Date", render: row => shortDay(String(row.date)) },
    { key: "amount", label: "Amount", number: true, render: row => wholeCents(row.amount as string) },
  ]} footer={transactions.incomplete ? <span>Some entities returned a partial read</span> : undefined} />;
}

function Exceptions({ data, metrics }: WidgetContext) {
  const { entities, health, gate } = useQboGate(data);
  if (gate) return gate;
  const totals = entities.reduce((sum, entity) => ({ exceptions: sum.exceptions + entity.health.openSyncExceptions, dead: sum.dead + entity.health.jobs.dead, retry: sum.retry + entity.health.jobs.retry, deleted: sum.deleted + entity.health.activeTombstones }), { exceptions: 0, dead: 0, retry: 0, deleted: 0 });
  const workers = health.data?.workers;
  return <><StatStrip metrics={metrics} min={96} items={[
    { key: "exceptions", label: "Sync exceptions", value: String(totals.exceptions), tone: totals.exceptions ? "attention" : undefined },
    { key: "dead", label: "Failed jobs", value: String(totals.dead), tone: totals.dead ? "attention" : undefined },
    { key: "retry", label: "Retrying", value: String(totals.retry) },
    { key: "deleted", label: "Deleted in QBO", value: String(totals.deleted), detail: "last 30 days" },
  ]} />{metrics.h > 2 && <Foot action="Connections" onAction={companyOpener(data, "accounting", { accountingView: "connections" })}>{workers ? `${workers.active} worker${workers.active === 1 ? "" : "s"} · seen ${ago(workers.lastSeenAt)}` : ""}</Foot>}</>;
}

export const QUICKBOOKS_WIDGETS: readonly WidgetDefinition[] = [
  { id: "qb-sync", category: "qb", name: "QuickBooks sync", description: "Connection freshness, last sync and issues per entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <Sync {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "connections" }) },
  { id: "qb-pnl", category: "qb", name: "P&L by entity", description: "Income, operating expenses, operating income and net income YTD per LLC", sizes: SIZESETS.table, defaultSize: "L", render: context => <PnlByEntity {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "overview" }) },
  { id: "qb-income", category: "qb", name: "Income", description: "QuickBooks income year to date, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <FigureByEntity {...context} group="Income" label="Income" /> },
  { id: "qb-expenses", category: "qb", name: "Operating expenses", description: "QuickBooks operating expenses year to date, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <FigureByEntity {...context} group="Expenses" label="Operating expenses" /> },
  { id: "qb-noi", category: "qb", name: "Operating income", description: "Operating income (NOI) year to date, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <FigureByEntity {...context} group="NetOperatingIncome" label="Operating income" signed /> },
  { id: "qb-net-income", category: "qb", name: "Net income", description: "Net income year to date, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <FigureByEntity {...context} group="NetIncome" label="Net income" signed /> },
  { id: "qb-other-expenses", category: "qb", name: "Interest & other expenses", description: "Other expenses (interest, financing) year to date, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <FigureByEntity {...context} group="OtherExpenses" label="Other expenses" /> },
  { id: "qb-margin", category: "qb", name: "Operating margin", description: "Operating income as a share of income, by entity", sizes: SIZESETS.list, defaultSize: "M", render: context => <Margin {...context} /> },
  { id: "qb-balance", category: "qb", name: "Balance sheet by entity", description: "Assets, liabilities and equity per LLC from QuickBooks", sizes: SIZESETS.table, defaultSize: "L", render: context => <BalanceByEntity {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "overview" }) },
  { id: "qb-balance-mix", category: "qb", name: "Assets, debt & equity", description: "Totals across entities with the debt-to-equity split", sizes: ["M", "MT", "W", "XT"], defaultSize: "MT", render: context => <BalanceMix {...context} /> },
  { id: "qb-accounts", category: "qb", name: "Chart of accounts", description: "Active QuickBooks accounts by type", sizes: SIZESETS.list, defaultSize: "M", render: context => <Mirror {...context} kind="accounts" label="Accounts" /> },
  { id: "qb-vendors", category: "qb", name: "Vendors", description: "Active QuickBooks vendors, recently changed first", sizes: SIZESETS.list, defaultSize: "M", render: context => <Mirror {...context} kind="vendors" label="Vendors" /> },
  { id: "qb-customers", category: "qb", name: "Customers", description: "Active QuickBooks customers (tenants), recently changed first", sizes: SIZESETS.list, defaultSize: "M", render: context => <Mirror {...context} kind="customers" label="Customers" /> },
  { id: "qb-transactions", category: "qb", name: "QuickBooks transactions", description: "Latest mirrored QuickBooks transactions across entities", sizes: SIZESETS.table, defaultSize: "L", render: context => <Transactions {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "transactions" }) },
  { id: "qb-exceptions", category: "qb", name: "Sync issues", description: "Open sync exceptions, failed and retrying jobs, deletions", sizes: ["M", "MT", "W"], defaultSize: "M", render: context => <Exceptions {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "connections" }) },
];
