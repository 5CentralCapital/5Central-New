import { useCallback, useEffect, useState, useMemo } from "react";
import { PropertySubTabs } from "./shared/property-subtabs";

/* ── Types matching the EnrichedTenant shape from server/dashboard/rentmanager.ts ── */
interface RMProperty {
  PropertyID: number;
  Name: string;
  ShortName?: string;
  AddressLine1?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  IsActive?: boolean;
}

interface EnrichedTenant {
  TenantID: number;
  FirstName: string;
  LastName: string;
  Name: string;
  PropertyID: number;
  Status: string;
  UnitID: number | null;
  UnitName: string;
  MoveInDate: string | null;
  MoveOutDate: string | null;
  MonthlyRent: number;
  Balance: number;
  Bedrooms: number | null;
  Bathrooms: number | null;
}

interface RMCharge {
  ChargeID: number;
  AccountID: number;
  AccountType: string;
  Amount: number;
  TransactionDate?: string;
  TransactionType?: string;
  Comment?: string;
  ChargeTypeID?: number;
  PropertyID?: number;
  UnitID?: number;
  Reference?: string;
}

interface RMRecurringCharge {
  RecurringChargeID: number;
  EntityKeyID: number;
  TenantID: number;
  UnitID?: number;
  Amount: number;
  ChargeTypeID?: number;
  Comment?: string;
  Frequency?: number;
  FromDate?: string;
}

interface RMWorkOrder {
  ServiceManagerIssueID: number;
  PropertyID: number;
  UnitID?: number;
  TenantID?: number;
  Category?: string;
  Priority?: string;
  Status?: string;
  Description?: string;
  ReportedByName?: string;
  CreatedDate?: string;
  ClosedDate?: string;
}

interface RentRollData {
  property: any;
  units: any[];
  tenants: EnrichedTenant[];
  summary: {
    totalUnits: number;
    occupiedUnits: number;
    vacantUnits: number;
    occupancyRate: number;
    totalMonthlyRent: number;
    totalBalance: number;
  };
}

function fmtMoney(v: number) {
  return "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

const STATUS_COLORS: Record<string, string> = {
  Current: "var(--color-success)",
  Past: "var(--color-text-muted)",
  Future: "var(--color-accent)",
  Applicant: "var(--color-warning)",
  Eviction: "#e74c3c",
};

const PRIORITY_COLORS: Record<string, string> = {
  Emergency: "#e74c3c",
  High: "#e67e22",
  Normal: "var(--color-accent)",
  Low: "var(--color-text-muted)",
};

/* ── Hook to fetch RM properties ── */
let cachedRMProperties: RMProperty[] | null = null;

function useRMProperties() {
  const [properties, setProperties] = useState<RMProperty[]>(cachedRMProperties || []);
  const [loading, setLoading] = useState(!cachedRMProperties);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedRMProperties) {
      setProperties(cachedRMProperties);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/rm/properties", { credentials: "include" });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `Failed to load properties (${r.status})`);
        }
        const data = await r.json();
        if (Array.isArray(data) && !cancelled) {
          // Only show the 4 active 5Central Capital properties
          const ACTIVE_PROPERTY_IDS = new Set([30, 31, 32, 33]);
          const active = data.filter((p: RMProperty) => ACTIVE_PROPERTY_IDS.has(p.PropertyID));
          cachedRMProperties = active;
          setProperties(active);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { properties, loading, error };
}

/* ═══════════════════════════════════════════════════════════════ */
/*  TENANT MANAGEMENT — POWERED BY RENT MANAGER                   */
/* ═══════════════════════════════════════════════════════════════ */
export default function TenantManagement() {
  const { properties: rmProperties, loading: propsLoading, error: propsError } = useRMProperties();
  const [selectedPropId, setSelectedPropId] = useState<string>("all");
  const [rentRollData, setRentRollData] = useState<RentRollData | null>(null);
  const [allTenants, setAllTenants] = useState<EnrichedTenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<EnrichedTenant | null>(null);
  const [sortField, setSortField] = useState<string>("Unit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [activeTab, setActiveTab] = useState<"tenants" | "work-orders" | "delinquency">("tenants");
  const [workOrders, setWorkOrders] = useState<RMWorkOrder[]>([]);
  const [loadingWO, setLoadingWO] = useState(false);
  const [chargeTypeMap, setChargeTypeMap] = useState<Record<number, string>>({});
  const [leaseData, setLeaseData] = useState<Record<number, { MoveOutDate: string | null }>>({});

  const tabProperties = rmProperties.map(p => ({
    id: String(p.PropertyID),
    name: p.Name || p.ShortName || `Property ${p.PropertyID}`,
  }));

  /* ── Fetch rent roll for selected property ── */
  const loadRentRoll = useCallback(async () => {
    if (rmProperties.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      if (selectedPropId === "all") {
        const results = await Promise.all(
          rmProperties.map(p =>
            fetch(`/api/rm/rent-roll?propertyId=${p.PropertyID}`, { credentials: "include" })
              .then(r => r.ok ? r.json() : { tenants: [], units: [], summary: {} })
          )
        );
        const combinedTenants = results.flatMap((r: RentRollData) => r.tenants || []);
        setAllTenants(combinedTenants);
        const combined: RentRollData = {
          property: null,
          units: results.flatMap((r: RentRollData) => r.units || []),
          tenants: combinedTenants,
          summary: {
            totalUnits: results.reduce((s, r) => s + (r.summary?.totalUnits || 0), 0),
            occupiedUnits: results.reduce((s, r) => s + (r.summary?.occupiedUnits || 0), 0),
            vacantUnits: results.reduce((s, r) => s + (r.summary?.vacantUnits || 0), 0),
            occupancyRate: 0,
            totalMonthlyRent: results.reduce((s, r) => s + (r.summary?.totalMonthlyRent || 0), 0),
            totalBalance: results.reduce((s, r) => s + (r.summary?.totalBalance || 0), 0),
          },
        };
        if (combined.summary.totalUnits > 0) {
          combined.summary.occupancyRate = combined.summary.occupiedUnits / combined.summary.totalUnits;
        }
        setRentRollData(combined);
      } else {
        const r = await fetch(`/api/rm/rent-roll?propertyId=${selectedPropId}`, { credentials: "include" });
        if (!r.ok) throw new Error("Failed to load rent roll");
        const data: RentRollData = await r.json();
        setRentRollData(data);
        setAllTenants(data.tenants || []);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load rent roll");
    } finally {
      setLoading(false);
    }
  }, [rmProperties, selectedPropId]);

  useEffect(() => { loadRentRoll(); }, [loadRentRoll]);

  /* ── Fetch work orders ── */
  const loadWorkOrders = useCallback(async () => {
    if (rmProperties.length === 0) return;
    setLoadingWO(true);
    try {
      const propParam = selectedPropId !== "all" ? `?propertyId=${selectedPropId}` : "";
      const r = await fetch(`/api/rm/work-orders${propParam}`, { credentials: "include" });
      if (r.ok) setWorkOrders(await r.json());
    } catch { /* ignore */ } finally {
      setLoadingWO(false);
    }
  }, [rmProperties, selectedPropId]);

  useEffect(() => {
    if (activeTab === "work-orders") loadWorkOrders();
  }, [activeTab, loadWorkOrders]);

  // Fetch charge types (cached on server, fetch once)
  useEffect(() => {
    fetch("/api/rm/charge-types", { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(types => {
        if (Array.isArray(types)) {
          const map: Record<number, string> = {};
          types.forEach((t: any) => { map[t.ChargeTypeID] = t.Name; });
          setChargeTypeMap(map);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch leases for expiration warnings
  useEffect(() => {
    if (rmProperties.length === 0) return;
    const propParam = selectedPropId !== "all" ? `?propertyId=${selectedPropId}` : "";
    const fetchUrl = selectedPropId !== "all"
      ? `/api/rm/leases?propertyId=${selectedPropId}`
      : Promise.all(rmProperties.map(p =>
          fetch(`/api/rm/leases?propertyId=${p.PropertyID}`, { credentials: "include" })
            .then(r => r.ok ? r.json() : []).catch(() => [])
        )).then(results => results.flat());

    if (typeof fetchUrl === "string") {
      fetch(fetchUrl, { credentials: "include" })
        .then(r => r.ok ? r.json() : [])
        .then((leases: any[]) => {
          const map: Record<number, { MoveOutDate: string | null }> = {};
          leases.forEach((l: any) => {
            if (!map[l.TenantID] || l.LeaseID > (map[l.TenantID] as any)._id) {
              map[l.TenantID] = { MoveOutDate: l.MoveOutDate || null };
              (map[l.TenantID] as any)._id = l.LeaseID;
            }
          });
          setLeaseData(map);
        })
        .catch(() => {});
    } else {
      fetchUrl.then((leases: any[]) => {
        const map: Record<number, { MoveOutDate: string | null }> = {};
        leases.forEach((l: any) => {
          if (!map[l.TenantID] || l.LeaseID > (map[l.TenantID] as any)._id) {
            map[l.TenantID] = { MoveOutDate: l.MoveOutDate || null };
            (map[l.TenantID] as any)._id = l.LeaseID;
          }
        });
        setLeaseData(map);
      }).catch(() => {});
    }
  }, [rmProperties, selectedPropId]);

  // Compute delinquent tenants for the delinquency tab
  const delinquentTenants = useMemo(() => {
    return allTenants
      .filter(t => t.Balance > 0)
      .sort((a, b) => b.Balance - a.Balance);
  }, [allTenants]);

  // Helper: lease expiration badge
  const leaseExpirationBadge = (tenantId: number) => {
    const lease = leaseData[tenantId];
    if (!lease?.MoveOutDate) return null;
    const moveOut = new Date(lease.MoveOutDate);
    const now = new Date();
    const daysLeft = Math.ceil((moveOut.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0 || daysLeft > 60) return null;
    const isUrgent = daysLeft <= 30;
    return (
      <span style={{
        fontSize: 9, padding: "1px 6px", borderRadius: 4, marginLeft: 6,
        background: isUrgent ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
        color: isUrgent ? "#ef4444" : "#f59e0b",
        fontWeight: 600,
      }}>
        {daysLeft <= 0 ? "EXPIRED" : `${daysLeft}d`}
      </span>
    );
  };

  /* ── Sorting ── */
  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };
  const sortIcon = (field: string) => sortField !== field ? "" : sortDir === "asc" ? " ↑" : " ↓";

  const extractUnitNum = (name: string) => {
    const m = (name || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : 99999;
  };

  const sortedTenants = [...allTenants].sort((a, b) => {
    // When viewing all properties, always group by property first
    if (selectedPropId === "all" && sortField === "Unit") {
      if (a.PropertyID !== b.PropertyID) return a.PropertyID - b.PropertyID;
    }

    let av: any, bv: any;
    switch (sortField) {
      case "Unit": av = extractUnitNum(a.UnitName); bv = extractUnitNum(b.UnitName); break;
      case "Name": av = a.Name; bv = b.Name; break;
      case "Rent": av = a.MonthlyRent; bv = b.MonthlyRent; break;
      case "Balance": av = a.Balance || 0; bv = b.Balance || 0; break;
      case "Status": av = a.Status; bv = b.Status; break;
      default: av = ""; bv = "";
    }
    if (typeof av === "string") { av = av.toLowerCase(); bv = (bv as string).toLowerCase(); }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const summary = rentRollData?.summary || { totalUnits: 0, occupiedUnits: 0, vacantUnits: 0, occupancyRate: 0, totalMonthlyRent: 0, totalBalance: 0 };
  const propName = (id: number) => rmProperties.find(p => p.PropertyID === id)?.Name || `Property ${id}`;

  /* ── Not configured ── */
  if (propsError) {
    return (
      <section className="tenant-mgmt" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "var(--color-danger)" }}>Rent Manager Not Connected</div>
          <div style={{ fontSize: 13, color: "var(--color-text-muted)", lineHeight: 1.6 }}>
            {propsError}
            <br /><br />
            Add your Rent Manager credentials to the <code>.env</code> file:
            <br />
            <code style={{ fontSize: 11, background: "var(--color-surface)", padding: "4px 8px", borderRadius: 4, display: "inline-block", marginTop: 6 }}>
              RM_USERNAME=your_username<br />
              RM_PASSWORD=your_password
            </code>
          </div>
        </div>
      </section>
    );
  }

  /* ── Tenant detail view ── */
  if (selectedTenant) {
    return (
      <TenantDetail
        tenant={selectedTenant}
        propertyName={propName(selectedTenant.PropertyID)}
        onBack={() => { setSelectedTenant(null); loadRentRoll(); }}
        chargeTypeMap={chargeTypeMap}
      />
    );
  }

  return (
    <section className="tenant-mgmt" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Property pills */}
      <div className="card" style={{ padding: "12px 16px" }}>
        <PropertySubTabs
          selected={selectedPropId}
          onSelect={setSelectedPropId}
          properties={tabProperties}
          showAll
          allLabel="All Properties"
        />
        <div style={{ display: "flex", gap: 6 }}>
          {(["tenants", "delinquency", "work-orders"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "4px 14px", fontSize: 11, border: "1px solid",
                borderColor: activeTab === tab ? "var(--color-accent)" : "var(--color-border)",
                borderRadius: 14, cursor: "pointer",
                background: activeTab === tab ? "var(--color-accent)18" : "transparent",
                color: activeTab === tab ? (tab === "delinquency" && delinquentTenants.length > 0 ? "var(--color-danger)" : "var(--color-accent)") : "var(--color-text-muted)",
                fontWeight: activeTab === tab ? 600 : 400,
                transition: "all 0.15s ease",
              }}
            >
              {tab === "tenants" ? "Tenants & Rent Roll" : tab === "delinquency" ? `Delinquent (${delinquentTenants.length})` : "Work Orders"}
            </button>
          ))}
        </div>
      </div>

      {/* Stat bar */}
      <div className="tenant-stat-bar" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        {[
          { label: "Total Units", value: summary.totalUnits, color: "var(--color-accent)" },
          { label: "Occupied", value: summary.occupiedUnits, color: "var(--color-success)" },
          { label: "Vacant", value: summary.vacantUnits, color: "var(--color-danger)" },
          { label: "Occupancy", value: `${(summary.occupancyRate * 100).toFixed(0)}%`, color: summary.occupancyRate >= 0.9 ? "var(--color-success)" : "var(--color-warning)" },
          { label: "Monthly Rent", value: fmtMoney(summary.totalMonthlyRent), color: "var(--color-accent)" },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: "12px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: s.color, fontFamily: "var(--font-display)" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Error / Loading */}
      {error && <div className="card" style={{ padding: 16, color: "var(--color-danger)", fontSize: 13 }}>Error: {error}</div>}
      {(loading || propsLoading) && <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)", fontSize: 13 }}>Loading from Rent Manager...</div>}

      {/* ── TENANTS TAB ── */}
      {activeTab === "tenants" && !loading && (
        <div className="card" style={{ padding: 12, overflowX: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 4px" }}>
            <div className="label" style={{ fontSize: 13 }}>Live Rent Roll</div>
            <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
              Data from Rent Manager - {allTenants.length} tenant{allTenants.length !== 1 ? "s" : ""}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("Unit")}>Unit{sortIcon("Unit")}</th>
                {selectedPropId === "all" && <th>Property</th>}
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("Name")}>Tenant{sortIcon("Name")}</th>
                <th>Bed/Bath</th>
                <th>Move-In</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("Rent")}>Rent{sortIcon("Rent")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("Balance")}>Balance{sortIcon("Balance")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("Status")}>Status{sortIcon("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedTenants.length === 0 && (
                <tr><td colSpan={selectedPropId === "all" ? 8 : 7} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 24 }}>No tenants found</td></tr>
              )}
              {sortedTenants.map(t => (
                <tr
                  key={t.TenantID}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedTenant(t)}
                >
                  <td style={{ fontWeight: 500 }}>{t.UnitName}</td>
                  {selectedPropId === "all" && <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{propName(t.PropertyID)}</td>}
                  <td>{t.Name}</td>
                  <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    {t.Bedrooms != null ? `${t.Bedrooms}/${t.Bathrooms ?? "—"}` : "—"}
                  </td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>
                    {fmtDate(t.MoveInDate)}
                    {leaseExpirationBadge(t.TenantID)}
                  </td>
                  <td className="tabular-nums" style={{ fontWeight: 500, color: "var(--color-accent)" }}>
                    {fmtMoney(t.MonthlyRent)}
                  </td>
                  <td className="tabular-nums" style={{
                    fontWeight: t.Balance > 0 ? 600 : 400,
                    color: t.Balance > 0 ? "var(--color-danger)" : "var(--color-success)",
                  }}>
                    {t.Balance > 0 ? fmtMoney(t.Balance) : t.Balance < 0 ? `(${fmtMoney(t.Balance)})` : "$0"}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 4,
                      background: `${STATUS_COLORS[t.Status] || "var(--color-text-muted)"}15`,
                      color: STATUS_COLORS[t.Status] || "var(--color-text-muted)",
                      fontWeight: 600, letterSpacing: "0.04em",
                    }}>
                      {t.Status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── DELINQUENCY TAB ── */}
      {activeTab === "delinquency" && !loading && (
        <div className="card" style={{ padding: 12, overflowX: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 4px" }}>
            <div className="label" style={{ fontSize: 13, color: "var(--color-danger)" }}>Delinquent Tenants</div>
            <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
              {delinquentTenants.length} tenant{delinquentTenants.length !== 1 ? "s" : ""} with outstanding balance
              {delinquentTenants.length > 0 && (
                <span style={{ marginLeft: 8, fontWeight: 600, color: "var(--color-danger)" }}>
                  Total: ${delinquentTenants.reduce((s, t) => s + t.Balance, 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                {selectedPropId === "all" && <th>Property</th>}
                <th>Tenant</th>
                <th>Monthly Rent</th>
                <th>Balance Owed</th>
                <th>Months Behind</th>
                <th>Lease Expires</th>
              </tr>
            </thead>
            <tbody>
              {delinquentTenants.length === 0 && (
                <tr><td colSpan={selectedPropId === "all" ? 7 : 6} style={{ textAlign: "center", color: "var(--color-success)", padding: 24 }}>No delinquent tenants — all accounts current</td></tr>
              )}
              {delinquentTenants.map(t => {
                const monthsBehind = t.MonthlyRent > 0 ? t.Balance / t.MonthlyRent : 0;
                const lease = leaseData[t.TenantID];
                return (
                  <tr key={t.TenantID} style={{ cursor: "pointer" }} onClick={() => setSelectedTenant(t)}>
                    <td style={{ fontWeight: 500 }}>{t.UnitName}</td>
                    {selectedPropId === "all" && <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{propName(t.PropertyID)}</td>}
                    <td>{t.Name}</td>
                    <td className="tabular-nums">{fmtMoney(t.MonthlyRent)}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600, color: "var(--color-danger)" }}>{fmtMoney(t.Balance)}</td>
                    <td>
                      <span style={{
                        fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 600,
                        background: monthsBehind >= 2 ? "rgba(239,68,68,0.12)" : monthsBehind >= 1 ? "rgba(245,158,11,0.12)" : "rgba(96,165,250,0.12)",
                        color: monthsBehind >= 2 ? "#ef4444" : monthsBehind >= 1 ? "#f59e0b" : "#60a5fa",
                      }}>
                        {monthsBehind.toFixed(1)}x
                      </span>
                    </td>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>
                      {lease?.MoveOutDate ? fmtDate(lease.MoveOutDate) : "—"}
                      {leaseExpirationBadge(t.TenantID)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── WORK ORDERS TAB ── */}
      {activeTab === "work-orders" && (
        <div className="card" style={{ padding: 12, overflowX: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 4px" }}>
            <div className="label" style={{ fontSize: 13 }}>Maintenance / Work Orders</div>
            <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
              {workOrders.length} work order{workOrders.length !== 1 ? "s" : ""}
            </div>
          </div>
          {loadingWO ? (
            <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-muted)", fontSize: 13 }}>Loading work orders...</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Reported</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 24 }}>No work orders found</td></tr>
                )}
                {workOrders.map(wo => (
                  <tr key={wo.ServiceManagerIssueID}>
                    <td style={{ fontWeight: 500, fontSize: 11 }}>#{wo.ServiceManagerIssueID}</td>
                    <td>{wo.Category || "—"}</td>
                    <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {wo.Description || "—"}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 10, padding: "2px 8px", borderRadius: 4,
                        background: `${PRIORITY_COLORS[wo.Priority || ""] || "var(--color-text-muted)"}15`,
                        color: PRIORITY_COLORS[wo.Priority || ""] || "var(--color-text-muted)",
                        fontWeight: 600,
                      }}>
                        {wo.Priority || "—"}
                      </span>
                    </td>
                    <td>
                      <span style={{
                        fontSize: 10, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
                        background: wo.Status === "Open" ? "var(--color-warning)15" : "var(--color-success)15",
                        color: wo.Status === "Open" ? "var(--color-warning)" : "var(--color-success)",
                        fontWeight: 600,
                      }}>
                        {wo.Status || "—"}
                      </span>
                    </td>
                    <td style={{ fontSize: 11 }}>{wo.ReportedByName || "—"}</td>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{fmtDate(wo.CreatedDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}


/* ═══════════════════════════════════════════════════════════════ */
/*  TENANT DETAIL — with live charges & recurring charges          */
/* ═══════════════════════════════════════════════════════════════ */
function TenantDetail({
  tenant,
  propertyName,
  onBack,
  chargeTypeMap,
}: {
  tenant: EnrichedTenant;
  propertyName: string;
  onBack: () => void;
  chargeTypeMap?: Record<number, string>;
}) {
  const [transactions, setTransactions] = useState<(RMCharge & { _type: string })[]>([]);
  const [recurringCharges, setRecurringCharges] = useState<RMRecurringCharge[]>([]);
  const [loadingTxns, setLoadingTxns] = useState(true);
  const [loadingRecurring, setLoadingRecurring] = useState(true);
  const [notes, setNotes] = useState<any[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [showPostCharge, setShowPostCharge] = useState(false);
  const [showLogPayment, setShowLogPayment] = useState(false);
  const [showAddNote, setShowAddNote] = useState(false);
  const [formAmount, setFormAmount] = useState("");
  const [formDate, setFormDate] = useState(new Date().toISOString().split("T")[0]);
  const [formComment, setFormComment] = useState("");
  const [formChargeType, setFormChargeType] = useState(2); // default to Rent
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const ctMap = chargeTypeMap || {};

  useEffect(() => {
    const tid = tenant.TenantID;
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const fromDate = twelveMonthsAgo.toISOString().split("T")[0];

    // Fetch both charges and payments, then merge
    Promise.all([
      fetch(`/api/rm/charges?tenantId=${tid}&fromDate=${fromDate}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/rm/payments?tenantId=${tid}&fromDate=${fromDate}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([charges, payments]) => {
      const all = [
        ...(Array.isArray(charges) ? charges : []).map((c: any) => ({ ...c, _type: "Charge" })),
        ...(Array.isArray(payments) ? payments : []).map((p: any) => ({ ...p, _type: "Payment" })),
      ].sort((a, b) => (b.TransactionDate || "").localeCompare(a.TransactionDate || ""));
      setTransactions(all);
    }).finally(() => setLoadingTxns(false));

    fetch(`/api/rm/recurring-charges?tenantId=${tid}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(data => setRecurringCharges(Array.isArray(data) ? data : []))
      .catch(() => setRecurringCharges([]))
      .finally(() => setLoadingRecurring(false));
  }, [tenant.TenantID]);

  // Fetch history notes
  useEffect(() => {
    setLoadingNotes(true);
    fetch(`/api/rm/history-notes?tenantId=${tenant.TenantID}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(data => setNotes(Array.isArray(data) ? data : []))
      .catch(() => setNotes([]))
      .finally(() => setLoadingNotes(false));
  }, [tenant.TenantID]);

  // Reload transactions after posting a charge or payment
  const reloadTransactions = useCallback(() => {
    setLoadingTxns(true);
    const tid = tenant.TenantID;
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const fromDate = twelveMonthsAgo.toISOString().split("T")[0];
    Promise.all([
      fetch(`/api/rm/charges?tenantId=${tid}&fromDate=${fromDate}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/rm/payments?tenantId=${tid}&fromDate=${fromDate}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([charges, payments]) => {
      const all = [
        ...(Array.isArray(charges) ? charges : []).map((c: any) => ({ ...c, _type: "Charge" })),
        ...(Array.isArray(payments) ? payments : []).map((p: any) => ({ ...p, _type: "Payment" })),
      ].sort((a, b) => (b.TransactionDate || "").localeCompare(a.TransactionDate || ""));
      setTransactions(all);
    }).finally(() => setLoadingTxns(false));
  }, [tenant.TenantID]);

  // Submit handlers
  const submitCharge = async () => {
    const amount = parseFloat(formAmount);
    if (!amount || amount <= 0) { setFormMessage({ type: "error", text: "Enter a valid amount" }); return; }
    setFormSubmitting(true); setFormMessage(null);
    try {
      const r = await fetch("/api/rm/charges", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          AccountID: tenant.TenantID, AccountType: "Customer",
          ChargeTypeID: formChargeType, Amount: amount,
          TransactionDate: formDate, Comment: formComment || undefined,
        }),
      });
      if (!r.ok) throw new Error("Failed to post charge");
      setFormMessage({ type: "success", text: "Charge posted" });
      setFormAmount(""); setFormComment(""); setShowPostCharge(false);
      reloadTransactions();
    } catch (err: any) { setFormMessage({ type: "error", text: err.message }); }
    finally { setFormSubmitting(false); }
  };

  const submitPayment = async () => {
    const amount = parseFloat(formAmount);
    if (!amount || amount <= 0) { setFormMessage({ type: "error", text: "Enter a valid amount" }); return; }
    setFormSubmitting(true); setFormMessage(null);
    try {
      const r = await fetch("/api/rm/payments", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          AccountID: tenant.TenantID, AccountType: "Customer",
          Amount: amount, TransactionDate: formDate,
          Comment: formComment || undefined,
        }),
      });
      if (!r.ok) throw new Error("Failed to log payment");
      setFormMessage({ type: "success", text: "Payment logged" });
      setFormAmount(""); setFormComment(""); setShowLogPayment(false);
      reloadTransactions();
    } catch (err: any) { setFormMessage({ type: "error", text: err.message }); }
    finally { setFormSubmitting(false); }
  };

  const submitNote = async () => {
    if (!formComment.trim()) { setFormMessage({ type: "error", text: "Enter a note" }); return; }
    setFormSubmitting(true); setFormMessage(null);
    try {
      const r = await fetch("/api/rm/history-notes", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          EntityType: "Tenant", EntityKeyID: tenant.TenantID,
          Date: new Date().toISOString(), Note: formComment,
        }),
      });
      if (!r.ok) throw new Error("Failed to add note");
      setFormMessage({ type: "success", text: "Note added" });
      setFormComment(""); setShowAddNote(false);
      // Reload notes
      fetch(`/api/rm/history-notes?tenantId=${tenant.TenantID}`, { credentials: "include" })
        .then(r2 => r2.ok ? r2.json() : [])
        .then(data => setNotes(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (err: any) { setFormMessage({ type: "error", text: err.message }); }
    finally { setFormSubmitting(false); }
  };

  const infoRow = (label: string, value: string | number | undefined | null) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}>
      <span style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{value ?? "—"}</span>
    </div>
  );

  const totalChargesAmt = transactions.filter(t => t._type === "Charge").reduce((s, c) => s + (c.Amount || 0), 0);
  const totalPaymentsAmt = transactions.filter(t => t._type === "Payment").reduce((s, c) => s + (c.Amount || 0), 0);
  const monthlyTotal = recurringCharges.reduce((s, rc) => s + (rc.Amount || 0), 0);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button
        className="nav-btn"
        onClick={onBack}
        style={{ alignSelf: "flex-start", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
      >
        &larr; Back to Tenant List
      </button>

      {/* Header card */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", fontWeight: 600, color: "var(--color-text)" }}>
              {tenant.Name}
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
              {tenant.UnitName} - {propertyName}
              {tenant.Bedrooms != null && ` - ${tenant.Bedrooms}bd/${tenant.Bathrooms ?? "?"}ba`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{
              fontSize: 11, textTransform: "uppercase", padding: "4px 12px", borderRadius: 6,
              background: `${STATUS_COLORS[tenant.Status] || "var(--color-text-muted)"}15`,
              color: STATUS_COLORS[tenant.Status] || "var(--color-text-muted)",
              fontWeight: 600, letterSpacing: "0.04em",
            }}>
              {tenant.Status}
            </span>
            {tenant.Balance > 0 && (
              <span style={{
                fontSize: 11, padding: "4px 12px", borderRadius: 6,
                background: "var(--color-danger)15", color: "var(--color-danger)",
                fontWeight: 600,
              }}>
                Owes {fmtMoney(tenant.Balance)}
              </span>
            )}
            <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
              {([
                { label: "Post Charge", onClick: () => { setShowPostCharge(true); setShowLogPayment(false); setShowAddNote(false); setFormAmount(""); setFormComment(""); setFormMessage(null); }, color: "var(--color-danger)" },
                { label: "Log Payment", onClick: () => { setShowLogPayment(true); setShowPostCharge(false); setShowAddNote(false); setFormAmount(""); setFormComment(""); setFormMessage(null); }, color: "var(--color-success)" },
                { label: "Add Note", onClick: () => { setShowAddNote(true); setShowPostCharge(false); setShowLogPayment(false); setFormComment(""); setFormMessage(null); }, color: "var(--color-accent)" },
              ] as const).map(btn => (
                <button key={btn.label} onClick={btn.onClick} style={{
                  fontSize: 10, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                  background: `${btn.color}15`, color: btn.color, border: `1px solid ${btn.color}30`,
                  fontWeight: 600, transition: "all 0.15s ease",
                }}>{btn.label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Status message */}
      {formMessage && (
        <div className="card" style={{
          padding: "10px 16px", fontSize: 12, fontWeight: 500,
          color: formMessage.type === "success" ? "var(--color-success)" : "var(--color-danger)",
          background: formMessage.type === "success" ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
          border: `1px solid ${formMessage.type === "success" ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
        }}>
          {formMessage.text}
          <button onClick={() => setFormMessage(null)} style={{ marginLeft: 12, cursor: "pointer", fontSize: 11, color: "var(--color-text-muted)", background: "none", border: "none" }}>✕</button>
        </div>
      )}

      {/* Write forms */}
      {(showPostCharge || showLogPayment) && (
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10, color: showPostCharge ? "var(--color-danger)" : "var(--color-success)" }}>
            {showPostCharge ? "Post Charge" : "Log Payment"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}>Amount ($)</label>
              <input type="number" value={formAmount} onChange={e => setFormAmount(e.target.value)} placeholder="0.00"
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)" }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}>Date</label>
              <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)" }} />
            </div>
            {showPostCharge && (
              <div>
                <label style={{ fontSize: 10, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}>Charge Type</label>
                <select value={formChargeType} onChange={e => setFormChargeType(Number(e.target.value))}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)" }}>
                  {Object.entries(ctMap).length > 0
                    ? Object.entries(ctMap).map(([id, name]) => <option key={id} value={id}>{name}</option>)
                    : <option value={2}>Rent</option>
                  }
                </select>
              </div>
            )}
            {!showPostCharge && (
              <div>
                <label style={{ fontSize: 10, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}>Comment</label>
                <input type="text" value={formComment} onChange={e => setFormComment(e.target.value)} placeholder="Optional"
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)" }} />
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={showPostCharge ? submitCharge : submitPayment} disabled={formSubmitting}
                style={{
                  padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: formSubmitting ? "not-allowed" : "pointer",
                  background: showPostCharge ? "var(--color-danger)" : "var(--color-success)", color: "#fff", border: "none", opacity: formSubmitting ? 0.6 : 1,
                }}>
                {formSubmitting ? "..." : "Submit"}
              </button>
              <button onClick={() => { setShowPostCharge(false); setShowLogPayment(false); }}
                style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}>
                Cancel
              </button>
            </div>
          </div>
          {showPostCharge && (
            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 10, color: "var(--color-text-muted)", display: "block", marginBottom: 4 }}>Comment</label>
              <input type="text" value={formComment} onChange={e => setFormComment(e.target.value)} placeholder="Optional comment"
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)" }} />
            </div>
          )}
        </div>
      )}

      {showAddNote && (
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10, color: "var(--color-accent)" }}>Add Note</div>
          <div style={{ display: "flex", gap: 10, alignItems: "end" }}>
            <div style={{ flex: 1 }}>
              <textarea value={formComment} onChange={e => setFormComment(e.target.value)} placeholder="Enter note..."
                rows={3} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 13, background: "var(--color-surface)", color: "var(--color-text)", resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button onClick={submitNote} disabled={formSubmitting}
                style={{
                  padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: formSubmitting ? "not-allowed" : "pointer",
                  background: "var(--color-accent)", color: "#fff", border: "none", opacity: formSubmitting ? 0.6 : 1,
                }}>
                {formSubmitting ? "..." : "Save"}
              </button>
              <button onClick={() => setShowAddNote(false)}
                style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10 }}>Tenant Info</div>
          {infoRow("Name", tenant.Name)}
          {infoRow("Unit", tenant.UnitName)}
          {infoRow("Bed/Bath", tenant.Bedrooms != null ? `${tenant.Bedrooms}/${tenant.Bathrooms}` : undefined)}
          {infoRow("Move-In", fmtDate(tenant.MoveInDate))}
          {infoRow("Move-Out", fmtDate(tenant.MoveOutDate))}
          {infoRow("Status", tenant.Status)}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10 }}>Financial Summary</div>
          {infoRow("Current Balance", tenant.Balance > 0 ? fmtMoney(tenant.Balance) : tenant.Balance < 0 ? `(${fmtMoney(tenant.Balance)})` : "$0")}
          {infoRow("Monthly Rent", fmtMoney(tenant.MonthlyRent))}
          {infoRow("Total Charges (12mo)", fmtMoney(totalChargesAmt))}
          {infoRow("Total Payments (12mo)", fmtMoney(totalPaymentsAmt))}
          {infoRow("Tenant ID", tenant.TenantID)}
          {infoRow("Unit ID", tenant.UnitID)}
        </div>
      </div>

      {/* Recurring Charges */}
      <div className="card" style={{ padding: 16 }}>
        <div className="label" style={{ marginBottom: 10 }}>Recurring Charges</div>
        {loadingRecurring ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>Loading...</div>
        ) : recurringCharges.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>No recurring charges</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Amount</th>
                <th>Frequency</th>
                <th>From Date</th>
              </tr>
            </thead>
            <tbody>
              {recurringCharges.map(rc => (
                <tr key={rc.RecurringChargeID}>
                  <td>{rc.Comment || "Charge"}</td>
                  <td className="tabular-nums" style={{ fontWeight: 500 }}>{fmtMoney(rc.Amount)}</td>
                  <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                    {rc.Frequency === 1 ? "Monthly" : rc.Frequency === 12 ? "Annually" : `Every ${rc.Frequency} mo`}
                  </td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{fmtDate(rc.FromDate)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: "2px solid var(--color-border)" }}>
                <td style={{ fontWeight: 600 }}>Monthly Total</td>
                <td className="tabular-nums" style={{ fontWeight: 600 }}>{fmtMoney(monthlyTotal)}</td>
                <td colSpan={2}></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Transactions */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="label">Transactions (Last 12 Months)</div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{transactions.length} transaction{transactions.length !== 1 ? "s" : ""}</div>
        </div>
        {loadingTxns ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>Loading...</div>
        ) : transactions.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>No transactions found</div>
        ) : (
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((c, i) => (
                  <tr key={`${c._type}-${c.ChargeID || i}`}>
                    <td className="tabular-nums" style={{ fontSize: 11 }}>{fmtDate(c.TransactionDate)}</td>
                    <td>
                      <span style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 4,
                        background: c._type === "Charge" ? "var(--color-danger)15" : "var(--color-success)15",
                        color: c._type === "Charge" ? "var(--color-danger)" : "var(--color-success)",
                        fontWeight: 600,
                      }}>
                        {c._type}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {c.ChargeTypeID && ctMap[c.ChargeTypeID] ? (
                        <><span style={{ fontWeight: 500 }}>{ctMap[c.ChargeTypeID]}</span>{c.Comment ? ` — ${c.Comment}` : ""}</>
                      ) : (c.Comment || "—")}
                    </td>
                    <td className="tabular-nums" style={{
                      fontWeight: 500,
                      color: c._type === "Payment" ? "var(--color-success)" : "var(--color-text)",
                    }}>
                      {c._type === "Payment" ? `(${fmtMoney(c.Amount)})` : fmtMoney(c.Amount)}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{c.Reference || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Notes / History */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="label">History Notes</div>
          <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{notes.length} note{notes.length !== 1 ? "s" : ""}</div>
        </div>
        {loadingNotes ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>Loading...</div>
        ) : notes.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 16, textAlign: "center" }}>No history notes</div>
        ) : (
          <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {notes.map((note: any, i: number) => (
              <div key={note.HistoryNoteID || i} style={{
                padding: "8px 12px", borderRadius: 6, fontSize: 12,
                background: "var(--color-surface)", border: "1px solid var(--color-border)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontWeight: 500, color: "var(--color-text)" }}>{note.CreatedBy || "System"}</span>
                  <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{fmtDate(note.Date || note.CreateDate)}</span>
                </div>
                <div style={{ color: "var(--color-text-muted)", lineHeight: 1.5 }}>{note.Note || note.NoteText || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
