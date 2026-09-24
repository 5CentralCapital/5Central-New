import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Plus } from "lucide-react";
import type { QuickAction } from "../rent-ops/form-payload";
import { PaymentReviewPanel } from "../rent-ops/payment-review-panel";
import { ManagerIncomeActions } from "../rent-ops/manager-income-actions";
import { RecurringBillingPanel } from "../rent-ops/recurring-billing-panel";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { EmptyState, NotVerified } from "../rent-ops/workspace/ops-ui";
import { selectedWorkspaceProperties } from "../rent-ops/workspace/workspace-state";
import { displayPersonName, formatLongDate, formatTableDate } from "../../lib/rent-ops-formatters";
import { centsSortValue, formatCentsText, formatKnownSubtotal, formatMeasure, formatMonth, sumCentsTexts } from "./format";
import { ErrorState, Loading, Section, Segmented } from "./page";
import { matchesSearch, rentalRows, useRentalReport } from "./rental-reports";
import { balancesDue, legacyCents, receiptsByPayment, type RentalRow } from "./models";
import { balanceAge, balancesScopeSummary, groupBalances, unverifiedReason, type TenantScope } from "./collections-model";

const SCOPE_OPTIONS = [["current", "Current tenants"], ["former", "Former tenants"]] as const;
const KNOWN_PAGE = 25;
const UNVERIFIED_PAGE = 10;

function tenantLabel(row: RentalRow): string {
  return displayPersonName(row.tenantName as string | null | undefined) || "Tenant";
}

/** Tenancy status that is neither current nor former, shown beside the name in the current view. */
function otherStatusNote(row: RentalRow): string | undefined {
  if (row.tenancyStatus === "future") return "Future tenant";
  if (row.tenancyStatus === "current" || row.tenancyStatus === "former") return undefined;
  return "Tenancy status not verified";
}

/** Tenants › Collections: balances due, this month's receipts and the receipt/charge actions. */
export function Collections({ identity, snapshot, filters, businessDate, readOnly, paymentContextLoading, onRequestPaymentContext, onSaved, onEdit, onOpenRecurring }: {
  identity: string; snapshot: AdminSnapshot; filters: ViewFilters; businessDate: string; readOnly: boolean;
  paymentContextLoading: boolean; onRequestPaymentContext: () => void; onSaved: () => Promise<void>;
  onEdit: (action: QuickAction) => void; onOpenRecurring: () => void;
}) {
  const [panel, setPanel] = useState<"receipt" | "billing">();
  const [scope, setScope] = useState<TenantScope>("current");
  const [expanded, setExpanded] = useState<{ known: boolean; unverified: boolean }>({ known: false, unverified: false });
  const month = filters.asOfDate.slice(0, 7);
  const asOfYear = Number(filters.asOfDate.slice(0, 4)) || undefined;
  // Former tenants who still owe are collection work too, so every tenancy status is included.
  const delinquency = useRentalReport(identity, "delinquency", filters, { asOfDate: filters.asOfDate }, { tenantStatus: "all" });
  // Receipts from every tenancy count, including former tenants settling a balance.
  const collected = useRentalReport(identity, "collected-income", filters, { asOfDate: filters.asOfDate, month, fromDate: `${month}-01`, toDate: filters.asOfDate }, { tenantStatus: "all" });
  const due = rentalRows(delinquency.data, snapshot, ["personId", "tenantName", "propertyId", "propertyName", "unitId", "unitNumber", "operationalBalanceCents", "balanceComplete", "balanceUncertaintyCodes", "oldestUnpaidRentOn", "lastPaymentOn", "tenancyStatus"]);
  const receiptRows = rentalRows(collected.data, snapshot, ["paymentTransactionId", "personId", "tenantName", "propertyId", "propertyName", "unitNumber", "paymentOn", "category", "amountCents"]);
  const dueRows = due ? balancesDue(due).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"])) : undefined;
  const receipts = receiptRows ? receiptsByPayment(receiptRows).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"])) : undefined;
  const selected = selectedWorkspaceProperties(filters);
  const groups = dueRows ? groupBalances(dueRows, scope) : undefined;
  const receiptTotal = receipts ? sumCentsTexts(receipts.map(row => row.receiptCents as string | null)) : undefined;
  const tableDate = (value: unknown) => formatTableDate(value, asOfYear) ?? "—";
  const receiptColumns: GridColumn<RentalRow>[] = [
    { key: "paymentOn", label: "Received", render: row => tableDate(row.paymentOn) },
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string} tab="ledger">{tenantLabel(row)}</EntityLink> },
    { key: "propertyName", label: "Property" },
    { key: "unitNumber", label: "Unit" },
    { key: "receiptCents", label: "Applied", align: "right", render: row => formatCentsText(row.receiptCents as string | null), sortValue: row => centsSortValue(row.receiptCents as string | null) },
  ];
  const togglePanel = (next: "receipt" | "billing") => setPanel(current => current === next ? undefined : next);

  const balanceRow = (row: RentalRow, index: number, known: boolean) => {
    const cents = legacyCents(row.operationalBalanceCents);
    const age = known ? balanceAge(row.oldestUnpaidRentOn, filters.asOfDate) : undefined;
    const note = scope === "current" ? otherStatusNote(row) : undefined;
    return <tr key={`${row.personId}:${row.propertyId ?? ""}:${index}`}>
      <td><EntityLink personId={row.personId as string} tab="ledger">{tenantLabel(row)}</EntityLink>{note && <span className="ws-source">{note}</span>}</td>
      <td><RecordLink kind="property" recordId={row.propertyId as string}>{String(row.propertyName ?? "—")}</RecordLink></td>
      <td>{String(row.unitNumber ?? "—")}</td>
      <td>{tableDate(row.oldestUnpaidRentOn)}{age && <span className={`rm-status${age.tone === "neutral" ? "" : ` rm-status--${age.tone}`}`} style={{ marginLeft: 8 }}>{age.label}</span>}</td>
      <td>{tableDate(row.lastPaymentOn)}</td>
      <td className="number">{known
        ? <EntityLink personId={row.personId as string} tab="ledger">{row.balanceComplete === false ? `At least ${formatCentsText(cents)}` : formatCentsText(cents)}</EntityLink>
        : <NotVerified reason={unverifiedReason(row)} />}</td>
    </tr>;
  };
  const showMore = (group: "known" | "unverified", total: number) => <tr>
    <td colSpan={6}><button type="button" className="ws-link ws-link--quiet" onClick={() => setExpanded(current => ({ ...current, [group]: true }))}>Show all {total}</button></td>
  </tr>;

  const balancesTable = () => {
    if (!groups) return null;
    const { known, unverified } = groups;
    if (!known.length && !unverified.length) {
      return <EmptyState compact title="No balances due">{scope === "current" ? "No current tenants" : "No former tenants"} owe a balance as of {formatLongDate(filters.asOfDate) ?? filters.asOfDate}{filters.search.trim() ? " that matches this search" : ""}.</EmptyState>;
    }
    const shownKnown = expanded.known ? known : known.slice(0, KNOWN_PAGE);
    const shownUnverified = expanded.unverified ? unverified : unverified.slice(0, UNVERIFIED_PAGE);
    return <table className="ws-table">
      <thead><tr><th scope="col">Tenant</th><th scope="col">Property</th><th scope="col">Unit</th><th scope="col">Oldest unpaid</th><th scope="col">Last payment</th><th scope="col" className="number">Balance due</th></tr></thead>
      <tbody>
        {shownKnown.map((row, index) => balanceRow(row, index, true))}
        {shownKnown.length < known.length && showMore("known", known.length)}
      </tbody>
      {!!unverified.length && <tbody>
        <tr><th scope="colgroup" colSpan={6}>Not verified · {unverified.length} — balance can't be confirmed until the ledger is reconciled</th></tr>
        {shownUnverified.map((row, index) => balanceRow(row, index, false))}
        {shownUnverified.length < unverified.length && showMore("unverified", unverified.length)}
      </tbody>}
    </table>;
  };

  return <div className="ws-page">
    {!readOnly && <div className="ws-toolbar" role="toolbar" aria-label="Collection actions">
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" className="rm-button ws-toolbar-end">More actions<ChevronDown size={14} aria-hidden="true" /></button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className="rops-nav-menu" align="end" sideOffset={4} collisionPadding={12}>
            <Dropdown.Item className="rops-menu-item" onSelect={() => onEdit("post-ledger-transaction")}>Post charge or credit</Dropdown.Item>
            <Dropdown.Item className="rops-menu-item" onSelect={() => onEdit("save-payment-allocation")}>Allocate payment</Dropdown.Item>
            <Dropdown.Item className="rops-menu-item" onSelect={() => onEdit("reverse-ledger-transaction")}>Reverse transaction</Dropdown.Item>
            <Dropdown.Item className="rops-menu-item" onSelect={() => togglePanel("billing")}>{panel === "billing" ? "Hide recurring charge posting" : "Post recurring charges"}</Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <button type="button" className="rm-button rm-button-primary" aria-expanded={panel === "receipt"} onClick={() => { togglePanel("receipt"); onRequestPaymentContext(); }}><Plus size={14} aria-hidden="true" />Record payment</button>
    </div>}
    {panel === "receipt" && <ManagerIncomeActions snapshot={snapshot} businessDate={businessDate} propertyId={filters.propertyId} onSaved={onSaved} onRequestPaymentContext={onRequestPaymentContext} paymentContextLoading={paymentContextLoading} />}
    {panel === "billing" && (selected.length > 1
      ? <p className="ws-note" role="status">Select one property to post its recurring charges.</p>
      : <RecurringBillingPanel businessDate={businessDate} propertyId={filters.propertyId === "all" ? undefined : filters.propertyId} onPosted={onSaved} />)}
    {!readOnly && <PaymentReviewPanel tenants={snapshot.tenants} />}
    <Section title="Balances due" id="collections-due" count={groups ? `· ${balancesScopeSummary(groups, scope)}` : undefined}
      actions={<>
        <Segmented<TenantScope> label="Tenant status" value={scope} options={SCOPE_OPTIONS} onChange={next => { setScope(next); setExpanded({ known: false, unverified: false }); }} />
        <button type="button" className="ws-link ws-link--quiet" onClick={onOpenRecurring}>Recurring charges →</button>
      </>}>
      {delinquency.error ? <ErrorState error={delinquency.error} onRetry={() => void delinquency.refetch()} /> : !dueRows ? <Loading label="Loading balances…" /> : balancesTable()}
    </Section>
    <Section title={`Receipts · ${formatMonth(month)} to date`} id="collections-receipts" count={receipts ? `${receipts.length} · ${formatMeasure(receiptTotal!.total, receiptTotal!.complete)}` : undefined}>
      {collected.error ? <ErrorState error={collected.error} onRetry={() => void collected.refetch()} /> : !receipts ? <Loading label="Loading receipts…" />
        : <DataGrid<RentalRow> rows={receipts} columns={receiptColumns} getRowKey={(row, index) => `${row.paymentTransactionId}:${index}`} emptyMessage="No receipts applied this month." storageKey="ws-collections-receipts" summaryLabel="receipt"
          getFooterMetrics={rows => { const total = sumCentsTexts(rows.map(row => row.receiptCents as string | null)); return [{ label: "Filtered total", value: formatKnownSubtotal(total.total, total.complete) }]; }} />}
    </Section>
  </div>;
}
