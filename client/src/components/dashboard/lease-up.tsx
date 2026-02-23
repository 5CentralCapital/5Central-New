import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties } from "./shared/property-subtabs";

interface UnitRentRoll {
  id: string; propertyId: string; unitNumber: string; bedrooms?: number;
  bathrooms?: string; sqft?: number; tenantName?: string; leaseStart?: string;
  leaseEnd?: string; monthlyRent?: string; marketRent?: string; securityDeposit?: string;
  status: string; moveInDate?: string; moveOutDate?: string; notes?: string;
}
interface VacancyPipeline {
  id: string; unitId: string; propertyId: string; unitNumber: string;
  vacancyStartDate: string; daysVacant?: number; turnStatus: string;
  targetReadyDate?: string; targetLeaseDate?: string; askingRent?: string;
  marketComps?: string; showingsCount?: number; applicationsCount?: number;
  urgency?: string; notes?: string;
}
interface TurnChecklistItem {
  id: string; vacancyId: string; step: string; sortOrder: number;
  isComplete?: boolean; completedAt?: string; completedBy?: string; dueDate?: string; notes?: string;
}

function fmtMoney(v: number) { return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

const TURN_STAGES = [
  "not_started", "rehab_in_progress", "punch_clean", "photos_pending",
  "listing_live", "showing_scheduled", "application_received", "approved",
  "lease_sent", "lease_signed", "move_in_scheduled", "complete"
];
const TURN_LABELS: Record<string, string> = {
  not_started: "Not Started", rehab_in_progress: "Rehab", punch_clean: "Punch & Clean",
  photos_pending: "Photos", listing_live: "Listed", showing_scheduled: "Showings",
  application_received: "Application", approved: "Approved", lease_sent: "Lease Sent",
  lease_signed: "Signed", move_in_scheduled: "Move-In", complete: "Complete"
};
const DEFAULT_CHECKLIST = [
  "move_out_inspection", "scope_approved", "rehab_complete", "punch_clean",
  "photos_complete", "listing_live", "showings_scheduled", "application_screening",
  "lease_sent", "lease_signed", "move_in_scheduled"
];

export default function LeaseUpControl() {
  const { properties } = useProperties();
  const [selectedProp, setSelectedProp] = useState<string>("");
  const [units, setUnits] = useState<UnitRentRoll[]>([]);
  const [vacancies, setVacancies] = useState<VacancyPipeline[]>([]);
  const [checklist, setChecklist] = useState<Record<string, TurnChecklistItem[]>>({});
  const [view, setView] = useState<"kanban" | "rentroll" | "vacancies">("kanban");
  const [expandedVacancy, setExpandedVacancy] = useState<string | null>(null);
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (properties.length > 0 && !selectedProp) setSelectedProp(properties[0].id);
  }, [properties, selectedProp]);

  const load = useCallback(async () => {
    if (!selectedProp) return;
    setLoading(true);
    setError(null);
    try {
      const [rUnits, rVacancies] = await Promise.all([
        fetch(`/api/lease-up/${selectedProp}/units`, { credentials: "include" }),
        fetch(`/api/lease-up/vacancies?propertyId=${selectedProp}`, { credentials: "include" }),
      ]);
      if (!rUnits.ok) throw new Error(`Failed to load units (${rUnits.status})`);
      if (!rVacancies.ok) throw new Error(`Failed to load vacancies (${rVacancies.status})`);
      const u = await rUnits.json();
      const v = await rVacancies.json();
      setUnits(u);
      setVacancies(v);
    } catch (err: any) {
      setError(err.message || "Failed to load lease-up data");
    } finally {
      setLoading(false);
    }
  }, [selectedProp]);

  useEffect(() => { load(); }, [load]);

  const loadChecklist = async (vacancyId: string) => {
    try {
      const r = await fetch(`/api/lease-up/vacancies/${vacancyId}/checklist`, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load checklist (${r.status})`);
      const cl = await r.json();
      setChecklist(prev => ({ ...prev, [vacancyId]: cl }));
    } catch (err: any) {
      setError(err.message || "Failed to load checklist");
    }
  };

  // Computed
  const occupied = units.filter(u => u.status === "occupied").length;
  const vacant = units.filter(u => u.status !== "occupied").length;
  const occRate = units.length > 0 ? (occupied / units.length) * 100 : 0;
  const totalRent = units.filter(u => u.status === "occupied").reduce((s, u) => s + Number(u.monthlyRent || 0), 0);
  const totalMarket = units.reduce((s, u) => s + Number(u.marketRent || 0), 0);
  const rentUpside = totalMarket - totalRent;
  const urgentVacancies = vacancies.filter(v => v.urgency === "red").length;
  const yellowVacancies = vacancies.filter(v => v.urgency === "yellow").length;

  const updateVacancy = async (id: string, changes: Partial<VacancyPipeline>) => {
    try {
      const r = await fetch(`/api/lease-up/vacancies/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(changes) });
      if (!r.ok) throw new Error(`Failed to update vacancy (${r.status})`);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to update vacancy");
    }
  };

  const urgencyColor = (u?: string) => u === "red" ? "var(--color-danger)" : u === "yellow" ? "var(--color-warning)" : "var(--color-success)";
  const statusColor = (s: string) => {
    const m: Record<string, string> = { occupied: "var(--color-success)", vacant: "var(--color-danger)", notice: "var(--color-warning)", eviction: "var(--color-danger)", renovation: "var(--color-accent)" };
    return m[s] || "var(--color-text-muted)";
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Property selector */}
      <PropertySubTabs properties={properties} selected={selectedProp} onSelect={setSelectedProp} />

      {/* Error banner */}
      {error && (
        <div className="card" style={{ padding: 10, borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)" }}>
          <div style={{ fontSize: 12, color: "var(--color-danger)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{error}</span>
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-danger)", fontSize: 14, padding: "0 4px" }}>x</button>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{ textAlign: "center", padding: 24, color: "var(--color-text-muted)", fontSize: 13 }}>Loading lease-up data...</div>
      )}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        <KPI label="Occupancy" value={`${occRate.toFixed(0)}%`} sub={`${occupied}/${units.length} units`} color={occRate < 75 ? "var(--color-danger)" : occRate < 90 ? "var(--color-warning)" : "var(--color-success)"} />
        <KPI label="Vacant" value={String(vacant)} color={vacant > 0 ? "var(--color-warning)" : "var(--color-success)"} />
        <KPI label="Monthly Rent" value={fmtMoney(totalRent)} />
        <KPI label="Market Rent" value={fmtMoney(totalMarket)} />
        <KPI label="Rent Upside" value={fmtMoney(rentUpside)} color="var(--color-accent)" />
        <KPI label="Active Turns" value={String(vacancies.filter(v => v.turnStatus !== "complete").length)} />
        {urgentVacancies > 0 && <KPI label="Urgent (>14d)" value={String(urgentVacancies)} color="var(--color-danger)" />}
        {yellowVacancies > 0 && <KPI label="Watch (>7d)" value={String(yellowVacancies)} color="var(--color-warning)" />}
      </div>

      {/* Alerts */}
      {vacancies.some(v => v.urgency === "red") && (
        <div className="card" style={{ padding: 10, borderColor: "rgba(239,68,68,0.25)" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-danger)", marginBottom: 4, fontWeight: 600 }}>Vacancy Alerts</div>
          {vacancies.filter(v => v.urgency === "red").map(v => (
            <div key={v.id} style={{ fontSize: 12, color: "var(--color-text)", marginBottom: 2 }}>
              <span style={{ color: "var(--color-danger)", fontWeight: 600, marginRight: 6 }}>RED</span>
              Unit {v.unitNumber} — {v.daysVacant} days vacant — {TURN_LABELS[v.turnStatus]}
            </div>
          ))}
        </div>
      )}

      {/* Sub-nav */}
      <div style={{ display: "flex", gap: 6 }}>
        {(["kanban", "rentroll", "vacancies"] as const).map(v => (
          <button key={v} className={`nav-btn ${view === v ? "active" : ""}`} onClick={() => setView(v)} style={{ fontSize: 11 }}>
            {v === "kanban" ? "Turn Kanban" : v === "rentroll" ? "Rent Roll" : "Vacancy Pipeline"}
          </button>
        ))}
      </div>

      {/* KANBAN VIEW */}
      {view === "kanban" && (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "flex", gap: 8, minWidth: "max-content" }}>
            {TURN_STAGES.filter(s => s !== "complete").map(stage => {
              const stageVacancies = vacancies.filter(v => v.turnStatus === stage);
              return (
                <div key={stage} style={{ minWidth: 180, flex: "0 0 180px" }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 6, padding: "0 4px", display: "flex", justifyContent: "space-between" }}>
                    <span>{TURN_LABELS[stage]}</span>
                    <span style={{ fontWeight: 600 }}>{stageVacancies.length}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {stageVacancies.map(v => (
                      <div key={v.id} className="card interactive" style={{ padding: 10, borderColor: `${urgencyColor(v.urgency)}33`, cursor: "pointer" }} onClick={() => { setExpandedVacancy(expandedVacancy === v.id ? null : v.id); if (!checklist[v.id]) loadChecklist(v.id); }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{v.unitNumber}</span>
                          <span style={{ fontSize: 10, color: urgencyColor(v.urgency), fontWeight: 600 }}>{v.daysVacant}d</span>
                        </div>
                        {v.askingRent && <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Asking: {fmtMoney(Number(v.askingRent))}</div>}
                        <div style={{ fontSize: 10, color: "var(--color-text-muted)", display: "flex", gap: 8 }}>
                          {(v.showingsCount ?? 0) > 0 && <span>{v.showingsCount} showings</span>}
                          {(v.applicationsCount ?? 0) > 0 && <span>{v.applicationsCount} apps</span>}
                        </div>
                        {/* Advance button */}
                        {TURN_STAGES.indexOf(stage) < TURN_STAGES.length - 1 && (
                          <button className="nav-btn" style={{ fontSize: 9, marginTop: 6, width: "100%", padding: "2px 0" }} onClick={(e) => { e.stopPropagation(); updateVacancy(v.id, { turnStatus: TURN_STAGES[TURN_STAGES.indexOf(stage) + 1] }); }}>
                            Advance →
                          </button>
                        )}
                      </div>
                    ))}
                    {stageVacancies.length === 0 && (
                      <div style={{ padding: 12, textAlign: "center", fontSize: 10, color: "var(--color-text-muted)", border: "1px dashed var(--color-border)", borderRadius: 6 }}>Empty</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expanded vacancy checklist */}
      {expandedVacancy && checklist[expandedVacancy] && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 8 }}>Turn Checklist — Unit {vacancies.find(v => v.id === expandedVacancy)?.unitNumber}</div>
          {[...checklist[expandedVacancy]].sort((a, b) => a.sortOrder - b.sortOrder).map(item => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--color-border)" }}>
              <button onClick={async () => { try { const r = await fetch(`/api/lease-up/checklist/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ isComplete: !item.isComplete }) }); if (!r.ok) throw new Error(`Failed to update checklist (${r.status})`); loadChecklist(expandedVacancy!); } catch (err: any) { setError(err.message || "Failed to update checklist item"); } }} style={{
                width: 18, height: 18, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "white", flexShrink: 0,
                border: `1px solid ${item.isComplete ? "var(--color-success)" : "var(--color-border)"}`,
                background: item.isComplete ? "var(--color-success)" : "transparent",
              }}>
                {item.isComplete ? "✓" : ""}
              </button>
              <span style={{ flex: 1, fontSize: 12, textTransform: "capitalize", textDecoration: item.isComplete ? "line-through" : "none", opacity: item.isComplete ? 0.5 : 1 }}>
                {item.step.replace(/_/g, " ")}
              </span>
              {item.completedAt && <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{new Date(item.completedAt).toLocaleDateString()}</span>}
            </div>
          ))}
        </div>
      )}

      {/* RENT ROLL VIEW */}
      {view === "rentroll" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="label">Rent Roll — {properties.find(p => p.id === selectedProp)?.name}</div>
            <button className="nav-btn" style={{ fontSize: 10 }} onClick={() => setShowAddUnit(!showAddUnit)}>+ Add Unit</button>
          </div>
          {showAddUnit && <AddUnitForm propertyId={selectedProp} onSave={async (u) => { try { const r = await fetch("/api/lease-up/units", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(u) }); if (!r.ok) throw new Error(`Failed to add unit (${r.status})`); setShowAddUnit(false); load(); } catch (err: any) { setError(err.message || "Failed to add unit"); } }} onCancel={() => setShowAddUnit(false)} />}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Unit</th><th>Bed/Bath</th><th>SqFt</th><th>Tenant</th><th>Status</th><th>Rent</th><th>Market</th><th>Lease Start</th><th>Lease End</th><th>Upside</th></tr>
              </thead>
              <tbody>
                {[...units].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)).map(u => {
                  const upside = Number(u.marketRent || 0) - Number(u.monthlyRent || 0);
                  const leaseEnd = u.leaseEnd ? new Date(u.leaseEnd) : null;
                  const expiringsSoon = leaseEnd && ((leaseEnd.getTime() - Date.now()) / 86400000) < 60;
                  return (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 600 }}>{u.unitNumber}</td>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>{u.bedrooms || "—"}/{u.bathrooms || "—"}</td>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>{u.sqft || "—"}</td>
                      <td>{u.tenantName || <span style={{ color: "var(--color-text-muted)" }}>Vacant</span>}</td>
                      <td><span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, background: `${statusColor(u.status)}15`, color: statusColor(u.status), border: `1px solid ${statusColor(u.status)}33` }}>{u.status}</span></td>
                      <td className="tabular-nums">{u.monthlyRent ? fmtMoney(Number(u.monthlyRent)) : "—"}</td>
                      <td className="tabular-nums" style={{ color: "var(--color-text-muted)" }}>{u.marketRent ? fmtMoney(Number(u.marketRent)) : "—"}</td>
                      <td style={{ fontSize: 11 }}>{u.leaseStart || "—"}</td>
                      <td style={{ fontSize: 11, color: expiringsSoon ? "var(--color-danger)" : "inherit", fontWeight: expiringsSoon ? 600 : 400 }}>{u.leaseEnd || "—"}{expiringsSoon && " !"}</td>
                      <td className="tabular-nums" style={{ color: upside > 0 ? "var(--color-success)" : "var(--color-text-muted)" }}>{upside > 0 ? `+${fmtMoney(upside)}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                  <td colSpan={5}>TOTAL ({units.length} units)</td>
                  <td className="tabular-nums">{fmtMoney(totalRent)}</td>
                  <td className="tabular-nums">{fmtMoney(totalMarket)}</td>
                  <td colSpan={2} />
                  <td className="tabular-nums" style={{ color: "var(--color-success)" }}>+{fmtMoney(rentUpside)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* VACANCIES VIEW */}
      {view === "vacancies" && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Vacancy Pipeline</div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Unit</th><th>Days Vacant</th><th>Urgency</th><th>Turn Status</th><th>Target Ready</th><th>Target Lease</th><th>Asking</th><th>Showings</th><th>Apps</th></tr>
              </thead>
              <tbody>
                {[...vacancies].sort((a, b) => (b.daysVacant || 0) - (a.daysVacant || 0)).map(v => (
                  <tr key={v.id}>
                    <td style={{ fontWeight: 600 }}>{v.unitNumber}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600, fontSize: 16, color: urgencyColor(v.urgency) }}>{v.daysVacant}d</td>
                    <td><span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, color: urgencyColor(v.urgency), background: `${urgencyColor(v.urgency)}12`, border: `1px solid ${urgencyColor(v.urgency)}33` }}>{v.urgency}</span></td>
                    <td>
                      <select className="select-inline" value={v.turnStatus} onChange={e => updateVacancy(v.id, { turnStatus: e.target.value })}>
                        {TURN_STAGES.map(s => <option key={s} value={s}>{TURN_LABELS[s]}</option>)}
                      </select>
                    </td>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{v.targetReadyDate || "—"}</td>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{v.targetLeaseDate || "—"}</td>
                    <td className="tabular-nums">{v.askingRent ? fmtMoney(Number(v.askingRent)) : "—"}</td>
                    <td className="tabular-nums">{v.showingsCount || 0}</td>
                    <td className="tabular-nums">{v.applicationsCount || 0}</td>
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

function KPI({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <article className="card interactive" style={{ padding: "10px 12px" }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: "1.2rem", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: color || "var(--color-text)", fontFamily: "var(--font-display)" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "var(--color-text-muted)", marginTop: 1 }}>{sub}</div>}
    </article>
  );
}

function AddUnitForm({ propertyId, onSave, onCancel }: { propertyId: string; onSave: (u: any) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ propertyId, unitNumber: "", bedrooms: "2", bathrooms: "1", sqft: "", monthlyRent: "", marketRent: "", status: "vacant" });
  return (
    <div style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Unit Number</span>
          <input className="inline-edit" value={form.unitNumber} onChange={e => setForm({ ...form, unitNumber: e.target.value })} placeholder="e.g. 101, A1" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Bed/Bath</span>
          <div style={{ display: "flex", gap: 4 }}>
            <input className="inline-edit" type="number" value={form.bedrooms} onChange={e => setForm({ ...form, bedrooms: e.target.value })} style={{ width: 50 }} />
            <input className="inline-edit" type="number" step="0.5" value={form.bathrooms} onChange={e => setForm({ ...form, bathrooms: e.target.value })} style={{ width: 50 }} />
          </div>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Monthly Rent</span>
          <input className="inline-edit" type="number" value={form.monthlyRent} onChange={e => setForm({ ...form, monthlyRent: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Market Rent</span>
          <input className="inline-edit" type="number" value={form.marketRent} onChange={e => setForm({ ...form, marketRent: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" style={{ fontSize: 10 }} onClick={onCancel}>Cancel</button>
        <button className="nav-btn active" style={{ fontSize: 10 }} onClick={() => onSave(form)}>Add Unit</button>
      </div>
    </div>
  );
}
