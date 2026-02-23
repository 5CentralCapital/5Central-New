import { useState, useEffect, useCallback } from "react";
import { propertyDetails, type PropertyDetails } from "@/lib/property-details";

/* ── Helpers ── */
function fmtCompact(v: number): string {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(0) + "K";
  return "$" + v.toLocaleString();
}
function fmtPct(v: number): string { return (v * 100).toFixed(1) + "%"; }
function fmtDollars(v: number): string { return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function fmtPctChange(before: number, after: number): string {
  if (before === 0) return "+0%";
  return "+" + (((after - before) / before) * 100).toFixed(0) + "%";
}

/* ── Types ── */
interface PropertyCard {
  id: string; name: string; address: string; city: string; state: string; units: number;
  acquisitionPrice: number; rehabBudget: number; totalBasis: number; currentValue: number;
  currentDebt: number; currentEquity: number; lender: string; interestRate: number;
  maturityDate: string; annualNOI: number; yieldOnCost: number; capRate: number;
  dscr: number; occupancyRate: number; occupiedUnits: number; phase: string;
  refiTarget?: string; refiProceeds?: number;
}
interface OccupancyRecord { id: string; property: string; units: number; occupied: number; vacant: number; occupancyRate: number; monthlyRent: number; status: string; }
interface DebtMaturity { id: string; property: string; lender: string; balance: number; interestRate: number; maturityDate: string; daysUntilMaturity: number; urgency: string; refiTarget?: string; expectedProceeds?: number; }
interface RehabTracker { id: string; property: string; project: string; budget: number; spent: number; completionPct: number; status: string; targetDate?: string; notes?: string; }
interface RentRollUnit {
  id: number; propertyId: string; unitNumber: string; tenantName: string | null;
  monthlyRent: number | null; bedrooms: number | null; bathrooms: string | null;
  sqft: number | null; status: string; notes: string | null;
}

interface Props {
  propertyName: string;
  property: PropertyCard;
  occupancy?: OccupancyRecord;
  debt?: DebtMaturity;
  rehab?: RehabTracker;
  onBack: () => void;
}

/* ══════════════════════════ MAIN COMPONENT ══════════════════════════ */

export default function PropertyDetail({ propertyName, property: p, occupancy: o, debt: d, rehab: r, onBack }: Props) {
  const details = propertyDetails[propertyName];
  const [units, setUnits] = useState<RentRollUnit[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const [editingUnit, setEditingUnit] = useState<number | null>(null);
  const [unitDraft, setUnitDraft] = useState<Partial<RentRollUnit>>({});
  const [beforeIdx, setBeforeIdx] = useState(0);
  const [afterIdx, setAfterIdx] = useState(0);
  const [propertyId, setPropertyId] = useState<string | null>(null);

  const loadRentRoll = useCallback(async () => {
    setLoadingUnits(true);
    try {
      const propsRes = await fetch("/api/properties/current");
      if (!propsRes.ok) { setLoadingUnits(false); return; }
      const props = await propsRes.json();
      const match = props.find((pr: any) => pr.name === propertyName);
      if (!match) { setLoadingUnits(false); return; }
      setPropertyId(match.id);
      const res = await fetch(`/api/lease-up/${match.id}/units`);
      if (res.ok) setUnits(await res.json());
    } catch { /* silent */ }
    setLoadingUnits(false);
  }, [propertyName]);

  useEffect(() => { loadRentRoll(); }, [loadRentRoll]);

  const saveUnit = useCallback(async (unitId: number, changes: Partial<RentRollUnit>) => {
    try {
      await fetch(`/api/lease-up/units/${unitId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      await loadRentRoll();
      setEditingUnit(null);
    } catch { /* silent */ }
  }, [loadRentRoll]);

  const beforePhotos = details?.beforePhotos || [];
  const afterPhotos = details?.afterPhotos || [];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ═══ HEADER ═══ */}
      <div className="card" style={{ padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={onBack} className="nav-btn" style={{ fontSize: 11, padding: "5px 14px" }}>← Back</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", fontWeight: 600 }}>
              {p.name}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
              {p.address} · {p.city}, {p.state} · {p.units} units
              <span style={{ color: phaseColor(p.phase), textTransform: "uppercase", fontWeight: 600, marginLeft: 8, padding: "1px 6px", borderRadius: 4, border: `1px solid ${phaseColor(p.phase)}44`, background: `${phaseColor(p.phase)}11`, fontSize: 9, letterSpacing: "0.05em" }}>
                {p.phase.replace("_", " ")}
              </span>
            </div>
          </div>
          {/* Occupancy badge */}
          {o && (
            <div style={{ textAlign: "center", padding: "6px 16px", borderRadius: 8, background: o.occupancyRate < 75 ? "rgba(239,68,68,0.08)" : o.occupancyRate < 90 ? "rgba(251,191,36,0.08)" : "rgba(16,185,129,0.08)", border: `1px solid ${o.occupancyRate < 75 ? "rgba(239,68,68,0.2)" : o.occupancyRate < 90 ? "rgba(251,191,36,0.2)" : "rgba(16,185,129,0.2)"}` }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: o.occupancyRate < 75 ? "var(--color-danger)" : o.occupancyRate < 90 ? "var(--color-warning)" : "var(--color-success)" }} className="tabular-nums">{o.occupancyRate.toFixed(0)}%</div>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)" }}>occupied</div>
            </div>
          )}
        </div>
      </div>

      {/* ═══ HERO KPIs ═══ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        <MetricCard label="ARV / Value" value={fmtCompact(p.currentValue || p.totalBasis)} />
        <MetricCard label="Annual NOI" value={fmtCompact(p.annualNOI)} />
        <MetricCard label="DSCR" value={p.dscr.toFixed(2) + "x"} color={p.dscr < 1.15 ? "var(--color-warning)" : "var(--color-success)"} />
        <MetricCard label="Yield on Cost" value={p.yieldOnCost.toFixed(1) + "%"} />
        <MetricCard label="Cap Rate" value={p.capRate.toFixed(2) + "%"} />
        <MetricCard label="Total Equity" value={fmtCompact(p.currentEquity)} />
        <MetricCard label="Current Debt" value={fmtCompact(p.currentDebt)} />
        <MetricCard label="Monthly Rent" value={o ? fmtCompact(o.monthlyRent) : "—"} />
      </div>

      {/* ═══ INVESTMENT THESIS ═══ */}
      {details?.investmentThesis && (
        <div className="card" style={{ padding: "12px 16px", background: "rgba(196,165,116,0.04)", borderColor: "rgba(196,165,116,0.2)" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-accent)", fontWeight: 600, marginBottom: 6 }}>Investment Thesis</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.7 }}>{details.investmentThesis}</div>
        </div>
      )}

      {/* ═══ BEFORE & AFTER PHOTOS ═══ */}
      {(beforePhotos.length > 0 || afterPhotos.length > 0) && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Before & After</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* Before */}
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 6 }}>Before</div>
              {beforePhotos.length > 0 ? (
                <PhotoViewer photos={beforePhotos} idx={beforeIdx} setIdx={setBeforeIdx} label="Before" />
              ) : (
                <div style={{ aspectRatio: "4/3", background: "var(--color-surface-alt)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-muted)", fontSize: 11 }}>No photos</div>
              )}
            </div>
            {/* After */}
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 6 }}>After</div>
              {afterPhotos.length > 0 ? (
                <PhotoViewer photos={afterPhotos} idx={afterIdx} setIdx={setAfterIdx} label="After" />
              ) : (
                <div style={{ aspectRatio: "4/3", background: "var(--color-surface-alt)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-muted)", fontSize: 11 }}>Coming soon</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ 4-STEP INVESTMENT STORY ═══ */}
      {details && (
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 14 }}>Investment Story</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

            {/* Step 1: Acquisition */}
            <StoryStep number={1} title="Acquisition" subtitle="Entry Point" color="var(--color-accent)">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                <SmallMetric label="Purchase Price" value={fmtDollars(p.acquisitionPrice)} />
                <SmallMetric label="Rehab Budget" value={fmtDollars(p.rehabBudget)} />
                <SmallMetric label="Total Basis" value={fmtDollars(p.totalBasis)} highlight />
                <SmallMetric label="Price/Unit" value={fmtDollars(details.entryPerUnit)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
                <SmallMetric label="Bridge Loan" value={fmtDollars(details.bridgeLoan)} />
                <SmallMetric label="LTV" value={fmtPct(details.ltvPurchase)} />
                <SmallMetric label="Rate" value={fmtPct(details.interestRate)} />
                <SmallMetric label="Monthly P&I" value={fmtDollars(details.monthlyPI)} />
              </div>
            </StoryStep>

            {/* Step 2: Value Add */}
            <StoryStep number={2} title="Value Add" subtitle="Transformation" color="var(--color-accent-strong)">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <BeforeAfterMetric label="Monthly Rent" before={fmtDollars(details.inPlaceRent)} after={fmtDollars(details.proformaRent)} change={fmtPctChange(details.inPlaceRent, details.proformaRent)} />
                <BeforeAfterMetric label="Annual NOI" before={fmtDollars(details.inPlaceNOI)} after={fmtDollars(details.stabilizedNOI)} change={"+" + fmtDollars(details.noiUpside)} />
                <BeforeAfterMetric label="Property Value" before={fmtDollars(p.totalBasis)} after={fmtDollars(details.arvTotal)} change={"+" + fmtDollars(details.valueCreation)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
                <SmallMetric label="Occupied" value={`${o?.occupied || details.occupiedUnits}/${p.units}`} />
                <SmallMetric label="Occupancy" value={fmtPct(details.occupancyRate)} />
                <SmallMetric label="In-Place" value={fmtDollars(details.inPlaceRent) + "/mo"} />
                <SmallMetric label="Proforma" value={fmtDollars(details.proformaRent) + "/mo"} highlight />
              </div>
            </StoryStep>

            {/* Step 3: Refinance */}
            <StoryStep number={3} title="Refinance" subtitle="Harvest Equity" color="var(--color-success)">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SmallMetric label="New Loan" value={details.refiLoanAmount ? fmtDollars(details.refiLoanAmount) : "TBD"} />
                <SmallMetric label="Refi LTV" value={details.refiLTV ? fmtPct(details.refiLTV) : "TBD"} />
                <SmallMetric label="Cash-Out" value={fmtDollars(details.refiCashOut || details.cashOutAtRefi)} highlight />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
                <SmallMetric label="Equity After Refi" value={details.equityAfterRefi ? fmtDollars(details.equityAfterRefi) : "TBD"} />
                <SmallMetric label="New P&I" value={details.newMonthlyPI ? fmtDollars(details.newMonthlyPI) : "TBD"} />
                <SmallMetric label="DSCR" value={details.dscrStabilized.toFixed(2) + "x"} />
                <SmallMetric label="Target" value={"Month " + (details.refiMonth || details.refiTargetMonth)} />
              </div>
            </StoryStep>

            {/* Step 4: Exit */}
            <StoryStep number={4} title="Exit" subtitle="Realize Returns" color="var(--color-accent)" isLast highlight>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SmallMetric label="Exit Cap" value={fmtPct(details.exitCapRate)} />
                <SmallMetric label="Projected Sale" value={fmtDollars(details.projectedSalePrice || details.arvTotal)} />
                <SmallMetric label="Net Proceeds" value={fmtDollars(details.projectedNetProceeds || details.netCashFromSale)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(196,165,116,0.3)" }}>
                <div style={{ textAlign: "center", padding: 8, borderRadius: 6, background: "rgba(196,165,116,0.08)" }}>
                  <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-accent)", letterSpacing: "0.1em" }}>IRR</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-accent)", fontFamily: "var(--font-display)" }}>{details.irrLevered}</div>
                </div>
                <div style={{ textAlign: "center", padding: 8, borderRadius: 6, background: "rgba(196,165,116,0.08)" }}>
                  <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-accent)", letterSpacing: "0.1em" }}>MOIC</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-accent)", fontFamily: "var(--font-display)" }}>{details.moic.toFixed(2)}x</div>
                </div>
                <div style={{ textAlign: "center", padding: 8, borderRadius: 6, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)" }}>
                  <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-success)", letterSpacing: "0.1em" }}>Total Profit</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-success)", fontFamily: "var(--font-display)" }}>{fmtDollars(details.projectedTotalProfit || details.totalProfit)}</div>
                </div>
              </div>
              <div style={{ marginTop: 8, padding: "6px 0", textAlign: "center", fontSize: 11, color: "var(--color-accent)" }}>
                Hold Period: <strong>{details.holdPeriodMonths || 24} Months</strong>
              </div>
            </StoryStep>
          </div>
        </div>
      )}

      {/* ═══ ACTIVE REHAB BUDGET ═══ */}
      {r && r.status !== "complete" && r.status !== "not_started" && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Active Rehab — {r.project}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <MetricCard label="Budget" value={fmtCompact(r.budget)} small />
            <MetricCard label="Spent" value={fmtCompact(r.spent)} color={r.spent > r.budget ? "var(--color-danger)" : undefined} small />
            <MetricCard label="Remaining" value={fmtCompact(Math.max(r.budget - r.spent, 0))} small />
            <MetricCard label="Completion" value={r.completionPct + "%"} color={r.completionPct >= 80 ? "var(--color-success)" : "var(--color-accent)"} small />
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "var(--color-border)", marginBottom: 6 }}>
            <div style={{ height: "100%", borderRadius: 4, width: `${Math.min(r.completionPct, 100)}%`, background: "linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))", transition: "width 0.5s ease" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-muted)" }}>
            <span>Budget utilization: {r.budget > 0 ? ((r.spent / r.budget) * 100).toFixed(0) : 0}%</span>
            <span style={{ textTransform: "uppercase", color: r.status === "in_progress" ? "var(--color-accent)" : r.status === "blocked" ? "var(--color-danger)" : "var(--color-text-muted)" }}>{r.status.replace("_", " ")}</span>
            {r.targetDate && <span>Target: {r.targetDate}</span>}
          </div>
          {r.notes && <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-muted)" }}>{r.notes}</div>}
        </div>
      )}

      {/* ═══ DEBT & FINANCING ═══ */}
      {d && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Debt & Financing</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <MetricCard label="Loan Balance" value={fmtCompact(d.balance)} small />
            <MetricCard label="Interest Rate" value={d.interestRate + "%"} small />
            <MetricCard label="Days to Maturity" value={String(d.daysUntilMaturity)} color={urgencyColor(d.urgency)} small />
            <MetricCard label="Cash-Out (Refi)" value={fmtCompact(d.expectedProceeds || 0)} color="var(--color-accent)" small />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "4px 16px", fontSize: 12 }}>
            <DetailRow label="Lender" value={d.lender} />
            <DetailRow label="Maturity Date" value={d.maturityDate} />
            <DetailRow label="Refi Target" value={d.refiTarget || "TBD"} />
            <DetailRow label="LTV" value={p.currentValue ? ((d.balance / p.currentValue) * 100).toFixed(1) + "%" : "—"} />
          </div>
        </div>
      )}

      {/* ═══ RENT ROLL (EDITABLE) ═══ */}
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="label">Rent Roll — {units.length} Units</div>
          {o && (
            <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
              {o.occupied} occupied · {o.vacant} vacant · {fmtCompact(o.monthlyRent)}/mo
            </div>
          )}
        </div>

        {/* Rent Projection Cards (if details) */}
        {details && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            <div style={{ padding: 10, borderRadius: 6, background: "var(--color-surface-alt)", textAlign: "center" }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 2 }}>In-Place</div>
              <div style={{ fontSize: 16, fontWeight: 600 }} className="tabular-nums">{fmtDollars(details.inPlaceRent)}/mo</div>
            </div>
            <div style={{ padding: 10, borderRadius: 6, background: "var(--color-surface-alt)", textAlign: "center" }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 2 }}>Proforma</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-accent)" }} className="tabular-nums">{fmtDollars(details.proformaRent)}/mo</div>
            </div>
            <div style={{ padding: 10, borderRadius: 6, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", textAlign: "center" }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 2 }}>Upside</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-success)" }} className="tabular-nums">+{fmtDollars(details.rentUpside)}/mo</div>
            </div>
          </div>
        )}

        {loadingUnits ? (
          <div style={{ textAlign: "center", padding: 20, color: "var(--color-text-muted)", fontSize: 12 }}>Loading rent roll…</div>
        ) : units.length === 0 ? (
          <div style={{ textAlign: "center", padding: 20, color: "var(--color-text-muted)", fontSize: 12 }}>No unit data available</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Unit</th><th>Tenant</th><th>Rent</th><th>Bed/Bath</th><th>SqFt</th><th>Status</th><th>Notes</th><th style={{ width: 50 }} /></tr>
              </thead>
              <tbody>
                {units
                  .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
                  .map((u) => editingUnit === u.id ? (
                    <tr key={u.id} style={{ background: "rgba(196,165,116,0.04)" }}>
                      <td style={{ fontWeight: 500 }}>{u.unitNumber}</td>
                      <td><input className="inline-edit" style={{ width: "100%" }} value={unitDraft.tenantName || ""} onChange={e => setUnitDraft({ ...unitDraft, tenantName: e.target.value })} /></td>
                      <td><input className="inline-edit" type="number" style={{ width: 80 }} value={unitDraft.monthlyRent || ""} onChange={e => setUnitDraft({ ...unitDraft, monthlyRent: +e.target.value || null })} /></td>
                      <td className="tabular-nums">{u.bedrooms || "—"}/{u.bathrooms || "—"}</td>
                      <td className="tabular-nums">{u.sqft || "—"}</td>
                      <td>
                        <select className="select-inline" value={unitDraft.status || u.status} onChange={e => setUnitDraft({ ...unitDraft, status: e.target.value })}>
                          <option value="occupied">Occupied</option>
                          <option value="vacant">Vacant</option>
                          <option value="notice">Notice</option>
                          <option value="eviction">Eviction</option>
                          <option value="renovation">Renovation</option>
                        </select>
                      </td>
                      <td><input className="inline-edit" style={{ width: "100%" }} value={unitDraft.notes || ""} onChange={e => setUnitDraft({ ...unitDraft, notes: e.target.value })} /></td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button className="nav-btn" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => saveUnit(u.id, unitDraft)}>Save</button>
                          <button className="nav-btn" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setEditingUnit(null)}>×</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => { setEditingUnit(u.id); setUnitDraft({ tenantName: u.tenantName, monthlyRent: u.monthlyRent, status: u.status, notes: u.notes }); }}>
                      <td style={{ fontWeight: 500 }}>{u.unitNumber}</td>
                      <td>{u.tenantName || <span style={{ color: "var(--color-text-muted)" }}>—</span>}</td>
                      <td className="tabular-nums">{u.monthlyRent ? fmtDollars(Number(u.monthlyRent)) : "—"}</td>
                      <td className="tabular-nums">{u.bedrooms || "—"}/{u.bathrooms || "—"}</td>
                      <td className="tabular-nums">{u.sqft || "—"}</td>
                      <td>
                        <span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, background: u.status === "occupied" ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)", color: u.status === "occupied" ? "var(--color-success)" : "var(--color-danger)" }}>
                          {u.status}
                        </span>
                      </td>
                      <td style={{ fontSize: 11, color: u.notes?.includes("DELINQUENT") ? "var(--color-danger)" : "var(--color-text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {u.notes || "—"}
                      </td>
                      <td style={{ fontSize: 9, color: "var(--color-text-muted)" }}>edit</td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                  <td>Total</td>
                  <td>{units.filter(u => u.tenantName).length} tenants</td>
                  <td className="tabular-nums">{fmtDollars(units.reduce((s, u) => s + (Number(u.monthlyRent) || 0), 0))}</td>
                  <td colSpan={2} />
                  <td>{units.filter(u => u.status === "occupied").length}/{units.length}</td>
                  <td /><td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ═══ RISK METRICS ═══ */}
      {details && (
        <div className="card" style={{ padding: 14 }}>
          <div className="label" style={{ marginBottom: 10 }}>Risk Metrics</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
            <MetricCard label="Break-Even Occ" value={fmtPct(details.breakevenOccupancy)} color={details.breakevenOccupancy > 0.85 ? "var(--color-danger)" : "var(--color-success)"} small />
            <MetricCard label="DSCR Stabilized" value={details.dscrStabilized.toFixed(2) + "x"} color={details.dscrStabilized < 1.25 ? "var(--color-warning)" : "var(--color-success)"} small />
            <MetricCard label="Debt Yield" value={fmtPct(details.debtYield)} small />
            <MetricCard label="Cash-on-Cash" value={fmtPct(details.cashYieldStabilized)} small />
            <MetricCard label="Payback" value={details.paybackPeriod.toFixed(1) + " months"} small />
            <MetricCard label="Value Creation" value={fmtDollars(details.valueCreation)} color="var(--color-success)" small />
          </div>
        </div>
      )}

    </section>
  );
}

/* ══════════════════════════ SUB-COMPONENTS ══════════════════════════ */

function MetricCard({ label, value, color, small }: { label: string; value: string; color?: string; small?: boolean }) {
  return (
    <div style={{ padding: small ? "8px 10px" : "10px 12px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: small ? "1rem" : "1.2rem", fontWeight: 600, color: color || "var(--color-text)", fontFamily: "var(--font-display)" }} className="tabular-nums">{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--color-border)" }}>
      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: 500, fontSize: 12 }} className="tabular-nums">{value}</span>
    </div>
  );
}

function SmallMetric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: highlight ? 700 : 500, color: highlight ? "var(--color-accent)" : "var(--color-text)" }} className="tabular-nums">{value}</div>
    </div>
  );
}

function BeforeAfterMetric({ label, before, after, change }: { label: string; before: string; after: string; change: string }) {
  return (
    <div style={{ padding: "6px 8px", borderRadius: 6, background: "var(--color-surface-alt)" }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <span className="tabular-nums" style={{ color: "var(--color-text-muted)" }}>{before}</span>
        <span style={{ color: "var(--color-accent)", fontSize: 10 }}>→</span>
        <span className="tabular-nums" style={{ fontWeight: 600 }}>{after}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--color-success)", fontWeight: 600, marginTop: 2 }}>{change}</div>
    </div>
  );
}

function StoryStep({ number, title, subtitle, color, isLast, highlight, children }: {
  number: number; title: string; subtitle: string; color: string; isLast?: boolean; highlight?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 14 }}>
      {/* Vertical timeline indicator */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 28, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: highlight ? "var(--color-accent)" : `${color}22`, border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: highlight ? "white" : color }}>
          {number}
        </div>
        {!isLast && <div style={{ width: 2, flex: 1, background: "var(--color-border)", margin: "4px 0" }} />}
      </div>
      {/* Content */}
      <div style={{ flex: 1, paddingBottom: isLast ? 0 : 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{subtitle}</span>
        </div>
        <div style={{ padding: highlight ? 12 : 10, borderRadius: 8, background: highlight ? "rgba(196,165,116,0.04)" : "var(--color-surface-alt)", border: highlight ? "1px solid rgba(196,165,116,0.2)" : "1px solid var(--color-border)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function PhotoViewer({ photos, idx, setIdx, label }: { photos: string[]; idx: number; setIdx: (v: number) => void; label: string }) {
  return (
    <div>
      <div style={{ position: "relative", aspectRatio: "4/3", borderRadius: 8, overflow: "hidden", background: "var(--color-surface-alt)" }}>
        <img
          src={photos[idx]}
          alt={`${label} ${idx + 1}`}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        {photos.length > 1 && (
          <>
            <button onClick={() => setIdx(Math.max(0, idx - 1))} style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", background: "rgba(0,0,0,0.5)", color: "white", border: "none", borderRadius: "50%", width: 26, height: 26, cursor: "pointer", fontSize: 13 }}>‹</button>
            <button onClick={() => setIdx(Math.min(photos.length - 1, idx + 1))} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "rgba(0,0,0,0.5)", color: "white", border: "none", borderRadius: "50%", width: 26, height: 26, cursor: "pointer", fontSize: 13 }}>›</button>
          </>
        )}
      </div>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", textAlign: "center", marginTop: 4 }}>{idx + 1} / {photos.length}</div>
    </div>
  );
}

function phaseColor(p: string) {
  if (p === "rehab") return "var(--color-warning)";
  if (p === "lease_up") return "var(--color-accent-strong)";
  if (p === "stabilizing") return "var(--color-accent)";
  if (p === "stabilized") return "var(--color-success)";
  return "var(--color-text-muted)";
}

function urgencyColor(u: string) {
  if (u === "urgent") return "var(--color-danger)";
  if (u === "upcoming") return "var(--color-warning)";
  return "var(--color-success)";
}
