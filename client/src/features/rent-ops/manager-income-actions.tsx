import { useState, type FormEvent } from "react";
import { rentOpsAuthClient } from "./auth";
import { requireCentsInput } from "./money";
import type { AdminSnapshot } from "./types";

export async function saveManagerIncomeAction(path: string, body: unknown, method = "POST", request = rentOpsAuthClient.request.bind(rentOpsAuthClient)) {
  const response = await request(`/api/rent-ops/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 409 ? "This record changed or conflicts with an existing entry. Refresh and review before retrying." : "The record could not be saved. Check the selected tenancy and amounts.");
  return response.json();
}
const label = (value: string) => value.replaceAll("_", " ");
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);

export function ManagerIncomeActions({ snapshot, businessDate, onSaved, propertyId }: { snapshot: AdminSnapshot; businessDate?: string; onSaved: () => Promise<void>; propertyId: string }) {
  const [mode, setMode] = useState<"payment" | "definitions">();
  const [editingDefinition, setEditingDefinition] = useState<AdminSnapshot["chargeDefinitions"][number]>();
  const [tenancyId, setTenancyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [paymentId, setPaymentId] = useState(() => `manual:payment:${crypto.randomUUID()}`);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const tenancies = snapshot.snapshot.tenancies.filter(row => row.id && (propertyId === "all" || row.propertyId === propertyId));
  const charges = snapshot.snapshot.ledgerTransactions.filter(row => row.tenancyId === tenancyId && row.kind === "charge" && row.status === "posted" && row.id);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setMessage("");
    try {
      if (mode === "payment") {
        const amountCents = requireCentsInput(data.get("amount"), "Amount");
        if (amountCents <= 0) throw new Error("Amount must be greater than zero.");
        const lines = Object.entries(allocations).filter(([,value]) => value.trim()).map(([chargeTransactionId,value]) => ({ chargeTransactionId, amountCents: requireCentsInput(value, "Allocation") }));
        if (lines.some(row => row.amountCents <= 0) || lines.reduce((sum,row) => sum + row.amountCents, 0) > amountCents) throw new Error("Positive allocations cannot exceed the payment amount.");
        await saveManagerIncomeAction("manual-payments", { id: paymentId, tenancyId, amountCents, postedOn: data.get("postedOn"), paymentMethod: data.get("paymentMethod"), description: data.get("description"), category: data.get("category"), allocations: lines });
        setPaymentId(`manual:payment:${crypto.randomUUID()}`); setAllocations({}); form.reset(); setMessage("Manual payment recorded.");
      } else {
        if (editingDefinition?.id) await saveManagerIncomeAction(`charge-definitions/${encodeURIComponent(editingDefinition.id)}`, { expectedRevision: editingDefinition.recordRevision, patch: { displayName: data.get("displayName"), active: data.get("active") === "true" } }, "PATCH");
        else await saveManagerIncomeAction("charge-definitions", { id: `manual:definition:${crypto.randomUUID()}`, displayName: data.get("displayName"), category: data.get("category"), active: true });
        setEditingDefinition(undefined);
        form.reset(); setMessage("Charge type saved.");
      }
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed."); } finally { setBusy(false); }
  }
  return <section className="ro-panel"><div className="ro-panel-heading"><h2>Income actions</h2><div className="ro-actions"><button className="primary" onClick={() => { setMode("payment"); setMessage(""); }}>Record manual payment</button><button className="secondary" onClick={() => { setMode("definitions"); setMessage(""); }}>Charge types</button></div></div>
    {message && <p className="ro-panel-message" role="status">{message}</p>}
    {mode && <form key={`${mode}:${editingDefinition?.id ?? "new"}`} className="ro-income-form" onSubmit={submit}><fieldset disabled={busy}><div className="ro-form-grid">
      {mode === "payment" ? <><label>Tenancy<select required value={tenancyId} onChange={event => { setTenancyId(event.target.value); setAllocations({}); }}><option value="">Select tenancy…</option>{tenancies.map(row => { const person = snapshot.snapshot.people.find(person => person.id === row.primaryPersonId); const unit = snapshot.snapshot.units.find(unit => unit.id === row.unitId); const property = snapshot.snapshot.properties.find(property => property.id === row.propertyId); return <option key={row.id} value={row.id}>{property?.name} / {unit?.unitNumber} · {person?.firstName} {person?.lastName} · {row.status}</option>; })}</select></label><label>Amount<input name="amount" required type="number" step="0.01" min="0.01" /></label><label>Received date<input name="postedOn" required type="date" defaultValue={businessDate} /></label><label>Method<select name="paymentMethod">{["ach", "cash", "check", "money_order", "zelle", "other"].map(value => <option key={value}>{value}</option>)}</select></label><label>Category<select name="category">{["base_rent", "recurring_fee", "one_time_fee", "unapplied_cash", "other"].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label><label>Description / reference<input name="description" required maxLength={240} /></label></> : <><label>Charge type name<input name="displayName" required maxLength={240} defaultValue={editingDefinition?.displayName ?? ""} /></label><label>Category<select name="category" disabled={Boolean(editingDefinition)} defaultValue={editingDefinition?.category ?? "base_rent"}>{["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>{editingDefinition && <label>Status<select name="active" defaultValue={String(editingDefinition.active ?? "")} required><option value="">Needs review</option><option value="true">Active</option><option value="false">Inactive</option></select></label>}</>}
    </div>{mode === "payment" && <><p>Record money already received. Allocate to charges below; any remainder stays unapplied.</p>{charges.map(charge => <label className="ro-allocation" key={charge.id}>{charge.postedOn} · {charge.description} · {money(charge.amountCents ?? 0)}<input aria-label={`Allocate to ${charge.description}`} type="number" min="0.01" step="0.01" value={allocations[charge.id!] ?? ""} onChange={event => setAllocations(current => ({ ...current, [charge.id!]: event.target.value }))} /></label>)}</>}<div className="ro-actions"><button className="primary" disabled={busy}>{busy ? "Saving…" : mode === "payment" ? "Record payment" : editingDefinition ? "Save charge type" : "Add charge type"}</button><button type="button" className="secondary" onClick={() => setMode(undefined)}>Close</button></div></fieldset></form>}
    {mode === "definitions" && <div className="ro-table-wrap"><table className="ro-table"><thead><tr><th>Charge type</th><th>Category</th><th>Status</th><th>Action</th></tr></thead><tbody>{snapshot.chargeDefinitions.map(row => <tr key={row.id}><td>{row.displayName}</td><td>{label(row.category ?? "unknown")}</td><td>{row.active == null ? "Needs review" : row.active ? "Active" : "Inactive"}</td><td><button className="secondary" disabled={!row.id || !row.recordRevision || busy} onClick={() => setEditingDefinition(row)}>Edit</button></td></tr>)}</tbody></table></div>}
  </section>;
}
