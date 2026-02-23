import { useCallback, useEffect, useState } from "react";
import { PropertySubTabs, useProperties, type Property } from "./shared/property-subtabs";

/* ── Types ── */
interface Tenant {
  id: string;
  propertyId: string;
  unitNumber: string;
  bedrooms?: number;
  bathrooms?: string;
  sqft?: number;
  tenantName?: string;
  leaseStart?: string;
  leaseEnd?: string;
  monthlyRent?: string;
  marketRent?: string;
  securityDeposit?: string;
  status: string;
  moveInDate?: string;
  moveOutDate?: string;
  notes?: string;
}

function fmtMoney(v: number) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const STATUS_COLORS: Record<string, string> = {
  occupied: "var(--color-success)",
  vacant: "var(--color-danger)",
  notice: "var(--color-warning)",
  eviction: "#e74c3c",
  renovation: "var(--color-accent)",
};

const STATUS_OPTIONS = ["occupied", "vacant", "notice", "eviction", "renovation"];

/* ═══════════════════════════════════════════════════════════════ */
/*  TENANT MANAGEMENT                                             */
/* ═══════════════════════════════════════════════════════════════ */
export default function TenantManagement() {
  const { properties, loading: propsLoading } = useProperties();
  const [selectedProp, setSelectedProp] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [sortField, setSortField] = useState<string>("unitNumber");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  /* ── Fetch tenants across all properties ── */
  const loadTenants = useCallback(async () => {
    if (properties.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const propsToFetch = selectedProp === "all" ? properties : properties.filter(p => p.id === selectedProp);
      const results = await Promise.all(
        propsToFetch.map(p => fetch(`/api/lease-up/${p.id}/units`, { credentials: "include" }).then(r => r.ok ? r.json() : []))
      );
      setTenants(results.flat());
    } catch (err: any) {
      setError(err.message || "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }, [properties, selectedProp]);

  useEffect(() => { loadTenants(); }, [loadTenants]);

  /* ── Sorting ── */
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  /* ── Filter + sort tenants ── */
  const filtered = tenants
    .filter(t => statusFilter === "all" || t.status === statusFilter)
    .sort((a, b) => {
      let av: any = (a as any)[sortField] ?? "";
      let bv: any = (b as any)[sortField] ?? "";
      if (sortField === "monthlyRent" || sortField === "marketRent") {
        av = parseFloat(av) || 0;
        bv = parseFloat(bv) || 0;
      }
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

  /* ── Summary stats ── */
  const totalUnits = tenants.length;
  const occupied = tenants.filter(t => t.status === "occupied").length;
  const vacant = tenants.filter(t => t.status === "vacant").length;
  const avgRent = occupied > 0
    ? tenants.filter(t => t.status === "occupied" && t.monthlyRent)
        .reduce((s, t) => s + (parseFloat(t.monthlyRent!) || 0), 0) / occupied
    : 0;

  /* ── Property name lookup ── */
  const propName = (id: string) => properties.find(p => p.id === id)?.name || "—";

  /* ── If a tenant is selected, show detail view ── */
  if (selectedTenant) {
    return (
      <TenantDetail
        tenant={selectedTenant}
        propertyName={propName(selectedTenant.propertyId)}
        onBack={() => { setSelectedTenant(null); loadTenants(); }}
        onUpdate={(updated) => setSelectedTenant(updated)}
      />
    );
  }

  /* ── Sort indicator ── */
  const sortIcon = (field: string) => {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  return (
    <section className="tenant-mgmt" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Property pills */}
      <div className="card" style={{ padding: "12px 16px" }}>
        <PropertySubTabs
          selected={selectedProp}
          onSelect={setSelectedProp}
          properties={properties}
          showAll
          allLabel="All Properties"
        />

        {/* Status filter pills */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["all", ...STATUS_OPTIONS].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: "4px 14px",
                fontSize: 11,
                border: "1px solid",
                borderColor: statusFilter === s ? (STATUS_COLORS[s] || "var(--color-accent)") : "var(--color-border)",
                borderRadius: 14,
                cursor: "pointer",
                background: statusFilter === s ? `${STATUS_COLORS[s] || "var(--color-accent)"}18` : "transparent",
                color: statusFilter === s ? (STATUS_COLORS[s] || "var(--color-accent)") : "var(--color-text-muted)",
                fontWeight: statusFilter === s ? 600 : 400,
                textTransform: "capitalize",
                transition: "all 0.15s ease",
              }}
            >
              {s === "all" ? "All Statuses" : s}
            </button>
          ))}
        </div>
      </div>

      {/* Stat bar */}
      <div className="tenant-stat-bar" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          { label: "Total Units", value: totalUnits, color: "var(--color-accent)" },
          { label: "Occupied", value: occupied, color: "var(--color-success)" },
          { label: "Vacant", value: vacant, color: "var(--color-danger)" },
          { label: "Avg Rent", value: fmtMoney(avgRent), color: "var(--color-accent)" },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: "12px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-muted)", marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: s.color, fontFamily: "var(--font-display)" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="nav-btn" onClick={() => setShowAddForm(!showAddForm)} style={{ fontSize: 11 }}>
          {showAddForm ? "✕ Cancel" : "+ Add Tenant"}
        </button>
        <button
          className="nav-btn"
          onClick={() => alert("Bulk import coming soon — upload a CSV of tenants.")}
          style={{ fontSize: 11, opacity: 0.7 }}
        >
          ⇧ Bulk Import
        </button>
      </div>

      {/* Add tenant form */}
      {showAddForm && (
        <AddTenantForm
          properties={properties}
          defaultPropertyId={selectedProp !== "all" ? selectedProp : properties[0]?.id}
          onSaved={() => { setShowAddForm(false); loadTenants(); }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Error / Loading */}
      {error && <div className="card" style={{ padding: 16, color: "var(--color-danger)", fontSize: 13 }}>⚠ {error}</div>}
      {loading && <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)", fontSize: 13 }}>Loading tenants…</div>}

      {/* Tenant table */}
      {!loading && (
        <div className="card" style={{ padding: 12, overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("unitNumber")}>Unit{sortIcon("unitNumber")}</th>
                {selectedProp === "all" && <th style={{ cursor: "pointer" }} onClick={() => handleSort("propertyId")}>Property{sortIcon("propertyId")}</th>}
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("tenantName")}>Tenant{sortIcon("tenantName")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("monthlyRent")}>Rent{sortIcon("monthlyRent")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("leaseEnd")}>Lease End{sortIcon("leaseEnd")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => handleSort("status")}>Status{sortIcon("status")}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={selectedProp === "all" ? 7 : 6} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: 24 }}>No tenants found</td></tr>
              )}
              {filtered.map(t => (
                <tr
                  key={t.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedTenant(t)}
                >
                  <td style={{ fontWeight: 500 }}>{t.unitNumber}</td>
                  {selectedProp === "all" && <td style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{propName(t.propertyId)}</td>}
                  <td>{t.tenantName || <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>Vacant</span>}</td>
                  <td className="tabular-nums">{t.monthlyRent ? fmtMoney(parseFloat(t.monthlyRent)) : "—"}</td>
                  <td className="tabular-nums" style={{ fontSize: 11 }}>{t.leaseEnd || "—"}</td>
                  <td>
                    <span style={{
                      fontSize: 10,
                      textTransform: "uppercase",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: `${STATUS_COLORS[t.status] || "var(--color-text-muted)"}15`,
                      color: STATUS_COLORS[t.status] || "var(--color-text-muted)",
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                    }}>
                      {t.status}
                    </span>
                  </td>
                  <td>
                    <button
                      className="nav-btn"
                      onClick={(e) => { e.stopPropagation(); setSelectedTenant(t); }}
                      style={{ fontSize: 10, padding: "2px 10px" }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}


/* ═══════════════════════════════════════════════════════════════ */
/*  ADD TENANT FORM                                               */
/* ═══════════════════════════════════════════════════════════════ */
function AddTenantForm({
  properties,
  defaultPropertyId,
  onSaved,
  onCancel,
}: {
  properties: Property[];
  defaultPropertyId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    propertyId: defaultPropertyId,
    unitNumber: "",
    tenantName: "",
    status: "occupied",
    monthlyRent: "",
    marketRent: "",
    securityDeposit: "",
    leaseStart: "",
    leaseEnd: "",
    bedrooms: "",
    bathrooms: "",
    sqft: "",
    moveInDate: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.unitNumber.trim()) return alert("Unit number is required");
    setSaving(true);
    try {
      const body: any = {
        propertyId: form.propertyId,
        unitNumber: form.unitNumber.trim(),
        tenantName: form.tenantName.trim() || null,
        status: form.status,
        monthlyRent: form.monthlyRent || null,
        marketRent: form.marketRent || null,
        securityDeposit: form.securityDeposit || null,
        leaseStart: form.leaseStart || null,
        leaseEnd: form.leaseEnd || null,
        bedrooms: form.bedrooms ? parseInt(form.bedrooms) : null,
        bathrooms: form.bathrooms || null,
        sqft: form.sqft ? parseInt(form.sqft) : null,
        moveInDate: form.moveInDate || null,
        notes: form.notes.trim() || null,
      };
      const r = await fetch(`/api/lease-up/units`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Failed to create tenant");
      onSaved();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: string, type = "text", placeholder = "") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{label}</label>
      <input
        type={type}
        value={(form as any)[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{
          padding: "6px 10px",
          fontSize: 12,
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          background: "var(--color-surface)",
          color: "var(--color-text)",
          outline: "none",
        }}
      />
    </div>
  );

  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="label" style={{ marginBottom: 14 }}>Add New Tenant</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>Property</label>
          <select
            value={form.propertyId}
            onChange={e => setForm(f => ({ ...f, propertyId: e.target.value }))}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "var(--color-surface)",
              color: "var(--color-text)",
            }}
          >
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {field("Unit #", "unitNumber", "text", "e.g. 101")}
        {field("Tenant Name", "tenantName", "text", "John Doe")}
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>Status</label>
          <select
            value={form.status}
            onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "var(--color-surface)",
              color: "var(--color-text)",
              textTransform: "capitalize",
            }}
          >
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {field("Monthly Rent", "monthlyRent", "number", "1200")}
        {field("Market Rent", "marketRent", "number", "1300")}
        {field("Security Deposit", "securityDeposit", "number", "1200")}
        {field("Lease Start", "leaseStart", "date")}
        {field("Lease End", "leaseEnd", "date")}
        {field("Move-In Date", "moveInDate", "date")}
        {field("Bedrooms", "bedrooms", "number", "2")}
        {field("Bathrooms", "bathrooms", "text", "1.5")}
        {field("Sq Ft", "sqft", "number", "850")}
      </div>
      <div style={{ marginTop: 12 }}>
        {field("Notes", "notes", "text", "Optional notes…")}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
        <button className="nav-btn" onClick={onCancel} style={{ fontSize: 11, opacity: 0.7 }}>Cancel</button>
        <button
          className="nav-btn active"
          onClick={handleSave}
          disabled={saving}
          style={{ fontSize: 11 }}
        >
          {saving ? "Saving…" : "Save Tenant"}
        </button>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════ */
/*  TENANT DETAIL                                                 */
/* ═══════════════════════════════════════════════════════════════ */
function TenantDetail({
  tenant,
  propertyName,
  onBack,
  onUpdate,
}: {
  tenant: Tenant;
  propertyName: string;
  onBack: () => void;
  onUpdate: (t: Tenant) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...tenant });
  const [saving, setSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState(tenant.notes || "");
  const [savingNote, setSavingNote] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: any = {
        tenantName: form.tenantName?.trim() || null,
        status: form.status,
        monthlyRent: form.monthlyRent || null,
        marketRent: form.marketRent || null,
        securityDeposit: form.securityDeposit || null,
        leaseStart: form.leaseStart || null,
        leaseEnd: form.leaseEnd || null,
        moveInDate: form.moveInDate || null,
        moveOutDate: form.moveOutDate || null,
        bedrooms: form.bedrooms ?? null,
        bathrooms: form.bathrooms || null,
        sqft: form.sqft ?? null,
      };
      const r = await fetch(`/api/lease-up/units/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Failed to update");
      const updated = await r.json();
      onUpdate(updated);
      setEditing(false);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveNote = async () => {
    setSavingNote(true);
    try {
      const r = await fetch(`/api/lease-up/units/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notes: noteDraft.trim() || null }),
      });
      if (!r.ok) throw new Error("Failed to save note");
      const updated = await r.json();
      onUpdate(updated);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSavingNote(false);
    }
  };

  const infoRow = (label: string, value: string | number | undefined | null, suffix = "") => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}>
      <span style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{value ?? "—"}{suffix}</span>
    </div>
  );

  const editField = (label: string, key: keyof Tenant, type = "text") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{label}</label>
      <input
        type={type}
        value={(form as any)[key] ?? ""}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        style={{
          padding: "6px 10px",
          fontSize: 12,
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          background: "var(--color-surface)",
          color: "var(--color-text)",
          outline: "none",
        }}
      />
    </div>
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Back button */}
      <button
        className="nav-btn"
        onClick={onBack}
        style={{ alignSelf: "flex-start", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
      >
        ← Back to Tenant List
      </button>

      {/* Header card */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", fontWeight: 600, color: "var(--color-text)" }}>
              {tenant.tenantName || "Vacant Unit"}
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
              Unit {tenant.unitNumber} · {propertyName}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{
              fontSize: 11,
              textTransform: "uppercase",
              padding: "4px 12px",
              borderRadius: 6,
              background: `${STATUS_COLORS[tenant.status] || "var(--color-text-muted)"}15`,
              color: STATUS_COLORS[tenant.status] || "var(--color-text-muted)",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}>
              {tenant.status}
            </span>
            <button className="nav-btn" onClick={() => setEditing(!editing)} style={{ fontSize: 11 }}>
              {editing ? "✕ Cancel" : "✎ Edit"}
            </button>
          </div>
        </div>
      </div>

      {/* Edit mode */}
      {editing && (
        <div className="card" style={{ padding: 20 }}>
          <div className="label" style={{ marginBottom: 14 }}>Edit Tenant Details</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            {editField("Tenant Name", "tenantName")}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>Status</label>
              <select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                style={{
                  padding: "6px 10px", fontSize: 12, border: "1px solid var(--color-border)",
                  borderRadius: 6, background: "var(--color-surface)", color: "var(--color-text)", textTransform: "capitalize",
                }}
              >
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {editField("Monthly Rent", "monthlyRent", "number")}
            {editField("Market Rent", "marketRent", "number")}
            {editField("Security Deposit", "securityDeposit", "number")}
            {editField("Lease Start", "leaseStart", "date")}
            {editField("Lease End", "leaseEnd", "date")}
            {editField("Move-In", "moveInDate", "date")}
            {editField("Move-Out", "moveOutDate", "date")}
            {editField("Bedrooms", "bedrooms", "number")}
            {editField("Bathrooms", "bathrooms", "text")}
            {editField("Sq Ft", "sqft", "number")}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
            <button className="nav-btn" onClick={() => setEditing(false)} style={{ fontSize: 11, opacity: 0.7 }}>Cancel</button>
            <button className="nav-btn active" onClick={handleSave} disabled={saving} style={{ fontSize: 11 }}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      )}

      {/* Info cards — 2-column layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Lease summary */}
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10 }}>Lease Summary</div>
          {infoRow("Lease Start", tenant.leaseStart)}
          {infoRow("Lease End", tenant.leaseEnd)}
          {infoRow("Monthly Rent", tenant.monthlyRent ? fmtMoney(parseFloat(tenant.monthlyRent)) : undefined)}
          {infoRow("Market Rent", tenant.marketRent ? fmtMoney(parseFloat(tenant.marketRent)) : undefined)}
          {infoRow("Security Deposit", tenant.securityDeposit ? fmtMoney(parseFloat(tenant.securityDeposit)) : undefined)}
          {infoRow("Move-In", tenant.moveInDate)}
          {infoRow("Move-Out", tenant.moveOutDate)}
        </div>

        {/* Unit details */}
        <div className="card" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 10 }}>Unit Details</div>
          {infoRow("Unit Number", tenant.unitNumber)}
          {infoRow("Bedrooms", tenant.bedrooms)}
          {infoRow("Bathrooms", tenant.bathrooms)}
          {infoRow("Sq Ft", tenant.sqft, tenant.sqft ? " sqft" : "")}
          {infoRow("Property", propertyName)}
        </div>
      </div>

      {/* Notes */}
      <div className="card" style={{ padding: 16 }}>
        <div className="label" style={{ marginBottom: 10 }}>Notes</div>
        <textarea
          value={noteDraft}
          onChange={e => setNoteDraft(e.target.value)}
          placeholder="Add notes about this tenant…"
          rows={3}
          style={{
            width: "100%",
            padding: "8px 12px",
            fontSize: 12,
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: "var(--color-surface)",
            color: "var(--color-text)",
            resize: "vertical",
            outline: "none",
            fontFamily: "var(--font-sans)",
          }}
        />
        {noteDraft !== (tenant.notes || "") && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button className="nav-btn active" onClick={saveNote} disabled={savingNote} style={{ fontSize: 11 }}>
              {savingNote ? "Saving…" : "Save Note"}
            </button>
          </div>
        )}
      </div>

      {/* Placeholder: Transactions */}
      <div className="card" style={{ padding: 16, opacity: 0.6 }}>
        <div className="label" style={{ marginBottom: 6 }}>Transactions</div>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>
          Transaction tracking coming soon — payments, charges, and ledger history.
        </div>
      </div>

      {/* Placeholder: Recurring Charges */}
      <div className="card" style={{ padding: 16, opacity: 0.6 }}>
        <div className="label" style={{ marginBottom: 6 }}>Recurring Charges</div>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>
          Recurring charge management coming soon — rent, utilities, fees.
        </div>
      </div>
    </section>
  );
}
