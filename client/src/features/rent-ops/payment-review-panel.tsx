import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { loadRentOpsPaymentReviewQueue, reconcileRentOpsPayment } from "./api";
import type { TenantPaymentReview, TenantView } from "./types";
import { formatTimestamp, usdCurrencyFormatter } from "../../lib/rent-ops-formatters";
import { ListTotals } from "./workspace/list-totals";
import { StatusLine } from "./workspace/ops-ui";

function money(cents: number): string {
  return usdCurrencyFormatter.format(cents / 100);
}

function residentName(tenant: TenantView | undefined): string {
  if (!tenant) return "Resident record unavailable";
  return [tenant.person.firstName, tenant.person.lastName].filter((part) => part?.trim()).join(" ") || "Resident name unavailable";
}

function residentContext(row: TenantPaymentReview, tenants: TenantView[]): string {
  const tenant = tenants.find((candidate) => candidate.person.id === row.personId);
  if (!tenant) return `${row.personId} · ${row.propertyId} / ${row.unitId}`;
  return `${residentName(tenant)} · ${tenant.property?.name ?? row.propertyId} / ${tenant.unit?.unitNumber ?? row.unitId}`;
}

function statusLabel(status: TenantPaymentReview["status"]): string {
  return status === "review_required" ? "Review required" : status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function queueLabel(row: TenantPaymentReview): string {
  return row.queueReason === "stale_active" ? "Reconciliation required" : statusLabel(row.status);
}

function adjustmentSummary(row: TenantPaymentReview): string {
  const active = row.adjustments.filter((adjustment) => adjustment.active);
  if (!active.length) return "No active refund or dispute";
  return active.map((adjustment) => `${adjustment.kind === "dispute" ? "Dispute" : "Refund"} ${money(adjustment.amountCents)}`).join(", ");
}

export interface PaymentReviewViewProps {
  rows: TenantPaymentReview[];
  tenants: TenantView[];
  loaded: boolean;
  busy: boolean;
  error?: string;
  reconciling?: string;
  /** When the queue was last fetched; omitted from the empty line when unknown. */
  lastChecked?: Date;
  onRefresh: () => void;
  onReconcile: (paymentId: string) => void;
  now?: Date;
}

/** Presentation for the payment exception queue: one status line when empty, the table when not. */
export function PaymentReviewView({ rows, tenants, loaded, busy, error, reconciling, lastChecked, onRefresh, onReconcile, now = new Date() }: PaymentReviewViewProps): JSX.Element {
  const refreshIcon = <button type="button" className="rm-button rm-button--icon" aria-label="Refresh payment exceptions" title="Refresh payment exceptions" disabled={busy} onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" className={busy ? "spin" : undefined} /></button>;
  if (!rows.length) {
    if (error) return <StatusLine tone="critical" actions={refreshIcon}>Payment exceptions unavailable · {error}</StatusLine>;
    if (!loaded) return <StatusLine tone="neutral">Checking payment exceptions…</StatusLine>;
    const checked = formatTimestamp(lastChecked, now);
    return <StatusLine tone="positive" actions={refreshIcon}>No payment exceptions{checked ? ` · checked ${checked}` : ""}</StatusLine>;
  }
  return <section className="ro-panel" aria-labelledby="payment-review-title">
    <div className="ro-panel-heading">
      <div>
        <h2 id="payment-review-title">Payment exceptions</h2>
        <p>Disputed, provider-held, or stale tenant payments need review before the reserved balance can be released.</p>
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={onRefresh}><RefreshCw className={busy ? "spin" : undefined} /> {busy ? "Refreshing…" : "Refresh queue"}</button>
    </div>
    {error && <p className="ro-panel-message" role="alert"><AlertCircle /> {error}</p>}
    <div className="ro-table-wrap"><table className="ro-table">
      <thead><tr><th>Status</th><th>Resident / unit</th><th className="number">Amount</th><th>Provider adjustment</th><th>Created</th><th>Payment ID</th><th>Action</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td><span className={`status ${row.status}`}>{queueLabel(row)}</span></td>
        <td>{residentContext(row, tenants)}<small>Tenancy {row.tenancyId}</small></td>
        <td className="number">{money(row.amountCents)}</td>
        <td>{adjustmentSummary(row)}<small>Ledger credit {money(row.currentLedgerCents)}</small></td>
        <td>{formatTimestamp(row.createdAt, now) ?? "—"}</td>
        <td><code>{row.id}</code></td>
        <td>{row.queueReason === "stale_active" && <button type="button" className="secondary" disabled={reconciling === row.id} onClick={() => onReconcile(row.id)}>{reconciling === row.id ? "Checking…" : "Reconcile provider"}</button>}</td>
      </tr>)}</tbody>
    </table></div>
    <ListTotals totalCount={rows.length} itemLabel="payment exception" className="ro-list-totals" />
  </section>;
}

export function PaymentReviewPanel({ tenants }: { tenants: TenantView[] }): JSX.Element {
  const [rows, setRows] = useState<TenantPaymentReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState<string>();
  const [error, setError] = useState<string>();
  const [lastChecked, setLastChecked] = useState<Date>();

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRows(await loadRentOpsPaymentReviewQueue());
      setLastChecked(new Date());
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment exceptions are unavailable.");
    } finally {
      setBusy(false);
    }
  }, []);

  const reconcile = useCallback(async (paymentId: string) => {
    setReconciling(paymentId);
    setError(undefined);
    try {
      await reconcileRentOpsPayment(paymentId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider reconciliation is unavailable.");
    } finally {
      setReconciling(undefined);
    }
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  return <PaymentReviewView rows={rows} tenants={tenants} loaded={loaded} busy={busy} error={error} reconciling={reconciling} lastChecked={lastChecked} onRefresh={() => void load()} onReconcile={(paymentId) => void reconcile(paymentId)} />;
}
