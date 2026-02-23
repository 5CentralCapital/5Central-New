import { useState, useEffect, useMemo } from "react";

/* ══════════════════════════════════════════════════════════════
   Investor Overview — 5Central Capital
   Full investor debt summary connected to the database.
   Shows: Portfolio Summary, Deal-Specific Loans by property,
   General/Blanket Loans, Grand Totals.
   ══════════════════════════════════════════════════════════════ */

interface Investment {
  id: string;
  investorId: string;
  propertyName: string;
  propertyAddress?: string | null;
  principal: string;
  balloonAmount?: string | null;
  monthlyPayment?: string | null;
  returnMultiple?: string | null;
  interestRate?: string | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  term?: string | null;
  status: string;
  investmentType: string;
  notes?: string | null;
  equityPercentage?: string | null;
  initialInvestment?: string | null;
  currentEquityValue?: string | null;
  cashOutAtRefi?: string | null;
  projectedExitValue?: string | null;
  equityMultiple?: string | null;
}

interface InvestorProfile {
  id: string;
  userId: string;
  accreditedStatus: string;
  investedAmount: string;
  phone?: string | null;
  investorType: string;
  companyEquityPercentage?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  investments: Investment[];
}

const fmt = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDec = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => (n * 100).toFixed(2) + "%";
const num = (v: string | null | undefined) => parseFloat(v || "0") || 0;
const shortDate = (v: string | null | undefined) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
};

export default function InvestorOverview() {
  const [profiles, setProfiles] = useState<InvestorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedInvestor, setExpandedInvestor] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/investors", { credentials: "include" })
      .then(r => { if (!r.ok) throw new Error("Failed to fetch"); return r.json(); })
      .then(data => {
        if (Array.isArray(data)) setProfiles(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  /* ── Computed data ── */
  const allInvestments = useMemo(() => (profiles || []).flatMap(p => (p.investments || []).map(inv => ({ ...inv, investorName: `${p.firstName} ${p.lastName}` }))), [profiles]);

  const dealSpecific = useMemo(() => allInvestments.filter(i => i.investmentType === "deal-specific"), [allInvestments]);
  const generalLoans = useMemo(() => allInvestments.filter(i => i.investmentType === "general"), [allInvestments]);
  const equityInvestments = useMemo(() => allInvestments.filter(i => i.investmentType === "equity"), [allInvestments]);

  // Group deal-specific by property
  const dealsByProperty = useMemo(() => {
    const map = new Map<string, typeof dealSpecific>();
    dealSpecific.forEach(inv => {
      const key = inv.propertyName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(inv);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [dealSpecific]);

  // Portfolio summary
  const totalDealPrincipal = dealSpecific.reduce((s, i) => s + num(i.principal), 0);
  const totalDealBalloon = dealSpecific.reduce((s, i) => s + num(i.balloonAmount), 0);
  const totalGeneralPrincipal = generalLoans.reduce((s, i) => s + num(i.principal), 0);
  const totalGeneralMonthly = generalLoans.reduce((s, i) => s + num(i.monthlyPayment), 0);
  const totalDealMonthly = dealSpecific.reduce((s, i) => s + num(i.monthlyPayment), 0);
  const totalAllMonthly = totalGeneralMonthly + totalDealMonthly;
  const totalPrincipal = totalDealPrincipal + totalGeneralPrincipal;
  const totalBalloon = totalDealBalloon;

  if (loading) return <div style={{ textAlign: "center", padding: 60, color: "var(--color-text-muted)" }}>Loading investor data…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ═══ HEADER ═══ */}
      <div className="card" style={{ padding: "18px 20px", background: "linear-gradient(135deg, rgba(196,165,116,0.06) 0%, rgba(196,165,116,0.01) 100%)", borderColor: "rgba(196,165,116,0.25)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "1.6rem", fontWeight: 700, color: "var(--color-accent)", letterSpacing: "-0.02em" }}>
          5Central Capital — Investor Overview
        </div>
        <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>
          Private Lender & Investor Debt Summary · {profiles.length} investors · {allInvestments.length} loans
        </div>
      </div>

      {/* ═══ PORTFOLIO SUMMARY ═══ */}
      <div className="card" style={{ padding: 16 }}>
        <div className="label" style={{ marginBottom: 12 }}>Portfolio Summary</div>
        <table>
          <thead>
            <tr><th>Category</th><th>Total Principal</th><th>Total Balloon / Payoff</th><th># of Loans</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 500, fontSize: 11 }}>Deal-Specific Loans</td>
              <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(totalDealPrincipal)}</td>
              <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(totalDealBalloon)}</td>
              <td className="tabular-nums" style={{ fontSize: 11 }}>{dealSpecific.length}</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 500, fontSize: 11 }}>General / Blanket Loans</td>
              <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(totalGeneralPrincipal)}</td>
              <td className="tabular-nums" style={{ fontSize: 11, color: "var(--color-text-muted)" }}>N/A (Monthly)</td>
              <td className="tabular-nums" style={{ fontSize: 11 }}>{generalLoans.length}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: "2px solid var(--color-border)" }}>
              <td>TOTAL</td>
              <td className="tabular-nums">{fmt(totalPrincipal)}</td>
              <td className="tabular-nums">{fmt(totalBalloon)}</td>
              <td className="tabular-nums">{dealSpecific.length + generalLoans.length}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ═══ DEAL-SPECIFIC LOANS BY PROPERTY ═══ */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 4 }}>Deal-Specific Investor Loans</div>
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 14 }}>Loans tied to specific property acquisitions — repaid at refinance or sale</div>

        {dealsByProperty.map(([propertyName, invs]) => {
          const address = invs[0]?.propertyAddress || "";
          const propPrincipal = invs.reduce((s, i) => s + num(i.principal), 0);
          const propBalloon = invs.reduce((s, i) => s + num(i.balloonAmount), 0);
          const propMonthly = invs.reduce((s, i) => s + num(i.monthlyPayment), 0);
          const invsWithReturn = invs.filter(i => num(i.returnMultiple) > 0);
          const avgReturn = invsWithReturn.length > 0 ? invsWithReturn.reduce((s, i) => s + num(i.returnMultiple), 0) / invsWithReturn.length : 0;

          return (
            <div key={propertyName} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                  {propertyName}
                </div>
                {address && <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{address}</div>}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Investor</th>
                    <th>Principal</th>
                    <th>Balloon / Monthly</th>
                    <th>Return</th>
                    <th>Effective Date</th>
                    <th>Term</th>
                    <th>Status</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {invs.map(i => (
                    <tr key={i.id}>
                      <td style={{ fontWeight: 500, fontSize: 11 }}>{i.investorName}</td>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(num(i.principal))}</td>
                      <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>
                        {num(i.balloonAmount) > 0 ? fmt(num(i.balloonAmount)) : num(i.monthlyPayment) > 0 ? fmtDec(num(i.monthlyPayment)) + "/mo" : "—"}
                      </td>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>
                        {num(i.returnMultiple) > 0 ? num(i.returnMultiple).toFixed(1) + "x" : "—"}
                      </td>
                      <td className="tabular-nums" style={{ fontSize: 11 }}>{shortDate(i.effectiveDate)}</td>
                      <td style={{ fontSize: 11 }}>{i.term || "—"}</td>
                      <td>
                        <span style={{
                          fontSize: 9, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4,
                          background: i.status === "active" ? "rgba(196,165,116,0.1)" : "rgba(16,185,129,0.1)",
                          color: i.status === "active" ? "var(--color-accent)" : "var(--color-success)",
                        }}>{i.status}</span>
                      </td>
                      <td style={{ fontSize: 10, color: "var(--color-text-muted)", maxWidth: 140 }}>{i.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                    <td>Subtotal — {propertyName.split(" ")[0]}</td>
                    <td className="tabular-nums">{fmt(propPrincipal)}</td>
                    <td className="tabular-nums">
                      {propBalloon > 0 ? fmt(propBalloon) : propMonthly > 0 ? fmtDec(propMonthly) + "/mo" : "—"}
                    </td>
                    <td className="tabular-nums">{avgReturn > 0 ? avgReturn.toFixed(1) + "x" : "—"}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        })}
      </div>

      {/* ═══ GENERAL / BLANKET LOANS ═══ */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 4 }}>General / Blanket Loans to 5Central Capital</div>
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 14 }}>Loans for general corporate purposes — not tied to specific properties</div>
        <table>
          <thead>
            <tr>
              <th>Investor</th>
              <th>Principal</th>
              <th>Monthly Pmt</th>
              <th>Interest Rate</th>
              <th>Effective Date</th>
              <th>Maturity</th>
              <th>Term</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {generalLoans.map(i => (
              <tr key={i.id}>
                <td style={{ fontWeight: 500, fontSize: 11 }}>{i.investorName}</td>
                <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(num(i.principal))}</td>
                <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>{num(i.monthlyPayment) > 0 ? fmtDec(num(i.monthlyPayment)) : "—"}</td>
                <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.interestRate) > 0 ? pct(num(i.interestRate)) : "—"}</td>
                <td className="tabular-nums" style={{ fontSize: 11 }}>{shortDate(i.effectiveDate)}</td>
                <td className="tabular-nums" style={{ fontSize: 11 }}>{shortDate(i.maturityDate)}</td>
                <td style={{ fontSize: 11 }}>{i.term || "—"}</td>
                <td>
                  <span style={{
                    fontSize: 9, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4,
                    background: i.status === "active" ? "rgba(196,165,116,0.1)" : "rgba(16,185,129,0.1)",
                    color: i.status === "active" ? "var(--color-accent)" : "var(--color-success)",
                  }}>{i.status}</span>
                </td>
              </tr>
            ))}
            {generalLoans.map(i => i.notes ? (
              <tr key={i.id + "-notes"}>
                <td colSpan={8} style={{ fontSize: 10, color: "var(--color-text-muted)", paddingTop: 0, paddingBottom: 6, borderTop: "none" }}>
                  Notes: {i.notes}
                </td>
              </tr>
            ) : null)}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: "2px solid var(--color-border)" }}>
              <td>TOTAL GENERAL LOANS</td>
              <td className="tabular-nums">{fmt(totalGeneralPrincipal)}</td>
              <td className="tabular-nums">{fmtDec(totalGeneralMonthly)}</td>
              <td colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ═══ EQUITY INVESTMENTS ═══ */}
      {equityInvestments.length > 0 && (
        <div className="card" style={{ padding: "14px 16px" }}>
          <div className="label" style={{ marginBottom: 4 }}>Equity Investments</div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 14 }}>Equity ownership stakes in properties</div>
          <table>
            <thead>
              <tr>
                <th>Investor</th>
                <th>Property</th>
                <th>Equity %</th>
                <th>Initial Investment</th>
                <th>Current Equity Value</th>
                <th>Cash-Out at Refi</th>
                <th>Projected Exit</th>
                <th>Equity Multiple</th>
              </tr>
            </thead>
            <tbody>
              {equityInvestments.map(i => (
                <tr key={i.id}>
                  <td style={{ fontWeight: 500, fontSize: 11 }}>{i.investorName}</td>
                  <td style={{ fontSize: 11 }}>{i.propertyName}</td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.equityPercentage) > 0 ? pct(num(i.equityPercentage)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.initialInvestment) > 0 ? fmt(num(i.initialInvestment)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600, color: "var(--color-accent)" }}>{num(i.currentEquityValue) > 0 ? fmt(num(i.currentEquityValue)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.cashOutAtRefi) > 0 ? fmt(num(i.cashOutAtRefi)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.projectedExitValue) > 0 ? fmt(num(i.projectedExitValue)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>{num(i.equityMultiple) > 0 ? num(i.equityMultiple).toFixed(2) + "x" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ GRAND TOTAL ═══ */}
      <div className="card" style={{ padding: 16, background: "linear-gradient(135deg, rgba(196,165,116,0.06) 0%, rgba(196,165,116,0.01) 100%)", borderColor: "rgba(196,165,116,0.25)" }}>
        <div className="label" style={{ marginBottom: 12 }}>Grand Total — All Investor Debt</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)", textAlign: "center" }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>Total Principal Outstanding</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--color-accent)" }} className="tabular-nums">{fmt(totalPrincipal)}</div>
          </div>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)", textAlign: "center" }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>Total Balloon / Payoff Obligations</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-display)" }} className="tabular-nums">{fmt(totalBalloon)}</div>
          </div>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)", textAlign: "center" }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>Monthly Payment Obligations</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-display)" }} className="tabular-nums">{fmtDec(totalAllMonthly)}<span style={{ fontSize: 12, fontWeight: 400 }}>/month</span></div>
          </div>
        </div>
      </div>

      {/* ═══ INVESTOR PROFILES (expandable) ═══ */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 12 }}>Investor Profiles</div>
        {profiles.filter(p => p.investments.length > 0 || p.investorType === "company-partner").map(p => {
          const isExpanded = expandedInvestor === p.id;
          const totalInvested = p.investments.reduce((s, i) => s + num(i.principal) + num(i.initialInvestment), 0);
          const totalBalloon = p.investments.reduce((s, i) => s + num(i.balloonAmount), 0);
          const totalMonthly = p.investments.reduce((s, i) => s + num(i.monthlyPayment), 0);
          const propertyCount = new Set(p.investments.map(i => i.propertyName)).size;

          return (
            <div key={p.id} style={{ marginBottom: 6 }}>
              <div
                onClick={() => setExpandedInvestor(isExpanded ? null : p.id)}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                  background: isExpanded ? "rgba(196,165,116,0.06)" : "var(--color-surface-alt)",
                  border: `1px solid ${isExpanded ? "rgba(196,165,116,0.2)" : "var(--color-border)"}`,
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--color-accent)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                    {p.firstName[0]}{p.lastName[0]}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{p.firstName} {p.lastName}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                      {p.investorType === "company-partner" ? "Company Partner" : `${p.investments.length} loan${p.investments.length !== 1 ? "s" : ""} · ${propertyCount} propert${propertyCount !== 1 ? "ies" : "y"}`}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  {totalInvested > 0 && (
                    <div style={{ textAlign: "right" }}>
                      <div className="tabular-nums" style={{ fontSize: 12, fontWeight: 600 }}>{fmt(totalInvested)}</div>
                      <div style={{ fontSize: 9, color: "var(--color-text-muted)" }}>principal</div>
                    </div>
                  )}
                  {totalMonthly > 0 && (
                    <div style={{ textAlign: "right" }}>
                      <div className="tabular-nums" style={{ fontSize: 12, fontWeight: 600, color: "var(--color-accent)" }}>{fmtDec(totalMonthly)}</div>
                      <div style={{ fontSize: 9, color: "var(--color-text-muted)" }}>monthly</div>
                    </div>
                  )}
                  {totalBalloon > 0 && (
                    <div style={{ textAlign: "right" }}>
                      <div className="tabular-nums" style={{ fontSize: 12, fontWeight: 600 }}>{fmt(totalBalloon)}</div>
                      <div style={{ fontSize: 9, color: "var(--color-text-muted)" }}>balloon</div>
                    </div>
                  )}
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{isExpanded ? "▴" : "▾"}</span>
                </div>
              </div>

              {isExpanded && (
                <div style={{ padding: "12px 14px", marginTop: 4, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)" }}>
                  {/* Contact info */}
                  <div style={{ display: "flex", gap: 20, marginBottom: 12, fontSize: 11 }}>
                    <div><span style={{ color: "var(--color-text-muted)" }}>Email:</span> {p.email}</div>
                    {p.phone && <div><span style={{ color: "var(--color-text-muted)" }}>Phone:</span> {p.phone}</div>}
                    <div><span style={{ color: "var(--color-text-muted)" }}>Type:</span> {p.investorType === "company-partner" ? "Company Partner" : "Deal Investor"}</div>
                    {p.companyEquityPercentage && num(p.companyEquityPercentage) > 0 && (
                      <div><span style={{ color: "var(--color-text-muted)" }}>Equity:</span> {pct(num(p.companyEquityPercentage))}</div>
                    )}
                  </div>

                  {/* Investments table */}
                  {p.investments.length > 0 ? (
                    <table>
                      <thead>
                        <tr><th>Property</th><th>Type</th><th>Principal</th><th>Balloon/Monthly</th><th>Return</th><th>Effective</th><th>Status</th><th>Notes</th></tr>
                      </thead>
                      <tbody>
                        {p.investments.map(i => (
                          <tr key={i.id}>
                            <td style={{ fontWeight: 500, fontSize: 11 }}>{i.propertyName}</td>
                            <td style={{ fontSize: 10 }}>
                              <span style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, textTransform: "uppercase",
                                background: i.investmentType === "deal-specific" ? "rgba(196,165,116,0.1)" : i.investmentType === "equity" ? "rgba(59,130,246,0.1)" : "rgba(139,92,246,0.1)",
                                color: i.investmentType === "deal-specific" ? "var(--color-accent)" : i.investmentType === "equity" ? "#3b82f6" : "#8b5cf6",
                              }}>{i.investmentType}</span>
                            </td>
                            <td className="tabular-nums" style={{ fontSize: 11 }}>{fmt(num(i.principal))}</td>
                            <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>
                              {num(i.balloonAmount) > 0 ? fmt(num(i.balloonAmount)) : num(i.monthlyPayment) > 0 ? fmtDec(num(i.monthlyPayment)) + "/mo" : "—"}
                            </td>
                            <td className="tabular-nums" style={{ fontSize: 11 }}>{num(i.returnMultiple) > 0 ? num(i.returnMultiple).toFixed(1) + "x" : num(i.interestRate) > 0 ? pct(num(i.interestRate)) : "—"}</td>
                            <td className="tabular-nums" style={{ fontSize: 11 }}>{shortDate(i.effectiveDate)}</td>
                            <td><span style={{ fontSize: 9, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, background: i.status === "active" ? "rgba(196,165,116,0.1)" : "rgba(16,185,129,0.1)", color: i.status === "active" ? "var(--color-accent)" : "var(--color-success)" }}>{i.status}</span></td>
                            <td style={{ fontSize: 10, color: "var(--color-text-muted)", maxWidth: 120 }}>{i.notes || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--color-text-muted)", fontStyle: "italic" }}>
                      Company partner — no direct deal investments. {p.companyEquityPercentage && `Holds ${pct(num(p.companyEquityPercentage))} company equity.`}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
