import { useCallback, useEffect, useState } from "react";

// ─── Types ──────────────────────────────────────────────
interface InvestorLead {
  id: string; firstName: string; lastName: string; email: string;
  phone?: string; company?: string; accreditedStatus: string;
  investableCapital?: string; source?: string; stage: string;
  interestLevel: string; notes?: string; lastContactDate?: string;
  nextFollowUpDate?: string; convertedToInvestorId?: string;
  createdAt: string; updatedAt: string;
}
interface Communication {
  id: string; investorId?: string; leadId?: string; type: string;
  direction: string; subject?: string; content?: string;
  sentAt: string; sentBy?: string; status: string;
  relatedDocumentId?: string; notes?: string; createdAt: string;
}
interface CapitalAccount {
  id: string; investorId: string; investmentId?: string; propertyId?: string;
  period: string; beginningBalance: string; contributions: string;
  distributionsPaid: string; allocatedIncome: string; allocatedLoss: string;
  appreciationAllocation: string; endingBalance: string; notes?: string;
}
interface Distribution {
  id: string; investorId: string; investmentId?: string; propertyId?: string;
  amount: string; distributionType: string; period?: string;
  paymentMethod?: string; paymentReference?: string; status: string;
  paidAt?: string; notes?: string; createdAt: string;
}

// ─── Constants ──────────────────────────────────────────
const STAGES = [
  "new", "contacted", "qualified", "meeting_scheduled",
  "meeting_complete", "docs_sent", "committed", "funded", "inactive",
] as const;
const STAGE_LABELS: Record<string, string> = {
  new: "New", contacted: "Contacted", qualified: "Qualified",
  meeting_scheduled: "Meeting Set", meeting_complete: "Meeting Done",
  docs_sent: "Docs Sent", committed: "Committed", funded: "Funded", inactive: "Inactive",
};
const STAGE_COLORS: Record<string, string> = {
  new: "#8B8FA3", contacted: "#6366F1", qualified: "#2563EB",
  meeting_scheduled: "#0891B2", meeting_complete: "#0D9488",
  docs_sent: "#D97706", committed: "#16A34A", funded: "#C4A574", inactive: "#9CA3AF",
};
const INTEREST_CONFIG: Record<string, { bg: string; fg: string; label: string }> = {
  hot: { bg: "#FEF2F2", fg: "#DC2626", label: "Hot" },
  warm: { bg: "#FFF7ED", fg: "#EA580C", label: "Warm" },
  cold: { bg: "#F0F9FF", fg: "#0284C7", label: "Cold" },
};
const ACCREDITED_CONFIG: Record<string, { bg: string; fg: string; dot: string }> = {
  verified: { bg: "#F0FDF4", fg: "#16A34A", dot: "#16A34A" },
  self_reported: { bg: "#FFF7ED", fg: "#D97706", dot: "#D97706" },
  not_accredited: { bg: "#FEF2F2", fg: "#DC2626", dot: "#DC2626" },
  unknown: { bg: "#F5F4F1", fg: "#8c836e", dot: "#8c836e" },
};
const DIST_STATUS: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "#FFF7ED", fg: "#D97706" },
  processing: { bg: "#EFF6FF", fg: "#2563EB" },
  paid: { bg: "#F0FDF4", fg: "#16A34A" },
  failed: { bg: "#FEF2F2", fg: "#DC2626" },
};

// ─── Helpers ────────────────────────────────────────────
function fmtMoney(v: number) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCompact(v: number) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

// ─── Shared Sub-Components ──────────────────────────────
function KPI({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel kpi" style={{ position: "relative", overflow: "hidden" }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div className="value" style={{
        color: color || "var(--color-text)",
        fontFamily: "'Cormorant Garamond', Georgia, serif",
        fontSize: "1.6rem",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.02em",
      }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2, letterSpacing: "0.01em" }}>{sub}</div>}
      {/* Subtle brass accent line at bottom */}
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
      lineHeight: 1.6,
    }}>{text}</span>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(26,26,26,0.35)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 1000,
      animation: "dashFadeIn 0.2s ease-out",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--color-surface, #fff)", borderRadius: 10, padding: 28, width: 520,
        maxHeight: "85vh", overflow: "auto",
        boxShadow: "0 24px 80px rgba(26,26,26,0.15), 0 8px 24px rgba(26,26,26,0.08)",
        border: "1px solid var(--color-border, #E5E3DF)",
        animation: "dashFadeIn 0.25s ease-out",
      }}>{children}</div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted, #6B6B6B)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 4, border: "1px solid var(--color-border, #E5E3DF)",
  background: "var(--color-surface, #fff)", fontSize: 13, color: "var(--color-text, #1A1A1A)",
  transition: "border-color 0.2s",
};

// ═════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════
export default function InvestorCRM() {
  const [leads, setLeads] = useState<InvestorLead[]>([]);
  const [comms, setComms] = useState<Communication[]>([]);
  const [accounts, setAccounts] = useState<CapitalAccount[]>([]);
  const [distributions, setDistributions] = useState<Distribution[]>([]);
  const [view, setView] = useState<"pipeline" | "communications" | "capital" | "distributions">("pipeline");
  const [showAddLead, setShowAddLead] = useState(false);
  const [showAddComm, setShowAddComm] = useState(false);
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [l, c, a, d] = await Promise.all([
        fetch("/api/crm/leads").then(r => { if (!r.ok) throw new Error("Failed to load leads"); return r.json(); }),
        fetch("/api/crm/communications").then(r => { if (!r.ok) throw new Error("Failed to load communications"); return r.json(); }),
        fetch("/api/capital-accounts").then(r => { if (!r.ok) throw new Error("Failed to load capital accounts"); return r.json(); }),
        fetch("/api/distributions").then(r => { if (!r.ok) throw new Error("Failed to load distributions"); return r.json(); }),
      ]);
      setLeads(l); setComms(c); setAccounts(a); setDistributions(d);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ─── Computed KPIs ──────────────────────────────────
  const activeLeads = leads.filter(l => !["funded", "inactive"].includes(l.stage));
  const hotLeads = leads.filter(l => l.interestLevel === "hot" && l.stage !== "inactive");
  const committedCapital = leads
    .filter(l => ["committed", "funded"].includes(l.stage))
    .reduce((s, l) => s + Number(l.investableCapital || 0), 0);
  const totalDistributed = distributions
    .filter(d => d.status === "paid")
    .reduce((s, d) => s + Number(d.amount), 0);
  const totalPendingDist = distributions
    .filter(d => d.status === "pending")
    .reduce((s, d) => s + Number(d.amount), 0);
  const totalCapitalBalance = accounts.reduce((s, a) => s + Number(a.endingBalance), 0);

  // Pipeline funnel counts
  const stageCounts = STAGES.reduce((acc, s) => {
    acc[s] = leads.filter(l => l.stage === s).length;
    return acc;
  }, {} as Record<string, number>);

  const filteredLeads = stageFilter === "all" ? leads : leads.filter(l => l.stage === stageFilter);

  // ─── Actions ────────────────────────────────────────
  async function updateLeadStage(id: string, stage: string) {
    try {
      const res = await fetch(`/api/crm/leads/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error("Failed to update lead stage");
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update lead stage");
    }
  }

  async function addLead(data: Record<string, string>) {
    try {
      const res = await fetch("/api/crm/leads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to add lead");
      setShowAddLead(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add lead");
    }
  }

  async function addComm(data: Record<string, string>) {
    try {
      const res = await fetch("/api/crm/communications", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, sentAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error("Failed to log communication");
      setShowAddComm(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to log communication");
    }
  }

  // ═════════════════════════════════════════════════════
  if (loading) {
    return (
      <section style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
        <div style={{ textAlign: "center", color: "var(--color-text-muted, #6B6B6B)" }}>
          <div style={{ fontSize: 14 }}>Loading investor data...</div>
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
      {/* ─── KPI Strip ─────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <KPI label="Total Leads" value={String(leads.length)} sub={`${activeLeads.length} active`} />
        <KPI label="Active Pipeline" value={String(activeLeads.length)} color="var(--color-accent, #C4A574)" />
        <KPI label="Hot Leads" value={String(hotLeads.length)} color={hotLeads.length > 0 ? "#DC2626" : undefined} sub="high intent" />
        <KPI label="Committed Capital" value={fmtCompact(committedCapital)} color="#16A34A" />
        <KPI label="Distributions Paid" value={fmtCompact(totalDistributed)} sub={totalPendingDist > 0 ? `${fmtCompact(totalPendingDist)} pending` : undefined} />
        <KPI label="Capital Balances" value={fmtCompact(totalCapitalBalance)} color="var(--color-accent, #C4A574)" />
      </div>

      {/* ─── Pipeline Funnel Strip ─────────────────── */}
      <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 0 }}>
        {STAGES.filter(s => s !== "inactive").map((stage, i, arr) => {
          const count = stageCounts[stage] || 0;
          const maxCount = Math.max(...arr.map(s => stageCounts[s] || 0), 1);
          const barWidth = Math.max(20, (count / maxCount) * 100);
          return (
            <div key={stage} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
              <div style={{
                fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em",
                color: stageFilter === stage ? STAGE_COLORS[stage] : "var(--color-text-muted, #6B6B6B)",
                fontWeight: stageFilter === stage ? 700 : 500, marginBottom: 6,
                cursor: "pointer", transition: "color 0.2s",
              }} onClick={() => setStageFilter(stageFilter === stage ? "all" : stage)}>
                {STAGE_LABELS[stage]}
              </div>
              <div style={{
                width: `${barWidth}%`, height: 6, borderRadius: 3,
                background: STAGE_COLORS[stage],
                opacity: count > 0 ? 0.85 : 0.15,
                transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                cursor: "pointer",
              }} onClick={() => setStageFilter(stageFilter === stage ? "all" : stage)} />
              <div style={{
                fontSize: 13, fontWeight: 700, marginTop: 4,
                color: count > 0 ? STAGE_COLORS[stage] : "var(--color-text-muted, #6B6B6B)",
                fontFamily: "'Cormorant Garamond', Georgia, serif",
              }}>{count}</div>
              {/* Connector arrow */}
              {i < arr.length - 1 && (
                <div style={{
                  position: "absolute", right: -4, top: 18, width: 8, height: 8,
                  borderRight: "1.5px solid var(--color-border, #E5E3DF)",
                  borderBottom: "1.5px solid var(--color-border, #E5E3DF)",
                  transform: "rotate(-45deg)", opacity: 0.5,
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* ─── Sub-nav + Actions ─────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["pipeline", "communications", "capital", "distributions"] as const).map(v => (
            <button key={v} className={`nav-btn ${view === v ? "active" : ""}`}
              onClick={() => setView(v)} style={{ fontSize: 11 }}>
              {v === "pipeline" ? "Pipeline" : v === "communications" ? "Communications" : v === "capital" ? "Capital Accounts" : "Distributions"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {stageFilter !== "all" && (
            <button className="nav-btn" onClick={() => setStageFilter("all")} style={{ fontSize: 10, color: "var(--color-accent, #C4A574)" }}>
              Clear filter: {STAGE_LABELS[stageFilter]}
            </button>
          )}
          {view === "pipeline" && (
            <button className="nav-btn active" onClick={() => setShowAddLead(true)} style={{ fontSize: 11 }}>+ Add Lead</button>
          )}
          {view === "communications" && (
            <button className="nav-btn active" onClick={() => setShowAddComm(true)} style={{ fontSize: 11 }}>+ Log Communication</button>
          )}
        </div>
      </div>

      {/* ═══════════ PIPELINE VIEW ═══════════════════ */}
      {view === "pipeline" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Name</th>
                <th>Company</th>
                <th>Email</th>
                <th>Accredited</th>
                <th style={{ textAlign: "right" }}>Capital</th>
                <th>Stage</th>
                <th>Interest</th>
                <th>Last Contact</th>
                <th>Follow-Up</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>
                  {stageFilter !== "all" ? `No leads in "${STAGE_LABELS[stageFilter]}" stage` : "No investor leads yet"}
                </td></tr>
              ) : filteredLeads.map(lead => {
                const accr = ACCREDITED_CONFIG[lead.accreditedStatus] || ACCREDITED_CONFIG.unknown;
                const interest = INTEREST_CONFIG[lead.interestLevel] || INTEREST_CONFIG.warm;
                const followUp = daysUntil(lead.nextFollowUpDate);
                const overdue = followUp !== null && followUp < 0;
                return (
                  <tr key={lead.id}>
                    <td style={{ paddingLeft: 16, fontWeight: 500 }}>
                      <div style={{ lineHeight: 1.3 }}>
                        {lead.firstName} {lead.lastName}
                        {lead.source && (
                          <span style={{ fontSize: 9, color: "var(--color-text-muted)", display: "block", letterSpacing: "0.05em" }}>
                            via {lead.source}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: lead.company ? "var(--color-text)" : "var(--color-text-muted)" }}>
                      {lead.company || "—"}
                    </td>
                    <td style={{ fontSize: 12 }}>{lead.email}</td>
                    <td>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
                        background: accr.bg, color: accr.fg,
                      }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: accr.dot }} />
                        {lead.accreditedStatus.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                      {lead.investableCapital ? fmtCompact(Number(lead.investableCapital)) : "—"}
                    </td>
                    <td>
                      <select className="select-inline" value={lead.stage}
                        onChange={e => updateLeadStage(lead.id, e.target.value)}
                        style={{
                          color: STAGE_COLORS[lead.stage] || "var(--color-text-muted)",
                          fontWeight: 600, fontSize: 11,
                        }}>
                        {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                      </select>
                    </td>
                    <td><Badge text={interest.label} bg={interest.bg} fg={interest.fg} /></td>
                    <td style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                      {lead.lastContactDate || "—"}
                    </td>
                    <td>
                      {lead.nextFollowUpDate ? (
                        <span style={{
                          fontSize: 11, fontWeight: overdue ? 600 : 400,
                          color: overdue ? "#DC2626" : followUp !== null && followUp <= 2 ? "#D97706" : "var(--color-text-muted)",
                        }}>
                          {lead.nextFollowUpDate}
                          {overdue && <span style={{ fontSize: 9, marginLeft: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>overdue</span>}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════ COMMUNICATIONS VIEW ═════════════ */}
      {view === "communications" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Type</th>
                <th>Direction</th>
                <th>Subject</th>
                <th>Sent By</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {comms.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>No communications logged yet</td></tr>
              ) : comms.map(c => (
                <tr key={c.id}>
                  <td style={{ paddingLeft: 16 }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      fontSize: 11, fontWeight: 500,
                    }}>
                      <span style={{
                        width: 18, height: 18, borderRadius: 4,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        background: c.type === "email" ? "#EFF6FF" : c.type === "phone" ? "#F0FDF4" : c.type === "meeting" ? "#FFF7ED" : "#F5F4F1",
                        fontSize: 10,
                      }}>
                        {c.type === "email" ? "E" : c.type === "phone" ? "P" : c.type === "meeting" ? "M" : "O"}
                      </span>
                      {c.type}
                    </span>
                  </td>
                  <td>
                    <Badge
                      text={c.direction}
                      bg={c.direction === "outbound" ? "#EFF6FF" : "#F0FDF4"}
                      fg={c.direction === "outbound" ? "#2563EB" : "#16A34A"}
                    />
                  </td>
                  <td style={{ fontWeight: 500, maxWidth: 280 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.subject || "—"}
                    </div>
                    {c.content && (
                      <div style={{ fontSize: 11, color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
                        {c.content}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>{c.sentBy || "—"}</td>
                  <td>
                    <Badge
                      text={c.status}
                      bg={c.status === "sent" ? "#EFF6FF" : c.status === "delivered" ? "#F0FDF4" : c.status === "read" ? "#F0FDF4" : c.status === "bounced" ? "#FEF2F2" : "#F5F4F1"}
                      fg={c.status === "sent" ? "#2563EB" : c.status === "delivered" ? "#16A34A" : c.status === "read" ? "#0D9488" : c.status === "bounced" ? "#DC2626" : "#8c836e"}
                    />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {new Date(c.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════ CAPITAL ACCOUNTS VIEW ═══════════ */}
      {view === "capital" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Investor</th>
                <th>Period</th>
                <th style={{ textAlign: "right" }}>Beginning</th>
                <th style={{ textAlign: "right" }}>Contributions</th>
                <th style={{ textAlign: "right" }}>Distributions</th>
                <th style={{ textAlign: "right" }}>Income</th>
                <th style={{ textAlign: "right" }}>Loss</th>
                <th style={{ textAlign: "right" }}>Appreciation</th>
                <th style={{ textAlign: "right" }}>Ending</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>No capital account entries</td></tr>
              ) : accounts.map(a => (
                <tr key={a.id}>
                  <td style={{ paddingLeft: 16, fontWeight: 500, fontSize: 12 }}>{a.investorId}</td>
                  <td style={{ fontSize: 12 }}>{a.period}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(Number(a.beginningBalance))}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(a.contributions) > 0 ? "#16A34A" : "var(--color-text)" }}>
                    {Number(a.contributions) > 0 ? "+" : ""}{fmtMoney(Number(a.contributions))}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(a.distributionsPaid) > 0 ? "#DC2626" : "var(--color-text)" }}>
                    {Number(a.distributionsPaid) > 0 ? "-" : ""}{fmtMoney(Number(a.distributionsPaid))}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(a.allocatedIncome) > 0 ? "#16A34A" : "var(--color-text)" }}>
                    {fmtMoney(Number(a.allocatedIncome))}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(a.allocatedLoss) > 0 ? "#DC2626" : "var(--color-text)" }}>
                    {Number(a.allocatedLoss) > 0 ? `(${fmtMoney(Number(a.allocatedLoss))})` : fmtMoney(0)}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(a.appreciationAllocation) > 0 ? "#16A34A" : "var(--color-text)" }}>
                    {fmtMoney(Number(a.appreciationAllocation))}
                  </td>
                  <td style={{
                    textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600,
                    fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 14,
                  }}>
                    {fmtMoney(Number(a.endingBalance))}
                  </td>
                </tr>
              ))}
            </tbody>
            {accounts.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--color-border, #E5E3DF)" }}>
                  <td colSpan={8} style={{ paddingLeft: 16, fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)" }}>
                    Total Capital
                  </td>
                  <td style={{
                    textAlign: "right", fontWeight: 700,
                    fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 16,
                    color: "var(--color-accent, #C4A574)",
                  }}>
                    {fmtMoney(totalCapitalBalance)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* ═══════════ DISTRIBUTIONS VIEW ═════════════ */}
      {view === "distributions" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {/* Summary bar */}
          <div style={{
            display: "flex", gap: 24, padding: "14px 16px",
            borderBottom: "1px solid var(--color-border, #E5E3DF)",
            background: "var(--color-surface-alt, #F5F4F1)",
          }}>
            {[
              { label: "Total Distributed", value: fmtCompact(totalDistributed), color: "#16A34A" },
              { label: "Pending", value: fmtCompact(totalPendingDist), color: "#D97706" },
              { label: "Count", value: String(distributions.length), color: "var(--color-text)" },
            ].map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)" }}>{s.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: s.color, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{s.value}</div>
              </div>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 16 }}>Investor</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Type</th>
                <th>Period</th>
                <th>Method</th>
                <th>Status</th>
                <th>Paid Date</th>
              </tr>
            </thead>
            <tbody>
              {distributions.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>No distributions recorded</td></tr>
              ) : distributions.map(d => {
                const st = DIST_STATUS[d.status] || DIST_STATUS.pending;
                return (
                  <tr key={d.id}>
                    <td style={{ paddingLeft: 16, fontWeight: 500, fontSize: 12 }}>{d.investorId}</td>
                    <td style={{
                      textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums",
                      fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 14,
                    }}>{fmtMoney(Number(d.amount))}</td>
                    <td>
                      <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                        {d.distributionType.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{d.period || "—"}</td>
                    <td style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
                      {d.paymentMethod || "—"}
                    </td>
                    <td><Badge text={d.status} bg={st.bg} fg={st.fg} /></td>
                    <td style={{ fontSize: 12, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {d.paidAt ? new Date(d.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════════ ADD LEAD MODAL ═════════════════ */}
      {showAddLead && (
        <ModalOverlay onClose={() => setShowAddLead(false)}>
          <div style={{ marginBottom: 20 }}>
            <h3 style={{
              margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em",
            }}>New Investor Lead</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--color-text-muted, #6B6B6B)" }}>
              Add a new lead to the investor pipeline
            </p>
          </div>
          <form onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            addLead(Object.fromEntries(fd) as Record<string, string>);
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="First Name">
                  <input name="firstName" required style={inputStyle} placeholder="John" />
                </FormField>
                <FormField label="Last Name">
                  <input name="lastName" required style={inputStyle} placeholder="Smith" />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="Email">
                  <input name="email" type="email" required style={inputStyle} placeholder="john@example.com" />
                </FormField>
                <FormField label="Phone">
                  <input name="phone" style={inputStyle} placeholder="(555) 123-4567" />
                </FormField>
              </div>
              <FormField label="Company">
                <input name="company" style={inputStyle} placeholder="Company name" />
              </FormField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="Accredited Status">
                  <select name="accreditedStatus" style={inputStyle}>
                    <option value="unknown">Unknown</option>
                    <option value="self_reported">Self Reported</option>
                    <option value="verified">Verified</option>
                    <option value="not_accredited">Not Accredited</option>
                  </select>
                </FormField>
                <FormField label="Investable Capital">
                  <input name="investableCapital" type="number" step="1000" style={inputStyle} placeholder="250000" />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="Source">
                  <select name="source" style={inputStyle}>
                    <option value="website">Website</option>
                    <option value="referral">Referral</option>
                    <option value="event">Event</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="cold_outreach">Cold Outreach</option>
                  </select>
                </FormField>
                <FormField label="Interest Level">
                  <select name="interestLevel" style={inputStyle}>
                    <option value="warm">Warm</option>
                    <option value="hot">Hot</option>
                    <option value="cold">Cold</option>
                  </select>
                </FormField>
              </div>
              <FormField label="Stage">
                <select name="stage" defaultValue="new" style={inputStyle}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                </select>
              </FormField>
              {/* Divider */}
              <div style={{ height: 1, background: "var(--color-border, #E5E3DF)", margin: "4px 0" }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setShowAddLead(false)} className="nav-btn" style={{ fontSize: 12, padding: "8px 18px" }}>
                  Cancel
                </button>
                <button type="submit" className="nav-btn active" style={{ fontSize: 12, padding: "8px 18px" }}>
                  Add Lead
                </button>
              </div>
            </div>
          </form>
        </ModalOverlay>
      )}

      {/* ═══════════ ADD COMMUNICATION MODAL ════════ */}
      {showAddComm && (
        <ModalOverlay onClose={() => setShowAddComm(false)}>
          <div style={{ marginBottom: 20 }}>
            <h3 style={{
              margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em",
            }}>Log Communication</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--color-text-muted, #6B6B6B)" }}>
              Record an investor interaction
            </p>
          </div>
          <form onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            addComm(Object.fromEntries(fd) as Record<string, string>);
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {leads.length > 0 && (
                <FormField label="Lead">
                  <select name="leadId" style={inputStyle}>
                    <option value="">Select lead...</option>
                    {leads.map(l => <option key={l.id} value={l.id}>{l.firstName} {l.lastName}</option>)}
                  </select>
                </FormField>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="Type">
                  <select name="type" required style={inputStyle}>
                    {["email", "phone", "meeting", "report", "distribution_notice", "k1_delivery", "text", "other"].map(t => (
                      <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Direction">
                  <select name="direction" required style={inputStyle}>
                    <option value="outbound">Outbound</option>
                    <option value="inbound">Inbound</option>
                  </select>
                </FormField>
              </div>
              <FormField label="Subject">
                <input name="subject" style={inputStyle} placeholder="Meeting re: Q4 distribution" />
              </FormField>
              <FormField label="Content">
                <textarea name="content" rows={3} style={{ ...inputStyle, resize: "vertical" }} placeholder="Notes about the interaction..." />
              </FormField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <FormField label="Sent By">
                  <input name="sentBy" defaultValue="michael" style={inputStyle} />
                </FormField>
                <FormField label="Status">
                  <select name="status" style={inputStyle}>
                    <option value="sent">Sent</option>
                    <option value="delivered">Delivered</option>
                    <option value="read">Read</option>
                    <option value="draft">Draft</option>
                  </select>
                </FormField>
              </div>
              <div style={{ height: 1, background: "var(--color-border, #E5E3DF)", margin: "4px 0" }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setShowAddComm(false)} className="nav-btn" style={{ fontSize: 12, padding: "8px 18px" }}>
                  Cancel
                </button>
                <button type="submit" className="nav-btn active" style={{ fontSize: 12, padding: "8px 18px" }}>
                  Log Communication
                </button>
              </div>
            </div>
          </form>
        </ModalOverlay>
      )}
    </section>
  );
}