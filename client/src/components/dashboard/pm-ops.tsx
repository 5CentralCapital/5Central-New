import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties } from "./shared/property-subtabs";

interface PmNote {
  id: string; propertyId: string; author: string; date: string;
  content: string; category: string; createdAt: string;
}
interface PmEscalation {
  id: string; propertyId?: string; title: string; description: string;
  priority: string; trigger: string; status: string; escalatedBy: string;
  resolvedBy?: string; resolvedAt?: string; spendAmount?: string; notes?: string;
  createdAt: string;
}
interface SlaTimer {
  id: string; propertyId?: string; slaType: string; targetHours: number;
  startedAt: string; completedAt?: string; isBreached: boolean;
  relatedEntityType?: string; relatedEntityId?: string; assignedTo?: string; notes?: string;
}
interface MaintenanceRequest {
  id: string; propertyId: string; unitNumber?: string; tenantName?: string;
  title: string; description: string; category: string; priority: string;
  status: string; assignedTo?: string; estimatedCost?: string; actualCost?: string;
  reportedAt: string; acknowledgedAt?: string; scheduledDate?: string; completedAt?: string;
  photoUrls?: string; notes?: string; createdAt: string;
}

function fmtMoney(v: number) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function hoursElapsed(dateStr: string) {
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 3600000);
}

const PRIORITY_COLORS: Record<string, string> = {
  emergency: "#7C3AED", critical: "#DC2626", high: "#EA580C", medium: "#D97706", low: "#65A30D",
};
const STATUS_COLORS: Record<string, string> = {
  open: "#DC2626", assigned: "#2563EB", acknowledged: "#D97706", in_progress: "#2563EB",
  parts_ordered: "#7C3AED", scheduled: "#0891B2", complete: "#16A34A",
  cancelled: "#6B7280", resolved: "#16A34A", dismissed: "#6B7280",
};

export default function PmOps() {
  const [notes, setNotes] = useState<PmNote[]>([]);
  const [escalations, setEscalations] = useState<PmEscalation[]>([]);
  const [slaTimers, setSlaTimers] = useState<SlaTimer[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceRequest[]>([]);
  const [view, setView] = useState<"dashboard" | "maintenance" | "escalations" | "notes" | "sla">("dashboard");
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  const [showAddNote, setShowAddNote] = useState(false);
  const [showAddRequest, setShowAddRequest] = useState(false);
  const [showAddEscalation, setShowAddEscalation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { properties } = useProperties();

  // Map local UUIDs to RM property IDs for filtering
  const localToRmId: Record<string, string> = {
    "ea28fe29-c3e4-4ccd-a68d-a38dbd6b52fb": "30", // MLK
    "48385b5c-791a-455d-a358-5f1947b448e3": "31", // Hickory
    "ba502e16-e1ee-4925-baff-1b156ad37133": "32", // Sun Cove
    "4d7c6538-2f0d-42e2-8c40-6ec57b438a4a": "33", // Lucia
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const q = propertyFilter !== "all" ? `?propertyId=${propertyFilter}` : "";
      const [nRes, eRes, sRes] = await Promise.all([
        fetch(`/api/pm/notes${q}`),
        fetch(`/api/pm/escalations${q}`),
        fetch(`/api/pm/sla-timers${q}`),
      ]);
      if (!nRes.ok || !eRes.ok || !sRes.ok) {
        throw new Error("One or more API requests failed");
      }
      const [n, e, s] = await Promise.all([nRes.json(), eRes.json(), sRes.json()]);
      setNotes(n); setEscalations(e); setSlaTimers(s);

      // Maintenance: try RM first, fall back to local DB
      let maintenanceData: MaintenanceRequest[] = [];
      try {
        const rmPropId = propertyFilter !== "all" ? localToRmId[propertyFilter] : undefined;
        const rmQ = rmPropId ? `?propertyId=${rmPropId}` : "";
        const rmRes = await fetch(`/api/rm/maintenance${rmQ}`, { credentials: "include" });
        if (rmRes.ok) {
          maintenanceData = await rmRes.json();
        } else {
          throw new Error("RM unavailable");
        }
      } catch {
        // Fall back to local DB
        const mRes = await fetch(`/api/maintenance${q}`);
        if (mRes.ok) maintenanceData = await mRes.json();
      }
      setMaintenance(maintenanceData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [propertyFilter]);

  useEffect(() => { load(); }, [load]);

  const propName = (id: string) => properties.find(p => p.id === id)?.name || id;

  // KPIs
  const openRequests = maintenance.filter(m => m.status !== "complete" && m.status !== "cancelled").length;
  const emergencyCount = maintenance.filter(m => m.priority === "emergency" && m.status !== "complete").length;
  const openEscalations = escalations.filter(e => e.status === "open").length;
  const breachedSLAs = slaTimers.filter(s => s.isBreached && !s.completedAt).length;
  const activeSLAs = slaTimers.filter(s => !s.completedAt).length;
  const avgResponseHours = maintenance.filter(m => m.acknowledgedAt).length > 0
    ? Math.round(maintenance.filter(m => m.acknowledgedAt).reduce((s, m) =>
        s + (new Date(m.acknowledgedAt!).getTime() - new Date(m.reportedAt).getTime()) / 3600000, 0)
      / maintenance.filter(m => m.acknowledgedAt).length)
    : 0;
  const totalMaintCost = maintenance.reduce((s, m) => s + Number(m.actualCost || 0), 0);

  async function addNote(data: Record<string, string>) {
    try {
      const res = await fetch("/api/pm/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error("Failed to add note");
      setShowAddNote(false); load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add note");
    }
  }
  async function addRequest(data: Record<string, string>) {
    try {
      const res = await fetch("/api/maintenance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error("Failed to add request");
      setShowAddRequest(false); load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add request");
    }
  }
  async function addEscalation(data: Record<string, string>) {
    try {
      const res = await fetch("/api/pm/escalations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error("Failed to add escalation");
      setShowAddEscalation(false); load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add escalation");
    }
  }
  async function updateRequestStatus(id: string, status: string) {
    try {
      const body: Record<string, string> = { status };
      if (status === "complete") body.completedAt = new Date().toISOString();
      if (status === "acknowledged") body.acknowledgedAt = new Date().toISOString();
      const res = await fetch(`/api/maintenance/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("Failed to update request status");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update request status");
    }
  }
  async function resolveEscalation(id: string) {
    try {
      const res = await fetch(`/api/pm/escalations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved", resolvedBy: "Admin", resolvedAt: new Date().toISOString() }) });
      if (!res.ok) throw new Error("Failed to resolve escalation");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve escalation");
    }
  }
  async function completeSlaTimer(id: string) {
    try {
      const res = await fetch(`/api/pm/sla-timers/${id}/complete`, { method: "PATCH" });
      if (!res.ok) throw new Error("Failed to complete SLA timer");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete SLA timer");
    }
  }

  if (loading && notes.length === 0) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 64 }}>
        <div style={{ fontSize: 15, color: "var(--color-text-muted)" }}>Loading PM operations...</div>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div style={{ padding: "12px 16px", marginBottom: 16, borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#DC2626" }}>{error}</span>
          <button onClick={() => { setError(null); load(); }} style={{ fontSize: 12, padding: "4px 12px", borderRadius: 4, border: "1px solid #FECACA", background: "var(--color-surface)", color: "#DC2626", cursor: "pointer" }}>Retry</button>
        </div>
      )}
      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Open Requests", value: openRequests, color: openRequests > 5 ? "#DC2626" : "#C4A574" },
          { label: "Emergency", value: emergencyCount, color: emergencyCount > 0 ? "#DC2626" : "#16A34A" },
          { label: "Open Escalations", value: openEscalations, color: openEscalations > 0 ? "#EA580C" : "#16A34A" },
          { label: "Breached SLAs", value: breachedSLAs, color: breachedSLAs > 0 ? "#DC2626" : "#16A34A" },
          { label: "Active SLAs", value: activeSLAs, color: "#C4A574" },
          { label: "Avg Response", value: `${avgResponseHours}h`, color: avgResponseHours > 24 ? "#DC2626" : "#16A34A" },
          { label: "Maint Cost", value: fmtMoney(totalMaintCost), color: "#C4A574" },
        ].map(kpi => (
          <div key={kpi.label} style={{ background: "var(--color-surface)", borderRadius: 10, padding: "14px 16px", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{kpi.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, fontFamily: "var(--font-display)" }}>
              {typeof kpi.value === "number" ? kpi.value : kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Navigation + Filters */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["dashboard", "maintenance", "escalations", "notes", "sla"] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className="nav-btn" style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid var(--color-border)",
              background: view === v ? "var(--color-text)" : "var(--color-surface)", color: view === v ? "var(--color-surface)" : "var(--color-text)",
              fontSize: 13, cursor: "pointer", fontWeight: view === v ? 600 : 400,
            }}>
              {v === "dashboard" ? "Dashboard" : v === "maintenance" ? "Maintenance" : v === "sla" ? "SLA Timers" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {view === "maintenance" && <button onClick={() => setShowAddRequest(true)} style={{ padding: "6px 14px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", fontSize: 13, cursor: "pointer" }}>+ Request</button>}
          {view === "notes" && <button onClick={() => setShowAddNote(true)} style={{ padding: "6px 14px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", fontSize: 13, cursor: "pointer" }}>+ Note</button>}
          {view === "escalations" && <button onClick={() => setShowAddEscalation(true)} style={{ padding: "6px 14px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", fontSize: 13, cursor: "pointer" }}>+ Escalation</button>}
        </div>
      </div>

      <PropertySubTabs
        properties={properties}
        selected={propertyFilter}
        onSelect={setPropertyFilter}
        showAll={true}
        allLabel="All Properties"
      />

      {/* =============== DASHBOARD VIEW =============== */}
      {view === "dashboard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Critical Alerts */}
          <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Critical Alerts</h3>
            {maintenance.filter(m => m.priority === "emergency" && m.status !== "complete").length === 0 &&
              escalations.filter(e => e.priority === "critical" && e.status === "open").length === 0 &&
              slaTimers.filter(s => s.isBreached && !s.completedAt).length === 0 ? (
              <div style={{ color: "#16A34A", fontSize: 14, padding: 16, textAlign: "center" }}>All clear - no critical alerts</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {maintenance.filter(m => m.priority === "emergency" && m.status !== "complete").map(m => (
                  <div key={m.id} style={{ padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#DC2626" }}>EMERGENCY: {m.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{propName(m.propertyId)} {m.unitNumber ? `- ${m.unitNumber}` : ""} | {timeAgo(m.reportedAt)}</div>
                  </div>
                ))}
                {escalations.filter(e => e.priority === "critical" && e.status === "open").map(e => (
                  <div key={e.id} style={{ padding: "10px 12px", borderRadius: 8, background: "#FFF7ED", border: "1px solid #FED7AA" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#EA580C" }}>ESCALATION: {e.title}</div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{e.trigger} | {timeAgo(e.createdAt)}</div>
                  </div>
                ))}
                {slaTimers.filter(s => s.isBreached && !s.completedAt).map(s => (
                  <div key={s.id} style={{ padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#DC2626" }}>SLA BREACHED: {s.slaType.replace(/_/g, " ")}</div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{hoursElapsed(s.startedAt)}h elapsed (target: {s.targetHours}h) | {s.assignedTo || "Unassigned"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Maintenance */}
          <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Recent Requests</h3>
            {maintenance.slice(0, 6).map(m => (
              <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--color-surface-alt)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{m.title}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{propName(m.propertyId)} {m.unitNumber ? `- ${m.unitNumber}` : ""} | {m.category}</div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: (PRIORITY_COLORS[m.priority] || "#999") + "18", color: PRIORITY_COLORS[m.priority] || "#999", fontWeight: 600 }}>{m.priority}</span>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: (STATUS_COLORS[m.status] || "#999") + "18", color: STATUS_COLORS[m.status] || "#999", fontWeight: 600 }}>{m.status.replace(/_/g, " ")}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Active SLAs */}
          <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Active SLA Timers</h3>
            {slaTimers.filter(s => !s.completedAt).length === 0 ? (
              <div style={{ color: "var(--color-text-muted)", fontSize: 13, textAlign: "center", padding: 16 }}>No active SLA timers</div>
            ) : slaTimers.filter(s => !s.completedAt).slice(0, 6).map(s => {
              const elapsed = hoursElapsed(s.startedAt);
              const pct = Math.min(100, (elapsed / s.targetHours) * 100);
              return (
                <div key={s.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--color-surface-alt)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{s.slaType.replace(/_/g, " ")}</span>
                    <span style={{ fontSize: 12, color: s.isBreached ? "#DC2626" : elapsed > s.targetHours * 0.75 ? "#D97706" : "#16A34A", fontWeight: 600 }}>
                      {elapsed}h / {s.targetHours}h
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: "var(--color-surface-alt)" }}>
                    <div style={{ height: "100%", borderRadius: 2, width: `${pct}%`, background: s.isBreached ? "#DC2626" : pct > 75 ? "#D97706" : "#16A34A", transition: "width 0.3s" }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>{s.assignedTo || "Unassigned"}</div>
                </div>
              );
            })}
          </div>

          {/* Recent Notes */}
          <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Daily Notes</h3>
            {notes.slice(0, 6).map(n => (
              <div key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--color-surface-alt)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{n.author}</span>
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{n.date}</span>
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>{n.content.length > 120 ? n.content.slice(0, 120) + "..." : n.content}</div>
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: "#f5f0e8", color: "var(--color-text-muted)", marginTop: 4, display: "inline-block" }}>{n.category}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* =============== MAINTENANCE VIEW =============== */}
      {view === "maintenance" && (
        <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "left" }}>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Title</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Property</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Unit</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Category</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Priority</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Status</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Assigned</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Cost</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Reported</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {maintenance.map(m => (
                <tr key={m.id} style={{ borderBottom: "1px solid var(--color-surface-alt)" }}>
                  <td style={{ padding: "8px 6px", fontWeight: 500 }}>{m.title}</td>
                  <td style={{ padding: "8px 6px" }}>{propName(m.propertyId)}</td>
                  <td style={{ padding: "8px 6px" }}>{m.unitNumber || "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{m.category}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: (PRIORITY_COLORS[m.priority] || "#999") + "18", color: PRIORITY_COLORS[m.priority], fontWeight: 600 }}>{m.priority}</span>
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <select value={m.status} onChange={e => updateRequestStatus(m.id, e.target.value)} className="select-inline"
                      style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--color-border)", background: (STATUS_COLORS[m.status] || "#999") + "12", color: STATUS_COLORS[m.status] }}>
                      {["open", "assigned", "in_progress", "parts_ordered", "scheduled", "complete", "cancelled"].map(s => (
                        <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{m.assignedTo || "—"}</td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{m.actualCost ? fmtMoney(Number(m.actualCost)) : m.estimatedCost ? `~${fmtMoney(Number(m.estimatedCost))}` : "—"}</td>
                  <td style={{ padding: "8px 6px", fontSize: 11, color: "var(--color-text-muted)" }}>{timeAgo(m.reportedAt)}</td>
                  <td style={{ padding: "8px 6px" }}>
                    {m.status !== "complete" && m.status !== "cancelled" && (
                      <button onClick={() => updateRequestStatus(m.id, "complete")} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #16A34A", background: "#F0FDF4", color: "#16A34A", cursor: "pointer" }}>Complete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {maintenance.length === 0 && <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 32, fontSize: 14 }}>No maintenance requests</div>}
        </div>
      )}

      {/* =============== ESCALATIONS VIEW =============== */}
      {view === "escalations" && (
        <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "left" }}>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Title</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Trigger</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Priority</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Status</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Amount</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Escalated By</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>When</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {escalations.map(e => (
                <tr key={e.id} style={{ borderBottom: "1px solid var(--color-surface-alt)" }}>
                  <td style={{ padding: "8px 6px", fontWeight: 500 }}>{e.title}</td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{e.trigger.replace(/_/g, " ")}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: (PRIORITY_COLORS[e.priority] || "#999") + "18", color: PRIORITY_COLORS[e.priority], fontWeight: 600 }}>{e.priority}</span>
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: (STATUS_COLORS[e.status] || "#999") + "18", color: STATUS_COLORS[e.status], fontWeight: 600 }}>{e.status}</span>
                  </td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{e.spendAmount ? fmtMoney(Number(e.spendAmount)) : "—"}</td>
                  <td style={{ padding: "8px 6px", fontSize: 12 }}>{e.escalatedBy}</td>
                  <td style={{ padding: "8px 6px", fontSize: 11, color: "var(--color-text-muted)" }}>{timeAgo(e.createdAt)}</td>
                  <td style={{ padding: "8px 6px" }}>
                    {e.status === "open" && (
                      <button onClick={() => resolveEscalation(e.id)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #16A34A", background: "#F0FDF4", color: "#16A34A", cursor: "pointer" }}>Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {escalations.length === 0 && <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 32, fontSize: 14 }}>No escalations</div>}
        </div>
      )}

      {/* =============== NOTES VIEW =============== */}
      {view === "notes" && (
        <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
          {notes.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 32, fontSize: 14 }}>No PM notes yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {notes.map(n => (
                <div key={n.id} style={{ padding: "12px 16px", borderRadius: 8, background: "#FAFAF8", border: "1px solid var(--color-surface-alt)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{n.author}</span>
                      <span style={{ fontSize: 10, padding: "1px 8px", borderRadius: 10, background: "var(--color-border)", color: "var(--color-text-muted)" }}>{n.category}</span>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{n.date} | {propName(n.propertyId)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#333", lineHeight: 1.5 }}>{n.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* =============== SLA VIEW =============== */}
      {view === "sla" && (
        <div className="card" style={{ background: "var(--color-surface)", borderRadius: 10, padding: 20, border: "1px solid var(--color-border)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "left" }}>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>SLA Type</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Target</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Elapsed</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Progress</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Status</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Assigned</th>
                <th style={{ padding: "8px 6px", color: "var(--color-text-muted)", fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {slaTimers.map(s => {
                const elapsed = s.completedAt ? Math.round((new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()) / 3600000) : hoursElapsed(s.startedAt);
                const pct = Math.min(100, (elapsed / s.targetHours) * 100);
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid var(--color-surface-alt)" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 500 }}>{s.slaType.replace(/_/g, " ")}</td>
                    <td style={{ padding: "8px 6px" }}>{s.targetHours}h</td>
                    <td style={{ padding: "8px 6px", color: s.isBreached ? "#DC2626" : "#333" }}>{elapsed}h</td>
                    <td style={{ padding: "8px 6px", width: 120 }}>
                      <div style={{ height: 6, borderRadius: 3, background: "var(--color-surface-alt)", width: 100 }}>
                        <div style={{ height: "100%", borderRadius: 3, width: `${pct}%`, background: s.completedAt ? "#16A34A" : s.isBreached ? "#DC2626" : pct > 75 ? "#D97706" : "#C4A574" }} />
                      </div>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600,
                        background: s.completedAt ? "#F0FDF4" : s.isBreached ? "#FEF2F2" : "#FFF7ED",
                        color: s.completedAt ? "#16A34A" : s.isBreached ? "#DC2626" : "#D97706",
                      }}>{s.completedAt ? "Complete" : s.isBreached ? "Breached" : "Active"}</span>
                    </td>
                    <td style={{ padding: "8px 6px", fontSize: 12 }}>{s.assignedTo || "—"}</td>
                    <td style={{ padding: "8px 6px" }}>
                      {!s.completedAt && (
                        <button onClick={() => completeSlaTimer(s.id)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #16A34A", background: "#F0FDF4", color: "#16A34A", cursor: "pointer" }}>Complete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {slaTimers.length === 0 && <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 32, fontSize: 14 }}>No SLA timers</div>}
        </div>
      )}

      {/* =============== ADD NOTE MODAL =============== */}
      {showAddNote && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "var(--color-surface)", borderRadius: 12, padding: 24, width: 480, maxHeight: "80vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Add PM Note</h3>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); addNote(Object.fromEntries(fd) as Record<string, string>); }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <select name="propertyId" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input name="author" placeholder="Author" defaultValue="Admin" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                <input name="date" type="date" defaultValue={new Date().toISOString().split("T")[0]} required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                <select name="category" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                  {["general", "maintenance", "tenant", "leasing", "financial", "emergency"].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <textarea name="content" placeholder="Note content..." required rows={4} style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)", resize: "vertical" }} />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" onClick={() => setShowAddNote(false)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface)", cursor: "pointer" }}>Cancel</button>
                <button type="submit" style={{ padding: "8px 16px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", cursor: "pointer" }}>Add Note</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =============== ADD MAINTENANCE REQUEST MODAL =============== */}
      {showAddRequest && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "var(--color-surface)", borderRadius: 12, padding: 24, width: 520, maxHeight: "80vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>New Maintenance Request</h3>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); addRequest(Object.fromEntries(fd) as Record<string, string>); }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <select name="propertyId" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input name="unitNumber" placeholder="Unit # (optional)" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                  <input name="tenantName" placeholder="Tenant Name (optional)" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                </div>
                <input name="title" placeholder="Issue title" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                <textarea name="description" placeholder="Describe the issue..." required rows={3} style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)", resize: "vertical" }} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <select name="category" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                    {["plumbing", "electrical", "hvac", "appliance", "pest", "structural", "cosmetic", "emergency", "other"].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select name="priority" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                    {["low", "medium", "high", "emergency"].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input name="assignedTo" placeholder="Assign to..." style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                  <input name="estimatedCost" type="number" step="0.01" placeholder="Est. cost" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" onClick={() => setShowAddRequest(false)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface)", cursor: "pointer" }}>Cancel</button>
                <button type="submit" style={{ padding: "8px 16px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", cursor: "pointer" }}>Create Request</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =============== ADD ESCALATION MODAL =============== */}
      {showAddEscalation && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "var(--color-surface)", borderRadius: 12, padding: 24, width: 480, maxHeight: "80vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>New Escalation</h3>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.currentTarget); addEscalation(Object.fromEntries(fd) as Record<string, string>); }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <select name="propertyId" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                  <option value="">Company-wide</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input name="title" placeholder="Escalation title" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                <textarea name="description" placeholder="Details..." required rows={3} style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)", resize: "vertical" }} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <select name="priority" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                    {["low", "medium", "high", "critical"].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select name="trigger" required style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                    {["spend_over_limit", "rent_concession", "vendor_change", "tenant_issue", "emergency", "maintenance"].map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input name="escalatedBy" placeholder="Escalated by" required defaultValue="Admin" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                  <input name="spendAmount" type="number" step="0.01" placeholder="Spend amount (if applicable)" style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" onClick={() => setShowAddEscalation(false)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface)", cursor: "pointer" }}>Cancel</button>
                <button type="submit" style={{ padding: "8px 16px", borderRadius: 6, background: "#C4A574", color: "var(--color-surface)", border: "none", cursor: "pointer" }}>Create Escalation</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}