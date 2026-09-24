import { useState } from "react";
import { Plus } from "lucide-react";
import type { QuickAction } from "../rent-ops/form-payload";
import { PaymentReviewPanel } from "../rent-ops/payment-review-panel";
import { ManagerIncomeActions } from "../rent-ops/manager-income-actions";
import { RecurringBillingPanel } from "../rent-ops/recurring-billing-panel";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { selectedWorkspaceProperties } from "../rent-ops/workspace/workspace-state";
import { centsSortValue, formatCentsText, formatIsoDate, formatKnownSubtotal, formatMeasure, formatMonth, humanize, sumCentsTexts } from "./format";
import { ErrorState, Loading, Section } from "./page";
import { matchesSearch, rentalRows, useRentalReport } from "./rental-reports";
import { balancesDue, legacyCents, receiptsByPayment, type RentalRow } from "./models";

/** Tenants › Collections: balances due, this month's receipts and the receipt/charge actions. */
export function Collections({ identity, snapshot, filters, businessDate, readOnly, paymentContextLoading, onRequestPaymentContext, onSaved, onEdit, onOpenRecurring }: {
  identity: string; snapshot: AdminSnapshot; filters: ViewFilters; businessDate: string; readOnly: boolean;
  paymentContextLoading: boolean; onRequestPaymentContext: () => void; onSaved: () => Promise<void>;
  onEdit: (action: QuickAction) => void; onOpenRecurring: () => void;
}) {
  const [panel, setPanel] = useState<"receipt" | "billing">();
  const month = filters.asOfDate.slice(0, 7);
  // Former tenants who still owe are collection work too, so every tenancy status is included.
  const delinquency = useRentalReport(identity, "delinquency", filters, { asOfDate: filters.asOfDate }, { tenantStatus: "all" });
  // Receipts from every tenancy count, including former tenants settling a balance.
  const collected = useRentalReport(identity, "collected-income", filters, { asOfDate: filters.asOfDate, month, fromDate: `${month}-01`, toDate: filters.asOfDate }, { tenantStatus: "all" });
  const due = rentalRows(delinquency.data, snapshot, ["personId", "tenantName", "propertyId", "propertyName", "unitId", "unitNumber", "operationalBalanceCents", "balanceComplete", "oldestUnpaidRentOn", "lastPaymentOn", "tenancyStatus"]);
  const receiptRows = rentalRows(collected.data, snapshot, ["paymentTransactionId", "personId", "tenantName", "propertyId", "propertyName", "unitNumber", "paymentOn", "category", "amountCents"]);
  const dueRows = due ? balancesDue(due).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"])) : undefined;
  const receipts = receiptRows ? receiptsByPayment(receiptRows).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"])) : undefined;
  const selected = selectedWorkspaceProperties(filters);
  const dueTotal = dueRows ? sumCentsTexts(dueRows.map(row => legacyCents(row.operationalBalanceCents))) : undefined;
  const receiptTotal = receipts ? sumCentsTexts(receipts.map(row => row.receiptCents as string | null)) : undefined;
  const dueColumns: GridColumn<RentalRow>[] = [
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string} tab="ledger">{String(row.tenantName ?? "Tenant")}</EntityLink> },
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.propertyId as string}>{String(row.propertyName ?? "—")}</RecordLink> },
    { key: "unitNumber", label: "Unit" },
    { key: "tenancyStatus", label: "Tenancy", render: row => humanize(row.tenancyStatus as string) },
    { key: "oldestUnpaidRentOn", label: "Oldest unpaid", render: row => formatIsoDate(row.oldestUnpaidRentOn as string) },
    { key: "lastPaymentOn", label: "Last payment", render: row => formatIsoDate(row.lastPaymentOn as string) },
    { key: "operationalBalanceCents", label: "Balance due", align: "right", render: row => <EntityLink personId={row.personId as string} tab="ledger">{row.balanceComplete === false && legacyCents(row.operationalBalanceCents) ? `At least ${formatCentsText(legacyCents(row.operationalBalanceCents))}` : formatCentsText(legacyCents(row.operationalBalanceCents))}</EntityLink>, sortValue: row => centsSortValue(legacyCents(row.operationalBalanceCents)) },
  ];
  const receiptColumns: GridColumn<RentalRow>[] = [
    { key: "paymentOn", label: "Received", render: row => formatIsoDate(row.paymentOn as string) },
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string} tab="ledger">{String(row.tenantName ?? "Tenant")}</EntityLink> },
    { key: "propertyName", label: "Property" },
    { key: "unitNumber", label: "Unit" },
    { key: "receiptCents", label: "Applied", align: "right", render: row => formatCentsText(row.receiptCents as string | null), sortValue: row => centsSortValue(row.receiptCents as string | null) },
  ];
  return <div className="ws-page">
    <div className="ws-toolbar" role="toolbar" aria-label="Collection actions">
      {!readOnly && <button type="button" className="rm-button rm-button-primary" aria-expanded={panel === "receipt"} onClick={() => { setPanel(current => current === "receipt" ? undefined : "receipt"); onRequestPaymentContext(); }}><Plus size={14} aria-hidden="true" />Record receipt</button>}
      {!readOnly && <button type="button" className="rm-button" onClick={() => onEdit("post-ledger-transaction")}>Post charge or credit</button>}
      {!readOnly && <button type="button" className="rm-button" onClick={() => onEdit("save-payment-allocation")}>Allocate payment</button>}
      {!readOnly && <button type="button" className="rm-button" onClick={() => onEdit("reverse-ledger-transaction")}>Reverse transaction</button>}
      {!readOnly && <button type="button" className="rm-button" aria-expanded={panel === "billing"} onClick={() => setPanel(current => current === "billing" ? undefined : "billing")}>Post recurring charges</button>}
      <button type="button" className="rm-button" onClick={onOpenRecurring}>Recurring charges</button>
    </div>
    {panel === "receipt" && <ManagerIncomeActions snapshot={snapshot} businessDate={businessDate} propertyId={filters.propertyId} onSaved={onSaved} onRequestPaymentContext={onRequestPaymentContext} paymentContextLoading={paymentContextLoading} />}
    {panel === "billing" && (selected.length > 1
      ? <p className="ws-note" role="status">Select one property to post its recurring charges.</p>
      : <RecurringBillingPanel businessDate={businessDate} propertyId={filters.propertyId === "all" ? undefined : filters.propertyId} onPosted={onSaved} />)}
    {!readOnly && <PaymentReviewPanel tenants={snapshot.tenants} />}
    <Section title="Balances due" id="collections-due" count={dueRows ? `${dueRows.length} · ${formatMeasure(dueTotal!.total, dueTotal!.complete)}` : undefined}>
      {delinquency.error ? <ErrorState error={delinquency.error} onRetry={() => void delinquency.refetch()} /> : !dueRows ? <Loading label="Loading balances…" />
        : <DataGrid<RentalRow> rows={dueRows} columns={dueColumns} getRowKey={(row, index) => `${row.personId}:${index}`} emptyMessage="No balances due." storageKey="ws-collections-due" summaryLabel="balance due"
          getFooterMetrics={rows => { const total = sumCentsTexts(rows.map(row => legacyCents(row.operationalBalanceCents))); return [{ label: "Filtered total", value: formatKnownSubtotal(total.total, total.complete) }]; }} />}
    </Section>
    <Section title={`Receipts · ${formatMonth(month)} to date`} id="collections-receipts" count={receipts ? `${receipts.length} · ${formatMeasure(receiptTotal!.total, receiptTotal!.complete)}` : undefined}>
      {collected.error ? <ErrorState error={collected.error} onRetry={() => void collected.refetch()} /> : !receipts ? <Loading label="Loading receipts…" />
        : <DataGrid<RentalRow> rows={receipts} columns={receiptColumns} getRowKey={(row, index) => `${row.paymentTransactionId}:${index}`} emptyMessage="No receipts applied this month." storageKey="ws-collections-receipts" summaryLabel="receipt"
          getFooterMetrics={rows => { const total = sumCentsTexts(rows.map(row => row.receiptCents as string | null)); return [{ label: "Filtered total", value: formatKnownSubtotal(total.total, total.complete) }]; }} />}
    </Section>
  </div>;
}
