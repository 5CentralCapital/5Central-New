import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { loadRentOpsPaymentReviewQueue } from "./api";
import type { TenantPaymentReview, TenantView } from "./types";
import { usdCurrencyFormatter } from "../../lib/rent-ops-formatters";

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

function adjustmentSummary(row: TenantPaymentReview): string {
  const active = row.adjustments.filter((adjustment) => adjustment.active);
  if (!active.length) return "No active refund or dispute";
  return active.map((adjustment) => `${adjustment.kind === "dispute" ? "Dispute" : "Refund"} ${money(adjustment.amountCents)}`).join(", ");
}

export function PaymentReviewPanel({ tenants }: { tenants: TenantView[] }): JSX.Element {
  const [rows, setRows] = useState<TenantPaymentReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRows(await loadRentOpsPaymentReviewQueue());
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment exceptions are unavailable.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <section className="ro-panel" aria-labelledby="payment-review-title">
    <div className="ro-panel-heading">
      <div>
        <span className="eyebrow">Staff queue</span>
        <h2 id="payment-review-title">Payment exceptions</h2>
        <p>Disputed or provider-held tenant payments need review before the account can accept another payment.</p>
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void load()}><RefreshCw className={busy ? "spin" : undefined} /> {busy ? "Refreshing…" : "Refresh queue"}</button>
    </div>
    {error && <p className="ro-panel-message" role="alert"><AlertCircle /> {error}</p>}
    {!loaded && !error && <p className="ro-panel-message" role="status">Loading payment exceptions…</p>}
    {loaded && !rows.length && !error && <p className="ro-panel-message" role="status">No disputed or held tenant payments.</p>}
    {!!rows.length && <div className="ro-table-wrap"><table className="ro-table">
      <thead><tr><th>Status</th><th>Resident / unit</th><th className="number">Amount</th><th>Provider adjustment</th><th>Created</th><th>Payment ID</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td><span className={`status ${row.status}`}>{statusLabel(row.status)}</span></td>
        <td>{residentContext(row, tenants)}<small>Tenancy {row.tenancyId}</small></td>
        <td className="number">{money(row.amountCents)}</td>
        <td>{adjustmentSummary(row)}<small>Ledger credit {money(row.currentLedgerCents)}</small></td>
        <td>{new Date(row.createdAt).toLocaleString()}</td>
        <td><code>{row.id}</code></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
