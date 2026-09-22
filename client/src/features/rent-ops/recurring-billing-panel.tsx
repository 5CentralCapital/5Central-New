import React, { useState } from "react";
import { z } from "zod";
import { rentOpsAuthClient } from "./auth";

const cents = z.number().int().nonnegative().safe();
const previewSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), billingOn: z.string(), previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.object({ propertyId: z.string().optional(), tenancyId: z.string().optional() }).optional(),
  rows: z.array(z.object({
    scheduleId: z.string(), propertyName: z.string(), unitNumber: z.string(), tenantName: z.string(), description: z.string(),
    amountCents: z.number().int().safe().nullable(), billingOn: z.string(), status: z.enum(["ready", "blocked", "posted", "excluded"]), reasons: z.array(z.string()),
  }).strict()),
  readyCount: cents, readyCents: cents, blockedCount: cents, postedCount: cents, postedCents: cents,
}).strict();
type Preview = z.infer<typeof previewSchema>;
const postSchema = z.object({ postedCount: cents, postedCents: cents, alreadyPostedCount: cents, preview: previewSchema }).strict();

const errorMessages: Record<string, string> = {
  invalid_input: "Choose a valid billing month.",
  preview_changed: "The billing records changed. Preview the month again before posting.",
  billing_busy: "Another billing run is finishing. Preview again in a moment.",
  no_ready_charges: "There are no new charges ready to post.",
  billing_unavailable: "Billing is unavailable. The database setup must be complete before charges can be posted.",
};
const money = (value: number | null): string => value === null ? "Needs review" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const statusLabels = { ready: "Ready", blocked: "Needs review", posted: "Posted", excluded: "Separate workflow" };

async function requestBilling(path: string, body?: { month: string; previewToken: string; scope?: { propertyId?: string } }): Promise<unknown> {
  const response = await rentOpsAuthClient.request(`/api/rent-ops/billing/${path}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const result: unknown = await response.json();
  if (!response.ok) {
    const code = z.object({ code: z.string() }).safeParse(result);
    throw new Error(errorMessages[code.success ? code.data.code : ""] ?? "Billing could not finish. Preview again to verify whether charges were posted.");
  }
  return result;
}

export function RecurringBillingPanel({ onPosted, businessDate, propertyId }: { propertyId?: string; onPosted?: () => void | Promise<void>; businessDate?: string }): JSX.Element {
  const [selectedMonth, setMonth] = useState<string>();
  const month = selectedMonth ?? businessDate?.slice(0, 7) ?? "";
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function loadPreview(): Promise<void> {
    setBusy(true); setError(""); setResult(""); setPreview(undefined);
    try { setPreview(previewSchema.parse(await requestBilling(`preview?month=${encodeURIComponent(month)}${propertyId ? `&propertyId=${encodeURIComponent(propertyId)}` : ""}`))); }
    catch (failure) { setError(failure instanceof z.ZodError ? "Billing returned an invalid response." : failure instanceof Error ? failure.message : "Billing preview is unavailable."); }
    finally { setBusy(false); }
  }

  async function post(): Promise<void> {
    if (!preview || preview.month !== month || busy || !preview.readyCount) return;
    setBusy(true); setError(""); setResult("");
    try {
      const posted = postSchema.parse(await requestBilling("post", { month, previewToken: preview.previewToken, ...(propertyId ? { scope: { propertyId } } : {}) }));
      setPreview(posted.preview);
      setResult(posted.postedCount ? `${posted.postedCount} charges totaling ${money(posted.postedCents)} posted.` : `${posted.alreadyPostedCount} charges were already posted. No duplicate charges were created.`);
      try { await onPosted?.(); }
      catch { setError("Charges are posted. Refresh the workspace to see the updated balances."); }
    } catch (failure) {
      setPreview(undefined);
      setError(failure instanceof z.ZodError ? "Billing returned an invalid response. Preview again to verify the posted state." : failure instanceof Error ? failure.message : "Posting could not finish. Preview again to verify the posted state.");
    } finally { setBusy(false); }
  }

  return <section className="ro-panel" aria-labelledby="recurring-billing-title">
    <div className="ro-panel-heading">
      <div><h2 id="recurring-billing-title">Monthly billing</h2><p>Preview monthly rent and recurring fees before posting tenant charges.</p></div>
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <label>Billing month<input type="month" value={month} disabled={busy} onChange={(event) => { setMonth(event.target.value); setPreview(undefined); setResult(""); setError(""); }} /></label>
        <button type="button" disabled={busy || !month} onClick={() => void loadPreview()}>{busy ? "Working…" : "Preview charges"}</button>
      </div>
    </div>
    {error && <p role="alert" style={{ padding: "0 20px", color: "#9b2c2c" }}>{error}</p>}
    {result && <p role="status" style={{ padding: "0 20px" }}>{result}</p>}
    {preview && <>
      <div className="ro-panel-heading">
        <p>{preview.readyCount} ready · {money(preview.readyCents)} · {preview.blockedCount} need review · {preview.postedCount} already posted</p>
        <button type="button" className="primary" disabled={busy || preview.readyCount === 0} onClick={() => void post()}>Post {preview.readyCount} ready charges · {money(preview.readyCents)}</button>
      </div>
      <p style={{ padding: "0 20px" }}>Charges post and become due on {preview.billingOn}. Partial months need a confirmed manual charge. Subsidies, deposits, and one-time fees use their separate workflows.</p>
      <div className="ro-table-wrap"><table className="ro-table"><thead><tr><th>Property / unit</th><th>Tenant</th><th>Charge</th><th className="number">Amount</th><th>Status</th></tr></thead><tbody>
        {preview.rows.map((row, index) => <tr key={`${row.scheduleId}:${index}`}><td>{row.propertyName} / {row.unitNumber}</td><td>{row.tenantName}</td><td>{row.description}</td><td className="number">{money(row.amountCents)}</td><td>{statusLabels[row.status]}{row.reasons.map((reason) => <div key={reason} style={{ fontSize: 12, marginTop: 4 }}>{reason}</div>)}</td></tr>)}
        {!preview.rows.length && <tr><td colSpan={5}>No applicable recurring charges for this month.</td></tr>}
      </tbody></table></div>
    </>}
  </section>;
}
