/**
 * Rent Manager 12 Web API (WAPI12) integration.
 * Provides live tenant, charge, lease, and work order data.
 *
 * Auth: POST /Authentication/AuthorizeUser -> API token
 * Base URL: https://mcelweepm.api.rentmanager.com
 * Token header: X-RM12Api-ApiToken
 *
 * FIELD NOTES (verified against live API):
 * - Tenants: TenantID, FirstName, LastName, Name, PropertyID, Status, RentDueDay, RentPeriod
 *   (NO Phone, Email, UnitID, CurrentBalance, MoveInDate)
 * - Leases: LeaseID, TenantID, UnitID, PropertyID, MoveInDate, MoveOutDate, ArrivalDate, DepartureDate
 * - Units: UnitID, PropertyID, Name, UnitTypeID, Bedrooms, Bathrooms, IsLicensed
 *   (NO IsOccupied, MarketRent)
 * - RecurringCharges: RecurringChargeID, EntityType, EntityKeyID, UnitID, Amount, ChargeTypeID, Frequency, FromDate, TenantID
 *   Filter by EntityKeyID (NOT TenantID)
 * - Charges: ChargeID, AccountID, AccountType("Customer"), Amount, TransactionDate, TransactionType, PropertyID, UnitID, ChargeTypeID, Comment
 *   Filter by AccountID (NOT TenantID)
 */

import { PROPERTY_NAMES, ALL_RM_IDS, rmToLocal } from "./property-map";
import { cachedFetch, cacheInvalidate } from "./rmCache";

const RM_BASE = process.env.RM_API_BASE || "https://mcelweepm.api.rentmanager.com";

let cachedToken: { token: string; expiresAt: number } | null = null;

export function isRMConfigured(): boolean {
  return !!(process.env.RM_USERNAME && process.env.RM_PASSWORD);
}

/**
 * Authenticate with Rent Manager and get an API token. Cached for 12 hours.
 * If RM_API_TOKEN env var is set, uses that directly (for when max sessions reached).
 * On "max logins" error, retries once after 30s in case sessions are expiring.
 */
async function getApiToken(): Promise<string> {
  // Use pre-set token if available
  if (process.env.RM_API_TOKEN) {
    return process.env.RM_API_TOKEN;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 3600_000) {
    return cachedToken.token;
  }

  const doAuth = async (): Promise<string> => {
    const res = await fetch(`${RM_BASE}/Authentication/AuthorizeUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Username: process.env.RM_USERNAME,
        Password: process.env.RM_PASSWORD,
        LocationID: parseInt(process.env.RM_LOCATION_ID || "1", 10),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RM auth failed (${res.status}): ${text}`);
    }

    return (await res.text()).replace(/^"|"$/g, "");
  };

  try {
    const token = await doAuth();
    cachedToken = { token, expiresAt: Date.now() + 12 * 3600_000 };
    return token;
  } catch (err: any) {
    // If max logins, wait and retry once
    if (err.message?.includes("maximum number of times")) {
      console.log("[RM] Max logins reached, retrying in 30s...");
      await new Promise(r => setTimeout(r, 30_000));
      const token = await doAuth();
      cachedToken = { token, expiresAt: Date.now() + 12 * 3600_000 };
      return token;
    }
    throw err;
  }
}

/** Make an authenticated GET request to the Rent Manager API. */
export async function rmGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getApiToken();
  const url = new URL(`${RM_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { "X-RM12Api-ApiToken": token },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RM API error (${res.status} ${path}): ${text}`);
  }

  return res.json();
}

/** Make an authenticated POST request to the Rent Manager API. */
export async function rmPost(path: string, body: any): Promise<any> {
  const token = await getApiToken();
  const res = await fetch(`${RM_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-RM12Api-ApiToken": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RM API error (${res.status} POST ${path}): ${text}`);
  }

  return res.json();
}

/** Make an authenticated PUT request to the Rent Manager API (for updates). */
export async function rmPut(path: string, body: any): Promise<any> {
  const token = await getApiToken();
  const res = await fetch(`${RM_BASE}${path}`, {
    method: "PUT",
    headers: {
      "X-RM12Api-ApiToken": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RM API error (${res.status} PUT ${path}): ${text}`);
  }

  return res.json();
}

// ═══════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════

/** Get all properties from RM. */
export async function fetchRMProperties(): Promise<any[]> {
  return rmGet("/Properties");
}

/** Get tenants, optionally filtered by property and status. */
export async function fetchRMTenants(propertyId?: string, status?: string): Promise<any[]> {
  const params: Record<string, string> = { pagesize: "500" };
  const filters: string[] = [];
  if (propertyId) filters.push(`PropertyID,eq,${propertyId}`);
  if (status) filters.push(`Status,eq,${status}`);
  if (filters.length) params.filters = filters.join(";");
  return rmGet("/Tenants", params);
}

/** Get units for a property. */
export async function fetchRMUnits(propertyId: string): Promise<any[]> {
  return rmGet("/Units", {
    filters: `PropertyID,eq,${propertyId}`,
    pagesize: "500",
  });
}

/** Get leases, optionally filtered by property or tenant. */
export async function fetchRMLeases(opts: {
  tenantId?: string;
  propertyId?: string;
}): Promise<any[]> {
  const params: Record<string, string> = { pagesize: "500" };
  const filters: string[] = [];
  if (opts.tenantId) filters.push(`TenantID,eq,${opts.tenantId}`);
  if (opts.propertyId) filters.push(`PropertyID,eq,${opts.propertyId}`);
  if (filters.length) params.filters = filters.join(";");
  return rmGet("/Leases", params);
}

/**
 * Get charges/transactions. Filters by AccountID (not TenantID).
 * TransactionType: "Charge", "Payment", "Credit"
 */
export async function fetchRMCharges(opts: {
  tenantId?: string;
  propertyId?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<any[]> {
  const params: Record<string, string> = {
    pagesize: "500",
    orderby: "TransactionDate desc",
  };
  const filters: string[] = [];
  // RM uses AccountID + AccountType=Customer for tenant charges
  if (opts.tenantId) {
    filters.push(`AccountID,eq,${opts.tenantId}`);
    filters.push(`AccountType,eq,Customer`);
  }
  if (opts.propertyId) filters.push(`PropertyID,eq,${opts.propertyId}`);
  if (opts.fromDate) filters.push(`TransactionDate,ge,${opts.fromDate}`);
  if (opts.toDate) filters.push(`TransactionDate,le,${opts.toDate}`);
  if (filters.length) params.filters = filters.join(";");

  return rmGet("/Charges", params);
}

/**
 * Get recurring charges. Filters by EntityKeyID (not TenantID).
 * NOTE: RecurringCharges does NOT support PropertyID filter.
 * Use tenantId to filter by specific tenant, or tenantIds for multiple.
 */
export async function fetchRMRecurringCharges(opts: {
  tenantId?: string;
  tenantIds?: number[];
}): Promise<any[]> {
  if (opts.tenantId) {
    return rmGet("/RecurringCharges", {
      pagesize: "500",
      filters: `EntityKeyID,eq,${opts.tenantId}`,
    });
  }
  // For multiple tenants (rent roll): fetch all and filter in memory
  const all = await rmGet("/RecurringCharges", { pagesize: "1000" });
  if (opts.tenantIds && opts.tenantIds.length > 0) {
    const idSet = new Set(opts.tenantIds);
    return all.filter((rc: any) => idSet.has(rc.EntityKeyID) || idSet.has(rc.TenantID));
  }
  return all;
}

/**
 * Get payments for a tenant or set of tenants.
 * Payments are in a separate /Payments resource from Charges.
 * NOTE: Payments do NOT have PropertyID. Filter by AccountID (tenant ID).
 * For multiple tenants, fetches each tenant's payments individually (API doesn't support bulk filter).
 */
export async function fetchRMPayments(opts: {
  tenantId?: string;
  tenantIds?: number[];
  fromDate?: string;
  toDate?: string;
}): Promise<any[]> {
  try {
    // If multiple tenant IDs, fetch each individually and combine
    if (opts.tenantIds && opts.tenantIds.length > 0 && !opts.tenantId) {
      const results = await Promise.all(
        opts.tenantIds.map(tid =>
          fetchRMPayments({ tenantId: String(tid), fromDate: opts.fromDate, toDate: opts.toDate })
        )
      );
      return results.flat();
    }

    const params: Record<string, string> = {
      pagesize: "500",
      orderby: "TransactionDate desc",
    };
    const filters: string[] = [];
    if (opts.tenantId) {
      filters.push(`AccountID,eq,${opts.tenantId}`);
      filters.push(`AccountType,eq,Customer`);
    }
    if (opts.fromDate) filters.push(`TransactionDate,ge,${opts.fromDate}`);
    if (opts.toDate) filters.push(`TransactionDate,le,${opts.toDate}`);
    if (filters.length) params.filters = filters.join(";");

    return await rmGet("/Payments", params);
  } catch {
    return [];
  }
}

/** Get service issues (work orders / maintenance). */
export async function fetchRMServiceIssues(opts: {
  propertyId?: string;
  status?: string;
}): Promise<any[]> {
  const params: Record<string, string> = {
    pagesize: "500",
    orderby: "CreateDate desc",
  };
  const filters: string[] = [];
  if (opts.propertyId) filters.push(`PropertyID,eq,${opts.propertyId}`);
  if (opts.status) filters.push(`Status,eq,${opts.status}`);
  if (filters.length) params.filters = filters.join(";");

  try {
    return await rmGet("/ServiceManagerIssues", params);
  } catch {
    // ServiceManagerIssues may not be enabled for all RM instances
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// RENT ROLL — joins tenants, leases, units, charges
// ═══════════════════════════════════════════════════════════

export interface EnrichedTenant {
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

export interface RentRollResult {
  property: { PropertyID: string };
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

/**
 * Build a rent roll for a property by joining:
 * - Units (for unit names, bed/bath)
 * - Current tenants (for names, status)
 * - Leases (for unit mapping, move-in dates)
 * - Recurring charges (for monthly rent amounts)
 * - Charges (for balance calculation)
 */
export async function buildRentRoll(propertyId: string): Promise<RentRollResult> {
  // Fetch units, tenants, leases, and charges in parallel
  // (Payments and RecurringCharges don't support PropertyID filter, need tenant IDs first)
  const [units, tenants, leases, charges] = await Promise.all([
    fetchRMUnits(propertyId),
    fetchRMTenants(propertyId, "Current"),
    fetchRMLeases({ propertyId }),
    fetchRMCharges({ propertyId }),
  ]);

  // Now fetch payments and recurring charges using tenant IDs
  const tenantIds = tenants.map((t: any) => t.TenantID);
  const [recurringCharges, payments] = await Promise.all([
    fetchRMRecurringCharges({ tenantIds }),
    fetchRMPayments({ tenantIds }),
  ]);

  // Build lookup maps
  const unitMap = new Map<number, any>();
  for (const u of units) unitMap.set(u.UnitID, u);

  // Map tenant -> most recent lease (highest LeaseID = most recent)
  const tenantLeaseMap = new Map<number, any>();
  for (const l of leases) {
    const existing = tenantLeaseMap.get(l.TenantID);
    if (!existing || l.LeaseID > existing.LeaseID) {
      tenantLeaseMap.set(l.TenantID, l);
    }
  }

  // Map tenant -> recurring charge total (monthly rent)
  const tenantRentMap = new Map<number, number>();
  for (const rc of recurringCharges) {
    const tid = rc.EntityKeyID || rc.TenantID;
    if (tid) {
      tenantRentMap.set(tid, (tenantRentMap.get(tid) || 0) + (rc.Amount || 0));
    }
  }

  // Fallback: if tenant has no recurring charges, use most recent Rent Charge (ChargeTypeID=2)
  // This covers tenants whose recurring charges aren't set up in RM
  const RENT_CHARGE_TYPE_ID = 2;
  for (const tid of tenantIds) {
    if (!tenantRentMap.has(tid) || tenantRentMap.get(tid) === 0) {
      const rentCharges = charges
        .filter((c: any) => c.AccountID === tid && c.AccountType === "Customer" && c.ChargeTypeID === RENT_CHARGE_TYPE_ID)
        .sort((a: any, b: any) => (b.TransactionDate || "").localeCompare(a.TransactionDate || ""));
      if (rentCharges.length > 0) {
        tenantRentMap.set(tid, rentCharges[0].Amount || 0);
      }
    }
  }

  // Calculate balance per tenant: Charges (debit) - Payments (credit)
  // Charges and Payments are separate resources in RM
  const tenantBalanceMap = new Map<number, number>();
  for (const c of charges) {
    const tid = c.AccountID;
    if (!tid || c.AccountType !== "Customer") continue;
    tenantBalanceMap.set(tid, (tenantBalanceMap.get(tid) || 0) + (c.Amount || 0));
  }
  for (const p of payments) {
    const tid = p.AccountID;
    if (!tid || p.AccountType !== "Customer") continue;
    tenantBalanceMap.set(tid, (tenantBalanceMap.get(tid) || 0) - (p.Amount || 0));
  }

  // Track which units are occupied (have a current tenant with a lease)
  const occupiedUnitIds = new Set<number>();

  // Build enriched tenant list
  const enrichedTenants: EnrichedTenant[] = tenants.map((t: any) => {
    const lease = tenantLeaseMap.get(t.TenantID);
    const unitId = lease?.UnitID || null;
    const unit = unitId ? unitMap.get(unitId) : null;

    if (unitId) occupiedUnitIds.add(unitId);

    return {
      TenantID: t.TenantID,
      FirstName: t.FirstName,
      LastName: t.LastName,
      Name: t.Name || `${t.FirstName} ${t.LastName}`,
      PropertyID: t.PropertyID,
      Status: t.Status,
      UnitID: unitId,
      UnitName: unit?.Name || (unitId ? `Unit ${unitId}` : "Unassigned"),
      MoveInDate: lease?.MoveInDate || null,
      MoveOutDate: lease?.MoveOutDate || null,
      MonthlyRent: tenantRentMap.get(t.TenantID) || 0,
      Balance: Math.round((tenantBalanceMap.get(t.TenantID) || 0) * 100) / 100,
      Bedrooms: unit?.Bedrooms || null,
      Bathrooms: unit?.Bathrooms || null,
    };
  });

  // Sort tenants by unit name numerically (e.g., #1, #2, #7, #10 instead of #1, #10, #2)
  enrichedTenants.sort((a, b) => {
    const numA = parseInt((a.UnitName || "").replace(/[^0-9]/g, "")) || 9999;
    const numB = parseInt((b.UnitName || "").replace(/[^0-9]/g, "")) || 9999;
    return numA - numB;
  });

  const totalMonthlyRent = enrichedTenants.reduce((s, t) => s + t.MonthlyRent, 0);
  const totalBalance = enrichedTenants.reduce((s, t) => s + t.Balance, 0);
  const occupiedCount = occupiedUnitIds.size;
  const totalUnits = units.length;

  return {
    property: { PropertyID: propertyId },
    units,
    tenants: enrichedTenants,
    summary: {
      totalUnits,
      occupiedUnits: occupiedCount,
      vacantUnits: totalUnits - occupiedCount,
      occupancyRate: totalUnits > 0 ? occupiedCount / totalUnits : 0,
      totalMonthlyRent,
      totalBalance: Math.round(totalBalance * 100) / 100,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// VACANCY REPORT — vacant units with days vacant & lost rent
// ═══════════════════════════════════════════════════════════

export interface VacantUnit {
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

export interface VacancyReport {
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

/**
 * Build a vacancy report across one or more properties.
 * For each vacant unit: calculates days vacant from last lease MoveOutDate,
 * estimates market rent from average of occupied units with same bedroom count,
 * and computes total lost rent.
 */
export async function buildVacancyReport(
  propertyIds?: string[]
): Promise<VacancyReport> {
  const pids = propertyIds || ["30", "31", "32", "33"];

  // Fetch units, current tenants, and all leases for each property in parallel
  const perProp = await Promise.all(
    pids.map(async (pid) => {
      const [units, tenants, leases] = await Promise.all([
        fetchRMUnits(pid),
        fetchRMTenants(pid, "Current"),
        fetchRMLeases({ propertyId: pid }),
      ]);
      return { pid: parseInt(pid, 10), units, tenants, leases };
    })
  );

  // Also fetch recurring charges for all current tenants (for market rent estimates)
  const allTenantIds = perProp.flatMap((p) => p.tenants.map((t: any) => t.TenantID));
  const recurringCharges = allTenantIds.length > 0
    ? await fetchRMRecurringCharges({ tenantIds: allTenantIds })
    : [];

  // Build tenant -> monthly rent map
  const tenantRentMap = new Map<number, number>();
  for (const rc of recurringCharges) {
    const tid = rc.EntityKeyID || rc.TenantID;
    if (tid) tenantRentMap.set(tid, (tenantRentMap.get(tid) || 0) + (rc.Amount || 0));
  }

  // For market rent estimates: group rent by bedroom count from occupied units
  const rentByBedroom = new Map<number, { total: number; count: number }>();

  const vacantUnits: VacantUnit[] = [];
  let totalUnitsAll = 0;
  let occupiedAll = 0;

  for (const { pid, units, tenants, leases } of perProp) {
    totalUnitsAll += units.length;

    // Map tenant -> most recent lease for this property
    const tenantLeaseMap = new Map<number, any>();
    for (const l of leases) {
      const existing = tenantLeaseMap.get(l.TenantID);
      if (!existing || l.LeaseID > existing.LeaseID) {
        tenantLeaseMap.set(l.TenantID, l);
      }
    }

    // Identify occupied units
    const occupiedUnitIds = new Set<number>();
    for (const t of tenants) {
      const lease = tenantLeaseMap.get(t.TenantID);
      if (lease?.UnitID) {
        occupiedUnitIds.add(lease.UnitID);
        // Track rent by bedroom count for market rent estimation
        const unit = units.find((u: any) => u.UnitID === lease.UnitID);
        const beds = unit?.Bedrooms ?? 2; // default 2BR if unknown
        const rent = tenantRentMap.get(t.TenantID) || 0;
        if (rent > 0) {
          const entry = rentByBedroom.get(beds) || { total: 0, count: 0 };
          entry.total += rent;
          entry.count += 1;
          rentByBedroom.set(beds, entry);
        }
      }
    }

    occupiedAll += occupiedUnitIds.size;

    // Map unit -> all leases (for finding last move-out)
    const unitLeasesMap = new Map<number, any[]>();
    for (const l of leases) {
      if (!unitLeasesMap.has(l.UnitID)) unitLeasesMap.set(l.UnitID, []);
      unitLeasesMap.get(l.UnitID)!.push(l);
    }

    // Find vacant units
    for (const unit of units) {
      if (occupiedUnitIds.has(unit.UnitID)) continue;

      // Find last lease for this unit to get MoveOutDate
      const unitLeases = unitLeasesMap.get(unit.UnitID) || [];
      // Sort by MoveOutDate descending to get most recent
      const sortedLeases = unitLeases
        .filter((l: any) => l.MoveOutDate)
        .sort((a: any, b: any) => (b.MoveOutDate || "").localeCompare(a.MoveOutDate || ""));
      const lastMoveOut = sortedLeases[0]?.MoveOutDate || null;

      // Calculate days vacant
      let daysVacant = 0;
      if (lastMoveOut) {
        const moveOutDate = new Date(lastMoveOut);
        daysVacant = Math.max(0, Math.floor((Date.now() - moveOutDate.getTime()) / 86400000));
      }

      vacantUnits.push({
        UnitID: unit.UnitID,
        UnitName: unit.Name || `Unit ${unit.UnitID}`,
        PropertyID: pid,
        PropertyName: PROPERTY_NAMES[pid] || `Property ${pid}`,
        Bedrooms: unit.Bedrooms ?? null,
        Bathrooms: unit.Bathrooms ?? null,
        LastMoveOutDate: lastMoveOut,
        DaysVacant: daysVacant,
        EstimatedMonthlyRent: 0, // filled below
        LostRentTotal: 0, // filled below
      });
    }
  }

  // Calculate average market rent per bedroom count
  const marketRentByBedroom: Record<number, number> = {};
  rentByBedroom.forEach(({ total, count }, beds) => {
    marketRentByBedroom[beds] = Math.round(total / count);
  });

  // Apply estimated rent and lost rent to vacant units
  for (const vu of vacantUnits) {
    const beds = vu.Bedrooms ?? 2;
    vu.EstimatedMonthlyRent = marketRentByBedroom[beds] || marketRentByBedroom[2] || 1000;
    // Lost rent = (days vacant / 30) * monthly rent
    vu.LostRentTotal = Math.round((vu.DaysVacant / 30) * vu.EstimatedMonthlyRent);
  }

  // Sort by days vacant descending (longest vacancy first)
  vacantUnits.sort((a, b) => b.DaysVacant - a.DaysVacant);

  const totalLostRent = vacantUnits.reduce((s, v) => s + v.LostRentTotal, 0);
  const avgDaysVacant = vacantUnits.length > 0
    ? Math.round(vacantUnits.reduce((s, v) => s + v.DaysVacant, 0) / vacantUnits.length)
    : 0;

  return {
    vacantUnits,
    summary: {
      totalUnits: totalUnitsAll,
      occupiedUnits: occupiedAll,
      vacantUnits: vacantUnits.length,
      occupancyRate: totalUnitsAll > 0 ? occupiedAll / totalUnitsAll : 0,
      totalLostRent,
      avgDaysVacant,
    },
    marketRentByBedroom,
  };
}

// ═══════════════════════════════════════════════════════════
// MONTHLY RENT SUMMARY — charges grouped by month for P&L overlay
// ═══════════════════════════════════════════════════════════

export interface MonthlyRentSummary {
  month: string;         // YYYY-MM format
  totalCharges: number;  // Total charges posted (rent billed)
  totalPayments: number; // Total payments received (rent collected)
  chargeCount: number;
  paymentCount: number;
}

/**
 * Build a monthly rent summary for a property over a date range.
 * Uses Charges (which have PropertyID) for billed rent and
 * fetches payments via tenants for actual rent collected.
 */
export async function buildMonthlyRentSummary(
  propertyId: string,
  fromDate: string,
  toDate: string
): Promise<MonthlyRentSummary[]> {
  // Fetch charges for this property in date range (billed rent)
  const charges = await fetchRMCharges({ propertyId, fromDate, toDate });

  // For payments: need to go through tenants since Payments don't have PropertyID
  const tenants = await fetchRMTenants(propertyId, "Current");
  const tenantIds = tenants.map((t: any) => t.TenantID);
  const payments = tenantIds.length > 0
    ? await fetchRMPayments({ tenantIds, fromDate, toDate })
    : [];

  // Group charges by month
  const chargesByMonth = new Map<string, { total: number; count: number }>();
  for (const c of charges) {
    if (!c.TransactionDate) continue;
    const month = c.TransactionDate.substring(0, 7); // YYYY-MM
    const entry = chargesByMonth.get(month) || { total: 0, count: 0 };
    entry.total += c.Amount || 0;
    entry.count += 1;
    chargesByMonth.set(month, entry);
  }

  // Group payments by month
  const paymentsByMonth = new Map<string, { total: number; count: number }>();
  for (const p of payments) {
    if (!p.TransactionDate) continue;
    const month = p.TransactionDate.substring(0, 7);
    const entry = paymentsByMonth.get(month) || { total: 0, count: 0 };
    entry.total += p.Amount || 0;
    entry.count += 1;
    paymentsByMonth.set(month, entry);
  }

  // Merge into sorted array
  const allMonthsArr: string[] = [];
  chargesByMonth.forEach((_, k) => allMonthsArr.push(k));
  paymentsByMonth.forEach((_, k) => { if (!chargesByMonth.has(k)) allMonthsArr.push(k); });
  const result: MonthlyRentSummary[] = allMonthsArr
    .sort()
    .map((month) => ({
      month,
      totalCharges: Math.round((chargesByMonth.get(month)?.total || 0) * 100) / 100,
      totalPayments: Math.round((paymentsByMonth.get(month)?.total || 0) * 100) / 100,
      chargeCount: chargesByMonth.get(month)?.count || 0,
      paymentCount: paymentsByMonth.get(month)?.count || 0,
    }));

  return result;
}

// ═══════════════════════════════════════════════════════════
// CHARGE TYPES — human-readable names for charge type IDs
// ═══════════════════════════════════════════════════════════

export interface ChargeType {
  ChargeTypeID: number;
  Name: string;
  Description?: string;
  IsActive?: boolean;
}

/** Fetch all charge types from RM. Cached indefinitely (rarely changes). */
export async function fetchChargeTypes(): Promise<ChargeType[]> {
  return cachedFetch<ChargeType[]>(
    "charge-types",
    () => rmGet("/ChargeTypes", { pagesize: "200" }),
    -1, // never expires
  );
}

/** Lookup a charge type name by ID. Returns "Unknown" if not found. */
export async function chargeTypeName(chargeTypeId: number): Promise<string> {
  const types = await fetchChargeTypes();
  return types.find((t) => t.ChargeTypeID === chargeTypeId)?.Name || "Unknown";
}

// ═══════════════════════════════════════════════════════════
// PORTFOLIO SUMMARY — aggregated KPIs across all properties
// ═══════════════════════════════════════════════════════════

export interface PortfolioSummary {
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  occupancyRate: number;
  totalMonthlyRent: number;
  delinquentBalance: number;
  delinquentCount: number;
  openWorkOrders: number;
  leasesExpiring30d: number;
  leasesExpiring60d: number;
  properties: Array<{
    propertyId: string;
    name: string;
    totalUnits: number;
    occupiedUnits: number;
    vacantUnits: number;
    occupancyRate: number;
    monthlyRent: number;
    delinquentBalance: number;
    openWorkOrders: number;
  }>;
  alerts: Array<{
    type: "danger" | "warning";
    message: string;
    propertyId?: string;
  }>;
}

/**
 * Build a portfolio-wide summary with KPIs, alerts, and per-property breakdown.
 * Uses cache for rent rolls; fetches work orders + leases fresh.
 */
export async function buildPortfolioSummary(): Promise<PortfolioSummary> {
  return cachedFetch<PortfolioSummary>(
    "portfolio-summary",
    async () => {
      // Fetch rent rolls for all properties in parallel (via cache)
      const rentRolls = await Promise.all(
        ALL_RM_IDS.map((pid) =>
          cachedFetch(`rent-roll-${pid}`, () => buildRentRoll(pid))
        )
      );

      // Fetch work orders (all properties) + leases in parallel
      const [allWorkOrders, allLeases] = await Promise.all([
        fetchRMServiceIssues({}).catch(() => []),
        Promise.all(ALL_RM_IDS.map((pid) => fetchRMLeases({ propertyId: pid }))).then((a) => a.flat()),
      ]);

      // Count open work orders
      const openWOs = Array.isArray(allWorkOrders)
        ? allWorkOrders.filter((wo: any) => !wo.IsClosed && wo.StatusID !== 5 && wo.StatusID !== 7 && wo.StatusID !== 8).length
        : 0;

      // Count leases expiring within 30d / 60d
      const now = new Date();
      const in30d = new Date(now.getTime() + 30 * 86400000);
      const in60d = new Date(now.getTime() + 60 * 86400000);
      let expiring30 = 0;
      let expiring60 = 0;
      for (const l of allLeases) {
        if (!l.MoveOutDate) continue;
        const moveOut = new Date(l.MoveOutDate);
        if (moveOut >= now && moveOut <= in30d) expiring30++;
        else if (moveOut > in30d && moveOut <= in60d) expiring60++;
      }

      // Aggregate
      let totalUnits = 0, occupiedUnits = 0, totalMonthlyRent = 0, delinquentBalance = 0, delinquentCount = 0;
      const alerts: PortfolioSummary["alerts"] = [];
      const properties: PortfolioSummary["properties"] = [];

      for (let i = 0; i < rentRolls.length; i++) {
        const rr = rentRolls[i];
        const pid = ALL_RM_IDS[i];
        const pName = PROPERTY_NAMES[parseInt(pid)] || pid;
        const s = rr.summary;

        totalUnits += s.totalUnits;
        occupiedUnits += s.occupiedUnits;
        totalMonthlyRent += s.totalMonthlyRent;

        // Per-property delinquency
        let propDelinq = 0;
        let propDelinqCount = 0;
        for (const t of rr.tenants) {
          if (t.Balance > 0) {
            propDelinq += t.Balance;
            propDelinqCount++;
            delinquentCount++;
            // Alert if balance > 1 month rent
            if (t.Balance > t.MonthlyRent && t.MonthlyRent > 0) {
              alerts.push({
                type: "danger",
                message: `${t.Name} (${pName} ${t.UnitName}) owes ${fmtMoney(t.Balance)} — more than 1 month's rent`,
                propertyId: pid,
              });
            }
          }
        }
        delinquentBalance += propDelinq;

        // Per-property open work orders (same filter as portfolio-wide count)
        const propOpenWOs = Array.isArray(allWorkOrders)
          ? allWorkOrders.filter((wo: any) => String(wo.PropertyID) === pid && !wo.IsClosed && wo.StatusID !== 5 && wo.StatusID !== 7 && wo.StatusID !== 8).length
          : 0;

        // Emergency work order alert
        if (Array.isArray(allWorkOrders)) {
          for (const wo of allWorkOrders) {
            if (String(wo.PropertyID) === pid && !wo.IsClosed && (wo.PriorityID === 6 || wo.PriorityID === 9)) {
              alerts.push({
                type: "danger",
                message: `Emergency work order open: ${wo.Title || wo.Description || "WO #" + wo.ServiceManagerIssueID} (${pName})`,
                propertyId: pid,
              });
            }
          }
        }

        properties.push({
          propertyId: pid,
          name: pName,
          totalUnits: s.totalUnits,
          occupiedUnits: s.occupiedUnits,
          vacantUnits: s.vacantUnits,
          occupancyRate: s.occupancyRate,
          monthlyRent: s.totalMonthlyRent,
          delinquentBalance: Math.round(propDelinq * 100) / 100,
          openWorkOrders: propOpenWOs,
        });
      }

      // Lease expiration alerts
      if (expiring30 > 0) {
        alerts.push({ type: "warning", message: `${expiring30} lease${expiring30 > 1 ? "s" : ""} expiring within 30 days` });
      }

      return {
        totalUnits,
        occupiedUnits,
        vacantUnits: totalUnits - occupiedUnits,
        occupancyRate: totalUnits > 0 ? occupiedUnits / totalUnits : 0,
        totalMonthlyRent: Math.round(totalMonthlyRent),
        delinquentBalance: Math.round(delinquentBalance * 100) / 100,
        delinquentCount,
        openWorkOrders: openWOs,
        leasesExpiring30d: expiring30,
        leasesExpiring60d: expiring60,
        properties,
        alerts,
      };
    },
    5 * 60 * 1000, // 5 minute TTL
  );
}

function fmtMoney(v: number): string {
  return "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── ServiceManagerIssues → MaintenanceRequest transform ──────────
// Maps from RM API names
const RM_STATUS_MAP: Record<number, string> = {
  1: "open", 2: "open", 3: "in_progress", 4: "cancelled",
  5: "complete", 6: "open", 7: "cancelled", 8: "complete",
};
const RM_PRIORITY_MAP: Record<number, string> = {
  1: "medium", 3: "medium", 4: "high", 5: "low",
  6: "emergency", 7: "medium", 8: "high", 9: "emergency",
};
const RM_CATEGORY_MAP: Record<number, string> = {
  1: "other", 3: "other", 4: "other", 5: "emergency", 6: "other",
  8: "structural", 9: "plumbing", 10: "electrical",
  11: "structural", 12: "other", 13: "other", 14: "other", 15: "other",
};

export interface RMMaintenanceRequest {
  id: string; propertyId: string; unitNumber?: string; tenantName?: string;
  title: string; description: string; category: string; priority: string;
  status: string; assignedTo?: string; estimatedCost?: string; actualCost?: string;
  reportedAt: string; acknowledgedAt?: string; scheduledDate?: string; completedAt?: string;
  photoUrls?: string; notes?: string; createdAt: string;
}

export async function fetchRMMaintenanceRequests(propertyId?: string): Promise<RMMaintenanceRequest[]> {
  const params: Record<string, string> = {
    pagesize: "200",
    orderby: "CreateDate desc",
    embeds: "Units,Properties,Tenants",
  };
  const issues = await rmGet("/ServiceManagerIssues", params);
  if (!Array.isArray(issues)) return [];

  return issues
    .filter((iss: any) => {
      if (!propertyId) return true;
      // Filter by property if embedded
      const props = iss.Properties || [];
      return props.some((p: any) => String(p.PropertyID) === propertyId);
    })
    .map((iss: any) => {
      const props = iss.Properties || [];
      const units = iss.Units || [];
      const tenants = iss.Tenants || [];
      const prop = props[0];
      const unit = units[0];
      const tenant = tenants[0];

      // Map propertyId back to local UUID
      const rmPropId = prop?.PropertyID ? String(prop.PropertyID) : "";
      const localId = rmPropId ? (rmToLocal(rmPropId) || rmPropId) : "";

      return {
        id: `rm-${iss.ServiceManagerIssueID}`,
        propertyId: localId,
        unitNumber: unit?.Name || undefined,
        tenantName: tenant ? `${tenant.FirstName || ""} ${tenant.LastName || ""}`.trim() : undefined,
        title: iss.Title || "Untitled",
        description: iss.Description || "",
        category: RM_CATEGORY_MAP[iss.CategoryID] || "other",
        priority: RM_PRIORITY_MAP[iss.PriorityID] || "medium",
        status: iss.IsClosed ? "complete" : (RM_STATUS_MAP[iss.StatusID] || "open"),
        assignedTo: undefined,
        estimatedCost: undefined,
        actualCost: undefined,
        reportedAt: iss.CreateDate || new Date().toISOString(),
        acknowledgedAt: iss.AssignedOpenDate || undefined,
        scheduledDate: iss.AssignedCloseDate || undefined,
        completedAt: iss.IsClosed ? (iss.CloseDate || iss.UpdateDate) : undefined,
        notes: iss.Resolution || iss.NoteText || undefined,
        createdAt: iss.CreateDate || new Date().toISOString(),
      } as RMMaintenanceRequest;
    });
}
