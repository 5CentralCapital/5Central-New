import { useCallback, useEffect, useState } from "react";

// ── Types matching backend VacancyReport ──
interface VacantUnit {
  UnitID: number;
  UnitName: string;
  PropertyID: number;
  PropertyName: string;
  Bedrooms: number | null;
  Bathrooms: number | null;
  LastMoveOutDate: string | null;
  DaysVacant: number;
  EstimatedMonthlyRent: number;
  LostRentTotal: number;
}

interface VacancyReport {
  vacantUnits: VacantUnit[];
  summary: {
    totalUnits: number;
    occupiedUnits: number;
    vacantUnits: number;
    occupancyRate: number;
    totalLostRent: number;
    avgDaysVacant: number;
  };
  marketRentByBedroom: Record<number, number>;
}

interface RentRollTenant {
  TenantID: number;
  Name: string;
  PropertyID: number;
  UnitID: number | null;
  UnitName: string;
  MoveInDate: string | null;
  MoveOutDate: string | null;
  MonthlyRent: number;
  Balance: number;
  Bedrooms: number | null;
  Bathrooms: number | null;
  Status: string;
}

interface RentRollResult {
  property: { PropertyID: string };
  units: any[];
  tenants: RentRollTenant[];
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
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const ACTIVE_PROPERTIES = [
  { id: "30", name: "MLK" },
  { id: "31", name: "Hickory" },
  { id: "32", name: "Sun Cove" },
  { id: "33", name: "Lucia" },
];

export default function LeaseUpControl() {
  const [selectedProp, setSelectedProp] = useState<string>("all");
  const [view, setView] = useState<"vacancies" | "rentroll">("vacancies");
  const [vacancyReport, setVacancyReport] = useState<VacancyReport | null>(null);
  const [rentRoll, setRentRoll] = useState<RentRollResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Load vacancy report (All or per-property) ──
  const loadVacancies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = selectedProp === "all"
        ? "/api/rm/vacancies"
        : `/api/rm/vacancies?propertyId=${selectedProp}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load vacancies (${res.status})`);
      const data: VacancyReport = await res.json();
      setVacancyReport(data);
    } catch (err: any) {
      setError(err.message || "Failed to load vacancy data");
    } finally {
      setLoading(false);
    }
  }, [selectedProp]);

  // ── Load rent roll for a specific property ──
  const loadRentRoll = useCallback(async () => {
    if (selectedProp === "all") {
      setRentRoll(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/rm/rent-roll?propertyId=${selectedProp}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load rent roll (${res.status})`);
      const data: RentRollResult = await res.json();
      setRentRoll(data);
    } catch (err: any) {
      setError(err.message || "Failed to load rent roll");
    } finally {
      setLoading(false);
    }
  }, [selectedProp]);

  useEffect(() => {
    if (view === "vacancies") loadVacancies();
    else loadRentRoll();
  }, [view, loadVacancies, loadRentRoll]);

  // ── Computed values ──
  const summary = vacancyReport?.summary;
  const vacantUnits = vacancyReport?.vacantUnits || [];
  const marketRents = vacancyReport?.marketRentByBedroom || {};

  // For rent roll view, compute from rent roll data
  const rrTenants = rentRoll?.tenants || [];
  const rrSummary = rentRoll?.summary;

  const urgencyColor = (days: number) =>
    days >= 30 ? "var(--color-danger)" : days >= 14 ? "var(--color-warning)" : "var(--color-success)";
  const urgencyLabel = (days: number) =>
    days >= 30 ? "CRITICAL" : days >= 14 ? "WATCH" : "OK";

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Property filter pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          className={`nav-btn ${selectedProp === "all" ? "active" : ""}`}
          onClick={() => setSelectedProp("all")}
          style={{ fontSize: 11 }}
        >
          All Properties
        </button>
        {ACTIVE_PROPERTIES.map((p) => (
          <button
            key={p.id}
            className={`nav-btn ${selectedProp === p.id ? "active" : ""}`}
            onClick={() => setSelectedProp(p.id)}
            style={{ fontSize: 11 }}
          >
            {p.name}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="card" style={{ padding: 10, borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)" }}>
          <div style={{ fontSize: 12, color: "var(--color-danger)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{error}</span>
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-danger)", fontSize: 14, padding: "0 4px" }}>×</button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 24, color: "var(--color-text-muted)", fontSize: 13 }}>
          Loading live data from Rent Manager...
        </div>
      )}

      {/* View tabs */}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className={`nav-btn ${view === "vacancies" ? "active" : ""}`}
          onClick={() => setView("vacancies")}
          style={{ fontSize: 11 }}
        >
          Vacancy Report
        </button>
        {selectedProp !== "all" && (
          <button
            className={`nav-btn ${view === "rentroll" ? "active" : ""}`}
            onClick={() => setView("rentroll")}
            style={{ fontSize: 11 }}
          >
            Rent Roll
          </button>
        )}
      </div>

      {/* ═══════ VACANCY VIEW ═══════ */}
      {view === "vacancies" && !loading && vacancyReport && (
        <>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
            <KPI
              label="Portfolio Occupancy"
              value={`${((summary?.occupancyRate || 0) * 100).toFixed(0)}%`}
              sub={`${summary?.occupiedUnits || 0}/${summary?.totalUnits || 0} units`}
              color={(summary?.occupancyRate || 0) < 0.75 ? "var(--color-danger)" : (summary?.occupancyRate || 0) < 0.9 ? "var(--color-warning)" : "var(--color-success)"}
            />
            <KPI
              label="Vacant Units"
              value={String(summary?.vacantUnits || 0)}
              color={(summary?.vacantUnits || 0) > 0 ? "var(--color-warning)" : "var(--color-success)"}
            />
            <KPI
              label="Avg Days Vacant"
              value={`${summary?.avgDaysVacant || 0}d`}
              color={(summary?.avgDaysVacant || 0) >= 30 ? "var(--color-danger)" : (summary?.avgDaysVacant || 0) >= 14 ? "var(--color-warning)" : "var(--color-success)"}
            />
            <KPI
              label="Total Lost Rent"
              value={fmtMoney(summary?.totalLostRent || 0)}
              color="var(--color-danger)"
            />
          </div>

          {/* Market rent reference */}
          {Object.keys(marketRents).length > 0 && (
            <div className="card" style={{ padding: 10 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 6 }}>
                Estimated Market Rent (avg of occupied units)
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {Object.entries(marketRents).sort(([a], [b]) => Number(a) - Number(b)).map(([beds, rent]) => (
                  <div key={beds} style={{ fontSize: 12 }}>
                    <span style={{ color: "var(--color-text-muted)" }}>{beds}BR:</span>{" "}
                    <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(rent)}/mo</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Vacancy alerts */}
          {vacantUnits.some((v) => v.DaysVacant >= 30) && (
            <div className="card" style={{ padding: 10, borderColor: "rgba(239,68,68,0.25)" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-danger)", marginBottom: 4, fontWeight: 600 }}>
                Critical Vacancies (30+ days)
              </div>
              {vacantUnits.filter((v) => v.DaysVacant >= 30).map((v) => (
                <div key={v.UnitID} style={{ fontSize: 12, color: "var(--color-text)", marginBottom: 2 }}>
                  <span style={{ color: "var(--color-danger)", fontWeight: 600, marginRight: 6 }}>
                    {v.DaysVacant}d
                  </span>
                  {v.PropertyName} — {v.UnitName} ({v.Bedrooms || "?"}BR/{v.Bathrooms || "?"}BA)
                  <span style={{ color: "var(--color-text-muted)", marginLeft: 8 }}>
                    ~{fmtMoney(v.LostRentTotal)} lost
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Vacant units table */}
          {vacantUnits.length > 0 ? (
            <div className="card" style={{ padding: 14 }}>
              <div className="label" style={{ marginBottom: 10 }}>
                Vacant Units{selectedProp === "all" ? " — All Properties" : ` — ${ACTIVE_PROPERTIES.find((p) => p.id === selectedProp)?.name}`}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      {selectedProp === "all" && <th>Property</th>}
                      <th>Unit</th>
                      <th>Type</th>
                      <th>Days Vacant</th>
                      <th>Urgency</th>
                      <th>Last Move-Out</th>
                      <th>Est. Rent</th>
                      <th>Lost Rent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vacantUnits.map((v) => (
                      <tr key={v.UnitID}>
                        {selectedProp === "all" && (
                          <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{v.PropertyName}</td>
                        )}
                        <td style={{ fontWeight: 600 }}>{v.UnitName}</td>
                        <td style={{ fontSize: 11 }}>
                          {v.Bedrooms ?? "?"}BR / {v.Bathrooms ?? "?"}BA
                        </td>
                        <td className="tabular-nums" style={{ fontWeight: 600, fontSize: 14, color: urgencyColor(v.DaysVacant) }}>
                          {v.DaysVacant}d
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: 10,
                              textTransform: "uppercase",
                              padding: "2px 6px",
                              borderRadius: 4,
                              color: urgencyColor(v.DaysVacant),
                              background: `${urgencyColor(v.DaysVacant)}12`,
                              border: `1px solid ${urgencyColor(v.DaysVacant)}33`,
                              fontWeight: 600,
                            }}
                          >
                            {urgencyLabel(v.DaysVacant)}
                          </span>
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {v.LastMoveOutDate
                            ? new Date(v.LastMoveOutDate).toLocaleDateString()
                            : "—"}
                        </td>
                        <td className="tabular-nums">{fmtMoney(v.EstimatedMonthlyRent)}/mo</td>
                        <td className="tabular-nums" style={{ color: "var(--color-danger)", fontWeight: 600 }}>
                          {fmtMoney(v.LostRentTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                      <td colSpan={selectedProp === "all" ? 6 : 5}>
                        TOTAL ({vacantUnits.length} vacant units)
                      </td>
                      <td className="tabular-nums">
                        {fmtMoney(vacantUnits.reduce((s, v) => s + v.EstimatedMonthlyRent, 0))}/mo
                      </td>
                      <td className="tabular-nums" style={{ color: "var(--color-danger)" }}>
                        {fmtMoney(summary?.totalLostRent || 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : (
            !loading && (
              <div className="card" style={{ padding: 24, textAlign: "center" }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🎉</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-success)" }}>
                  No Vacancies!
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
                  All units are currently occupied.
                </div>
              </div>
            )
          )}
        </>
      )}

      {/* ═══════ RENT ROLL VIEW (per-property only) ═══════ */}
      {view === "rentroll" && selectedProp !== "all" && !loading && rentRoll && (
        <>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
            <KPI
              label="Occupancy"
              value={`${((rrSummary?.occupancyRate || 0) * 100).toFixed(0)}%`}
              sub={`${rrSummary?.occupiedUnits || 0}/${rrSummary?.totalUnits || 0} units`}
              color={(rrSummary?.occupancyRate || 0) < 0.75 ? "var(--color-danger)" : (rrSummary?.occupancyRate || 0) < 0.9 ? "var(--color-warning)" : "var(--color-success)"}
            />
            <KPI label="Monthly Rent" value={fmtMoney(rrSummary?.totalMonthlyRent || 0)} />
            <KPI label="Vacant" value={String(rrSummary?.vacantUnits || 0)} color={(rrSummary?.vacantUnits || 0) > 0 ? "var(--color-warning)" : "var(--color-success)"} />
            <KPI label="Total Balance" value={fmtMoney(rrSummary?.totalBalance || 0)} color={(rrSummary?.totalBalance || 0) > 0 ? "var(--color-danger)" : "var(--color-success)"} />
          </div>

          {/* Rent roll table */}
          <div className="card" style={{ padding: 14 }}>
            <div className="label" style={{ marginBottom: 10 }}>
              Rent Roll — {ACTIVE_PROPERTIES.find((p) => p.id === selectedProp)?.name}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Type</th>
                    <th>Tenant</th>
                    <th>Move-In</th>
                    <th>Lease End</th>
                    <th>Rent</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rrTenants.map((t) => {
                    const leaseEnd = t.MoveOutDate ? new Date(t.MoveOutDate) : null;
                    const expiringSoon = leaseEnd && (leaseEnd.getTime() - Date.now()) / 86400000 < 60;
                    return (
                      <tr key={t.TenantID}>
                        <td style={{ fontWeight: 600 }}>{t.UnitName}</td>
                        <td style={{ fontSize: 11 }}>{t.Bedrooms ?? "?"}BR/{t.Bathrooms ?? "?"}BA</td>
                        <td>{t.Name}</td>
                        <td style={{ fontSize: 11 }}>
                          {t.MoveInDate ? new Date(t.MoveInDate).toLocaleDateString() : "—"}
                        </td>
                        <td
                          style={{
                            fontSize: 11,
                            color: expiringSoon ? "var(--color-danger)" : "inherit",
                            fontWeight: expiringSoon ? 600 : 400,
                          }}
                        >
                          {t.MoveOutDate ? new Date(t.MoveOutDate).toLocaleDateString() : "MTM"}
                          {expiringSoon && " ⚠"}
                        </td>
                        <td className="tabular-nums">{fmtMoney(t.MonthlyRent)}</td>
                        <td
                          className="tabular-nums"
                          style={{
                            color: t.Balance > 0 ? "var(--color-danger)" : "var(--color-success)",
                            fontWeight: t.Balance !== 0 ? 600 : 400,
                          }}
                        >
                          {t.Balance !== 0 ? fmtMoney(t.Balance) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600, borderTop: "2px solid var(--color-border)" }}>
                    <td colSpan={5}>TOTAL ({rrTenants.length} tenants)</td>
                    <td className="tabular-nums">{fmtMoney(rrSummary?.totalMonthlyRent || 0)}</td>
                    <td className="tabular-nums" style={{ color: (rrSummary?.totalBalance || 0) > 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                      {(rrSummary?.totalBalance || 0) !== 0 ? fmtMoney(rrSummary?.totalBalance || 0) : "—"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {/* When "All Properties" is selected and they switch to rent roll */}
      {view === "rentroll" && selectedProp === "all" && !loading && (
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Select a specific property to view its rent roll.
          </div>
        </div>
      )}
    </section>
  );
}

function KPI({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <article className="card interactive" style={{ padding: "10px 12px" }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-text-muted)", marginBottom: 2 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.2rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: color || "var(--color-text)",
          fontFamily: "var(--font-display)",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: "var(--color-text-muted)", marginTop: 1 }}>{sub}</div>}
    </article>
  );
}
