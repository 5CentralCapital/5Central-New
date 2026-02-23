import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties } from "./shared/property-subtabs";

interface Worker {
  id: string; name: string; role: string; phone?: string; email?: string;
  defaultRate: string; paymentMethod: string; paymentHandle?: string;
  status: string; hireDate: string; notes?: string;
}
interface PayrollEntry {
  id: string; workerId: string; propertyId?: string; unitNumber?: string;
  task: string; date: string; hours: string; rate: string; total: string;
  weekEnding?: string; notes?: string;
}
interface PayrollPayment {
  id: string; workerId: string; amount: string; paymentMethod: string;
  memo?: string; reference?: string; periodStart: string; periodEnd: string;
  paidAt: string; status: string; notes?: string;
}

function fmtMoney(v: number) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCompact(v: number) {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export default function PayrollOps() {
  const { properties } = useProperties();
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [entries, setEntries] = useState<PayrollEntry[]>([]);
  const [payments, setPayments] = useState<PayrollPayment[]>([]);
  const [view, setView] = useState<"roster" | "timesheet" | "payments" | "summary">("summary");
  const [selectedWeek, setSelectedWeek] = useState(() => {
    const d = new Date(); const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1) + 6;
    return new Date(d.setDate(diff)).toISOString().split("T")[0];
  });
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [wRes, eRes, pRes] = await Promise.all([
        fetch("/api/workers"),
        fetch("/api/payroll/entries"),
        fetch("/api/payroll/payments"),
      ]);
      if (!wRes.ok || !eRes.ok || !pRes.ok) {
        throw new Error("Failed to load payroll data");
      }
      const [w, e, p] = await Promise.all([wRes.json(), eRes.json(), pRes.json()]);
      setWorkers(w); setEntries(e); setPayments(p);
    } catch (err) {
      console.error("Payroll load error:", err);
      setError(err instanceof Error ? err.message : "Failed to load payroll data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const workerName = (id: string) => workers.find(w => w.id === id)?.name || "Unknown";

  // Computed
  const totalHours = entries.reduce((s, e) => s + Number(e.hours), 0);
  const totalLabor = entries.reduce((s, e) => s + Number(e.total), 0);
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = totalLabor - totalPaid;
  const weekEntries = entries.filter(e => e.weekEnding === selectedWeek);
  const weekTotal = weekEntries.reduce((s, e) => s + Number(e.total), 0);

  // Per-worker summary
  const workerSummary = workers.filter(w => w.status === "active").map(w => {
    const wEntries = entries.filter(e => e.workerId === w.id);
    const wPayments = payments.filter(p => p.workerId === w.id);
    const hrs = wEntries.reduce((s, e) => s + Number(e.hours), 0);
    const earned = wEntries.reduce((s, e) => s + Number(e.total), 0);
    const paid = wPayments.reduce((s, p) => s + Number(p.amount), 0);
    return { ...w, totalHours: hrs, totalEarned: earned, totalPaid: paid, balance: earned - paid };
  });

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loading && <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-muted)" }}>Loading payroll data...</div>}
      {error && <div style={{ padding: 14, borderRadius: 8, background: "var(--color-danger, #c00)15", color: "var(--color-danger, #c00)", border: "1px solid var(--color-danger, #c00)33", fontSize: 13 }}>Error: {error}</div>}
      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        <KPI label="Active Workers" value={String(workers.filter(w => w.status === "active").length)} />
        <KPI label="Total Hours" value={totalHours.toFixed(1)} />
        <KPI label="Total Labor Cost" value={fmtCompact(totalLabor)} />
        <KPI label="Total Paid" value={fmtCompact(totalPaid)} color="var(--color-success)" />
        <KPI label="Balance Due" value={fmtCompact(balance)} color={balance > 0 ? "var(--color-warning)" : "var(--color-success)"} />
        <KPI label="This Week" value={fmtCompact(weekTotal)} sub={`wk ending ${selectedWeek}`} />
      </div>

      <PropertySubTabs
        properties={properties}
        selected={propertyFilter}
        onSelect={setPropertyFilter}
        showAll={true}
        allLabel="All Properties"
      />

      {/* Sub-nav */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["summary", "roster", "timesheet", "payments"] as const).map(v => (
          <button key={v} className={`nav-btn ${view === v ? "active" : ""}`} onClick={() => setView(v)} style={{ fontSize: 11 }}>
            {v === "summary" ? "Weekly Summary" : v === "roster" ? "Worker Roster" : v === "timesheet" ? "Time Entries" : "Payments"}
          </button>
        ))}
      </div>

      {/* SUMMARY VIEW */}
      {view === "summary" && (
        <>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div className="label">Worker Payroll Summary</div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>Worker</th><th>Role</th><th>Rate</th><th>Total Hours</th><th>Earned</th><th>Paid</th><th>Balance Due</th><th>Payment</th></tr>
                </thead>
                <tbody>
                  {workerSummary.map(w => (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 500 }}>{w.name}</td>
                      <td style={{ fontSize: 11, textTransform: "capitalize" }}>{w.role}</td>
                      <td className="tabular-nums">{fmtMoney(Number(w.defaultRate))}/hr</td>
                      <td className="tabular-nums">{w.totalHours.toFixed(1)}</td>
                      <td className="tabular-nums">{fmtMoney(w.totalEarned)}</td>
                      <td className="tabular-nums" style={{ color: "var(--color-success)" }}>{fmtMoney(w.totalPaid)}</td>
                      <td className="tabular-nums" style={{ fontWeight: 600, color: w.balance > 0 ? "var(--color-warning)" : "var(--color-success)" }}>
                        {fmtMoney(w.balance)}
                      </td>
                      <td style={{ fontSize: 11, textTransform: "uppercase" }}>{w.paymentMethod}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                    <td colSpan={3}>TOTAL</td>
                    <td className="tabular-nums">{workerSummary.reduce((s, w) => s + w.totalHours, 0).toFixed(1)}</td>
                    <td className="tabular-nums">{fmtMoney(workerSummary.reduce((s, w) => s + w.totalEarned, 0))}</td>
                    <td className="tabular-nums">{fmtMoney(workerSummary.reduce((s, w) => s + w.totalPaid, 0))}</td>
                    <td className="tabular-nums">{fmtMoney(workerSummary.reduce((s, w) => s + w.balance, 0))}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Labor by Task breakdown */}
          <div className="card" style={{ padding: 14 }}>
            <div className="label" style={{ marginBottom: 10 }}>Labor Cost by Task Type</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {Object.entries(
                entries.reduce((acc, e) => {
                  acc[e.task] = (acc[e.task] || 0) + Number(e.total);
                  return acc;
                }, {} as Record<string, number>)
              ).sort((a, b) => b[1] - a[1]).map(([task, cost]) => (
                <div key={task} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)", fontSize: 12 }}>
                  <span style={{ textTransform: "capitalize", marginRight: 8 }}>{task}</span>
                  <span className="tabular-nums" style={{ fontWeight: 600 }}>{fmtMoney(cost)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ROSTER VIEW */}
      {view === "roster" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="label">Worker Roster</div>
            <button className="nav-btn" style={{ fontSize: 10 }} onClick={() => setShowAddWorker(!showAddWorker)}>+ Add Worker</button>
          </div>
          {showAddWorker && <AddWorkerForm onSave={async (w) => {
  try {
    const res = await fetch("/api/workers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(w) });
    if (!res.ok) throw new Error("Failed to save worker");
    setShowAddWorker(false); load();
  } catch (err) { console.error("Save worker error:", err); setError(err instanceof Error ? err.message : "Failed to save worker"); }
}} onCancel={() => setShowAddWorker(false)} />}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Role</th><th>Rate</th><th>Payment</th><th>Handle</th><th>Phone</th><th>Status</th><th>Hired</th></tr>
              </thead>
              <tbody>
                {workers.map(w => (
                  <tr key={w.id}>
                    <td style={{ fontWeight: 500 }}>{w.name}</td>
                    <td style={{ textTransform: "capitalize" }}>{w.role}</td>
                    <td className="tabular-nums">${Number(w.defaultRate).toFixed(2)}/hr</td>
                    <td style={{ textTransform: "uppercase", fontSize: 11 }}>{w.paymentMethod}</td>
                    <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{w.paymentHandle || "—"}</td>
                    <td style={{ fontSize: 11 }}>{w.phone || "—"}</td>
                    <td><StatusBadge status={w.status} /></td>
                    <td style={{ fontSize: 11 }}>{new Date(w.hireDate).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TIMESHEET VIEW */}
      {view === "timesheet" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="label">Time Entries</div>
              <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                Week ending:
                <input type="date" className="inline-edit" value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)} style={{ width: 130 }} />
              </label>
            </div>
            <button className="nav-btn" style={{ fontSize: 10 }} onClick={() => setShowAddEntry(!showAddEntry)}>+ Add Entry</button>
          </div>
          {showAddEntry && <AddEntryForm workers={workers} weekEnding={selectedWeek} onSave={async (e) => {
  try {
    const res = await fetch("/api/payroll/entries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) });
    if (!res.ok) throw new Error("Failed to save entry");
    setShowAddEntry(false); load();
  } catch (err) { console.error("Save entry error:", err); setError(err instanceof Error ? err.message : "Failed to save entry"); }
}} onCancel={() => setShowAddEntry(false)} />}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Worker</th><th>Task</th><th>Unit</th><th>Hours</th><th>Rate</th><th>Total</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {weekEntries.length > 0 ? weekEntries.slice(0, 100).map(e => (
                  <tr key={e.id}>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{e.date}</td>
                    <td style={{ fontWeight: 500 }}>{workerName(e.workerId)}</td>
                    <td style={{ textTransform: "capitalize" }}>{e.task}</td>
                    <td style={{ fontSize: 11 }}>{e.unitNumber || "—"}</td>
                    <td className="tabular-nums">{Number(e.hours).toFixed(1)}</td>
                    <td className="tabular-nums">${Number(e.rate).toFixed(2)}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{fmtMoney(Number(e.total))}</td>
                    <td style={{ fontSize: 11, color: "var(--color-text-muted)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.notes || "—"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={8} style={{ textAlign: "center", padding: 20, color: "var(--color-text-muted)", fontSize: 13 }}>No entries for this week</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PAYMENTS VIEW */}
      {view === "payments" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="label">Payment History</div>
            <button className="nav-btn" style={{ fontSize: 10 }} onClick={() => setShowAddPayment(!showAddPayment)}>+ Record Payment</button>
          </div>
          {showAddPayment && <AddPaymentForm workers={workers} onSave={async (p) => {
  try {
    const res = await fetch("/api/payroll/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
    if (!res.ok) throw new Error("Failed to record payment");
    setShowAddPayment(false); load();
  } catch (err) { console.error("Save payment error:", err); setError(err instanceof Error ? err.message : "Failed to record payment"); }
}} onCancel={() => setShowAddPayment(false)} />}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Worker</th><th>Amount</th><th>Method</th><th>Memo</th><th>Period</th><th>Reference</th><th>Status</th></tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{new Date(p.paidAt).toLocaleDateString()}</td>
                    <td style={{ fontWeight: 500 }}>{workerName(p.workerId)}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{fmtMoney(Number(p.amount))}</td>
                    <td style={{ textTransform: "uppercase", fontSize: 11 }}>{p.paymentMethod}</td>
                    <td style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.memo || "—"}</td>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{p.periodStart} — {p.periodEnd}</td>
                    <td style={{ fontSize: 11 }}>{p.reference || "—"}</td>
                    <td><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/* Sub-components */
function KPI({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <article className="card interactive" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: "1.3rem", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: color || "var(--color-text)", fontFamily: "var(--font-display)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{sub}</div>}
    </article>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { active: "var(--color-success)", paid: "var(--color-success)", inactive: "var(--color-text-muted)", terminated: "var(--color-danger)", pending: "var(--color-warning)", failed: "var(--color-danger)" };
  return (
    <span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, background: `${colors[status] || "var(--color-text-muted)"}15`, color: colors[status] || "var(--color-text-muted)", border: `1px solid ${colors[status] || "var(--color-border)"}33` }}>
      {status}
    </span>
  );
}

function AddWorkerForm({ onSave, onCancel }: { onSave: (w: any) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: "", role: "laborer", defaultRate: "20", paymentMethod: "zelle", phone: "", paymentHandle: "" });
  return (
    <div style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Name</span>
          <input className="inline-edit" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Role</span>
          <select className="select-field" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
            {["laborer", "lead", "electrician", "plumber", "painter", "general"].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Rate ($/hr)</span>
          <input className="inline-edit" type="number" value={form.defaultRate} onChange={e => setForm({ ...form, defaultRate: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Payment Method</span>
          <select className="select-field" value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value })}>
            {["zelle", "check", "ach", "cash"].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Phone</span>
          <input className="inline-edit" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Zelle/Payment Handle</span>
          <input className="inline-edit" value={form.paymentHandle} onChange={e => setForm({ ...form, paymentHandle: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" style={{ fontSize: 10 }} onClick={onCancel}>Cancel</button>
        <button className="nav-btn active" style={{ fontSize: 10 }} onClick={() => onSave(form)}>Save Worker</button>
      </div>
    </div>
  );
}

function AddEntryForm({ workers, weekEnding: parentWeekEnding, onSave, onCancel }: { workers: Worker[]; weekEnding: string; onSave: (e: any) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ workerId: workers[0]?.id || "", task: "paint", date: new Date().toISOString().split("T")[0], hours: "8", rate: workers[0]?.defaultRate || "20", unitNumber: "", weekEnding: parentWeekEnding || "", notes: "" });
  const total = (Number(form.hours) * Number(form.rate)).toFixed(2);
  return (
    <div style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Worker</span>
          <select className="select-field" value={form.workerId} onChange={e => { const w = workers.find(w => w.id === e.target.value); setForm({ ...form, workerId: e.target.value, rate: w?.defaultRate || form.rate }); }}>
            {workers.filter(w => w.status === "active").map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Task</span>
          <select className="select-field" value={form.task} onChange={e => setForm({ ...form, task: e.target.value })}>
            {["demo", "paint", "flooring", "plumbing", "electrical", "cabinets", "drywall", "trim", "exterior", "cleanup", "other"].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Date</span>
          <input className="inline-edit" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Unit</span>
          <input className="inline-edit" value={form.unitNumber} onChange={e => setForm({ ...form, unitNumber: e.target.value })} placeholder="e.g. C1" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Hours</span>
          <input className="inline-edit" type="number" step="0.5" value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Rate ($/hr)</span>
          <input className="inline-edit" type="number" value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Total</span>
          <div style={{ padding: "6px 8px", fontWeight: 600, fontSize: 14 }} className="tabular-nums">${total}</div>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Week Ending</span>
          <input className="inline-edit" type="date" value={form.weekEnding} onChange={e => setForm({ ...form, weekEnding: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" style={{ fontSize: 10 }} onClick={onCancel}>Cancel</button>
        <button className="nav-btn active" style={{ fontSize: 10 }} onClick={() => onSave({ ...form, total })}>Save Entry</button>
      </div>
    </div>
  );
}

function AddPaymentForm({ workers, onSave, onCancel }: { workers: Worker[]; onSave: (p: any) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ workerId: workers[0]?.id || "", amount: "", paymentMethod: "zelle", memo: "", reference: "", periodStart: "", periodEnd: "" });
  return (
    <div style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Worker</span>
          <select className="select-field" value={form.workerId} onChange={e => setForm({ ...form, workerId: e.target.value })}>
            {workers.filter(w => w.status === "active").map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Amount</span>
          <input className="inline-edit" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Method</span>
          <select className="select-field" value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value })}>
            {["zelle", "check", "ach", "cash"].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Memo (Zelle)</span>
          <input className="inline-edit" value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })} placeholder="e.g. Feb 20 — payment thru feb 20" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Period Start</span>
          <input className="inline-edit" type="date" value={form.periodStart} onChange={e => setForm({ ...form, periodStart: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Period End</span>
          <input className="inline-edit" type="date" value={form.periodEnd} onChange={e => setForm({ ...form, periodEnd: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" style={{ fontSize: 10 }} onClick={onCancel}>Cancel</button>
        <button className="nav-btn active" style={{ fontSize: 10 }} onClick={() => onSave(form)}>Record Payment</button>
      </div>
    </div>
  );
}
