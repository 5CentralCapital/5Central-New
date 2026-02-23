import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties } from "./shared/property-subtabs";

interface RehabLineItem {
  id: string; propertyId: string; unitNumber?: string; scopeItem: string; category: string;
  contractorBaselineCost?: string; inHouseLaborCost?: string; inHouseMaterialCost?: string;
  totalInHouseCost?: string; savingsVsContractor?: string; savingsPercent?: string;
  status: string; assignedWorkerId?: string; plannedStartDate?: string; plannedEndDate?: string;
  actualStartDate?: string; actualEndDate?: string; slipDays?: number;
  isCriticalPath?: boolean; blockerReason?: string; proofUrl?: string; notes?: string;
}
interface RehabMaterial {
  id: string; propertyId: string; lineItemId?: string; description: string;
  vendor?: string; cost: string; receiptUrl?: string; purchaseDate: string; notes?: string;
}
interface RehabPhoto {
  id: string; propertyId: string; unitNumber?: string; lineItemId?: string;
  photoUrl: string; caption?: string; phase: string; takenAt: string;
}


function fmtMoney(v: number) { return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtCompact(v: number) {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

interface RehabDetailProps {
  initialPropertyName?: string;
  onBack?: () => void;
}

export default function RehabDetail({ initialPropertyName, onBack }: RehabDetailProps = {}) {
  const { properties } = useProperties();
  const [selectedProp, setSelectedProp] = useState<string>("");
  const [items, setItems] = useState<RehabLineItem[]>([]);
  const [materials, setMaterials] = useState<RehabMaterial[]>([]);
  const [photos, setPhotos] = useState<RehabPhoto[]>([]);
  const [view, setView] = useState<"scope" | "materials" | "photos" | "timeline">("scope");
  const [showAdd, setShowAdd] = useState(false);
  const [unitFilter, setUnitFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (properties.length > 0 && !selectedProp) {
      if (initialPropertyName) {
        const match = properties.find(p => p.name === initialPropertyName);
        if (match) { setSelectedProp(match.id); return; }
      }
      setSelectedProp(properties[0].id);
    }
  }, [properties, initialPropertyName]);

  const load = useCallback(async () => {
    if (!selectedProp) return;
    setLoading(true);
    setError(null);
    try {
      const [rItems, rMats, rPhotos] = await Promise.all([
        fetch(`/api/rehab/${selectedProp}/items`),
        fetch(`/api/rehab/${selectedProp}/materials`),
        fetch(`/api/rehab/${selectedProp}/photos`),
      ]);
      if (!rItems.ok) throw new Error(`Failed to load items (${rItems.status})`);
      if (!rMats.ok) throw new Error(`Failed to load materials (${rMats.status})`);
      if (!rPhotos.ok) throw new Error(`Failed to load photos (${rPhotos.status})`);
      const [i, m, p] = await Promise.all([rItems.json(), rMats.json(), rPhotos.json()]);
      setItems(i); setMaterials(m); setPhotos(p);
    } catch (e: any) {
      setError(e.message || "Failed to load rehab data");
    } finally {
      setLoading(false);
    }
  }, [selectedProp]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { setUnitFilter("all"); }, [selectedProp]);

  // Computed
  const filteredItems = unitFilter === "all" ? items : items.filter(i => i.unitNumber === unitFilter);
  const units = Array.from(new Set(items.map(i => i.unitNumber).filter(Boolean))) as string[];
  const totalContractor = filteredItems.reduce((s, i) => s + Number(i.contractorBaselineCost || 0), 0);
  const totalInHouse = filteredItems.reduce((s, i) => s + Number(i.totalInHouseCost || 0), 0);
  const totalLabor = filteredItems.reduce((s, i) => s + Number(i.inHouseLaborCost || 0), 0);
  const totalMaterial = filteredItems.reduce((s, i) => s + Number(i.inHouseMaterialCost || 0), 0);
  const totalSavings = totalContractor - totalInHouse;
  const savingsPct = totalContractor > 0 ? (totalSavings / totalContractor) * 100 : 0;
  const completedItems = filteredItems.filter(i => i.status === "complete").length;
  const blockedItems = filteredItems.filter(i => i.status === "blocked").length;
  const materialTotal = materials.reduce((s, m) => s + Number(m.cost), 0);

  // Status counts
  const statusCounts = filteredItems.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const statusColor = (s: string) => {
    const colors: Record<string, string> = { planned: "var(--color-text-muted)", in_progress: "var(--color-accent)", complete: "var(--color-success)", blocked: "var(--color-danger)", cancelled: "var(--color-text-muted)" };
    return colors[s] || "var(--color-text-muted)";
  };

  const categoryIcon = (c: string) => {
    const icons: Record<string, string> = { demo: "D", flooring: "F", paint: "P", plumbing: "Pl", electrical: "E", hvac: "H", cabinets: "Cb", countertops: "Ct", exterior: "Ex", roofing: "R", appliances: "Ap", other: "?" };
    return icons[c] || "?";
  };

  const updateItem = async (id: string, changes: Partial<RehabLineItem>) => {
    try {
      const r = await fetch(`/api/rehab/items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
      if (!r.ok) throw new Error(`Failed to update item (${r.status})`);
      load();
    } catch (e: any) {
      setError(e.message || "Failed to update item");
    }
  };

  const selectedPropertyObj = properties.find(p => p.id === selectedProp);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header with back button (when drilled in) */}
      {onBack && (
        <div className="card" style={{ padding: "14px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button onClick={onBack} className="nav-btn" style={{ fontSize: 11, padding: "5px 14px" }}>← Back</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", fontWeight: 600 }}>
                {selectedPropertyObj?.name || "Rehab Tracker"}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                Detailed Rehab Management — Scope, Costs, Materials, Photos & Timeline
              </div>
            </div>
            {filteredItems.length > 0 && (
              <div style={{ textAlign: "center", padding: "6px 16px", borderRadius: 8, background: "rgba(196,165,116,0.08)", border: "1px solid rgba(196,165,116,0.2)" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-accent)" }} className="tabular-nums">{completedItems}/{filteredItems.length}</div>
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)" }}>items done</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Property selector + KPIs */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <PropertySubTabs properties={properties} selected={selectedProp} onSelect={setSelectedProp} />
        <select className="select-field" value={unitFilter} onChange={e => setUnitFilter(e.target.value)} style={{ fontSize: 11, width: 120 }}>
          <option value="all">All Units</option>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-muted)", fontSize: 13 }}>Loading rehab data...</div>
      )}

      {error && (
        <div style={{ padding: 12, borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)", fontSize: 12, color: "var(--color-danger)" }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        <KPI label="Contractor Baseline" value={fmtCompact(totalContractor)} />
        <KPI label="In-House Cost" value={fmtCompact(totalInHouse)} color="var(--color-accent)" />
        <KPI label="Labor" value={fmtCompact(totalLabor)} />
        <KPI label="Materials" value={fmtCompact(totalMaterial)} />
        <KPI label="Savings" value={fmtCompact(totalSavings)} sub={`${savingsPct.toFixed(1)}% saved`} color="var(--color-success)" />
        <KPI label="Progress" value={`${completedItems}/${filteredItems.length}`} sub={blockedItems > 0 ? `${blockedItems} blocked` : "on track"} color={blockedItems > 0 ? "var(--color-danger)" : "var(--color-success)"} />
        <KPI label="Material Log" value={fmtCompact(materialTotal)} sub={`${materials.length} purchases`} />
      </div>

      {/* Status bar */}
      <div className="card" style={{ padding: 10 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(status) }} />
              <span style={{ textTransform: "capitalize" }}>{status.replaceAll("_", " ")}</span>
              <span style={{ fontWeight: 600 }} className="tabular-nums">{count}</span>
            </div>
          ))}
          {filteredItems.length > 0 && (
            <div style={{ marginLeft: "auto", height: 8, flex: 1, maxWidth: 300, borderRadius: 4, background: "var(--color-border)", overflow: "hidden", display: "flex" }}>
              <div style={{ width: `${(completedItems / filteredItems.length) * 100}%`, background: "var(--color-success)", transition: "width 0.5s" }} />
              <div style={{ width: `${((statusCounts["in_progress"] || 0) / filteredItems.length) * 100}%`, background: "var(--color-accent)" }} />
              <div style={{ width: `${(blockedItems / filteredItems.length) * 100}%`, background: "var(--color-danger)" }} />
            </div>
          )}
        </div>
      </div>

      {/* Sub-nav */}
      <div style={{ display: "flex", gap: 6 }}>
        {(["scope", "materials", "photos", "timeline"] as const).map(v => (
          <button key={v} className={`nav-btn ${view === v ? "active" : ""}`} onClick={() => setView(v)} style={{ fontSize: 11 }}>
            {v === "scope" ? "Scope & Cost" : v === "materials" ? "Material Log" : v === "photos" ? "Photo Timeline" : "Timeline"}
          </button>
        ))}
      </div>

      {/* SCOPE VIEW - Dual cost engine */}
      {view === "scope" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="label">Rehab Line Items — Dual Cost Engine</div>
            <button className="nav-btn" style={{ fontSize: 10 }} onClick={() => setShowAdd(!showAdd)}>+ Add Item</button>
          </div>
          {showAdd && <AddLineItemForm units={units} onSave={async (item) => { try { const r = await fetch("/api/rehab/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...item, propertyId: selectedProp }) }); if (!r.ok) throw new Error(`Failed to add item (${r.status})`); setShowAdd(false); load(); } catch (e: any) { setError(e.message || "Failed to add item"); } }} onCancel={() => setShowAdd(false)} />}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Unit</th><th>Scope Item</th><th>Category</th><th>Contractor$</th><th>Labor$</th><th>Material$</th><th>In-House$</th><th>Savings</th><th>Status</th><th>Critical</th><th>Blocker</th></tr>
              </thead>
              <tbody>
                {filteredItems.map(item => (
                  <tr key={item.id} style={{ opacity: item.status === "cancelled" ? 0.4 : 1 }}>
                    <td style={{ fontSize: 11, fontWeight: 500 }}>{item.unitNumber || "Common"}</td>
                    <td>{item.scopeItem}</td>
                    <td>
                      <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {categoryIcon(item.category)} {item.category}
                      </span>
                    </td>
                    <td className="tabular-nums" style={{ color: "var(--color-text-muted)" }}>{item.contractorBaselineCost ? fmtMoney(Number(item.contractorBaselineCost)) : "—"}</td>
                    <td className="tabular-nums">{fmtMoney(Number(item.inHouseLaborCost || 0))}</td>
                    <td className="tabular-nums">{fmtMoney(Number(item.inHouseMaterialCost || 0))}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{fmtMoney(Number(item.totalInHouseCost || 0))}</td>
                    <td className="tabular-nums" style={{ color: Number(item.savingsVsContractor || 0) > 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                      {item.contractorBaselineCost ? `${fmtMoney(Number(item.savingsVsContractor || 0))} (${Number(item.savingsPercent || 0).toFixed(0)}%)` : "—"}
                    </td>
                    <td>
                      <select className="select-inline" value={item.status} onChange={e => updateItem(item.id, { status: e.target.value })} style={{ color: statusColor(item.status) }}>
                        {["planned", "in_progress", "complete", "blocked", "cancelled"].map(s => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "center" }}>{item.isCriticalPath ? <span style={{ color: "var(--color-danger)", fontWeight: 600 }}>CP</span> : "—"}</td>
                    <td style={{ fontSize: 11, color: "var(--color-warning)" }}>{item.blockerReason || "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                  <td colSpan={3}>TOTAL</td>
                  <td className="tabular-nums">{fmtMoney(totalContractor)}</td>
                  <td className="tabular-nums">{fmtMoney(totalLabor)}</td>
                  <td className="tabular-nums">{fmtMoney(totalMaterial)}</td>
                  <td className="tabular-nums">{fmtMoney(totalInHouse)}</td>
                  <td className="tabular-nums" style={{ color: "var(--color-success)" }}>{fmtMoney(totalSavings)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Alerts */}
          {filteredItems.some(i => Number(i.totalInHouseCost || 0) > Number(i.contractorBaselineCost || Infinity)) && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)", fontSize: 12 }}>
              <span style={{ color: "var(--color-danger)", fontWeight: 600 }}>ALERT:</span> Some items exceed contractor baseline cost:
              {filteredItems.filter(i => Number(i.totalInHouseCost || 0) > Number(i.contractorBaselineCost || Infinity)).map(i => (
                <div key={i.id} style={{ marginLeft: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
                  {i.unitNumber} — {i.scopeItem}: In-house {fmtMoney(Number(i.totalInHouseCost))} vs Contractor {fmtMoney(Number(i.contractorBaselineCost))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MATERIALS VIEW */}
      {view === "materials" && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="label">Rolling Material Spend — {fmtMoney(materialTotal)} total</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Description</th><th>Vendor</th><th>Amount</th><th>Running Total</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {[...materials].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate)).map((m, idx, sortedArr) => {
                  const running = sortedArr.slice(0, idx + 1).reduce((s, x) => s + Number(x.cost), 0);
                  return (
                    <tr key={m.id}>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>{m.purchaseDate}</td>
                      <td>{m.description}</td>
                      <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{m.vendor || "—"}</td>
                      <td className="tabular-nums" style={{ fontWeight: 500 }}>{fmtMoney(Number(m.cost))}</td>
                      <td className="tabular-nums" style={{ color: "var(--color-accent)" }}>{fmtMoney(running)}</td>
                      <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{m.notes || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PHOTOS VIEW */}
      {view === "photos" && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Rehab Photo Timeline</div>
          {photos.length === 0 ? (
            <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-muted)", fontSize: 12 }}>
              No photos uploaded yet. Photos appear here as work progresses.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
              {[...photos].sort((a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime()).map(p => (
                <div key={p.id} style={{ borderRadius: 8, border: "1px solid var(--color-border)", overflow: "hidden" }}>
                  {p.photoUrl ? (
                    <img src={p.photoUrl} alt={p.caption || p.phase} style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ height: 120, background: "var(--color-surface-alt)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, opacity: 0.2 }}>
                      {p.phase === "before" ? "B" : p.phase === "during" ? "D" : "A"}
                    </div>
                  )}
                  <div style={{ padding: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}>
                      <span style={{ textTransform: "uppercase", fontWeight: 600, color: p.phase === "before" ? "var(--color-text-muted)" : p.phase === "during" ? "var(--color-accent)" : "var(--color-success)" }}>{p.phase}</span>
                      <span style={{ color: "var(--color-text-muted)" }}>{p.unitNumber}</span>
                    </div>
                    <div style={{ fontSize: 11 }}>{p.caption || "Untitled"}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{new Date(p.takenAt).toLocaleDateString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TIMELINE VIEW */}
      {view === "timeline" && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Rehab Timeline — Critical Path</div>
          {filteredItems.filter(i => i.plannedStartDate || i.actualStartDate).length === 0 ? (
            <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-muted)", fontSize: 12 }}>
              Add planned/actual dates to scope items to see the timeline view.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...filteredItems]
                .filter(i => i.plannedStartDate || i.actualStartDate)
                .sort((a, b) => (a.actualStartDate || a.plannedStartDate || "").localeCompare(b.actualStartDate || b.plannedStartDate || ""))
                .map(item => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(item.status), flexShrink: 0 }} />
                    <span style={{ width: 40, fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }}>{item.unitNumber || "—"}</span>
                    <span style={{ flex: 1, fontSize: 12 }}>{item.scopeItem}</span>
                    <span style={{ fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }}>{item.actualStartDate || item.plannedStartDate} → {item.actualEndDate || item.plannedEndDate || "TBD"}</span>
                    {item.slipDays && item.slipDays > 0 && (
                      <span style={{ fontSize: 10, color: "var(--color-danger)", fontWeight: 600, flexShrink: 0 }}>+{item.slipDays}d slip</span>
                    )}
                    {item.isCriticalPath && <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "rgba(239,68,68,0.1)", color: "var(--color-danger)", fontWeight: 600, flexShrink: 0 }}>CP</span>}
                  </div>
                ))}
            </div>
          )}
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

function AddLineItemForm({ units, onSave, onCancel }: { units: string[]; onSave: (item: any) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ unitNumber: units[0] || "", scopeItem: "", category: "other", contractorBaselineCost: "", inHouseLaborCost: "0", inHouseMaterialCost: "0", status: "planned", isCriticalPath: false });
  const inHouseTotal = Number(form.inHouseLaborCost || 0) + Number(form.inHouseMaterialCost || 0);
  const savings = Number(form.contractorBaselineCost || 0) - inHouseTotal;
  return (
    <div style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Unit</span>
          <input className="inline-edit" value={form.unitNumber} onChange={e => setForm({ ...form, unitNumber: e.target.value })} placeholder="e.g. C1, L2" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: "span 2" }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Scope Item</span>
          <input className="inline-edit" value={form.scopeItem} onChange={e => setForm({ ...form, scopeItem: e.target.value })} placeholder="e.g. Kitchen demo, LVP flooring" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Category</span>
          <select className="select-field" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
            {["demo", "flooring", "paint", "plumbing", "electrical", "hvac", "roofing", "appliances", "cabinets", "countertops", "exterior", "other"].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Contractor Baseline ($)</span>
          <input className="inline-edit" type="number" value={form.contractorBaselineCost} onChange={e => setForm({ ...form, contractorBaselineCost: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>In-House Labor ($)</span>
          <input className="inline-edit" type="number" value={form.inHouseLaborCost} onChange={e => setForm({ ...form, inHouseLaborCost: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>In-House Material ($)</span>
          <input className="inline-edit" type="number" value={form.inHouseMaterialCost} onChange={e => setForm({ ...form, inHouseMaterialCost: e.target.value })} />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Savings</span>
          <div style={{ padding: "6px 8px", fontWeight: 600, color: savings > 0 ? "var(--color-success)" : "var(--color-danger)" }} className="tabular-nums">
            {fmtMoney(savings)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" style={{ fontSize: 10 }} onClick={onCancel}>Cancel</button>
        <button className="nav-btn active" style={{ fontSize: 10 }} onClick={() => onSave({ ...form, totalInHouseCost: String(inHouseTotal), savingsVsContractor: String(savings), savingsPercent: form.contractorBaselineCost ? String((savings / Number(form.contractorBaselineCost)) * 100) : "0" })}>Add Item</button>
      </div>
    </div>
  );
}
