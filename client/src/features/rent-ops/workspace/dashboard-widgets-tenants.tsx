// Tenant widgets beyond the core dashboard: who owes the most, who has not
// paid, lease ends, month-to-month, deposits, housing assistance, credits.
import React from "react";
import {
  Bars, Empty, Failed, Foot, LIST_ROW, Loading, Rows, SIZESETS, Stack, StatStrip, TABLE_ROW, TILE, Table, Tile,
  addDays, dollars, fitRows, groupByProperty, humanLabel, isSmall, money, numeric, pct, shortDay, sumKnown, tenantCell, text,
  type DashboardData, type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { useExtraRentalRows } from "./dashboard-sources";

const LEASE_KEYS = ["propertyId", "propertyName", "unitId", "unitNumber", "tenantName", "personId", "currentPersonId", "contractEndOn", "monthToMonth", "currentBaseRentCents", "noticeDeadlineOn", "actionStatus"];
const DEPOSIT_KEYS = ["propertyId", "propertyName", "unitNumber", "tenantName", "personId", "securityHeldCents", "refundablePetHeldCents", "otherRefundableHeldCents", "totalHeldCents", "dispositionStatus", "unknownHeldCount", "temporalUncertainty"];
const HAP_KEYS = ["propertyId", "propertyName", "unitNumber", "tenantName", "personId", "agencyName", "month", "agencyObligationCents", "tenantObligationCents", "expectedTotalCents", "receivedAgencyCents", "agencyReceiptStatus", "varianceCents", "exception"];
const SVC_KEYS = ["propertyId", "propertyName", "month", "scheduledCents", "scheduledUncertainCents", "scheduledUnknownAmountCount", "collectedCents", "collectedUncertainCents", "collectedUnknownAmountCount", "varianceCents", "complete"];

const isMonthToMonth = (value: unknown) => value === true || value === "yes" || value === "month_to_month";

/** A property-level comparison is exact only when the server explicitly says
 * that its scheduled and collected sides are complete. */
const isCompleteScheduledVsCollectedRow = (row: Row): boolean => row.complete === true
  && (row.scheduledUncertainCents === undefined || row.scheduledUncertainCents === 0)
  && (row.scheduledUnknownAmountCount === undefined || row.scheduledUnknownAmountCount === 0)
  && (row.collectedUncertainCents === undefined || row.collectedUncertainCents === 0)
  && (row.collectedUnknownAmountCount === undefined || row.collectedUnknownAmountCount === 0);

function TopBalances({ data, metrics }: WidgetContext) {
  if (!data.knownDue) return <Loading />;
  if (!data.knownDue.length) return data.unverifiedDue > 0
    ? <Empty title="No verified balances">Unverified accounts are excluded from this ranking.</Empty>
    : <Empty title="No balances due" />;
  const rows = [...data.knownDue].sort((a, b) => Number(b.operationalBalanceCents) - Number(a.operationalBalanceCents));
  return <><Bars tone="critical" limit={fitRows(metrics, LIST_ROW, 30, 1)} items={rows.map((row, index) => ({ key: `${row.personId}-${index}`, label: <>{text(row.tenantName)} <small>{text(row.propertyName)} {text(row.unitNumber)}</small></>, value: Number(row.operationalBalanceCents) || 0, tone: "critical" }))} />
    <Foot action="All balances" onAction={() => data.onReport("delinquency")}>{rows.length} accounts · top {Math.min(rows.length, fitRows(metrics, LIST_ROW, 30, 1))}</Foot></>;
}

function LeaseEnds({ data, metrics }: WidgetContext) {
  const leases = useExtraRentalRows(data, "lease-expiration", LEASE_KEYS);
  if (leases.error) return <Failed title="Lease dates unavailable" error={leases.error} retry={leases.retry} />;
  const until = addDays(data.filters.asOfDate, 90);
  const rows = leases.rows?.filter(row => typeof row.contractEndOn === "string" && row.contractEndOn <= until && !isMonthToMonth(row.monthToMonth)).sort((a, b) => String(a.contractEndOn).localeCompare(String(b.contractEndOn)));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No leases end in the next 90 days." onMore={() => data.onReport("lease-expiration")} columns={[
    { key: "tenantName", label: "Resident", render: row => tenantCell(data, row) },
    { key: "contractEndOn", label: "Ends", render: row => <span data-tone={String(row.contractEndOn) < data.filters.asOfDate ? "critical" : undefined}>{shortDay(String(row.contractEndOn))}</span> },
    ...(metrics.w >= 8 ? [{ key: "currentBaseRentCents", label: "Rent", number: true, render: (row: Row) => money(row.currentBaseRentCents) }, { key: "noticeDeadlineOn", label: "Notice by", render: (row: Row) => row.noticeDeadlineOn ? shortDay(String(row.noticeDeadlineOn)) : "—" }] : []),
    { key: "actionStatus", label: "Next step", render: row => humanLabel(String(row.actionStatus ?? "")) },
  ]} footer={rows ? <span>{rows.length} lease{rows.length === 1 ? "" : "s"} ending by {shortDay(until)}</span> : undefined} />;
}

function MonthToMonth({ data, metrics }: WidgetContext) {
  const leases = useExtraRentalRows(data, "lease-expiration", LEASE_KEYS);
  if (leases.error) return <Failed title="Lease data unavailable" error={leases.error} retry={leases.retry} />;
  if (!leases.rows) return <Loading />;
  const rows = leases.rows.filter(row => isMonthToMonth(row.monthToMonth));
  const rent = sumKnown(rows, "currentBaseRentCents");
  return <><Tile label="Month to month" big={isSmall(metrics)} value={String(rows.length)} detail={rows.length ? `${rent === undefined ? "rent not recorded for some" : `${dollars(rent)} a month`}` : "Every resident is on a term lease"} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map((row, index) => ({ key: `${row.unitId}-${index}`, label: text(row.tenantName), detail: `${text(row.propertyName)} ${text(row.unitNumber)}`, value: money(row.currentBaseRentCents) }))} />}</>;
}

function Deposits({ data, metrics }: WidgetContext) {
  const deposits = useExtraRentalRows(data, "security-deposit", DEPOSIT_KEYS);
  if (deposits.error) return <Failed title="Deposits unavailable" error={deposits.error} retry={deposits.retry} />;
  if (!deposits.rows) return <Loading />;
  const isUnknown = (row: Row) => !numeric(row.totalHeldCents) || row.temporalUncertainty === true;
  const known = deposits.rows.filter(row => !isUnknown(row));
  // `unknownHeldCount` counts unknown source deposits inside a grouped row;
  // adding the row count as well would report each unresolved deposit twice.
  const unknown = deposits.rows.reduce((sum, row) => {
    if (!isUnknown(row)) return sum;
    return sum + (numeric(row.unknownHeldCount) && row.unknownHeldCount > 0 ? row.unknownHeldCount : 1);
  }, 0);
  const total = known.reduce((sum, row) => sum + (row.totalHeldCents as number), 0);
  const groups = groupByProperty(known, () => ({ cents: 0, count: 0 }), (group, row) => { group.cents += row.totalHeldCents as number; group.count += 1; });
  const totalLabel = unknown ? (total ? `≥ ${dollars(total)}` : "Unknown") : dollars(total);
  return <><Tile label="Deposits held" big={isSmall(metrics)} value={totalLabel} detail={`${known.length} residents${unknown ? ` · ${unknown} records unresolved` : ""}`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={groups.sort((a, b) => b.cents - a.cents).map(group => ({ key: group.propertyId, label: <>{group.propertyName} <small>{group.count}</small></>, value: group.cents }))} />}</>;
}

function HousingAssistance({ data, metrics }: WidgetContext) {
  const hap = useExtraRentalRows(data, "hap", HAP_KEYS, { month: data.filters.asOfDate.slice(0, 7) });
  if (hap.error) return <Failed title="Housing assistance unavailable" error={hap.error} retry={hap.retry} />;
  if (!hap.rows) return <Loading />;
  if (!hap.rows.length) return <Empty title="No housing assistance this month" />;
  const expected = sumKnown(hap.rows, "agencyObligationCents"), received = sumKnown(hap.rows, "receivedAgencyCents");
  const byAgency = new Map<string, { expected: number; received: number; count: number; unknown: boolean }>();
  for (const row of hap.rows) {
    const key = text(row.agencyName);
    const group = byAgency.get(key) ?? { expected: 0, received: 0, count: 0, unknown: false };
    group.count += 1;
    if (numeric(row.agencyObligationCents)) group.expected += row.agencyObligationCents; else group.unknown = true;
    if (numeric(row.receivedAgencyCents)) group.received += row.receivedAgencyCents; else group.unknown = true;
    byAgency.set(key, group);
  }
  return <><Tile label={`Agency rent · ${data.monthLabel}`} big={isSmall(metrics)} value={received === undefined ? "Unknown" : dollars(received)} meter={expected && received !== undefined ? received / expected : undefined} detail={`of ${expected === undefined ? "unknown" : dollars(expected)} expected · ${hap.rows.length} households`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE + 10, 1)} items={Array.from(byAgency.entries()).map(([agency, group]) => ({ key: agency, label: agency, detail: `${group.count} households`, value: group.unknown ? "Unknown" : `${dollars(group.received)} / ${dollars(group.expected)}`, tone: !group.unknown && group.received < group.expected ? "critical" as const : undefined }))} />}</>;
}

function CollectionRate({ data, metrics }: WidgetContext) {
  const svc = useExtraRentalRows(data, "scheduled-vs-collected", SVC_KEYS, { month: data.filters.asOfDate.slice(0, 7) });
  if (svc.error) return <Failed title="Scheduled vs collected unavailable" error={svc.error} retry={svc.retry} />;
  if (!svc.rows) return <Loading />;
  if (!svc.rows.length) return <Empty title="Nothing scheduled this month" />;
  const scheduled = sumKnown(svc.rows, "scheduledCents"), collected = sumKnown(svc.rows, "collectedCents");
  const complete = svc.rows.every(isCompleteScheduledVsCollectedRow);
  const share = complete && scheduled && collected !== undefined ? collected / scheduled : undefined;
  return <><Tile label={`Collected of scheduled · ${data.monthLabel}`} big={isSmall(metrics)} value={share === undefined ? "Unknown" : pct(share)} meter={share} tone={share !== undefined && share < 0.8 ? "attention" : undefined} detail={`${collected === undefined ? "—" : dollars(collected)} of ${scheduled === undefined ? "—" : dollars(scheduled)}${complete ? "" : " · some properties incomplete"}`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE + 10, 1)} format={value => `${Math.round(value)}%`} items={svc.rows.map((row, index) => {
      const rate = isCompleteScheduledVsCollectedRow(row) && numeric(row.scheduledCents) && row.scheduledCents > 0 && numeric(row.collectedCents) ? row.collectedCents / row.scheduledCents * 100 : undefined;
      return { key: `${row.propertyId}-${index}`, label: text(row.propertyName), value: rate ?? 0, display: rate === undefined ? "Unknown" : `${Math.round(rate)}%`, tone: rate !== undefined && rate < 60 ? "critical" as const : undefined };
    })} />}</>;
}

function UnverifiedBalances({ data, metrics }: WidgetContext) {
  if (!data.dueRows) return <Loading />;
  const rows = data.dueRows.filter(row => !numeric(row.operationalBalanceCents));
  if (!rows.length) return <Empty title="Every balance is verified" />;
  return <><Tile label="Balances not verified" big={isSmall(metrics)} value={String(rows.length)} tone="review" detail="Ledger and review disagree or the amount is missing" />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map((row, index) => ({ key: `${row.personId}-${index}`, label: text(row.tenantName), detail: `${text(row.propertyName)} ${text(row.unitNumber)}`, value: numeric(row.totalBalanceCents) ? `Ledger ${money(row.totalBalanceCents)}` : "Unknown", tone: "muted" as const }))} />}</>;
}

function NotPaid({ data, metrics }: WidgetContext) {
  if (!data.rentRoll || !data.receipts) return <Loading />;
  const paid = new Set(data.receipts.map(row => String(row.personId ?? "")));
  const current = data.rentRoll.filter(row => row.occupancy === "current" && (row.currentPersonId || row.personId));
  const unpaid = current.filter(row => !paid.has(String(row.currentPersonId ?? row.personId)));
  const rent = sumKnown(unpaid, "baseRentCents");
  return <><Tile label={`No rent posted · ${data.monthLabel}`} big={isSmall(metrics)} value={`${unpaid.length} of ${current.length}`} tone={unpaid.length ? "attention" : undefined} detail={unpaid.length ? `${rent === undefined ? "rent unknown for some" : `${dollars(rent)} of base rent`}` : "Everyone has paid this month"} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={unpaid.map((row, index) => ({ key: `${row.unitId}-${index}`, label: text(row.currentTenantName ?? row.tenantName), detail: `${text(row.propertyName)} ${text(row.unitNumber)}`, value: money(row.baseRentCents) }))} />}</>;
}

function TenantCount({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const current = data.rentRoll.filter(row => row.occupancy === "current");
  // The server keeps a future replacement tenancy on a current row through
  // futurePersonId; count it alongside standalone future-preleased rows.
  const future = data.rentRoll.filter(row => row.occupancy === "future_preleased" || row.futurePersonId);
  const rent = sumKnown(current, "baseRentCents");
  return <StatStrip metrics={metrics} min={110} items={[
    { key: "current", label: "Current tenants", value: String(current.length), detail: `${data.propertyRows?.length ?? "—"} properties` },
    { key: "avg", label: "Average rent", value: rent === undefined || !current.length ? "—" : dollars(rent / current.length), detail: "Base rent, occupied" },
    { key: "future", label: "Moving in", value: String(future.length), detail: "Preleased or future tenants" },
  ]} />;
}

function Credits({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const rows = data.rentRoll.filter(row => numeric(row.operationalBalanceCents) && row.operationalBalanceCents < 0).sort((a, b) => Number(a.operationalBalanceCents) - Number(b.operationalBalanceCents));
  const total = rows.reduce((sum, row) => sum + Math.abs(Number(row.operationalBalanceCents)), 0);
  const unknown = data.rentRoll.filter(row => !numeric(row.operationalBalanceCents)).length;
  const totalLabel = unknown ? (total ? `≥ ${dollars(total)}` : "Unknown") : dollars(total);
  return <><Tile label="Prepaid & credits" big={isSmall(metrics)} value={totalLabel} detail={`${rows.length} tenant${rows.length === 1 ? "" : "s"} carrying a credit${unknown ? ` · ${unknown} balances not verified` : ""}`} />
    {!isSmall(metrics) && (rows.length ? <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map((row, index) => ({ key: `${row.unitId}-${index}`, label: text(row.currentTenantName ?? row.tenantName), detail: `${text(row.propertyName)} ${text(row.unitNumber)}`, value: dollars(Math.abs(Number(row.operationalBalanceCents))), tone: "positive" as const }))} /> : unknown ? <Empty title="Credit balances unavailable">Unverified balances may include credits.</Empty> : <Empty title="No credits" />)}</>;
}

function BalanceMix({ data }: WidgetContext) {
  if (!data.dueRows || !data.dueSplit) return <Loading />;
  const verifiedZero = (data.rentRoll ?? []).filter(row => row.occupancy === "current" && numeric(row.operationalBalanceCents) && row.operationalBalanceCents <= 0).length;
  return <Stack format={value => String(value)} parts={[
    { key: "clear", label: "Paid up", value: verifiedZero, tone: "positive" },
    { key: "owing", label: "Owing", value: data.dueSplit.knownCount, tone: "critical" },
    { key: "unverified", label: "Not verified", value: data.dueSplit.unverifiedCount, tone: "muted" },
  ]} />;
}

export const TENANT_WIDGETS: readonly WidgetDefinition[] = [
  { id: "top-delinquents", category: "rent", name: "Largest balances", description: "Tenants owing the most, as bars", sizes: SIZESETS.list, defaultSize: "MT", render: context => <TopBalances {...context} />, open: data => () => data.onReport("delinquency") },
  { id: "unpaid-tenants", category: "rent", name: "Not paid this month", description: "Current tenants with no rent receipt posted this month", sizes: SIZESETS.list, defaultSize: "MT", render: context => <NotPaid {...context} />, open: data => () => data.onReport("collected-income") },
  { id: "collection-rate", category: "rent", name: "Scheduled vs collected", description: "This month's collections against scheduled rent, per property", sizes: SIZESETS.list, defaultSize: "MT", render: context => <CollectionRate {...context} />, open: data => () => data.onReport("scheduled-vs-collected") },
  { id: "lease-expirations", category: "rent", name: "Lease expirations", description: "Term leases ending in the next 90 days with the next step", sizes: SIZESETS.table, defaultSize: "L", render: context => <LeaseEnds {...context} />, open: data => () => data.onReport("lease-expiration") },
  { id: "month-to-month", category: "rent", name: "Month to month", description: "Residents past their lease term, with rent", sizes: SIZESETS.list, defaultSize: "M", render: context => <MonthToMonth {...context} />, open: data => () => data.onReport("lease-expiration") },
  { id: "security-deposits", category: "rent", name: "Security deposits", description: "Deposits held by property; missing amounts are flagged", sizes: SIZESETS.list, defaultSize: "M", render: context => <Deposits {...context} />, open: data => () => data.onReport("security-deposit") },
  { id: "hap", category: "rent", name: "Housing assistance", description: "Agency rent received against expected this month, by agency", sizes: SIZESETS.list, defaultSize: "M", render: context => <HousingAssistance {...context} />, open: data => () => data.onReport("hap") },
  { id: "unverified-balances", category: "rent", name: "Balances not verified", description: "Tenants whose balance needs review before it can be trusted", sizes: SIZESETS.list, defaultSize: "M", render: context => <UnverifiedBalances {...context} />, open: data => () => data.onReport("delinquency") },
  { id: "tenant-count", category: "rent", name: "Tenant count", description: "Current tenants, average rent and move-ins coming", sizes: ["S", "M", "W"], defaultSize: "M", render: context => <TenantCount {...context} /> },
  { id: "credits", category: "rent", name: "Prepaid & credits", description: "Tenants carrying a credit balance", sizes: SIZESETS.list, defaultSize: "M", render: context => <Credits {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "balance-mix", category: "rent", name: "Balance status", description: "Current tenants paid up, owing, or not verified", sizes: ["S", "M", "W"], defaultSize: "M", render: context => <BalanceMix {...context} />, open: data => () => data.onReport("delinquency") },
];

export type { DashboardData };
