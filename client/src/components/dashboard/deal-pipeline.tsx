import { useCallback, useEffect, useState } from "react";

// ─── Types ──────────────────────────────────────────────
interface Deal {
  id: string; name: string; address?: string; city?: string; state?: string;
  units?: number; askingPrice?: string; offerPrice?: string;
  projectedNOI?: string; projectedCapRate?: string; projectedIRR?: string;
  stage: string; source?: string; brokerName?: string; brokerContact?: string;
  loiDate?: string; contractDate?: string; ddDeadline?: string; closingDate?: string;
  deadReason?: string; equityNeeded?: string; financingStrategy?: string;
  investmentThesis?: string; notes?: string; createdAt: string; updatedAt: string;
}

// ─── Constants ──────────────────────────────────────────
const STAGES = [
  "sourced", "underwriting", "loi_submitted", "under_contract",
  "due_diligence", "financing", "closing", "closed", "dead",
] as const;
const STAGE_LABELS: Record<string, string> = {
  sourced: "Sourced", underwriting: "Underwriting", loi_submitted: "LOI Sent",
  under_contract: "Under Contract", due_diligence: "Due Diligence",
  financing: "Financing", closing: "Closing", closed: "Closed", dead: "Dead",
};
const STAGE_COLORS: Record<string, string> = {
  sourced: "#8B8FA3", underwriting: "#6366F1", loi_submitted: "#2563EB",
  under_contract: "#0891B2", due_diligence: "#D97706", financing: "#EA580C",
  closing: "#C4A574", closed: "#16A34A", dead: "#9CA3AF",
};

// ─── Helpers ────────────────────────────────────────────
function fmtMoney(v: number) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtCompact(v: number) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtPct(v: number) {
  return (v * 100).toFixed(1) + "%";
}
function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
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

function Badge({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
      background: bg, color: fg, letterSpacing: "0.03em", textTransform: "uppercase",
    }}>{text}</span>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 4, border: "1px solid var(--color-border, #E5E3DF)",
  background: "var(--color-surface, #fff)", fontSize: 13, color: "var(--color-text, #1A1A1A)",
};

// ═════════════════════════════════════════════════════════
export default function DealPipeline() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [view, setView] = useState<"board" | "table" | "detail">("board");
  const [showAddDeal, setShowAddDeal] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const r = await fetch("/api/deals");
      if (!r.ok) throw new Error("Failed to load deals");
      const d = await r.json();
      setDeals(d);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // KPIs
  const activeDeals = deals.filter(d => !["closed", "dead"].includes(d.stage));
  const totalPipelineValue = activeDeals.reduce((s, d) => s + Number(d.offerPrice || d.askingPrice || 0), 0);
  const totalUnits = activeDeals.reduce((s, d) => s + (d.units || 0), 0);
  const totalEquityNeeded = activeDeals.reduce((s, d) => s + Number(d.equityNeeded || 0), 0);
  const closedDeals = deals.filter(d => d.stage === "closed");
  const avgCapRate = activeDeals.filter(d => d.projectedCapRate).length > 0
    ? activeDeals.filter(d => d.projectedCapRate).reduce((s, d) => s + Number(d.projectedCapRate || 0), 0) / activeDeals.filter(d => d.projectedCapRate).length
    : 0;

  const stageCounts = STAGES.reduce((acc, s) => {
    acc[s] = deals.filter(d => d.stage === s).length;
    return acc;
  }, {} as Record<string, number>);

  async function updateDealStage(id: string, stage: string) {
    try {
      const res = await fetch(`/api/deals/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error("Failed to update deal stage");
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update deal stage");
    }
  }

  async function addDeal(data: Record<string, string>) {
    try {
      const res = await fetch("/api/deals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to add deal");
      setShowAddDeal(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add deal");
    }
  }

  if (loading) {
    return (
      <section style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
        <div style={{ textAlign: "center", color: "var(--color-text-muted, #6B6B6B)" }}>
          <div style={{ fontSize: 14 }}>Loading deal pipeline...</div>
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "#DC2626", marginBottom: 12 }}>{loadError}</div>
          <button className="nav-btn active" onClick={() => { setLoading(true); load(); }} style={{ fontSize: 12 }}>Retry</button>
        </div>
      </section>
    );
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <KPI label="Active Deals" value={String(activeDeals.length)} sub={`${closedDeals.length} closed`} />
        <KPI label="Pipeline Value" value={fmtCompact(totalPipelineValue)} color="var(--color-accent, #C4A574)" />
        <KPI label="Total Units" value={String(totalUnits)} sub="in pipeline" />
        <KPI label="Equity Needed" value={fmtCompact(totalEquityNeeded)} color="#D97706" />
        <KPI label="Avg Cap Rate" value={avgCapRate > 0 ? fmtPct(avgCapRate) : "—"} />
        <KPI label="Closed" value={String(closedDeals.length)} color="#16A34A" />
      </div>

      {/* Stage progression bar */}
      <div className="card" style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
          {STAGES.filter(s => s !== "dead").map((stage, i, arr) => {
            const count = stageCounts[stage] || 0;
            const isActive = count > 0;
            return (
              <div key={stage} style={{
                flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                padding: "8px 4px", borderRadius: 6, cursor: "default",
                background: isActive ? STAGE_COLORS[stage] + "0C" : "transparent",
                border: `1px solid ${isActive ? STAGE_COLORS[stage] + "30" : "transparent"}`,
                transition: "all 0.3s ease",
              }}>
                <div style={{
                  fontSize: 22, fontWeight: 700, color: STAGE_COLORS[stage],
                  fontFamily: "'Cormorant Garamond', Georgia, serif",
                  opacity: isActive ? 1 : 0.3,
                }}>{count}</div>
                <div style={{
                  fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em",
                  color: isActive ? STAGE_COLORS[stage] : "var(--color-text-muted)",
                  fontWeight: 600, marginTop: 2, textAlign: "center",
                }}>{STAGE_LABELS[stage]}</div>
                {/* Step connector */}
                {i < arr.length - 1 && (
                  <div style={{
                    position: "absolute", display: "none",
                  }} />
                )}
              </div>
            );
          })}
          {/* Dead deals indicator */}
          {(stageCounts.dead || 0) > 0 && (
            <div style={{
              flex: 0.5, display: "flex", flexDirection: "column", alignItems: "center",
              padding: "8px 4px", borderRadius: 6, opacity: 0.5,
              borderLeft: "1px dashed var(--color-border, #E5E3DF)",
              marginLeft: 4, paddingLeft: 8,
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#9CA3AF", fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{stageCounts.dead}</div>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9CA3AF", fontWeight: 600 }}>Dead</div>
            </div>
          )}
        </div>
      </div>

      {/* Sub-nav */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["board", "table"] as const).map(v => (
            <button key={v} className={`nav-btn ${view === v ? "active" : ""}`}
              onClick={() => setView(v)} style={{ fontSize: 11 }}>
              {v === "board" ? "Board View" : "Table View"}
            </button>
          ))}
        </div>
        <button className="nav-btn active" onClick={() => setShowAddDeal(true)} style={{ fontSize: 11 }}>+ Add Deal</button>
      </div>

      {/* ═══════ BOARD VIEW ═══════════════════════ */}
      {view === "board" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${STAGES.filter(s => s !== "dead").length}, minmax(160px, 1fr))`,
          gap: 8, overflowX: "auto",
        }}>
          {STAGES.filter(s => s !== "dead").map(stage => (
            <div key={stage} style={{
              background: "var(--color-surface, #fff)",
              borderRadius: 8, border: "1px solid var(--color-border, #E5E3DF)",
              display: "flex", flexDirection: "column", minHeight: 200,
            }}>
              {/* Column header */}
              <div style={{
                padding: "10px 12px", borderBottom: `2px solid ${STAGE_COLORS[stage]}40`,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: "0.1em", color: STAGE_COLORS[stage],
                }}>{STAGE_LABELS[stage]}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: STAGE_COLORS[stage],
                  fontFamily: "'Cormorant Garamond', Georgia, serif",
                }}>{stageCounts[stage] || 0}</span>
              </div>
              {/* Cards */}
              <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                {deals.filter(d => d.stage === stage).map(deal => (
                  <div key={deal.id} className="interactive" onClick={() => { setSelectedDeal(deal); setView("detail"); }}
                    style={{
                      padding: "10px 10px", borderRadius: 6, cursor: "pointer",
                      border: "1px solid var(--color-border, #E5E3DF)",
                      background: "var(--color-surface, #fff)",
                    }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>{deal.name}</div>
                    {deal.city && deal.state && (
                      <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 4 }}>
                        {deal.city}, {deal.state}
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      {deal.units && (
                        <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{deal.units} units</span>
                      )}
                      {(deal.offerPrice || deal.askingPrice) && (
                        <span style={{
                          fontSize: 11, fontWeight: 600, color: "var(--color-accent, #C4A574)",
                          fontFamily: "'Cormorant Garamond', Georgia, serif",
                        }}>{fmtCompact(Number(deal.offerPrice || deal.askingPrice))}</span>
                      )}
                    </div>
                    {/* Deadline urgency */}
                    {deal.ddDeadline && (
                      <div style={{ marginTop: 6 }}>
                        {(() => {
                          const days = daysUntil(deal.ddDeadline);
                          if (days === null) return null;
                          const color = days < 0 ? "#DC2626" : days < 7 ? "#D97706" : "#16A34A";
                          return (
                            <span style={{ fontSize: 9, fontWeight: 600, color, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                              DD: {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))}
                {deals.filter(d => d.stage === stage).length === 0 && (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--color-text-muted)", opacity: 0.5 }}>
                    No deals
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══════ TABLE VIEW ═══════════════════════ */}
      {view === "table" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Deal Name</th>
                <th>Location</th>
                <th style={{ textAlign: "right" }}>Units</th>
                <th style={{ textAlign: "right" }}>Ask / Offer</th>
                <th style={{ textAlign: "right" }}>Cap Rate</th>
                <th style={{ textAlign: "right" }}>IRR</th>
                <th>Stage</th>
                <th>Source</th>
                <th>Financing</th>
                <th>Key Date</th>
              </tr>
            </thead>
            <tbody>
              {deals.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>No deals in pipeline</td></tr>
              ) : deals.map(d => (
                <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => { setSelectedDeal(d); setView("detail"); }}>
                  <td style={{ paddingLeft: 16, fontWeight: 500 }}>
                    {d.name}
                    {d.investmentThesis && (
                      <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 1, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.investmentThesis}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    {d.city && d.state ? `${d.city}, ${d.state}` : d.address || "—"}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.units || "—"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
                    {d.askingPrice && <div style={{ color: "var(--color-text-muted)" }}>{fmtCompact(Number(d.askingPrice))}</div>}
                    {d.offerPrice && <div style={{ fontWeight: 600 }}>{fmtCompact(Number(d.offerPrice))}</div>}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                    {d.projectedCapRate ? fmtPct(Number(d.projectedCapRate)) : "—"}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500, color: Number(d.projectedIRR || 0) >= 15 ? "#16A34A" : "var(--color-text)" }}>
                    {d.projectedIRR ? `${Number(d.projectedIRR).toFixed(1)}%` : "—"}
                  </td>
                  <td>
                    <select className="select-inline" value={d.stage}
                      onClick={e => e.stopPropagation()}
                      onChange={e => { e.stopPropagation(); updateDealStage(d.id, e.target.value); }}
                      style={{ color: STAGE_COLORS[d.stage], fontWeight: 600, fontSize: 11 }}>
                      {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{d.source || "—"}</td>
                  <td style={{ fontSize: 11 }}>
                    {d.financingStrategy ? (
                      <Badge
                        text={d.financingStrategy.replace(/_/g, " ")}
                        bg="#F5F4F1" fg="var(--color-text-muted, #6B6B6B)"
                      />
                    ) : "—"}
                  </td>
                  <td style={{ fontSize: 11, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {d.closingDate || d.ddDeadline || d.contractDate || d.loiDate || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ DETAIL VIEW ═════════════════════ */}
      {view === "detail" && selectedDeal && (
        <div>
          <button className="nav-btn" onClick={() => { setView("board"); setSelectedDeal(null); }}
            style={{ fontSize: 11, marginBottom: 12 }}>
            &larr; Back to pipeline
          </button>
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
              <div>
                <h2 style={{
                  margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif",
                  fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em",
                }}>{selectedDeal.name}</h2>
                {selectedDeal.address && (
                  <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 4 }}>
                    {selectedDeal.address}{selectedDeal.city ? `, ${selectedDeal.city}` : ""}{selectedDeal.state ? `, ${selectedDeal.state}` : ""}
                  </div>
                )}
              </div>
              <Badge text={STAGE_LABELS[selectedDeal.stage]} bg={STAGE_COLORS[selectedDeal.stage] + "18"} fg={STAGE_COLORS[selectedDeal.stage]} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
              {[
                { label: "Units", value: selectedDeal.units ? String(selectedDeal.units) : "—" },
                { label: "Asking Price", value: selectedDeal.askingPrice ? fmtMoney(Number(selectedDeal.askingPrice)) : "—" },
                { label: "Offer Price", value: selectedDeal.offerPrice ? fmtMoney(Number(selectedDeal.offerPrice)) : "—" },
                { label: "Equity Needed", value: selectedDeal.equityNeeded ? fmtMoney(Number(selectedDeal.equityNeeded)) : "—" },
                { label: "Projected NOI", value: selectedDeal.projectedNOI ? fmtMoney(Number(selectedDeal.projectedNOI)) : "—" },
                { label: "Cap Rate", value: selectedDeal.projectedCapRate ? fmtPct(Number(selectedDeal.projectedCapRate)) : "—" },
                { label: "Projected IRR", value: selectedDeal.projectedIRR ? `${Number(selectedDeal.projectedIRR).toFixed(1)}%` : "—" },
                { label: "Financing", value: selectedDeal.financingStrategy?.replace(/_/g, " ") || "—" },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 4 }}>{item.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* Timeline */}
            <div style={{ marginBottom: 20 }}>
              <div className="label" style={{ marginBottom: 10 }}>Deal Timeline</div>
              <div style={{ display: "flex", gap: 16 }}>
                {[
                  { label: "LOI Date", date: selectedDeal.loiDate },
                  { label: "Contract", date: selectedDeal.contractDate },
                  { label: "DD Deadline", date: selectedDeal.ddDeadline },
                  { label: "Closing", date: selectedDeal.closingDate },
                ].map(t => (
                  <div key={t.label} style={{ flex: 1, padding: "10px 12px", borderRadius: 6, background: "var(--color-surface-alt, #F5F4F1)", border: "1px solid var(--color-border, #E5E3DF)" }}>
                    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 2 }}>{t.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{t.date || "—"}</div>
                    {t.date && (() => {
                      const days = daysUntil(t.date);
                      if (days === null) return null;
                      const color = days < 0 ? "#DC2626" : days < 14 ? "#D97706" : "#16A34A";
                      return <div style={{ fontSize: 10, color, fontWeight: 600, marginTop: 2 }}>{days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`}</div>;
                    })()}
                  </div>
                ))}
              </div>
            </div>

            {/* Broker + Thesis */}
            {(selectedDeal.brokerName || selectedDeal.investmentThesis) && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16 }}>
                {selectedDeal.brokerName && (
                  <div style={{ padding: "12px 14px", borderRadius: 6, background: "var(--color-surface-alt, #F5F4F1)" }}>
                    <div className="label" style={{ marginBottom: 6 }}>Broker</div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{selectedDeal.brokerName}</div>
                    {selectedDeal.brokerContact && <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{selectedDeal.brokerContact}</div>}
                    {selectedDeal.source && <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>Source: {selectedDeal.source}</div>}
                  </div>
                )}
                {selectedDeal.investmentThesis && (
                  <div style={{ padding: "12px 14px", borderRadius: 6, background: "var(--color-surface-alt, #F5F4F1)" }}>
                    <div className="label" style={{ marginBottom: 6 }}>Investment Thesis</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-text)" }}>{selectedDeal.investmentThesis}</div>
                  </div>
                )}
              </div>
            )}

            {/* Stage change */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--color-border, #E5E3DF)", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-muted)", alignSelf: "center", marginRight: 8 }}>Move to:</span>
              {STAGES.filter(s => s !== selectedDeal.stage).map(s => (
                <button key={s} className="nav-btn" onClick={() => { updateDealStage(selectedDeal.id, s); setSelectedDeal({ ...selectedDeal, stage: s }); }}
                  style={{ fontSize: 10, color: STAGE_COLORS[s] }}>
                  {STAGE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ ADD DEAL MODAL ═══════════════════ */}
      {showAddDeal && (
        <div onClick={() => setShowAddDeal(false)} style={{
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
            <h3 style={{ margin: "0 0 4px", fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 22, fontWeight: 600 }}>New Deal</h3>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--color-text-muted)" }}>Add an acquisition opportunity to the pipeline</p>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); addDeal(Object.fromEntries(fd) as Record<string, string>); }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Deal Name</span>
                  <input name="name" required style={inputStyle} placeholder="e.g. Cypress Gardens 24-Unit" />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Address</span>
                    <input name="address" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>City</span>
                    <input name="city" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>State</span>
                    <input name="state" style={inputStyle} placeholder="FL" />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Units</span>
                    <input name="units" type="number" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Asking Price</span>
                    <input name="askingPrice" type="number" step="1000" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Offer Price</span>
                    <input name="offerPrice" type="number" step="1000" style={inputStyle} />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Source</span>
                    <select name="source" style={inputStyle}>
                      <option value="broker">Broker</option>
                      <option value="off-market">Off-Market</option>
                      <option value="auction">Auction</option>
                      <option value="wholesaler">Wholesaler</option>
                      <option value="direct">Direct</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Stage</span>
                    <select name="stage" style={inputStyle}>
                      {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Financing</span>
                    <select name="financingStrategy" style={inputStyle}>
                      <option value="">Select...</option>
                      <option value="bridge">Bridge</option>
                      <option value="agency">Agency</option>
                      <option value="seller_finance">Seller Finance</option>
                      <option value="cash">Cash</option>
                      <option value="portfolio_loan">Portfolio Loan</option>
                    </select>
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Projected NOI</span>
                    <input name="projectedNOI" type="number" step="1000" style={inputStyle} placeholder="150000" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Projected Cap Rate</span>
                    <input name="projectedCapRate" type="number" step="0.001" style={inputStyle} placeholder="0.065" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Projected IRR</span>
                    <input name="projectedIRR" type="number" step="0.1" style={inputStyle} placeholder="18.5" />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Equity Needed</span>
                    <input name="equityNeeded" type="number" step="1000" style={inputStyle} placeholder="500000" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Broker Name</span>
                    <input name="brokerName" style={inputStyle} placeholder="Jane Doe" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>DD Deadline</span>
                    <input name="ddDeadline" type="date" style={inputStyle} />
                  </label>
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Investment Thesis</span>
                  <textarea name="investmentThesis" rows={2} style={{ ...inputStyle, resize: "vertical" }} placeholder="Value-add opportunity with..." />
                </label>
                <div style={{ height: 1, background: "var(--color-border, #E5E3DF)", margin: "2px 0" }} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setShowAddDeal(false)} className="nav-btn" style={{ fontSize: 12, padding: "8px 18px" }}>Cancel</button>
                  <button type="submit" className="nav-btn active" style={{ fontSize: 12, padding: "8px 18px" }}>Add Deal</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}