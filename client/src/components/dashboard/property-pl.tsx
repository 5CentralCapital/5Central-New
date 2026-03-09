import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties } from "./shared/property-subtabs";

// ─── Types ──────────────────────────────────────────────
interface PropertyMonthlyData {
  id: string; propertyId: string; month: string;
  actualRentCollected?: string; proformaRent?: string;
  vacancyCount?: number; occupiedCount?: number;
  operatingExpenses?: string; actualNOI?: string; proformaNOI?: string;
  debtServicePaid?: string; netCashflow?: string;
  distributionsPaid?: string; rehabSpend?: string;
  varianceNotes?: string; createdAt: string;
}
// ─── Helpers ────────────────────────────────────────────
function fmtMoney(v: number) {
  const abs = Math.abs(v);
  const formatted = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return v < 0 ? "-" + formatted : formatted;
}
function fmtCompact(v: number) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function varianceColor(actual: number, budget: number) {
  if (budget === 0) return "var(--color-text)";
  const pct = ((actual - budget) / Math.abs(budget)) * 100;
  if (pct > 5) return "#16A34A";
  if (pct < -5) return "#DC2626";
  return "#D97706";
}
function variancePct(actual: number, budget: number) {
  if (budget === 0) return "—";
  const pct = ((actual - budget) / Math.abs(budget)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
function monthLabel(m: string) {
  const [y, mo] = m.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(mo) - 1]} ${y}`;
}

function KPI({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel kpi" style={{ position: "relative", overflow: "hidden" }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div className="value" style={{
        color: color || "var(--color-text)",
        fontFamily: "'Cormorant Garamond', Georgia, serif",
        fontSize: "1.6rem", fontWeight: 600, fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.02em",
      }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{sub}</div>}
      <div style={{
        position: "absolute", bottom: 0, left: "12%", right: "12%", height: 2,
        background: "linear-gradient(90deg, transparent, var(--color-accent, #C4A574), transparent)",
        opacity: 0.3, borderRadius: 1,
      }} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 4, border: "1px solid var(--color-border, #E5E3DF)",
  background: "var(--color-surface, #fff)", fontSize: 13, color: "var(--color-text, #1A1A1A)",
};

// Local DB UUID -> RM property ID mapping for live rent overlay
const localToRmId: Record<string, string> = {
  "ea28fe29-c3e4-4ccd-a68d-a38dbd6b52fb": "30", // MLK
  "48385b5c-791a-455d-a358-5f1947b448e3": "31", // Hickory
  "ba502e16-e1ee-4925-baff-1b156ad37133": "32", // Sun Cove
  "4d7c6538-2f0d-42e2-8c40-6ec57b438a4a": "33", // Lucia
};

// ═════════════════════════════════════════════════════════
export default function PropertyPL() {
  const { properties, loading: propsLoading } = useProperties();
  const [selectedProp, setSelectedProp] = useState<string>("");
  const [monthlyData, setMonthlyData] = useState<PropertyMonthlyData[]>([]);
  const [allData, setAllData] = useState<PropertyMonthlyData[]>([]);
  const [view, setView] = useState<"summary" | "monthly" | "variance">("summary");
  const [showAddMonth, setShowAddMonth] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize selectedProp from first property once loaded
  useEffect(() => {
    if (properties.length > 0 && !selectedProp) setSelectedProp(properties[0].id);
  }, [properties]);

  // Fetch allData (portfolio-level) on mount
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await fetch("/api/monthly-data");
        if (!r.ok) throw new Error(`Monthly data fetch failed (${r.status})`);
        setAllData(await r.json());
      } catch (e: any) {
        setError(e.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Overlay RM live rent data on local monthly records
  const overlayRMRent = useCallback(async (localData: PropertyMonthlyData[], propId: string): Promise<PropertyMonthlyData[]> => {
    const rmId = localToRmId[propId];
    if (!rmId || localData.length === 0) return localData;
    try {
      // Determine date range from the local data months
      const months = localData.map(d => d.month).sort();
      const fromDate = months[0] + "-01";
      const lastMonth = months[months.length - 1];
      // End of last month
      const [y, m] = lastMonth.split("-").map(Number);
      const endDate = new Date(y, m, 0); // last day of month
      const toDate = endDate.toISOString().substring(0, 10);

      const res = await fetch(`/api/rm/monthly-rent?propertyId=${rmId}&fromDate=${fromDate}&toDate=${toDate}`, { credentials: "include" });
      if (!res.ok) return localData;
      const rmMonths: { month: string; totalCharges: number; totalPayments: number }[] = await res.json();
      if (rmMonths.length === 0) return localData;

      // Build lookup by month
      const rmByMonth = new Map<string, { charges: number; payments: number }>();
      for (const rm of rmMonths) {
        rmByMonth.set(rm.month, { charges: rm.totalCharges, payments: rm.totalPayments });
      }

      // Overlay: replace actualRentCollected with RM payment data where available
      return localData.map(d => {
        const rm = rmByMonth.get(d.month);
        if (!rm || rm.payments === 0) return d;
        const actualRent = rm.payments;
        const opex = Number(d.operatingExpenses || 0);
        const actualNOI = actualRent - opex;
        return {
          ...d,
          actualRentCollected: String(actualRent),
          actualNOI: String(actualNOI),
          netCashflow: String(actualNOI - Number(d.debtServicePaid || 0)),
        };
      });
    } catch {
      return localData;
    }
  }, []);

  const load = useCallback(async () => {
    if (!selectedProp || selectedProp === "all") return;
    try {
      setLoading(true);
      setError(null);
      const r = await fetch(`/api/monthly-data?propertyId=${selectedProp}`);
      if (!r.ok) throw new Error(`Monthly data fetch failed (${r.status})`);
      const localData: PropertyMonthlyData[] = await r.json();
      // Overlay RM live rent collected on local P&L data
      const overlaid = await overlayRMRent(localData, selectedProp);
      setMonthlyData(overlaid);
      // Also refresh portfolio-level allData so portfolio view stays current
      const rAll = await fetch("/api/monthly-data");
      if (!rAll.ok) throw new Error(`All data fetch failed (${rAll.status})`);
      setAllData(await rAll.json());
    } catch (e: any) {
      setError(e.message || "Failed to load monthly data");
      setMonthlyData([]);
    } finally {
      setLoading(false);
    }
  }, [selectedProp, overlayRMRent]);

  useEffect(() => { load(); }, [load]);

  // Sort by month
  const sorted = [...monthlyData].sort((a, b) => a.month.localeCompare(b.month));

  // ─── Property-level KPIs ─────────────────────────
  const totalActualRent = sorted.reduce((s, d) => s + Number(d.actualRentCollected || 0), 0);
  const totalProformaRent = sorted.reduce((s, d) => s + Number(d.proformaRent || 0), 0);
  const totalOpex = sorted.reduce((s, d) => s + Number(d.operatingExpenses || 0), 0);
  const totalActualNOI = sorted.reduce((s, d) => s + Number(d.actualNOI || 0), 0);
  const totalProformaNOI = sorted.reduce((s, d) => s + Number(d.proformaNOI || 0), 0);
  const totalDebtService = sorted.reduce((s, d) => s + Number(d.debtServicePaid || 0), 0);
  const totalCashflow = sorted.reduce((s, d) => s + Number(d.netCashflow || 0), 0);
  const totalRehabSpend = sorted.reduce((s, d) => s + Number(d.rehabSpend || 0), 0);
  const avgOccupancy = sorted.length > 0
    ? sorted.reduce((s, d) => {
        const total = (d.occupiedCount || 0) + (d.vacancyCount || 0);
        return s + (total > 0 ? (d.occupiedCount || 0) / total * 100 : 0);
      }, 0) / sorted.length
    : 0;

  // ─── Portfolio-level aggregation ─────────────────
  const portfolioByProp = properties.map(p => {
    const data = allData.filter(d => d.propertyId === p.id);
    return {
      property: p,
      actualRent: data.reduce((s, d) => s + Number(d.actualRentCollected || 0), 0),
      proformaRent: data.reduce((s, d) => s + Number(d.proformaRent || 0), 0),
      opex: data.reduce((s, d) => s + Number(d.operatingExpenses || 0), 0),
      actualNOI: data.reduce((s, d) => s + Number(d.actualNOI || 0), 0),
      proformaNOI: data.reduce((s, d) => s + Number(d.proformaNOI || 0), 0),
      debtService: data.reduce((s, d) => s + Number(d.debtServicePaid || 0), 0),
      cashflow: data.reduce((s, d) => s + Number(d.netCashflow || 0), 0),
      months: data.length,
    };
  });
  const portfolioTotals = {
    actualRent: portfolioByProp.reduce((s, p) => s + p.actualRent, 0),
    proformaRent: portfolioByProp.reduce((s, p) => s + p.proformaRent, 0),
    opex: portfolioByProp.reduce((s, p) => s + p.opex, 0),
    actualNOI: portfolioByProp.reduce((s, p) => s + p.actualNOI, 0),
    proformaNOI: portfolioByProp.reduce((s, p) => s + p.proformaNOI, 0),
    debtService: portfolioByProp.reduce((s, p) => s + p.debtService, 0),
    cashflow: portfolioByProp.reduce((s, p) => s + p.cashflow, 0),
  };

  async function addMonth(data: Record<string, string>) {
    try {
      setError(null);
      const r = await fetch("/api/monthly-data", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, propertyId: selectedProp }),
      });
      if (!r.ok) throw new Error(`Failed to add month (${r.status})`);
      setShowAddMonth(false);
      await load();  // load() now refreshes both monthlyData and allData
    } catch (e: any) {
      setError(e.message || "Failed to add monthly data");
    }
  }

  const propName = properties.find(p => p.id === selectedProp)?.name || "";

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Property selector */}
      <PropertySubTabs
        properties={properties}
        selected={selectedProp}
        onSelect={setSelectedProp}
        showAll
        allLabel="Portfolio Roll-Up"
      />
      {selectedProp && selectedProp !== "all" && (
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: -8 }}>{sorted.length} months of data</span>
      )}

      {/* KPI Strip — individual property */}
      {selectedProp && selectedProp !== "all" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <KPI label="Actual Rent" value={fmtCompact(totalActualRent)} sub={sorted.length > 0 ? `vs ${fmtCompact(totalProformaRent)} pro forma` : undefined} color={totalActualRent >= totalProformaRent ? "#16A34A" : "#DC2626"} />
        <KPI label="NOI (Actual)" value={fmtCompact(totalActualNOI)} sub={variancePct(totalActualNOI, totalProformaNOI) + " vs plan"} color={varianceColor(totalActualNOI, totalProformaNOI)} />
        <KPI label="Operating Expenses" value={fmtCompact(totalOpex)} />
        <KPI label="Debt Service" value={fmtCompact(totalDebtService)} />
        <KPI label="Net Cashflow" value={fmtCompact(totalCashflow)} color={totalCashflow >= 0 ? "#16A34A" : "#DC2626"} />
        <KPI label="Avg Occupancy" value={`${avgOccupancy.toFixed(1)}%`} color={avgOccupancy >= 90 ? "#16A34A" : avgOccupancy >= 75 ? "#D97706" : "#DC2626"} />
        <KPI label="Rehab Spend" value={fmtCompact(totalRehabSpend)} color="var(--color-accent, #C4A574)" />
      </div>}

      {/* NOI Variance Bar — visual inline chart */}
      {selectedProp && selectedProp !== "all" && sorted.length > 0 && (
        <div className="card" style={{ padding: "14px 16px" }}>
          <div className="label" style={{ marginBottom: 10 }}>NOI — Actual vs Pro Forma by Month</div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 80 }}>
            {sorted.map(d => {
              const actual = Number(d.actualNOI || 0);
              const proforma = Number(d.proformaNOI || 0);
              const maxVal = Math.max(...sorted.map(s => Math.max(Number(s.actualNOI || 0), Number(s.proformaNOI || 0))), 1);
              const actualH = Math.max(4, (actual / maxVal) * 60);
              const proformaH = Math.max(4, (proforma / maxVal) * 60);
              return (
                <div key={d.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 64 }}>
                    <div title={`Actual: ${fmtMoney(actual)}`} style={{
                      width: 10, height: actualH, borderRadius: "3px 3px 0 0",
                      background: actual >= proforma ? "#16A34A" : "#DC2626",
                      opacity: 0.8, transition: "height 0.4s ease",
                    }} />
                    <div title={`Pro Forma: ${fmtMoney(proforma)}`} style={{
                      width: 10, height: proformaH, borderRadius: "3px 3px 0 0",
                      background: "var(--color-border, #E5E3DF)",
                      transition: "height 0.4s ease",
                    }} />
                  </div>
                  <div style={{ fontSize: 8, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {d.month.split("-")[1]}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 8, justifyContent: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: "#16A34A", opacity: 0.8 }} />
              <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Actual NOI</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--color-border, #E5E3DF)" }} />
              <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Pro Forma NOI</span>
            </div>
          </div>
        </div>
      )}

      {/* Sub-nav — only shown for individual properties */}
      {selectedProp && selectedProp !== "all" && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(["summary", "monthly", "variance"] as const).map(v => (
              <button key={v} className={`nav-btn ${view === v ? "active" : ""}`}
                onClick={() => setView(v)} style={{ fontSize: 11 }}>
                {v === "summary" ? `${propName} P&L` : v === "monthly" ? "Monthly Detail" : "Variance Analysis"}
              </button>
            ))}
          </div>
          <button className="nav-btn active" onClick={() => setShowAddMonth(true)} style={{ fontSize: 11 }}>+ Add Month</button>
        </div>
      )}

      {/* ═══════ SUMMARY P&L ═════════════════════ */}
      {selectedProp !== "all" && view === "summary" && (
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600 }}>
              {propName} — Year-to-Date P&L
            </h3>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              {sorted.length > 0 ? `${monthLabel(sorted[0].month)} – ${monthLabel(sorted[sorted.length - 1].month)}` : "No data"}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Line Item</th>
                <th style={{ textAlign: "right" }}>Actual (YTD)</th>
                <th style={{ textAlign: "right" }}>Pro Forma (YTD)</th>
                <th style={{ textAlign: "right" }}>Variance $</th>
                <th style={{ textAlign: "right" }}>Variance %</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: "Gross Rent", actual: totalActualRent, proforma: totalProformaRent, bold: false },
                { label: "Operating Expenses", actual: totalOpex, proforma: 0, bold: false },
                { label: "Net Operating Income", actual: totalActualNOI, proforma: totalProformaNOI, bold: true },
                { label: "Debt Service", actual: totalDebtService, proforma: 0, bold: false },
                { label: "Net Cashflow", actual: totalCashflow, proforma: 0, bold: true },
                { label: "Rehab Capex", actual: totalRehabSpend, proforma: 0, bold: false },
                { label: "Distributions Paid", actual: sorted.reduce((s, d) => s + Number(d.distributionsPaid || 0), 0), proforma: 0, bold: false },
              ].map(row => (
                <tr key={row.label} style={{ fontWeight: row.bold ? 600 : 400 }}>
                  <td style={{
                    paddingLeft: 16,
                    fontWeight: row.bold ? 600 : 400,
                    borderTop: row.bold ? "2px solid var(--color-border, #E5E3DF)" : undefined,
                    fontFamily: row.bold ? "'Cormorant Garamond', Georgia, serif" : undefined,
                    fontSize: row.bold ? 14 : 13,
                  }}>{row.label}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums",
                    borderTop: row.bold ? "2px solid var(--color-border)" : undefined,
                    fontWeight: row.bold ? 700 : 400,
                    fontFamily: row.bold ? "'Cormorant Garamond', Georgia, serif" : undefined,
                  }}>{fmtMoney(row.actual)}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums",
                    color: row.proforma > 0 ? "var(--color-text)" : "var(--color-text-muted)",
                    borderTop: row.bold ? "2px solid var(--color-border)" : undefined,
                  }}>{row.proforma > 0 ? fmtMoney(row.proforma) : "—"}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums",
                    color: row.proforma > 0 ? varianceColor(row.actual, row.proforma) : "var(--color-text-muted)",
                    borderTop: row.bold ? "2px solid var(--color-border)" : undefined,
                    fontWeight: row.bold ? 600 : 400,
                  }}>{row.proforma > 0 ? fmtMoney(row.actual - row.proforma) : "—"}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums",
                    color: row.proforma > 0 ? varianceColor(row.actual, row.proforma) : "var(--color-text-muted)",
                    borderTop: row.bold ? "2px solid var(--color-border)" : undefined,
                    fontWeight: row.bold ? 600 : 400,
                  }}>{row.proforma > 0 ? variancePct(row.actual, row.proforma) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ MONTHLY DETAIL ══════════════════ */}
      {selectedProp !== "all" && view === "monthly" && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16, position: "sticky", left: 0, background: "var(--color-surface, #fff)", zIndex: 1 }}>Month</th>
                <th style={{ textAlign: "right" }}>Rent</th>
                <th style={{ textAlign: "right" }}>Pro Forma</th>
                <th style={{ textAlign: "right" }}>OpEx</th>
                <th style={{ textAlign: "right" }}>NOI</th>
                <th style={{ textAlign: "right" }}>Debt Svc</th>
                <th style={{ textAlign: "right" }}>Cashflow</th>
                <th style={{ textAlign: "center" }}>Occ</th>
                <th style={{ textAlign: "right" }}>Rehab</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>No monthly data for {propName}</td></tr>
              ) : sorted.map(d => {
                const occ = (d.occupiedCount || 0) + (d.vacancyCount || 0);
                const occPct = occ > 0 ? ((d.occupiedCount || 0) / occ * 100) : 0;
                return (
                  <tr key={d.id}>
                    <td style={{
                      paddingLeft: 16, fontWeight: 600, fontSize: 12,
                      position: "sticky", left: 0, background: "var(--color-surface, #fff)", zIndex: 1,
                    }}>{monthLabel(d.month)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(Number(d.actualRentCollected || 0))}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-muted)" }}>{fmtMoney(Number(d.proformaRent || 0))}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#DC2626" }}>{fmtMoney(Number(d.operatingExpenses || 0))}</td>
                    <td style={{
                      textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600,
                      color: varianceColor(Number(d.actualNOI || 0), Number(d.proformaNOI || 0)),
                    }}>{fmtMoney(Number(d.actualNOI || 0))}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(Number(d.debtServicePaid || 0))}</td>
                    <td style={{
                      textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600,
                      color: Number(d.netCashflow || 0) >= 0 ? "#16A34A" : "#DC2626",
                      fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 14,
                    }}>{fmtMoney(Number(d.netCashflow || 0))}</td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: occPct >= 90 ? "#16A34A" : occPct >= 75 ? "#D97706" : "#DC2626",
                      }}>{occPct.toFixed(0)}%</span>
                      <span style={{ fontSize: 9, color: "var(--color-text-muted)", marginLeft: 3 }}>
                        ({d.occupiedCount || 0}/{occ})
                      </span>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-accent, #C4A574)" }}>
                      {Number(d.rehabSpend || 0) > 0 ? fmtMoney(Number(d.rehabSpend)) : "—"}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--color-text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.varianceNotes || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--color-border, #E5E3DF)", fontWeight: 700 }}>
                  <td style={{ paddingLeft: 16, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", position: "sticky", left: 0, background: "var(--color-surface, #fff)" }}>Totals</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(totalActualRent)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-muted)" }}>{fmtMoney(totalProformaRent)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#DC2626" }}>{fmtMoney(totalOpex)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 14 }}>{fmtMoney(totalActualNOI)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(totalDebtService)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 14, color: totalCashflow >= 0 ? "#16A34A" : "#DC2626" }}>{fmtMoney(totalCashflow)}</td>
                  <td style={{ textAlign: "center", fontSize: 11, color: "var(--color-text-muted)" }}>{avgOccupancy.toFixed(0)}% avg</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-accent, #C4A574)" }}>{fmtMoney(totalRehabSpend)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* ═══════ VARIANCE ANALYSIS ═══════════════ */}
      {selectedProp !== "all" && view === "variance" && (
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ margin: "0 0 16px", fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 18, fontWeight: 600 }}>
            Variance Analysis — {propName}
          </h3>
          {sorted.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 32 }}>No data to analyze</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {sorted.map(d => {
                const actualRent = Number(d.actualRentCollected || 0);
                const proformaRent = Number(d.proformaRent || 0);
                const actualNOI = Number(d.actualNOI || 0);
                const proformaNOI = Number(d.proformaNOI || 0);
                const rentVar = proformaRent > 0 ? actualRent - proformaRent : 0;
                const noiVar = proformaNOI > 0 ? actualNOI - proformaNOI : 0;
                return (
                  <div key={d.id} style={{
                    padding: "14px 16px", borderRadius: 8,
                    background: "var(--color-surface-alt, #F5F4F1)",
                    border: "1px solid var(--color-border, #E5E3DF)",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>
                        {monthLabel(d.month)}
                      </span>
                      <div style={{ display: "flex", gap: 12 }}>
                        <span style={{ fontSize: 11 }}>
                          Rent: <strong style={{ color: varianceColor(actualRent, proformaRent) }}>{rentVar >= 0 ? "+" : ""}{fmtMoney(rentVar)}</strong>
                        </span>
                        <span style={{ fontSize: 11 }}>
                          NOI: <strong style={{ color: varianceColor(actualNOI, proformaNOI) }}>{noiVar >= 0 ? "+" : ""}{fmtMoney(noiVar)}</strong>
                        </span>
                      </div>
                    </div>
                    {/* Rent variance bar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: "var(--color-text-muted)", width: 50, textAlign: "right" }}>Rent</span>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--color-border, #E5E3DF)", position: "relative", overflow: "hidden" }}>
                        {proformaRent > 0 && (
                          <div style={{
                            position: "absolute", left: 0, top: 0, height: "100%",
                            width: `${Math.min(100, (actualRent / proformaRent) * 100)}%`,
                            borderRadius: 4,
                            background: actualRent >= proformaRent ? "#16A34A" : "#DC2626",
                            opacity: 0.7, transition: "width 0.4s ease",
                          }} />
                        )}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 600, color: varianceColor(actualRent, proformaRent), width: 50 }}>
                        {proformaRent > 0 ? variancePct(actualRent, proformaRent) : "—"}
                      </span>
                    </div>
                    {/* NOI variance bar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 10, color: "var(--color-text-muted)", width: 50, textAlign: "right" }}>NOI</span>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--color-border, #E5E3DF)", position: "relative", overflow: "hidden" }}>
                        {proformaNOI > 0 && (
                          <div style={{
                            position: "absolute", left: 0, top: 0, height: "100%",
                            width: `${Math.min(100, (actualNOI / proformaNOI) * 100)}%`,
                            borderRadius: 4,
                            background: actualNOI >= proformaNOI ? "#16A34A" : "#DC2626",
                            opacity: 0.7, transition: "width 0.4s ease",
                          }} />
                        )}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 600, color: varianceColor(actualNOI, proformaNOI), width: 50 }}>
                        {proformaNOI > 0 ? variancePct(actualNOI, proformaNOI) : "—"}
                      </span>
                    </div>
                    {d.varianceNotes && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-muted)", fontStyle: "italic" }}>
                        {d.varianceNotes}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════ PORTFOLIO ROLL-UP ═══════════════ */}
      {selectedProp === "all" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{
            padding: "14px 16px", borderBottom: "1px solid var(--color-border, #E5E3DF)",
            background: "var(--color-surface-alt, #F5F4F1)",
          }}>
            <h3 style={{ margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 18, fontWeight: 600 }}>
              Portfolio P&L Roll-Up
            </h3>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Property</th>
                <th style={{ textAlign: "right" }}>Actual Rent</th>
                <th style={{ textAlign: "right" }}>Pro Forma</th>
                <th style={{ textAlign: "right" }}>OpEx</th>
                <th style={{ textAlign: "right" }}>NOI</th>
                <th style={{ textAlign: "right" }}>Debt Service</th>
                <th style={{ textAlign: "right" }}>Net Cashflow</th>
                <th style={{ textAlign: "right" }}>NOI Variance</th>
              </tr>
            </thead>
            <tbody>
              {portfolioByProp.map(p => (
                <tr key={p.property.id} style={{ cursor: "pointer" }} onClick={() => { setSelectedProp(p.property.id); setView("summary"); }}>
                  <td style={{ paddingLeft: 16, fontWeight: 500 }}>
                    {p.property.name}
                    <span style={{ fontSize: 10, color: "var(--color-text-muted)", marginLeft: 6 }}>{p.property.units} units</span>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(p.actualRent)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-muted)" }}>{fmtMoney(p.proformaRent)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(p.opex)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{fmtMoney(p.actualNOI)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(p.debtService)}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600,
                    color: p.cashflow >= 0 ? "#16A34A" : "#DC2626",
                    fontFamily: "'Cormorant Garamond', Georgia, serif",
                  }}>{fmtMoney(p.cashflow)}</td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600,
                    color: p.proformaNOI > 0 ? varianceColor(p.actualNOI, p.proformaNOI) : "var(--color-text-muted)",
                  }}>{p.proformaNOI > 0 ? variancePct(p.actualNOI, p.proformaNOI) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid var(--color-border, #E5E3DF)" }}>
                <td style={{ paddingLeft: 16, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)" }}>
                  Portfolio Total
                </td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmtMoney(portfolioTotals.actualRent)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-muted)", fontWeight: 700 }}>{fmtMoney(portfolioTotals.proformaRent)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmtMoney(portfolioTotals.opex)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 15 }}>{fmtMoney(portfolioTotals.actualNOI)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmtMoney(portfolioTotals.debtService)}</td>
                <td style={{
                  textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700,
                  fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 15,
                  color: portfolioTotals.cashflow >= 0 ? "#16A34A" : "#DC2626",
                }}>{fmtMoney(portfolioTotals.cashflow)}</td>
                <td style={{
                  textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700,
                  color: portfolioTotals.proformaNOI > 0 ? varianceColor(portfolioTotals.actualNOI, portfolioTotals.proformaNOI) : "var(--color-text-muted)",
                }}>{portfolioTotals.proformaNOI > 0 ? variancePct(portfolioTotals.actualNOI, portfolioTotals.proformaNOI) : "—"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ═══════ ADD MONTH MODAL ═════════════════ */}
      {showAddMonth && (
        <div onClick={() => setShowAddMonth(false)} style={{
          position: "fixed", inset: 0, background: "rgba(26,26,26,0.35)",
          backdropFilter: "blur(4px)", display: "flex", alignItems: "center",
          justifyContent: "center", zIndex: 1000,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "var(--color-surface, #fff)", borderRadius: 10, padding: 28, width: 560,
            maxHeight: "85vh", overflow: "auto",
            boxShadow: "0 24px 80px rgba(26,26,26,0.15)",
            border: "1px solid var(--color-border, #E5E3DF)",
          }}>
            <h3 style={{ margin: "0 0 4px", fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 22, fontWeight: 600 }}>
              Add Monthly Data — {propName}
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--color-text-muted)" }}>Enter actual and pro forma numbers for a month</p>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); addMonth(Object.fromEntries(fd) as Record<string, string>); }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Month</span>
                  <input name="month" type="month" required style={inputStyle} defaultValue={new Date().toISOString().slice(0, 7)} />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Actual Rent</span>
                    <input name="actualRentCollected" type="number" step="0.01" style={inputStyle} placeholder="0.00" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pro Forma Rent</span>
                    <input name="proformaRent" type="number" step="0.01" style={inputStyle} placeholder="0.00" />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Occupied Units</span>
                    <input name="occupiedCount" type="number" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Vacant Units</span>
                    <input name="vacancyCount" type="number" style={inputStyle} />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Operating Expenses</span>
                    <input name="operatingExpenses" type="number" step="0.01" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Debt Service</span>
                    <input name="debtServicePaid" type="number" step="0.01" style={inputStyle} />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Actual NOI</span>
                    <input name="actualNOI" type="number" step="0.01" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pro Forma NOI</span>
                    <input name="proformaNOI" type="number" step="0.01" style={inputStyle} />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Net Cashflow</span>
                    <input name="netCashflow" type="number" step="0.01" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Rehab Spend</span>
                    <input name="rehabSpend" type="number" step="0.01" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Distributions</span>
                    <input name="distributionsPaid" type="number" step="0.01" style={inputStyle} />
                  </label>
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Variance Notes</span>
                  <textarea name="varianceNotes" rows={2} style={{ ...inputStyle, resize: "vertical" }} placeholder="Explain any significant variances..." />
                </label>
                <div style={{ height: 1, background: "var(--color-border, #E5E3DF)", margin: "2px 0" }} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setShowAddMonth(false)} className="nav-btn" style={{ fontSize: 12, padding: "8px 18px" }}>Cancel</button>
                  <button type="submit" className="nav-btn active" style={{ fontSize: 12, padding: "8px 18px" }}>Add Month</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}