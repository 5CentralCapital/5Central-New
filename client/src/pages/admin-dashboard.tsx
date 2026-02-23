import { useEffect, useMemo, useState, useCallback, useRef, lazy, Suspense } from "react";
import "../styles/admin-dashboard.css";

// Lazy-load new module dashboards
const PayrollOps = lazy(() => import("../components/dashboard/payroll-ops"));
const RehabDetail = lazy(() => import("../components/dashboard/rehab-detail"));
const LeaseUpControl = lazy(() => import("../components/dashboard/lease-up"));
const PmOps = lazy(() => import("../components/dashboard/pm-ops"));
const InvestorCRM = lazy(() => import("../components/dashboard/investor-crm"));
const DealPipeline = lazy(() => import("../components/dashboard/deal-pipeline"));
const PropertyPL = lazy(() => import("../components/dashboard/property-pl"));
const TenantManagement = lazy(() => import("../components/dashboard/tenant-management"));
const PropertyDetailView = lazy(() => import("../components/dashboard/property-detail"));
const InvestorOverview = lazy(() => import("../components/dashboard/investor-overview"));

import { equityInvestors, mortgageObligations, getInvestorSummary } from "@/lib/investor-data";

// Dashboard types (inline to avoid external dependency)
interface TaskItem { id: string; title: string; dueDate?: string; cadence?: string; status: string; property?: string; module?: string; priority?: string; notes?: string; }
interface PropertyCard { id: string; name: string; address: string; city: string; state: string; units: number; acquisitionPrice: number; rehabBudget: number; totalBasis: number; currentValue: number; currentDebt: number; currentEquity: number; lender: string; interestRate: number; maturityDate: string; annualNOI: number; yieldOnCost: number; capRate: number; dscr: number; occupancyRate: number; occupiedUnits: number; phase: string; refiTarget?: string; refiProceeds?: number; }
interface RehabTracker { id: string; property: string; project: string; budget: number; spent: number; completionPct: number; status: string; targetDate?: string; notes?: string; }
interface OccupancyRecord { id: string; property: string; units: number; occupied: number; vacant: number; occupancyRate: number; monthlyRent: number; status: string; }
interface DebtMaturity { id: string; property: string; lender: string; balance: number; interestRate: number; maturityDate: string; daysUntilMaturity: number; urgency: string; refiTarget?: string; expectedProceeds?: number; }
interface GrowthMilestone { id: string; year: number; targetUnits: number; targetAUM: number; targetEquity: number; phase: string; status: string; }
interface BankAccount { id: string; plaidAccountId: string; name: string; officialName?: string; type: string; subtype: string; mask?: string; currentBalance: number; availableBalance?: number; currency: string; institution?: string; lastSynced?: string; }
interface BankTransaction { id: string; accountId: string; date: string; name: string; amount: number; category?: string[]; merchantName?: string; pending: boolean; }
interface DashboardData { tasks: TaskItem[]; metrics: any[]; properties: PropertyCard[]; rehab: RehabTracker[]; occupancy: OccupancyRecord[]; kpis: any[]; debt: DebtMaturity[]; growth: GrowthMilestone[]; activity: any[]; freshness?: any[]; diagnostics?: any[]; banking?: { accounts: BankAccount[]; recentTransactions: BankTransaction[]; connections: any[]; totalCash: number; }; }

interface RampSpending {
  totalSpent: number;
  transactionCount: number;
  byMerchant: { merchant: string; total: number; count: number }[];
  byCategory: { category: string; total: number; count: number }[];
  recentTransactions: { id: string; date: string; merchant: string; amount: number; category: string; memo: string | null; state: string; cardHolder: string }[];
}

/* ──────────────────────── Tab definitions ──────────────────────── */
type Tab =
  | "overview"
  | "portfolio"
  | "rehab"
  | "occupancy"
  | "debt"
  | "growth"
  | "ideas"
  | "diagnostics"
  | "payroll"
  | "rehab_detail"
  | "lease_up"
  | "pm_ops"
  | "investor_crm"
  | "deal_pipeline"
  | "property_pl"
  | "tenant_mgmt"
  | "investor_overview";

interface TabDef { key: Tab; label: string; icon: string }
interface TabGroup { label?: string; tabs: TabDef[] }

const tabGroups: TabGroup[] = [
  {
    tabs: [
      { key: "overview", label: "Command Center", icon: "⌘" },
    ],
  },
  {
    label: "Portfolio",
    tabs: [
      { key: "portfolio", label: "Portfolio", icon: "◆" },
      { key: "property_pl", label: "P&L", icon: "≡" },
      { key: "occupancy", label: "Occupancy", icon: "▦" },
    ],
  },
  {
    label: "Rehab",
    tabs: [
      { key: "rehab", label: "Rehab Tracker", icon: "⚒" },
      { key: "rehab_detail", label: "Rehab Detail", icon: "⊞" },
    ],
  },
  {
    label: "Tenants",
    tabs: [
      { key: "tenant_mgmt", label: "Tenant Mgmt", icon: "◉" },
      { key: "lease_up", label: "Lease-Up", icon: "◧" },
    ],
  },
  {
    label: "Operations",
    tabs: [
      { key: "payroll", label: "Payroll", icon: "⊕" },
      { key: "pm_ops", label: "PM Ops", icon: "⊘" },
    ],
  },
  {
    label: "Capital",
    tabs: [
      { key: "investor_overview", label: "Investor Overview", icon: "◈" },
      { key: "debt", label: "Capital & Debt", icon: "$" },
      { key: "investor_crm", label: "Investor CRM", icon: "◎" },
      { key: "deal_pipeline", label: "Deal Pipeline", icon: "↗" },
      { key: "growth", label: "Growth Plan", icon: "△" },
    ],
  },
  {
    label: "System",
    tabs: [
      { key: "ideas", label: "Ideas", icon: "✦" },
      { key: "diagnostics", label: "Diagnostics", icon: "⚙" },
    ],
  },
];

/* ──────────────────────── Helpers ──────────────────────── */
function fmt(v: number, format?: string): string {
  if (format === "currency") return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (format === "percent") return v.toFixed(1) + "%";
  if (format === "multiplier") return v.toFixed(3) + "x";
  return v.toLocaleString();
}

function fmtCompact(v: number): string {
  if (v >= 1_000_000_000) return "$" + (v / 1_000_000_000).toFixed(1) + "B";
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(0) + "K";
  return "$" + v.toLocaleString();
}

function urgencyColor(u: string) {
  if (u === "urgent") return "var(--color-danger)";
  if (u === "upcoming") return "var(--color-warning)";
  return "var(--color-success)";
}

function statusColor(s: string) {
  if (s === "critical") return "var(--color-danger)";
  if (s === "watch") return "var(--color-warning)";
  return "var(--color-success)";
}

function priorityColor(p?: string) {
  if (p === "critical") return "var(--color-danger)";
  if (p === "high") return "var(--color-warning)";
  if (p === "medium") return "var(--color-accent)";
  return "var(--color-text-muted)";
}

function phaseColor(p: string) {
  if (p === "rehab") return "var(--color-warning)";
  if (p === "lease_up") return "var(--color-accent-strong)";
  if (p === "stabilizing") return "var(--color-accent)";
  if (p === "stabilized") return "var(--color-success)";
  return "var(--color-text-muted)";
}

function daysFromNow(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

/* ──────────────────────── SVG Charts ──────────────────────── */

/* Donut chart - for occupancy, budget utilization, etc. */
function DonutChart({ value, max, label, size = 80, color = "var(--color-accent)" }: { value: number; max: number; label: string; size?: number; color?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dashoffset 0.8s ease" }} />
        <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central" fill="var(--color-text)" fontSize="14" fontWeight="600" fontFamily="var(--font-sans)">{pct.toFixed(0)}%</text>
      </svg>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

/* Horizontal bar chart for comparing properties */
function HBarChart({ items, maxVal }: { items: { label: string; value: number; color?: string }[]; maxVal?: number }) {
  const mx = maxVal || Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 80, fontSize: 11, color: "var(--color-text-muted)", textAlign: "right", flexShrink: 0 }}>{item.label}</div>
          <div style={{ flex: 1, height: 20, borderRadius: 4, background: "var(--color-surface-alt)", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, borderRadius: 4, width: `${(item.value / mx) * 100}%`, background: item.color || "var(--color-accent)", transition: "width 0.6s ease", minWidth: 2 }} />
          </div>
          <div style={{ width: 60, fontSize: 11, fontWeight: 500, textAlign: "right", flexShrink: 0 }} className="tabular-nums">{fmtCompact(item.value)}</div>
        </div>
      ))}
    </div>
  );
}

/* Mini sparkline bar for KPIs (current vs target) */
function ProgressBar({ current, target, color = "var(--color-accent)" }: { current: number; target: number; color?: string }) {
  const pct = target > 0 ? Math.min((current / target) * 100, 100) : 0;
  return (
    <div style={{ height: 4, borderRadius: 2, background: "var(--color-surface-alt)", marginTop: 6 }}>
      <div style={{ height: "100%", borderRadius: 2, width: `${pct}%`, background: color, transition: "width 0.5s ease" }} />
    </div>
  );
}

/* ──────────────────────── Main Component ──────────────────────── */
export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rampData, setRampData] = useState<RampSpending | null>(null);
  const [rampLoading, setRampLoading] = useState(false);
  const [rampError, setRampError] = useState<string | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<string | null>(null);
  const [selectedRehabProperty, setSelectedRehabProperty] = useState<string | null>(null);
  const [dbLoans, setDbLoans] = useState<{ id: string; propertyName: string; lender: string; balance: string; interestRate: string | null; monthlyPayment: string | null; maturityDate: string | null; status: string; loanType: string | null; notes: string | null }[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.includes("application/json")) {
        setData(await res.json());
      } else {
        // Backend not running — use empty shell so dashboard renders
        console.info("[DEV PREVIEW] Backend unreachable — using empty dashboard data");
        setData((prev) => prev || { tasks: [], metrics: [], properties: [], rehab: [], occupancy: [], kpis: [], debt: [], growth: [], activity: [] });
      }
    } catch {
      console.info("[DEV PREVIEW] Backend unreachable — using empty dashboard data");
      setData((prev) => prev || { tasks: [], metrics: [], properties: [], rehab: [], occupancy: [], kpis: [], debt: [], growth: [], activity: [] });
    }
  }, []);

  const loadRamp = useCallback(async () => {
    setRampLoading(true);
    setRampError(null);
    try {
      const res = await fetch("/api/ramp/transactions");
      if (!res.ok) {
        const err = await res.json();
        setRampError(err.error || "Failed to load Ramp data");
      } else {
        setRampData(await res.json());
      }
    } catch (e: any) {
      setRampError(e.message || "Network error");
    }
    setRampLoading(false);
  }, []);

  // Fetch loans from database for Command Center
  const loadLoans = useCallback(() => {
    fetch("/api/admin/loans", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) setDbLoans(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadLoans();
    const interval = setInterval(() => { load(); loadLoans(); }, 120_000);
    return () => clearInterval(interval);
  }, [load, loadLoans]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const save = useCallback(
    async (table: keyof DashboardData, payload: unknown, reason = "inline_edit") => {
      await fetch("/api/dashboard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table, data: payload, reason }),
      });
      await load();
    },
    [load]
  );

  const triggerRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetch("/api/dashboard/refresh", { method: "POST" });
    await load();
    setRefreshing(false);
  }, [load]);

  if (!data) {
    return (
      <div className="admin-dashboard">
        <main className="shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16, animation: "pulse 1.5s ease-in-out infinite", color: "var(--color-accent)" }}>⌘</div>
            <div style={{ fontSize: 14, color: "var(--color-text-muted)", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              Loading portfolio data…
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ── Computed (read-only — auto-calculated) ── */
  const totalUnits = data.properties.reduce((s, p) => s + p.units, 0);
  const totalNOI = data.properties.reduce((s, p) => s + p.annualNOI, 0);
  const totalDebt = data.debt.reduce((s, d) => s + d.balance, 0);
  const totalEquity = data.properties.reduce((s, p) => s + p.currentEquity, 0);
  const totalAUM = data.properties.reduce((s, p) => s + (p.currentValue || p.totalBasis), 0);
  const totalWeightedUnits = data.occupancy.reduce((s, o) => s + o.units, 0);
  const avgOcc = totalWeightedUnits > 0
    ? data.occupancy.reduce((s, o) => s + o.occupancyRate * o.units, 0) / totalWeightedUnits
    : 0;
  const avgDSCR = data.properties.length ? data.properties.reduce((s, p) => s + p.dscr, 0) / data.properties.length : 0;
  const urgentDebt = data.debt.filter((d) => d.urgency === "urgent");
  const criticalOcc = data.occupancy.filter((o) => o.status === "critical");
  const openTasks = data.tasks.filter((t) => t.status !== "done");
  const criticalTasks = openTasks.filter((t) => t.priority === "critical");
  const refiPipeline = data.debt.reduce((s, d) => s + (d.expectedProceeds || 0), 0);
  const totalOccupied = data.occupancy.reduce((s, o) => s + o.occupied, 0);
  const totalVacant = data.occupancy.reduce((s, o) => s + o.vacant, 0);

  return (
    <div className="admin-dashboard">
    <main className="shell" style={{ paddingBottom: 80 }}>
      {/* ═══════ HEADER ═══════ */}
      <header className="card" style={{ padding: "20px 24px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "1.6rem", fontWeight: 600, letterSpacing: "-0.02em" }}>
              <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>5Central</span>{" "}
              <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>Capital</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Portfolio Command Dashboard
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--color-text-muted)" }}>
              {data.freshness?.length
                ? data.freshness.map((f) => `${f.label}: ${new Date(f.at).toLocaleString()}`).join(" · ")
                : "Awaiting initial data sync"}
            </div>
          </div>
          <button onClick={triggerRefresh} className="nav-btn" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "inline-block", animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
            {refreshing ? "Syncing…" : "Refresh Data"}
          </button>
        </div>
      </header>

      {/* ═══════ NAV ═══════ */}
      <nav className="tab-nav" ref={navRef}>
        {tabGroups.map((group, gi) => {
          // Standalone tab (no label = no dropdown)
          if (!group.label) {
            const t = group.tabs[0];
            return (
              <button key={t.key} className={`nav-btn ${tab === t.key ? "active" : ""}`} onClick={() => { setTab(t.key); setOpenGroup(null); setSelectedProperty(null); setSelectedRehabProperty(null); }}>
                <span style={{ marginRight: 4, opacity: 0.7 }}>{t.icon}</span>{t.label}
              </button>
            );
          }

          // Dropdown group
          const isOpen = openGroup === group.label;
          const activeChild = group.tabs.find((t) => t.key === tab);
          const hasActive = !!activeChild;

          return (
            <div key={gi} className={`tab-dropdown ${isOpen ? "open" : ""}`}>
              <button
                className={`nav-btn tab-dropdown-trigger ${hasActive ? "group-active" : ""}`}
                onClick={() => setOpenGroup(isOpen ? null : (group.label ?? null))}
              >
                <span className="tab-dropdown-label">{group.label}</span>
                {activeChild && <span className="tab-dropdown-active-hint">{activeChild.label}</span>}
                <span className="tab-dropdown-chevron">{isOpen ? "▴" : "▾"}</span>
              </button>
              {isOpen && (
                <div className="tab-dropdown-menu">
                  {group.tabs.map((t) => (
                    <button
                      key={t.key}
                      className={`tab-dropdown-item ${tab === t.key ? "active" : ""}`}
                      onClick={() => { setTab(t.key); setOpenGroup(null); setSelectedProperty(null); setSelectedRehabProperty(null); }}
                    >
                      <span style={{ marginRight: 6, opacity: 0.6 }}>{t.icon}</span>{t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* ═══════ PROPERTY DETAIL VIEW ═══════ */}
      {selectedProperty && (() => {
        const sp = data.properties.find(p => p.name === selectedProperty);
        if (!sp) return null;
        return (
          <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Property Detail…</div>}>
            <PropertyDetailView
              propertyName={selectedProperty}
              property={sp}
              occupancy={data.occupancy.find(o => o.property === selectedProperty)}
              debt={data.debt.find(d => d.property === selectedProperty)}
              rehab={data.rehab.find(r => r.property === selectedProperty)}
              onBack={() => setSelectedProperty(null)}
            />
          </Suspense>
        );
      })()}

      {/* ═══════ OVERVIEW — KPIs + Tasks + Priorities + Charts ═══════ */}
      {tab === "overview" && !selectedProperty && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Hero KPIs — at the top */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
            <KPICard label="Units" value={String(totalUnits)} sub="across 4 properties" />
            <KPICard label="AUM" value={fmtCompact(totalAUM)} />
            <KPICard label="Total Equity" value={fmtCompact(totalEquity)} />
            <KPICard label="Annual NOI" value={fmtCompact(totalNOI)} />
            <KPICard label="Occupancy" value={avgOcc.toFixed(1) + "%"} color={avgOcc < 80 ? "var(--color-warning)" : "var(--color-success)"} />
            <KPICard label="Avg DSCR" value={avgDSCR.toFixed(3) + "x"} color={avgDSCR < 1.15 ? "var(--color-warning)" : "var(--color-accent)"} />
            <KPICard label="Total Debt" value={fmtCompact(totalDebt)} />
            <KPICard label="Refi Pipeline" value={fmtCompact(refiPipeline)} sub="expected cash-out" color="var(--color-accent)" />
          </div>

          {/* To-Do on left, Active Rehabs on right */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* TODAY'S TO-DO LIST */}
            <div className="card" style={{ padding: 14 }}>
              <div className="label" style={{ marginBottom: 8 }}>To-Do List</div>
              {openTasks
                .filter((t) => t.module === "reminders")
                .sort((a, b) => {
                  const po: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
                  return (po[a.priority || "low"] ?? 3) - (po[b.priority || "low"] ?? 3);
                })
                .slice(0, 12)
                .map((t) => (
                  <TaskRowCompact key={t.id} task={t} onToggle={() => {
                    save("tasks", data.tasks.map((x) => x.id === t.id ? { ...x, status: x.status === "done" ? "open" : "done" } : x), "task_toggle");
                  }} />
                ))}
              {openTasks.filter((t) => t.module === "reminders").length === 0 && (
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 8 }}>All caught up.</div>
              )}
            </div>

            {/* ACTIVE REHABS OVERVIEW */}
            <div className="card" style={{ padding: 14 }}>
              <div className="label" style={{ marginBottom: 10 }}>Active Rehabs</div>
              {data.rehab.filter(r => r.status !== "complete" && r.status !== "not_started").length === 0 && (
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 8 }}>No active rehabs.</div>
              )}
              {data.rehab
                .filter(r => r.status !== "complete" && r.status !== "not_started")
                .sort((a, b) => a.completionPct - b.completionPct)
                .map(r => {
                  const pctSpent = r.budget > 0 ? (r.spent / r.budget) * 100 : 0;
                  const overBudget = r.spent > r.budget;
                  return (
                    <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--color-border)", cursor: "pointer" }} onClick={() => setSelectedProperty(r.property)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <div>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{r.property}</span>
                          <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: 6 }}>{r.project}</span>
                        </div>
                        <span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, background: r.completionPct >= 80 ? "rgba(16,185,129,0.1)" : "rgba(196,165,116,0.1)", color: r.completionPct >= 80 ? "var(--color-success)" : "var(--color-accent)", fontWeight: 600 }}>
                          {r.completionPct}%
                        </span>
                      </div>
                      {/* Progress bar */}
                      <div style={{ height: 4, borderRadius: 2, background: "var(--color-border)", marginBottom: 4 }}>
                        <div style={{ height: "100%", borderRadius: 2, width: `${Math.min(r.completionPct, 100)}%`, background: r.completionPct >= 80 ? "var(--color-success)" : "var(--color-accent)", transition: "width 0.5s ease" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-muted)" }}>
                        <span>Budget: {fmtCompact(r.budget)}</span>
                        <span style={{ color: overBudget ? "var(--color-danger)" : "inherit" }}>Spent: {fmtCompact(r.spent)} ({pctSpent.toFixed(0)}%)</span>
                        {r.targetDate && <span>Target: {r.targetDate}</span>}
                      </div>
                    </div>
                  );
                })}
              {/* Rehab totals */}
              {(() => {
                const active = data.rehab.filter(r => r.status !== "complete" && r.status !== "not_started");
                if (active.length === 0) return null;
                const totalBudget = active.reduce((s, r) => s + r.budget, 0);
                const totalSpent = active.reduce((s, r) => s + r.spent, 0);
                return (
                  <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, fontSize: 11, fontWeight: 600 }}>
                    <span>Total: {fmtCompact(totalBudget)} budget</span>
                    <span style={{ color: totalSpent > totalBudget ? "var(--color-danger)" : "var(--color-accent)" }}>{fmtCompact(totalSpent)} spent</span>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Visual charts row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* Occupancy Donuts */}
            <div className="card" style={{ padding: 16 }}>
              <div className="label" style={{ marginBottom: 12 }}>Occupancy by Property</div>
              <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 12 }}>
                {data.occupancy.map((o) => (
                  <DonutChart key={o.id} value={o.occupied} max={o.units} label={o.property} size={72} color={o.occupancyRate >= 90 ? "var(--color-success)" : o.occupancyRate >= 75 ? "var(--color-accent)" : "var(--color-danger)"} />
                ))}
                <DonutChart value={totalOccupied} max={totalOccupied + totalVacant} label="Portfolio" size={72} color="var(--color-accent)" />
              </div>
            </div>

            {/* NOI by Property Bar Chart */}
            <div className="card" style={{ padding: 16 }}>
              <div className="label" style={{ marginBottom: 12 }}>Annual NOI by Property</div>
              <HBarChart items={data.properties.map((p) => ({ label: p.name.split(" ")[0], value: p.annualNOI, color: phaseColor(p.phase) }))} />
            </div>
          </div>

          {/* ═══ MONTHLY OBLIGATIONS & MORTGAGE SUMMARY ═══ */}
          {(() => {
            const inv = getInvestorSummary();
            // Use DB loans if available, fall back to static data
            const loanRows = dbLoans
              ? dbLoans.filter((l: any) => l.status === "active").map((l: any) => ({
                  property: l.propertyName,
                  lender: l.lender,
                  balance: parseFloat(l.balance) || 0,
                  interestRate: parseFloat(l.interestRate) || 0,
                  monthlyPI: parseFloat(l.monthlyPayment) || 0,
                  maturityDate: l.maturityDate || "TBD",
                }))
              : mortgageObligations;
            const totalMortBal = loanRows.reduce((s: number, m: any) => s + m.balance, 0);
            const totalMortMo = loanRows.reduce((s: number, m: any) => s + m.monthlyPI, 0);
            const totalMonthly = inv.totalEquityMonthly + totalMortMo;
            return (<>
              {/* Monthly Obligations Hero */}
              <div className="card" style={{ padding: 16, background: "linear-gradient(135deg, rgba(196,165,116,0.04) 0%, rgba(196,165,116,0.01) 100%)", borderColor: "rgba(196,165,116,0.2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                  <div className="label">Monthly Payment Obligations</div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)" }}>Total Due Monthly</div>
                    <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--color-accent)" }} className="tabular-nums">{fmtCompact(totalMonthly)}</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {/* Mortgage payments */}
                  <div style={{ padding: 12, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>Mortgage P&I</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)" }} className="tabular-nums">{fmtCompact(totalMortMo)}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{loanRows.length} loans · {fmtCompact(totalMortBal)} balance</div>
                  </div>
                  {/* Equity investor payments */}
                  <div style={{ padding: 12, borderRadius: 8, background: "var(--color-surface-alt)", border: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>Investor Pmts</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)" }} className="tabular-nums">{fmtCompact(inv.totalEquityMonthly)}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{inv.activeEquityCount} active · {fmtCompact(inv.totalAnnualInterest)}/yr interest</div>
                  </div>
                </div>
              </div>

              {/* Mortgage Detail + Investor Detail side by side */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {/* Mortgage by Property */}
                <div className="card" style={{ padding: 14 }}>
                  <div className="label" style={{ marginBottom: 10 }}>Mortgage Obligations by Property</div>
                  <table>
                    <thead>
                      <tr><th>Property</th><th>Lender</th><th>Balance</th><th>Rate</th><th>Monthly P&I</th><th>Maturity</th></tr>
                    </thead>
                    <tbody>
                      {loanRows.map((m: any, idx: number) => (
                        <tr key={m.property + idx}>
                          <td style={{ fontWeight: 500, fontSize: 11 }}>{m.property.replace(" Apartments", "")}</td>
                          <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{m.lender}</td>
                          <td className="tabular-nums" style={{ fontSize: 11 }}>{fmtCompact(m.balance)}</td>
                          <td className="tabular-nums" style={{ fontSize: 11 }}>{(m.interestRate * 100).toFixed(2)}%</td>
                          <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>${m.monthlyPI.toLocaleString()}</td>
                          <td className="tabular-nums" style={{ fontSize: 11 }}>{m.maturityDate}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                        <td colSpan={2}>Total</td>
                        <td className="tabular-nums">{fmtCompact(totalMortBal)}</td>
                        <td />
                        <td className="tabular-nums">${totalMortMo.toLocaleString()}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Investors with Monthly Payments */}
                <div className="card" style={{ padding: 14 }}>
                  <div className="label" style={{ marginBottom: 10 }}>Investors with Monthly Payments</div>
                  <table>
                    <thead>
                      <tr><th>Investor</th><th>Invested</th><th>Rate</th><th>Monthly Pmt</th><th>Payoff</th></tr>
                    </thead>
                    <tbody>
                      {equityInvestors.filter(i => i.monthlyPayment > 0).map(i => (
                        <tr key={i.name}>
                          <td style={{ fontWeight: 500, fontSize: 11 }}>{i.name}</td>
                          <td className="tabular-nums" style={{ fontSize: 11 }}>{fmtCompact(i.investedAmount)}</td>
                          <td className="tabular-nums" style={{ fontSize: 11 }}>{i.interestRate > 0 ? (i.interestRate * 100).toFixed(1) + "%" : "—"}</td>
                          <td className="tabular-nums" style={{ fontSize: 11, fontWeight: 600 }}>${i.monthlyPayment.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                          <td className="tabular-nums" style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{i.payoffDate}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                        <td>Total</td>
                        <td className="tabular-nums">{fmtCompact(equityInvestors.filter(i => i.monthlyPayment > 0).reduce((s, i) => s + i.investedAmount, 0))}</td>
                        <td />
                        <td className="tabular-nums">${inv.totalEquityMonthly.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </>);
          })()}

          {/* Property Summary Cards — 2 per row — clickable */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {data.properties.map((p) => (
              <PropertySummaryCard
                key={p.id}
                property={p}
                occupancy={data.occupancy.find((o) => o.property === p.name)}
                debt={data.debt.find((d) => d.property === p.name)}
                rehab={data.rehab.find((r) => r.property === p.name)}
                onClick={() => setSelectedProperty(p.name)}
              />
            ))}
          </div>

          {/* Debt Maturity Timeline */}
          <div className="card" style={{ padding: 14 }}>
            <div className="label" style={{ marginBottom: 10 }}>Debt Maturity Timeline</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
              {data.debt.sort((a, b) => a.daysUntilMaturity - b.daysUntilMaturity).map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: urgencyColor(d.urgency), flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12 }}>{d.property}</span>
                  <span style={{ fontSize: 18, fontWeight: 600, color: urgencyColor(d.urgency), width: 50, textAlign: "right" }} className="tabular-nums">{d.daysUntilMaturity}d</span>
                  <span style={{ fontSize: 10, color: "var(--color-text-muted)", width: 60, textAlign: "right" }}>{d.maturityDate}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Banking / Cash Position */}
          <BankingSection banking={data.banking} onRefresh={load} />

          {/* Ramp Card Spending */}
          <RampSection rampData={rampData} loading={rampLoading} error={rampError} onLoad={loadRamp} />
        </section>
      )}

      {/* ═══════ PORTFOLIO ═══════ */}
      {tab === "portfolio" && !selectedProperty && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Visual summary */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div className="card" style={{ padding: 16 }}>
              <div className="label" style={{ marginBottom: 10 }}>Equity Distribution</div>
              <HBarChart items={data.properties.map((p) => ({ label: p.name.split(" ")[0], value: p.currentEquity }))} />
            </div>
            <div className="card" style={{ padding: 16 }}>
              <div className="label" style={{ marginBottom: 10 }}>Debt by Property</div>
              <HBarChart items={data.properties.map((p) => ({ label: p.name.split(" ")[0], value: p.currentDebt, color: "var(--color-warning)" }))} />
            </div>
            <div className="card" style={{ padding: 16 }}>
              <div className="label" style={{ marginBottom: 10 }}>DSCR Coverage</div>
              <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 8 }}>
                {data.properties.map((p) => (
                  <DonutChart key={p.id} value={p.dscr * 100} max={200} label={p.name.split(" ")[0]} size={64} color={p.dscr < 1.15 ? "var(--color-warning)" : "var(--color-success)"} />
                ))}
              </div>
            </div>
          </div>

          {/* Portfolio table — calculated fields are READ-ONLY */}
          <div className="card" style={{ padding: 12, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Property</th><th>Units</th><th>Phase</th><th>ARV</th><th>NOI</th><th>DSCR</th>
                  <th>Yield</th><th>Occ%</th><th>Debt</th><th>Equity</th><th>Lender</th><th>Rate</th><th>Maturity</th>
                </tr>
              </thead>
              <tbody>
                {data.properties.map((p) => (
                  <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setSelectedProperty(p.name)}>
                    <td style={{ fontWeight: 500, color: "var(--color-accent)" }}>{p.name}</td>
                    <td className="tabular-nums">{p.units}</td>
                    <td><span style={{ color: phaseColor(p.phase), fontSize: 11, textTransform: "uppercase" }}>{p.phase.replace("_", " ")}</span></td>
                    <td className="tabular-nums">{fmtCompact(p.currentValue || p.totalBasis)}</td>
                    <td className="tabular-nums">{fmtCompact(p.annualNOI)}</td>
                    <td className="tabular-nums" style={{ color: p.dscr < 1.15 ? "var(--color-warning)" : "inherit" }}>{p.dscr.toFixed(2)}x</td>
                    <td className="tabular-nums">{p.yieldOnCost.toFixed(1)}%</td>
                    <td className="tabular-nums" style={{ color: p.occupancyRate < 75 ? "var(--color-danger)" : p.occupancyRate < 90 ? "var(--color-warning)" : "var(--color-success)" }}>{p.occupancyRate.toFixed(1)}%</td>
                    <td className="tabular-nums">{fmtCompact(p.currentDebt)}</td>
                    <td className="tabular-nums">{fmtCompact(p.currentEquity)}</td>
                    <td style={{ fontSize: 11 }}>{p.lender}</td>
                    <td className="tabular-nums">{p.interestRate.toFixed(2)}%</td>
                    <td style={{ fontSize: 11 }}>{p.maturityDate}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                  <td>Total</td>
                  <td className="tabular-nums">{totalUnits}</td>
                  <td />
                  <td className="tabular-nums">{fmtCompact(totalAUM)}</td>
                  <td className="tabular-nums">{fmtCompact(totalNOI)}</td>
                  <td className="tabular-nums">{avgDSCR.toFixed(2)}x</td>
                  <td />
                  <td className="tabular-nums">{avgOcc.toFixed(1)}%</td>
                  <td className="tabular-nums">{fmtCompact(totalDebt)}</td>
                  <td className="tabular-nums">{fmtCompact(totalEquity)}</td>
                  <td /><td /><td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {/* ═══════ REHAB ═══════ */}
      {tab === "rehab" && !selectedProperty && selectedRehabProperty && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Rehab Detail…</div>}>
          <RehabDetail initialPropertyName={selectedRehabProperty} onBack={() => setSelectedRehabProperty(null)} />
        </Suspense>
      )}
      {tab === "rehab" && !selectedProperty && !selectedRehabProperty && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Budget overview chart */}
          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 12 }}>Rehab Budget Utilization</div>
            <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 16 }}>
              {data.rehab.map((r) => (
                <div key={r.id} style={{ cursor: "pointer" }} onClick={() => setSelectedRehabProperty(r.property)}>
                  <DonutChart value={r.spent} max={r.budget} label={r.property} size={80} color={r.spent / r.budget > 0.9 ? "var(--color-danger)" : r.spent / r.budget > 0.7 ? "var(--color-warning)" : "var(--color-accent)"} />
                </div>
              ))}
            </div>
          </div>

          {data.rehab.map((r) => (
            <RehabCard key={r.id} item={r} onSave={(updated) => save("rehab", data.rehab.map((x) => (x.id === updated.id ? updated : x)), "rehab_edit")} onClick={() => setSelectedRehabProperty(r.property)} />
          ))}

          {/* Ramp Card Spending for Rehab */}
          <RampSection rampData={rampData} loading={rampLoading} error={rampError} onLoad={loadRamp} showDetails />
        </section>
      )}

      {/* ═══════ OCCUPANCY ═══════ */}
      {tab === "occupancy" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            {data.occupancy.map((o) => (
              <OccupancyCard key={o.id} item={o} />
            ))}
          </div>
          {/* Occupancy table — rate is calculated, rent/units are source data */}
          <div className="card" style={{ padding: 12, overflowX: "auto" }}>
            <table>
              <thead><tr><th>Property</th><th>Units</th><th>Occupied</th><th>Vacant</th><th>Occ Rate</th><th>Monthly Rent</th><th>Status</th></tr></thead>
              <tbody>
                {data.occupancy.map((o) => (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 500 }}>{o.property}</td>
                    <td className="tabular-nums">{o.units}</td>
                    <td className="tabular-nums">{o.occupied}</td>
                    <td className="tabular-nums">{o.vacant}</td>
                    <td className="tabular-nums" style={{ color: o.occupancyRate < 75 ? "var(--color-danger)" : o.occupancyRate < 90 ? "var(--color-warning)" : "var(--color-success)" }}>{o.occupancyRate.toFixed(1)}%</td>
                    <td className="tabular-nums">{fmtCompact(o.monthlyRent)}</td>
                    <td><span style={{ color: statusColor(o.status), fontSize: 11, textTransform: "uppercase" }}>{o.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ═══════ DEBT ═══════ */}
      {tab === "debt" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 10 }}>Refinance Pipeline — {fmtCompact(refiPipeline)} Expected Cash-Out</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              {data.debt.sort((a, b) => a.daysUntilMaturity - b.daysUntilMaturity).map((d) => (
                <div key={d.id} style={{ padding: 12, borderRadius: 8, border: `1px solid ${urgencyColor(d.urgency)}33`, background: `${urgencyColor(d.urgency)}08` }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{d.property}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6 }}>{d.lender} · {d.interestRate}% · {fmtCompact(d.balance)}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 20, fontWeight: 600, color: urgencyColor(d.urgency) }} className="tabular-nums">{d.daysUntilMaturity}d</span>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Refi target</div>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{d.refiTarget}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, marginTop: 6, color: "var(--color-accent)" }}>Cash-out: {fmtCompact(d.expectedProceeds || 0)}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Debt table — read-only since these are lender terms */}
          <div className="card" style={{ padding: 12, overflowX: "auto" }}>
            <table>
              <thead><tr><th>Property</th><th>Lender</th><th>Balance</th><th>Rate</th><th>Maturity</th><th>Urgency</th><th>Refi Target</th><th>Expected Proceeds</th></tr></thead>
              <tbody>
                {data.debt.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 500 }}>{d.property}</td>
                    <td>{d.lender}</td>
                    <td className="tabular-nums">{fmtCompact(d.balance)}</td>
                    <td className="tabular-nums">{d.interestRate}%</td>
                    <td>{d.maturityDate}</td>
                    <td><span style={{ color: urgencyColor(d.urgency), fontSize: 11, textTransform: "uppercase" }}>{d.urgency}</span></td>
                    <td>{d.refiTarget}</td>
                    <td className="tabular-nums">{fmtCompact(d.expectedProceeds || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ═══════ GROWTH ═══════ */}
      {tab === "growth" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 20 }}>
            <div className="label" style={{ marginBottom: 16 }}>Growth Trajectory — 55 → 2,000 Units</div>
            <GrowthTimeline milestones={data.growth} />
          </div>
          {/* Growth milestones — read-only strategic plan */}
          <div className="card" style={{ padding: 12, overflowX: "auto" }}>
            <table>
              <thead><tr><th>Year</th><th>Target Units</th><th>Target AUM</th><th>Target Equity</th><th>Phase</th><th>Status</th></tr></thead>
              <tbody>
                {data.growth.map((m) => (
                  <tr key={m.id}>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>{m.year}</td>
                    <td className="tabular-nums">{m.targetUnits}</td>
                    <td className="tabular-nums">{fmtCompact(m.targetAUM)}</td>
                    <td className="tabular-nums">{fmtCompact(m.targetEquity)}</td>
                    <td style={{ fontSize: 11 }}>{m.phase}</td>
                    <td>
                      <span style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, background: m.status === "completed" ? "rgba(16,185,129,0.12)" : m.status === "current" ? "rgba(196,165,116,0.12)" : "var(--color-border)", color: m.status === "completed" ? "var(--color-success)" : m.status === "current" ? "var(--color-accent)" : "var(--color-text-muted)" }}>
                        {m.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ═══════ IDEAS ═══════ */}
      {tab === "ideas" && (
        <TaskBoard
          items={data.tasks.filter((t) => t.module === "ideas_backlog")}
          allTasks={data.tasks}
          onSave={(updated) => save("tasks", updated, "ideas_edit")}
        />
      )}

      {/* ═══════ NEW MODULE TABS ═══════ */}
      {tab === "payroll" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Payroll Ops…</div>}>
          <PayrollOps />
        </Suspense>
      )}

      {tab === "rehab_detail" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Rehab Detail…</div>}>
          <RehabDetail />
        </Suspense>
      )}

      {tab === "tenant_mgmt" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Tenant Management…</div>}>
          <TenantManagement />
        </Suspense>
      )}

      {tab === "lease_up" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Lease-Up…</div>}>
          <LeaseUpControl />
        </Suspense>
      )}

      {tab === "pm_ops" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading PM Ops…</div>}>
          <PmOps />
        </Suspense>
      )}

      {tab === "investor_overview" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Investor Overview…</div>}>
          <InvestorOverview />
        </Suspense>
      )}

      {tab === "investor_crm" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Investor CRM…</div>}>
          <InvestorCRM />
        </Suspense>
      )}

      {tab === "deal_pipeline" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Deal Pipeline…</div>}>
          <DealPipeline />
        </Suspense>
      )}

      {tab === "property_pl" && (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>Loading Property P&L…</div>}>
          <PropertyPL />
        </Suspense>
      )}

      {/* ═══════ DIAGNOSTICS ═══════ */}
      {tab === "diagnostics" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 12 }}>Data Source Status</div>
            {(data.diagnostics || []).map((d) => (
              <div key={d.source} style={{ padding: "10px 0", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: d.lastError ? "var(--color-danger)" : d.lastSuccessAt ? "var(--color-success)" : "var(--color-text-muted)" }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{d.source.toUpperCase()}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    Rows: {d.rowCount} · Last sync: {d.lastSuccessAt ? new Date(d.lastSuccessAt).toLocaleString() : "never"}
                    {d.lastError && <span style={{ color: "var(--color-danger)" }}> · Error: {d.lastError}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 12 }}>OpenClaw Integration</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.8 }}>
              OpenClaw syncs at 9 AM &amp; 3 PM EST via API key auth (<code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>X-API-Key</code> header).<br />
              Endpoints: <code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>GET/POST/PATCH/DELETE /api/tasks</code>, <code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>GET/PUT /api/metrics</code>, <code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>POST /api/activity</code>, <code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>GET /api/dashboard/summary</code><br />
              Refresh returns live data: <code style={{ background: "var(--color-surface-alt)", padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>POST /api/dashboard/refresh</code>. Client polls every 2 min.
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 12 }}>All KPIs</div>
            <table>
              <thead><tr><th>KPI</th><th>Current</th><th>Previous</th><th>Target</th><th>Progress</th><th>Trend</th></tr></thead>
              <tbody>
                {data.kpis.map((k) => (
                  <tr key={k.id}>
                    <td style={{ fontWeight: 500 }}>{k.name}</td>
                    <td className="tabular-nums">{fmt(k.current, k.format)}</td>
                    <td className="tabular-nums" style={{ color: "var(--color-text-muted)" }}>{fmt(k.previous, k.format)}</td>
                    <td className="tabular-nums" style={{ color: "var(--color-accent)" }}>{fmt(k.target, k.format)}</td>
                    <td style={{ width: 80 }}><ProgressBar current={k.current} target={k.target} color={k.current >= k.target ? "var(--color-success)" : "var(--color-accent)"} /></td>
                    <td style={{ color: k.current >= k.previous ? "var(--color-success)" : "var(--color-danger)", fontWeight: 600 }}>
                      {k.current > k.previous ? "↑" : k.current < k.previous ? "↓" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="label" style={{ marginBottom: 10 }}>Full Activity Log</div>
            {data.activity.slice(0, 50).map((a) => (
              <div key={a.id} style={{ fontSize: 11, color: "var(--color-text-muted)", padding: "3px 0", borderBottom: "1px solid var(--color-border)" }}>
                <span style={{ color: "var(--color-accent)", marginRight: 6, fontSize: 10 }}>{new Date(a.ts).toLocaleString()}</span>
                <span style={{ color: "var(--color-text)", marginRight: 6 }}>{a.actor}</span>
                {a.action} — {a.detail}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
    </div>
  );
}

/* ──────────────────────── Sub-Components ──────────────────────── */

function KPICard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <article className="card interactive" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: color || "var(--color-text)", fontFamily: "var(--font-display)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>{sub}</div>}
    </article>
  );
}

function PropertySummaryCard({ property: p, occupancy: o, debt: d, rehab: r, onClick }: { property: PropertyCard; occupancy?: OccupancyRecord; debt?: DebtMaturity; rehab?: RehabTracker; onClick?: () => void }) {
  return (
    <article className="card interactive" style={{ padding: 14, cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{p.city}, {p.state} · {p.units} units</div>
        </div>
        <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4, border: `1px solid ${phaseColor(p.phase)}44`, color: phaseColor(p.phase), background: `${phaseColor(p.phase)}11` }}>
          {p.phase.replace("_", " ")}
        </span>
      </div>

      {o && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap", marginBottom: 3 }}>
            {Array.from({ length: p.units }).map((_, i) => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: 2, background: i < (o.occupied || 0) ? "var(--color-accent)" : "var(--color-border)", border: "1px solid var(--color-border)" }} />
            ))}
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{o.occupied}/{o.units} occupied · {fmtCompact(o.monthlyRent)}/mo</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, fontSize: 11, marginBottom: 6 }}>
        <div><span style={{ color: "var(--color-text-muted)" }}>NOI</span><br /><span className="tabular-nums" style={{ fontWeight: 500 }}>{fmtCompact(p.annualNOI)}</span></div>
        <div><span style={{ color: "var(--color-text-muted)" }}>DSCR</span><br /><span className="tabular-nums" style={{ fontWeight: 500, color: p.dscr < 1.15 ? "var(--color-warning)" : "inherit" }}>{p.dscr.toFixed(2)}x</span></div>
        <div><span style={{ color: "var(--color-text-muted)" }}>Yield</span><br /><span className="tabular-nums" style={{ fontWeight: 500 }}>{p.yieldOnCost.toFixed(1)}%</span></div>
      </div>

      {r && r.status !== "complete" && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}>
            <span style={{ color: "var(--color-text-muted)" }}>Rehab</span>
            <span className="tabular-nums">{r.completionPct}%</span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: "var(--color-border)" }}>
            <div style={{ height: "100%", borderRadius: 2, width: `${r.completionPct}%`, background: r.completionPct > 80 ? "var(--color-success)" : "var(--color-accent)", transition: "width 0.5s ease" }} />
          </div>
        </div>
      )}

      {d && (
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", paddingTop: 4, borderTop: "1px solid var(--color-border)" }}>
          {d.lender} · {d.interestRate}% · <span style={{ color: urgencyColor(d.urgency) }}>{d.daysUntilMaturity}d to maturity</span>
        </div>
      )}
    </article>
  );
}

/* Compact task row for overview - only status toggle, no inline editing */
function TaskRowCompact({ task: t, onToggle }: { task: TaskItem; onToggle: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid var(--color-border)" }}>
      <button onClick={onToggle} style={{
        width: 16, height: 16, borderRadius: 3, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "white", flexShrink: 0,
        border: `1px solid ${t.status === "done" ? "var(--color-success)" : "var(--color-border)"}`,
        background: t.status === "done" ? "var(--color-success)" : "transparent",
      }}>
        {t.status === "done" ? "✓" : ""}
      </button>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: priorityColor(t.priority), flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 12, textDecoration: t.status === "done" ? "line-through" : "none", opacity: t.status === "done" ? 0.4 : 1 }}>
        {t.title}
      </span>
      {t.dueDate && (
        <span style={{ fontSize: 9, color: daysFromNow(t.dueDate) <= 3 ? "var(--color-danger)" : "var(--color-text-muted)", flexShrink: 0 }} className="tabular-nums">
          {t.dueDate}
        </span>
      )}
    </div>
  );
}

function RehabCard({ item: r, onSave, onClick }: { item: RehabTracker; onSave: (updated: RehabTracker) => void; onClick?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r);

  return (
    <div className="card" style={{ padding: 16, cursor: onClick ? "pointer" : undefined }} onClick={(e) => { if (onClick && !editing && (e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "SELECT" && (e.target as HTMLElement).tagName !== "BUTTON") onClick(); }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{r.property}</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{r.project}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 6,
            background: r.status === "in_progress" ? "rgba(196,165,116,0.12)" : r.status === "complete" ? "rgba(16,185,129,0.12)" : r.status === "blocked" ? "rgba(239,68,68,0.12)" : "var(--color-border)",
            color: r.status === "in_progress" ? "var(--color-accent)" : r.status === "complete" ? "var(--color-success)" : r.status === "blocked" ? "var(--color-danger)" : "var(--color-text-muted)"
          }}>
            {r.status.replace("_", " ")}
          </span>
          <button className="nav-btn" style={{ fontSize: 10, padding: "3px 8px" }} onClick={(e) => {
            e.stopPropagation();
            if (editing) { onSave(draft); setEditing(false); } else { setDraft(r); setEditing(true); }
          }}>{editing ? "Save" : "Edit"}</button>
          {onClick && !editing && <button className="nav-btn" style={{ fontSize: 10, padding: "3px 8px" }} onClick={(e) => { e.stopPropagation(); onClick(); }}>View Detail →</button>}
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span className="tabular-nums">{fmtCompact(r.spent)} / {fmtCompact(r.budget)}</span>
          <span style={{ fontWeight: 600, color: "var(--color-accent)" }} className="tabular-nums">{r.completionPct}%</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--color-border)" }}>
          <div style={{ height: "100%", borderRadius: 4, width: `${r.completionPct}%`, background: "linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))", transition: "width 0.5s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-muted)", marginTop: 3 }}>
          <span>Budget variance: {((r.spent / r.budget) * 100 - r.completionPct).toFixed(1)}%</span>
          {r.targetDate && <span>Target: {r.targetDate}</span>}
        </div>
      </div>

      {editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
          {/* Editable: spent, completion %, notes — these are source data */}
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Spent ($)</span>
            <input className="inline-edit" type="number" value={draft.spent} onChange={(e) => setDraft({ ...draft, spent: +e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Completion %</span>
            <input className="inline-edit" type="number" value={draft.completionPct} onChange={(e) => setDraft({ ...draft, completionPct: +e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, gridColumn: "1/-1" }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Notes</span>
            <input className="inline-edit" value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>
        </div>
      ) : (
        r.notes && <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>{r.notes}</div>
      )}
    </div>
  );
}

function OccupancyCard({ item: o }: { item: OccupancyRecord }) {
  return (
    <div className="card interactive" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{o.property}</div>
        <span style={{ color: statusColor(o.status), fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, border: `1px solid ${statusColor(o.status)}33`, background: `${statusColor(o.status)}11` }}>
          {o.status}
        </span>
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
        {Array.from({ length: o.units }).map((_, i) => (
          <div key={i} style={{
            width: 16, height: 16, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7,
            background: i < o.occupied ? "var(--color-accent)" : "rgba(239,68,68,0.2)",
            border: i < o.occupied ? "1px solid var(--color-accent)" : "1px solid rgba(239,68,68,0.3)",
            color: i < o.occupied ? "white" : "var(--color-danger)"
          }}>
            {i < o.occupied ? "●" : "○"}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span className="tabular-nums" style={{ fontWeight: 600, fontSize: 18, color: o.occupancyRate < 75 ? "var(--color-danger)" : o.occupancyRate < 90 ? "var(--color-warning)" : "var(--color-success)" }}>{o.occupancyRate.toFixed(1)}%</span>
        <div style={{ textAlign: "right" }}>
          <div className="tabular-nums" style={{ fontWeight: 500 }}>{fmtCompact(o.monthlyRent)}/mo</div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{o.vacant} vacant</div>
        </div>
      </div>
    </div>
  );
}

function GrowthTimeline({ milestones }: { milestones: GrowthMilestone[] }) {
  const maxUnits = Math.max(...milestones.map((m) => m.targetUnits));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {milestones.map((m) => {
        const pct = (m.targetUnits / maxUnits) * 100;
        return (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 50, fontSize: 12, fontWeight: 600, textAlign: "right", flexShrink: 0 }} className="tabular-nums">{m.year}</div>
            <div style={{ flex: 1, position: "relative", height: 28 }}>
              <div style={{ position: "absolute", inset: 0, borderRadius: 6, background: "var(--color-border)" }} />
              <div style={{
                position: "absolute", top: 0, left: 0, bottom: 0, borderRadius: 6,
                width: `${Math.max(pct, 3)}%`,
                background: m.status === "completed" ? "var(--color-success)" : m.status === "current" ? "linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))" : "rgba(196,165,116,0.2)",
                transition: "width 0.6s ease",
                display: "flex", alignItems: "center", paddingLeft: 8
              }}>
                <span style={{ fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}>{m.targetUnits} units</span>
              </div>
            </div>
            <div style={{ width: 80, fontSize: 10, color: "var(--color-text-muted)", textAlign: "right", flexShrink: 0 }} className="tabular-nums">{fmtCompact(m.targetAUM)}</div>
            <div style={{ width: 70, fontSize: 10, flexShrink: 0 }}>
              <span style={{ padding: "1px 6px", borderRadius: 4, background: m.status === "completed" ? "rgba(16,185,129,0.12)" : m.status === "current" ? "rgba(196,165,116,0.12)" : "var(--color-border)", color: m.status === "completed" ? "var(--color-success)" : m.status === "current" ? "var(--color-accent)" : "var(--color-text-muted)" }}>
                {m.phase}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskBoard({ items, allTasks, onSave }: { items: TaskItem[]; allTasks: TaskItem[]; onSave: (rows: TaskItem[]) => void }) {
  const [filter, setFilter] = useState<"all" | "open" | "in_progress" | "done">("all");
  const filtered = filter === "all" ? items : items.filter((t) => t.status === filter);

  function updateTask(id: string, changes: Partial<TaskItem>) {
    onSave(allTasks.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }

  function addTask() {
    const newTask: TaskItem = {
      id: `t_${Date.now()}`,
      title: "New task",
      status: "open",
      property: "Portfolio-wide",
      module: items[0]?.module || "reminders",
      priority: "medium",
    };
    onSave([...allTasks, newTask]);
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["all", "open", "in_progress", "done"] as const).map((f) => (
            <button key={f} className="nav-btn" style={{ fontSize: 10, padding: "3px 10px" }} onClick={() => setFilter(f)}>
              {f === "all" ? `All (${items.length})` : f === "in_progress" ? "Active" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <button className="nav-btn" style={{ fontSize: 10, padding: "3px 10px" }} onClick={addTask}>+ Add</button>
      </div>

      {filtered
        .sort((a, b) => {
          const po: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
          return (po[a.priority || "low"] ?? 3) - (po[b.priority || "low"] ?? 3);
        })
        .map((t) => (
          <TaskRow key={t.id} task={t} onChange={(changes) => updateTask(t.id, changes)} />
        ))}
      {filtered.length === 0 && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: 12 }}>No tasks match this filter.</div>
      )}
    </div>
  );
}

function TaskRow({ task: t, onChange }: { task: TaskItem; onChange: (changes: Partial<TaskItem>) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ borderBottom: "1px solid var(--color-border)", padding: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => onChange({ status: t.status === "done" ? "open" : "done" })} style={{
          width: 18, height: 18, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "white", flexShrink: 0,
          border: `1px solid ${t.status === "done" ? "var(--color-success)" : "var(--color-border)"}`,
          background: t.status === "done" ? "var(--color-success)" : "transparent",
        }}>
          {t.status === "done" ? "✓" : ""}
        </button>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: priorityColor(t.priority), flexShrink: 0 }} />
        <span onClick={() => setExpanded(!expanded)} style={{ flex: 1, fontSize: 13, cursor: "pointer", textDecoration: t.status === "done" ? "line-through" : "none", opacity: t.status === "done" ? 0.5 : 1 }}>
          {t.title}
        </span>
        <span style={{ fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }}>{t.property}</span>
        {t.dueDate && <span style={{ fontSize: 10, color: daysFromNow(t.dueDate) <= 3 ? "var(--color-danger)" : "var(--color-text-muted)", flexShrink: 0 }} className="tabular-nums">{t.dueDate}</span>}
        <select className="select-inline" value={t.status} onChange={(e) => onChange({ status: e.target.value as TaskItem["status"] })}>
          <option value="open">Open</option>
          <option value="in_progress">Active</option>
          <option value="done">Done</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 32, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
          {/* Editable: title, property, due date, priority, notes — these are user inputs */}
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Title</span>
            <input className="inline-edit" value={t.title} onChange={(e) => onChange({ title: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Property</span>
            <input className="inline-edit" value={t.property} onChange={(e) => onChange({ property: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Due Date</span>
            <input className="inline-edit" type="date" value={t.dueDate || ""} onChange={(e) => onChange({ dueDate: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Priority</span>
            <select className="select-field" value={t.priority || "medium"} onChange={(e) => onChange({ priority: e.target.value as TaskItem["priority"] })}>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: "1/-1" }}>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Notes</span>
            <input className="inline-edit" value={t.notes || ""} onChange={(e) => onChange({ notes: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────── Banking Section ──────────────────────── */

function BankingSection({ banking, onRefresh }: { banking?: DashboardData["banking"]; onRefresh: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [plaidReady, setPlaidReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load Plaid Link script
  useEffect(() => {
    if (document.getElementById("plaid-link-script")) {
      setPlaidReady(true);
      return;
    }
    const script = document.createElement("script");
    script.id = "plaid-link-script";
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = () => setPlaidReady(true);
    document.head.appendChild(script);
  }, []);

  const connectBank = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/plaid/create-link-token", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setConnecting(false);
        return;
      }

      const handler = (window as any).Plaid.create({
        token: data.link_token,
        onSuccess: async (publicToken: string, metadata: any) => {
          await fetch("/api/plaid/exchange-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              public_token: publicToken,
              institution: metadata.institution,
            }),
          });
          // Immediately sync after connecting
          await fetch("/api/plaid/sync", { method: "POST" });
          onRefresh();
          setConnecting(false);
        },
        onExit: () => setConnecting(false),
      });
      handler.open();
    } catch (err: any) {
      setError(err.message || "Failed to connect");
      setConnecting(false);
    }
  }, [onRefresh]);

  const syncAccounts = useCallback(async () => {
    setSyncing(true);
    await fetch("/api/plaid/sync", { method: "POST" });
    onRefresh();
    setSyncing(false);
  }, [onRefresh]);

  const hasAccounts = banking?.accounts && banking.accounts.length > 0;
  const hasConnections = banking?.connections && banking.connections.length > 0;

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="label">Cash Position & Banking</div>
        <div style={{ display: "flex", gap: 6 }}>
          {hasConnections && (
            <button className="nav-btn" style={{ fontSize: 10, padding: "3px 10px" }} onClick={syncAccounts}>
              <span style={{ display: "inline-block", animation: syncing ? "spin 1s linear infinite" : "none", marginRight: 4 }}>↻</span>
              {syncing ? "Syncing…" : "Sync"}
            </button>
          )}
          <button className="nav-btn" style={{ fontSize: 10, padding: "3px 10px" }} onClick={connectBank} disabled={connecting || !plaidReady}>
            {connecting ? "Connecting…" : "+ Connect Bank"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: "var(--color-danger)", marginBottom: 8, padding: "6px 10px", borderRadius: 6, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
          {error}
        </div>
      )}

      {!hasAccounts ? (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>$</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>No bank accounts connected</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            Connect via Plaid for real-time cash balances and transaction tracking.
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 8, opacity: 0.6 }}>
            Click "Connect Bank" above to link your accounts via Plaid.
          </div>
        </div>
      ) : (
        <>
          {/* Total Cash */}
          <div style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--font-display)", color: "var(--color-accent)", marginBottom: 12 }} className="tabular-nums">
            {fmtCompact(banking!.totalCash)}
            <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontWeight: 400, marginLeft: 8 }}>total cash</span>
          </div>

          {/* Account cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginBottom: 12 }}>
            {banking!.accounts.map((a) => (
              <div key={a.id} style={{ padding: 10, borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{a.institution} {a.mask ? `···${a.mask}` : ""}</div>
                  </div>
                  <span style={{ fontSize: 9, textTransform: "uppercase", color: "var(--color-text-muted)", padding: "1px 4px", borderRadius: 3, background: "var(--color-border)" }}>{a.subtype}</span>
                </div>
                <div style={{ fontSize: 18, fontWeight: 600 }} className="tabular-nums">{fmtCompact(a.currentBalance)}</div>
                {a.availableBalance != null && a.availableBalance !== a.currentBalance && (
                  <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Available: {fmtCompact(a.availableBalance)}</div>
                )}
              </div>
            ))}
          </div>

          {/* Recent Transactions */}
          {banking!.recentTransactions.length > 0 && (
            <>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 6 }}>Recent Transactions</div>
              {banking!.recentTransactions.slice(0, 15).map((tx) => (
                <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--color-border)", fontSize: 12 }}>
                  <span style={{ width: 60, fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }} className="tabular-nums">{tx.date}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.merchantName || tx.name}</span>
                  {tx.pending && <span style={{ fontSize: 8, color: "var(--color-warning)", textTransform: "uppercase" }}>pending</span>}
                  <span style={{ fontWeight: 500, color: tx.amount > 0 ? "var(--color-danger)" : "var(--color-success)", flexShrink: 0 }} className="tabular-nums">
                    {tx.amount > 0 ? "-" : "+"}{fmtCompact(Math.abs(tx.amount))}
                  </span>
                </div>
              ))}
            </>
          )}

          {/* Connection status */}
          {banking!.connections.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
              {banking!.connections.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--color-text-muted)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.status === "active" ? "var(--color-success)" : "var(--color-danger)" }} />
                  {c.institutionName} · {c.accountCount} accounts
                  {c.lastSynced && <span>· Synced {new Date(c.lastSynced).toLocaleTimeString()}</span>}
                  {c.error && <span style={{ color: "var(--color-danger)" }}>· {c.error}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ──────────────────────── Ramp Spending Section ──────────────────────── */

function RampSection({ rampData, loading, error, onLoad, showDetails = false }: {
  rampData: RampSpending | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  showDetails?: boolean;
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="label">Ramp Card Spending</div>
        <button className="nav-btn" style={{ fontSize: 10, padding: "3px 10px" }} onClick={onLoad} disabled={loading}>
          <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none", marginRight: 4 }}>↻</span>
          {loading ? "Loading…" : rampData ? "Refresh" : "Load Ramp Data"}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: "var(--color-danger)", marginBottom: 8, padding: "6px 10px", borderRadius: 6, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
          {error}
        </div>
      )}

      {!rampData && !loading && !error && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>$</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>Click "Load Ramp Data" to pull corporate card transactions</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            Tracks rehab spending by merchant and category from your Ramp corporate cards.
          </div>
        </div>
      )}

      {rampData && (
        <>
          {/* Summary KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div style={{ padding: 12, borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 4 }}>Total Spent</div>
              <div style={{ fontSize: 24, fontWeight: 600, fontFamily: "var(--font-display)", color: "var(--color-accent)" }} className="tabular-nums">
                {fmtCompact(rampData.totalSpent)}
              </div>
            </div>
            <div style={{ padding: 12, borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 4 }}>Transactions</div>
              <div style={{ fontSize: 24, fontWeight: 600, fontFamily: "var(--font-display)" }} className="tabular-nums">
                {rampData.transactionCount}
              </div>
            </div>
          </div>

          {/* Spending by Category */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 8 }}>By Category</div>
            <HBarChart items={rampData.byCategory.slice(0, 8).map((c) => ({ label: c.category.length > 14 ? c.category.slice(0, 14) + "…" : c.category, value: c.total }))} />
          </div>

          {/* Top Merchants */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 8 }}>Top Merchants</div>
            <HBarChart items={rampData.byMerchant.slice(0, 8).map((m) => ({ label: m.merchant.length > 14 ? m.merchant.slice(0, 14) + "…" : m.merchant, value: m.total, color: "var(--color-accent-strong)" }))} />
          </div>

          {/* Recent Transactions - only on detailed view (Rehab tab) */}
          {showDetails && rampData.recentTransactions.length > 0 && (
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 6 }}>Recent Transactions</div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr><th>Date</th><th>Merchant</th><th>Category</th><th>Amount</th><th>Cardholder</th><th>Memo</th></tr>
                  </thead>
                  <tbody>
                    {rampData.recentTransactions.slice(0, 25).map((tx) => (
                      <tr key={tx.id}>
                        <td className="tabular-nums" style={{ fontSize: 11 }}>{tx.date}</td>
                        <td style={{ fontWeight: 500, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.merchant}</td>
                        <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{tx.category}</td>
                        <td className="tabular-nums" style={{ fontWeight: 500, color: tx.amount > 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                          {tx.amount > 0 ? "-" : "+"}{fmtCompact(Math.abs(tx.amount))}
                        </td>
                        <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{tx.cardHolder}</td>
                        <td style={{ fontSize: 11, color: "var(--color-text-muted)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.memo || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
