/**
 * Pure mappings from the host `properties` row to the legacy dashboard cards.
 * Kept free of database imports so the math can be tested directly.
 */
import type { PropertyCard, OccupancyRecord, DebtMaturity } from "./types";

/* ── Helpers ── */

export function num(val: string | number | null | undefined): number {
  if (val == null) return 0;
  return typeof val === "number" ? val : parseFloat(val) || 0;
}

function daysUntil(dateStr: string | null | undefined): number {
  if (!dateStr) return 999;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function urgencyLevel(days: number): "urgent" | "upcoming" | "safe" {
  if (days <= 120) return "urgent";
  if (days <= 240) return "upcoming";
  return "safe";
}

/* ── Build PropertyCard from PostgreSQL properties row ── */

export function toPropertyCard(p: any): PropertyCard {
  const units = num(p.units);
  const occupied = num(p.occupiedUnits);
  const occupancyRate = num(p.occupancyRate) * 100; // stored as decimal 0.762
  const annualNOI = num(p.noi);
  const currentDebt = num(p.currentDebt);
  const annualDebtService = num(p.annualDebtService);
  const acquisitionPrice = num(p.acquisitionPrice);
  const rehabBudget = num(p.rehabCosts);
  const totalBasis = num(p.totalBasis) || (acquisitionPrice + rehabBudget);
  const currentValue = num(p.currentValue) || num(p.arvTotal) || totalBasis;
  const currentEquity = currentValue - currentDebt;
  const yieldOnCost = totalBasis > 0 ? (annualNOI / totalBasis) * 100 : 0;
  // Cap rate is NOI over current value; yield on cost is NOI over basis.
  const capRate = currentValue > 0 ? (annualNOI / currentValue) * 100 : 0;
  const dscr = annualDebtService > 0 ? annualNOI / annualDebtService : num(p.dscrStabilized);

  return {
    id: p.id,
    name: p.name,
    address: p.address,
    city: p.city,
    state: p.state,
    units,
    acquisitionPrice,
    rehabBudget,
    totalBasis,
    currentValue,
    currentDebt,
    currentEquity,
    lender: p.lender || "Unknown",
    interestRate: num(p.interestRate) * 100, // stored as decimal 0.1125 → 11.25
    maturityDate: p.maturityDate || "",
    annualNOI,
    yieldOnCost,
    capRate,
    dscr,
    occupancyRate,
    occupiedUnits: occupied,
    phase: (p.phase as PropertyCard["phase"]) || "stabilizing",
    refiTarget: p.refiTarget || "",
    refiProceeds: num(p.refiCashOut),
  };
}

export function toOccupancy(p: any): OccupancyRecord {
  const units = num(p.units);
  const occupied = num(p.occupiedUnits);
  const rate = num(p.occupancyRate) * 100;
  const status = p.occupancyStatus || (rate >= 90 ? "stable" : rate >= 75 ? "watch" : "critical");
  return {
    id: `occ_${p.id}`,
    property: p.name,
    units,
    occupied,
    vacant: units - occupied,
    occupancyRate: rate,
    monthlyRent: num(p.monthlyRent),
    status,
  };
}

export function toDebt(p: any): DebtMaturity {
  const matDate = p.maturityDate || "";
  const days = daysUntil(matDate);
  return {
    id: `debt_${p.id}`,
    property: p.name,
    lender: p.lender || "Unknown",
    balance: num(p.currentDebt),
    interestRate: num(p.interestRate) * 100,
    maturityDate: matDate,
    daysUntilMaturity: days,
    urgency: urgencyLevel(days),
    refiTarget: p.refiTarget || "",
    expectedProceeds: num(p.refiCashOut),
  };
}
