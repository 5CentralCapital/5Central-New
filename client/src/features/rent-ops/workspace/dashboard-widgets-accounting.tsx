// Accounting widgets: month-end close, PM settlements and remittances, bills,
// investor payments, debt maturities and balances, forecast coverage, and the
// review and work queues.
import React from "react";
import {
  Bars, Columns, Empty, Failed, Foot, LIST_ROW, Loading, Ring, Rows, SIZESETS, StatStrip, TABLE_ROW, TILE, Table, Tile,
  centsNumber, companyOpener, dayDiff, fitRows, humanLabel, isSmall, monthKey, monthShort, shortCents, shortDay, sumCents, wholeCents,
  type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { useCloseChecklists, useCompanyDashboard, useDebtMaturities, useForecast, usePayables, usePaymentCalendar, usePmSettlements } from "./dashboard-sources";
import { ForecastGate, useCompanyGate } from "./dashboard-widgets-overview";

const outstanding = (item: { derivedOutstandingCents: string | null; manualOutstandingCents: string | null }) => item.manualOutstandingCents ?? item.derivedOutstandingCents;

function CloseChecklist({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const close = useCloseChecklists(data);
  if (gate) return gate;
  if (close.health.error) return <Failed title="Close status unavailable" error={close.health.error} retry={() => void close.health.refetch()} />;
  if (!close.entities || close.loading) return <Loading />;
  if (!close.entities.length) return <Empty title="QuickBooks not connected">Close checks need a connected entity.</Empty>;
  const size = Math.max(40, Math.min(64, metrics.bodyHeight / Math.max(1, close.rows.length) - 8));
  return <><ul className="ops-close">{close.rows.slice(0, fitRows(metrics, size + 10, 30, 1)).map(row => {
    const checklist = row.checklist;
    const open = checklist?.items.filter(item => item.state !== "complete") ?? [];
    return <li key={row.entity.scope.legalEntityId}>
      <Ring size={size} share={checklist ? checklist.completeCount / Math.max(1, checklist.items.length) : undefined} tone={open.length ? "accent" : "positive"} label={checklist ? `${checklist.completeCount}/${checklist.items.length}` : "—"} />
      <span><strong>{row.entity.name}</strong><small>{row.error ? "Could not load" : !checklist ? "…" : open.length ? open.map(item => item.label).join(" · ") : "Closed"}</small></span>
    </li>;
  })}</ul><Foot action="Period close" onAction={companyOpener(data, "accounting", { accountingView: "close" })}>{monthShort(close.month)} {close.month.slice(0, 4)} close</Foot></>;
}

function Settlements({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const settlements = usePmSettlements(data);
  if (gate) return gate;
  if (settlements.loading) return <Loading />;
  const rows: Row[] = [...settlements.items].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).map(item => ({ ...item, id: item.id }));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty={settlements.failed ? "Settlements could not be loaded." : "No PM settlements recorded."} onMore={companyOpener(data, "accounting", { accountingView: "pm-settlements" })} columns={[
    { key: "propertyName", label: "Property", render: row => <span className="rops-cell-stack"><span>{String(row.propertyName ?? "Property")}</span><small>{String(row.managerName)} · {shortDay(String(row.periodStart))}–{shortDay(String(row.periodEnd))}</small></span> },
    ...(metrics.w >= 8 ? [{ key: "grossCollectionsCents", label: "Collected", number: true, render: (row: Row) => wholeCents(row.grossCollectionsCents as string) }, { key: "pmCostsCents", label: "PM costs", number: true, render: (row: Row) => wholeCents(row.pmCostsCents as string) }] : []),
    { key: "ownerRemittanceCents", label: "Remitted", number: true, render: row => wholeCents(row.ownerRemittanceCents as string) },
    { key: "state", label: "State", render: row => <span data-tone={row.state === "exception" ? "critical" : row.state === "reconciled" ? "positive" : undefined}>{humanLabel(String(row.state))}</span> },
  ]} />;
}

function Remittances({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const settlements = usePmSettlements(data);
  if (gate) return gate;
  if (settlements.loading) return <Loading />;
  if (!settlements.items.length) return <Empty title="No PM settlements recorded" />;
  const months = Array.from({ length: Math.max(3, Math.min(12, Math.floor(metrics.bodyWidth / 46))) }, (_, index) => monthKey(data.filters.asOfDate, index - Math.max(3, Math.min(12, Math.floor(metrics.bodyWidth / 46))) + 1));
  const byMonth = new Map<string, number>();
  for (const item of settlements.items) byMonth.set(item.periodEnd.slice(0, 7), (byMonth.get(item.periodEnd.slice(0, 7)) ?? 0) + (centsNumber(item.ownerRemittanceCents) ?? 0));
  const exceptions = settlements.items.filter(item => item.state === "exception").length;
  return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} points={months.map(month => ({ label: monthShort(month), value: byMonth.has(month) ? byMonth.get(month)! : null }))} />
    <Foot>Owner remittances by month{exceptions ? ` · ${exceptions} exception${exceptions === 1 ? "" : "s"}` : ""}</Foot></>;
}

function Bills({ data, metrics, mode }: WidgetContext & { mode: "open" | "due" }) {
  const { gate } = useCompanyGate(data);
  const bills = usePayables(data, "bills");
  if (gate) return gate;
  if (bills.health.error) return <Failed title="Bills unavailable" error={bills.health.error} />;
  if (bills.loading || !bills.entities) return <Loading />;
  if (!bills.entities.length) return <Empty title="QuickBooks not connected" />;
  const asOf = data.filters.asOfDate;
  const open = bills.items.filter(item => item.postingState !== "voided" && (centsNumber(item.openBalanceCents) ?? 0) > 0);
  const rows = (mode === "due" ? open.filter(item => item.dueDate && dayDiff(asOf, item.dueDate) <= 14) : open).sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const total = sumCents(rows.map(item => item.openBalanceCents));
  const overdue = rows.filter(item => item.dueDate && item.dueDate < asOf).length;
  if (!rows.length) return <Empty title={mode === "due" ? "No bills due in 14 days" : "No open bills"}>{bills.incomplete ? "Some QuickBooks bills could not be read." : undefined}</Empty>;
  return <><Tile label={mode === "due" ? "Due in 14 days" : "Open bills"} big={isSmall(metrics)} value={wholeCents(total)} tone={overdue ? "attention" : undefined} detail={`${rows.length} bill${rows.length === 1 ? "" : "s"}${overdue ? ` · ${overdue} overdue` : ""}${bills.incomplete ? " · partial read" : ""}`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(item => ({ key: `${item.objectId}-${item.entityName}`, label: item.vendorName ?? "Vendor", detail: `${item.entityName}${item.dueDate ? ` · due ${shortDay(item.dueDate)}` : ""}`, value: wholeCents(item.openBalanceCents), tone: item.dueDate && item.dueDate < asOf ? "critical" as const : undefined }))} />}</>;
}

function BillPayments({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const payments = usePayables(data, "payments");
  if (gate) return gate;
  if (payments.loading || !payments.entities) return <Loading />;
  if (!payments.entities.length) return <Empty title="QuickBooks not connected" />;
  const rows = payments.items.filter(item => item.postingState !== "voided").sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  if (!rows.length) return <Empty title="No bill payments" />;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(item => ({ key: `${item.objectId}-${item.entityName}`, label: item.vendorName ?? "Vendor", detail: `${item.entityName} · ${shortDay(item.transactionDate)}`, value: wholeCents(item.amountCents) }))} />;
}

function InvestorPayments({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const calendar = usePaymentCalendar(data);
  if (gate) return gate;
  if (calendar.loading) return <Loading />;
  const upcoming = calendar.items.filter(item => item.dueOn >= data.filters.asOfDate || (centsNumber(item.remainingCents) ?? 1) > 0);
  if (!upcoming.length) return <Empty title="No investor payments scheduled">{calendar.failed ? "Some entities could not be read." : "Nothing due in the next three months."}</Empty>;
  const due = sumCents(upcoming.map(item => item.remainingCents));
  return <><Tile label="Investor payments · 3 months" big={isSmall(metrics)} value={due === null ? `≥ ${wholeCents(sumCents(upcoming.map(item => item.remainingCents ?? item.knownMinimumCents)))}` : wholeCents(due)} detail={`${upcoming.length} payments to ${new Set(upcoming.map(item => item.accountId)).size} investors`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={upcoming.map(item => ({ key: item.obligationId, label: item.accountName, detail: `${item.instrumentName} · ${shortDay(item.dueOn)}`, value: item.remainingCents === null ? "Unknown" : wholeCents(item.remainingCents), tone: item.dueOn < data.filters.asOfDate ? "critical" as const : undefined }))} />}</>;
}

function InvestorMonthly({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const calendar = usePaymentCalendar(data, 6);
  if (gate) return gate;
  if (calendar.loading) return <Loading />;
  if (!calendar.items.length) return <Empty title="No investor payments scheduled" />;
  const months = Array.from({ length: 6 }, (_, index) => monthKey(data.filters.asOfDate, index));
  const byMonth = months.map(month => { const items = calendar.items.filter(item => item.periodMonth.slice(0, 7) === month); return sumCents(items.map(item => item.expectedCents)); });
  return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} points={months.map((month, index) => ({ label: monthShort(month), value: centsNumber(byMonth[index]) ?? null, tone: "accent" }))} /><Foot>Scheduled investor payments by month</Foot></>;
}

function DebtMaturities({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const debt = useDebtMaturities(data);
  if (gate) return gate;
  if (debt.error) return <Failed title="Debt unavailable" error={debt.error} retry={() => void debt.refetch()} />;
  if (!debt.data) return <Loading />;
  const rows: Row[] = debt.data.items.filter(item => item.maturityOn).sort((a, b) => a.maturityOn!.localeCompare(b.maturityOn!)).map(item => ({ ...item, id: item.instrumentId, outstanding: outstanding(item) }));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No dated debt instruments." onMore={companyOpener(data, "investors", { investorTab: "debt" })} columns={[
    { key: "instrumentName", label: "Loan", render: row => <span className="rops-cell-stack"><span>{String(row.instrumentName)}</span><small>{String(row.accountName)}{row.annualRate ? ` · ${row.annualRate}%` : ""}</small></span> },
    { key: "maturityOn", label: "Matures", render: row => { const months = row.monthsToMaturity as number | null; return <span data-tone={months !== null && months <= 3 ? "critical" : undefined}>{shortDay(String(row.maturityOn))}{months !== null ? <small> · {months <= 0 ? "due" : `${months} mo`}</small> : null}</span>; } },
    { key: "outstanding", label: "Outstanding", number: true, render: row => wholeCents(row.outstanding as string | null) },
    ...(metrics.w >= 8 ? [{ key: "balloonCents", label: "Balloon", number: true, render: (row: Row) => wholeCents(row.balloonCents as string | null) }] : []),
  ]} />;
}

function DebtBalances({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const debt = useDebtMaturities(data);
  if (gate) return gate;
  if (debt.error) return <Failed title="Debt unavailable" error={debt.error} retry={() => void debt.refetch()} />;
  if (!debt.data) return <Loading />;
  const items = debt.data.items.filter(item => centsNumber(outstanding(item)) !== undefined);
  const total = sumCents(debt.data.items.map(outstanding));
  if (!debt.data.items.length) return <Empty title="No debt recorded" />;
  return <><Tile label="Debt outstanding" big={isSmall(metrics)} value={total === null ? `≥ ${wholeCents(sumCents(items.map(outstanding)))}` : wholeCents(total)} detail={`${debt.data.items.length} instruments${debt.data.items.length > items.length ? ` · ${debt.data.items.length - items.length} balance unknown` : ""}`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={items.sort((a, b) => (centsNumber(outstanding(b)) ?? 0) - (centsNumber(outstanding(a)) ?? 0)).map(item => ({ key: item.instrumentId, label: <>{item.instrumentName} <small>{item.accountName}</small></>, value: centsNumber(outstanding(item)) ?? 0 }))} />}</>;
}

function Coverage({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const rows = result.debt.coverage.slice(0, Math.max(3, Math.floor(metrics.bodyWidth / 40)));
    if (!rows.length) return <Empty title="No debt service in the forecast" />;
    return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} format={value => `${value.toFixed(2)}×`} points={rows.map(row => ({ label: monthShort(row.month), value: row.dscrBps === null ? null : row.dscrBps / 10_000, tone: row.dscrBps !== null && row.dscrBps < 12_500 ? "critical" : "positive" }))} />
      <Foot>Forecast NOI ÷ scheduled debt service; red is under 1.25×</Foot></>;
  }}</ForecastGate>;
}

function Ladder({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const ladder = result.debt.ladder;
    if (!ladder.length) return <Empty title="No loans in the forecast" />;
    return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} points={ladder.map(entry => ({ label: entry.year === "overdue" ? "Past due" : entry.year, value: centsNumber(entry.maturingCents) ?? null, tone: entry.year === "overdue" ? "critical" : "accent" }))} />
      <Foot>Loan balances maturing by year</Foot></>;
  }}</ForecastGate>;
}

function ForecastNoi({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const months = result.months.slice(0, Math.max(3, Math.min(result.months.length, Math.floor(metrics.bodyWidth / 38))));
    const total = months.reduce((sum, month) => sum + (centsNumber(month.noiCents) ?? 0), 0);
    return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} points={months.map(month => ({ label: monthShort(month.month), value: centsNumber(month.noiCents) ?? null }))} />
      <Foot>Forecast NOI · {shortCents(total)} over {months.length} months</Foot></>;
  }}</ForecastGate>;
}

function ReviewQueue({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const company = useCompanyDashboard(data);
  if (gate) return gate;
  if (company.error) return <Failed title="Review queue unavailable" error={company.error} retry={() => void company.refetch()} />;
  if (!company.data) return <Loading />;
  const review = company.data.reviewCases;
  if (!review.available) return <Empty title="Review queue unavailable" />;
  if (!review.openCount) return <Empty title="No records to review" />;
  return <><Tile label="Records to review" big={isSmall(metrics)} value={String(review.openCount)} tone="review" />
    {!isSmall(metrics) && <Bars format={value => String(value)} limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={review.topReasons.map(reason => ({ key: reason.reasonCode, label: <>{humanLabel(reason.reasonCode)}{reason.highMaterialityCount ? <small> {reason.highMaterialityCount} material</small> : null}</>, value: reason.count, tone: reason.highMaterialityCount ? "critical" as const : undefined }))} />}</>;
}

function WorkDue({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const company = useCompanyDashboard(data);
  if (gate) return gate;
  if (company.error) return <Failed title="Work orders unavailable" error={company.error} retry={() => void company.refetch()} />;
  if (!company.data) return <Loading />;
  const work = company.data.workDue;
  if (!work.items.length) return <Empty title="No work due in 14 days" />;
  const overdue = work.items.filter(item => item.overdue).length;
  return <><StatStrip metrics={metrics} min={100} items={[{ key: "open", label: "Due in 14 days", value: String(work.openCount) }, { key: "overdue", label: "Overdue", value: String(overdue), tone: overdue ? "attention" : undefined }]} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={work.items.map(item => ({ key: item.id, label: item.title, detail: `${item.propertyName ?? ""}${item.unitNumber ? ` ${item.unitNumber}` : ""} · ${humanLabel(item.priority)}`, value: item.scheduledOn ? shortDay(item.scheduledOn) : "Unscheduled", tone: item.overdue ? "critical" as const : undefined }))} />}</>;
}

export const ACCOUNTING_WIDGETS: readonly WidgetDefinition[] = [
  { id: "close-checklist", category: "accounting", name: "Month-end close", description: "Last month's close checks per entity: posting, sync, exceptions, settlements, deletions", sizes: SIZESETS.list, defaultSize: "MT", render: context => <CloseChecklist {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "close" }) },
  { id: "pm-settlements", category: "accounting", name: "PM settlements", description: "Manager statements with collections, costs, remittance and state", sizes: SIZESETS.table, defaultSize: "L", render: context => <Settlements {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "pm-settlements" }) },
  { id: "pm-remittances", category: "accounting", name: "Owner remittances", description: "What property managers remitted, by month", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <Remittances {...context} /> },
  { id: "bills-open", category: "accounting", name: "Open bills", description: "Unpaid QuickBooks bills across entities, oldest due first", sizes: SIZESETS.list, defaultSize: "MT", render: context => <Bills {...context} mode="open" />, open: data => companyOpener(data, "accounting", { accountingView: "bills" }) },
  { id: "bills-due", category: "accounting", name: "Bills due soon", description: "Bills due in the next 14 days or overdue", sizes: SIZESETS.list, defaultSize: "M", render: context => <Bills {...context} mode="due" />, open: data => companyOpener(data, "accounting", { accountingView: "bills" }) },
  { id: "bill-payments", category: "accounting", name: "Bill payments", description: "Recent payments to vendors from QuickBooks", sizes: SIZESETS.list, defaultSize: "M", render: context => <BillPayments {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "bills" }) },
  { id: "investor-payments", category: "accounting", name: "Investor payments", description: "Payments due to investors over the next three months", sizes: SIZESETS.list, defaultSize: "MT", render: context => <InvestorPayments {...context} />, open: data => companyOpener(data, "investors", { investorTab: "payments" }) },
  { id: "investor-monthly", category: "accounting", name: "Investor payments by month", description: "Scheduled investor payments for the next six months", sizes: SIZESETS.chart, defaultSize: "M", render: context => <InvestorMonthly {...context} />, open: data => companyOpener(data, "investors", { investorTab: "payments" }) },
  { id: "debt-maturities", category: "accounting", name: "Debt maturities", description: "Every dated loan by maturity with outstanding and balloon", sizes: SIZESETS.table, defaultSize: "L", render: context => <DebtMaturities {...context} />, open: data => companyOpener(data, "investors", { investorTab: "debt" }) },
  { id: "debt-balances", category: "accounting", name: "Debt outstanding", description: "Outstanding balance per loan and in total", sizes: SIZESETS.list, defaultSize: "MT", render: context => <DebtBalances {...context} />, open: data => companyOpener(data, "investors", { investorTab: "debt" }) },
  { id: "debt-coverage", category: "accounting", name: "Debt coverage", description: "Forecast DSCR by month: NOI over scheduled debt service", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <Coverage {...context} /> },
  { id: "debt-ladder", category: "accounting", name: "Maturity ladder", description: "Loan balances maturing each year in the forecast", sizes: SIZESETS.chart, defaultSize: "M", render: context => <Ladder {...context} /> },
  { id: "forecast-noi", category: "accounting", name: "Forecast NOI", description: "Monthly net operating income from the forecast", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <ForecastNoi {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "review-queue", category: "accounting", name: "Records to review", description: "Open review cases by reason, material ones flagged", sizes: SIZESETS.list, defaultSize: "M", render: context => <ReviewQueue {...context} />, open: data => companyOpener(data, "review-queue") },
  { id: "work-due", category: "company", name: "Work due", description: "Work orders due in the next 14 days and overdue", sizes: SIZESETS.list, defaultSize: "MT", render: context => <WorkDue {...context} />, open: data => companyOpener(data, "work-orders", { workOrderView: "schedule" }) },
];
