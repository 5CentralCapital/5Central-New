/**
 * Dashboard DB layer — reads/writes PostgreSQL (shared with investor site).
 * Properties, occupancy, and debt are computed from the `properties` table.
 * Tasks, rehab, growth, KPIs, metrics, and activity have their own tables.
 * Banking (Plaid) remains in SQLite via bankingDb.ts.
 */

import crypto from "crypto";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  properties,
  dashboardTasks,
  dashboardRehab,
  dashboardGrowth,
  dashboardKpis,
  dashboardMetrics,
  dashboardActivity,
} from "@shared/schema";
import type { DashboardData, PropertyCard, OccupancyRecord, DebtMaturity } from "./types";

/* ── Helpers ── */

function num(val: string | number | null | undefined): number {
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

function toPropertyCard(p: any): PropertyCard {
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
  const currentEquity = totalBasis - currentDebt;
  const yieldOnCost = totalBasis > 0 ? (annualNOI / totalBasis) * 100 : 0;
  const capRate = totalBasis > 0 ? (annualNOI / totalBasis) * 100 : 0;
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

function toOccupancy(p: any): OccupancyRecord {
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

function toDebt(p: any): DebtMaturity {
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

/* ── Main data fetch ── */

export async function getDashboardData(): Promise<DashboardData> {
  // Fetch all current properties from PostgreSQL
  const props = await db.select().from(properties).where(eq(properties.status, "current"));

  const propertyCards = props.map(toPropertyCard);
  const occupancy = props.map(toOccupancy);
  const debt = props.map(toDebt);

  // Fetch dashboard-specific tables
  const tasks = await db.select().from(dashboardTasks);
  const rehab = await db.select().from(dashboardRehab);
  const growth = await db.select().from(dashboardGrowth);
  const kpis = await db.select().from(dashboardKpis);
  const metrics = await db.select().from(dashboardMetrics);
  const activity = await db.select().from(dashboardActivity);

  return {
    properties: propertyCards,
    occupancy,
    debt,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate || undefined,
      cadence: t.cadence as any || undefined,
      status: t.status as any,
      property: t.property || "",
      module: t.module as any,
      priority: t.priority as any || undefined,
      notes: t.notes || undefined,
    })),
    rehab: rehab.map((r) => ({
      id: r.id,
      property: r.property,
      project: r.project,
      budget: num(r.budget),
      spent: num(r.spent),
      completionPct: r.completionPct,
      status: r.status as any,
      targetDate: r.targetDate || undefined,
      notes: r.notes || undefined,
    })),
    growth: growth.map((g) => ({
      id: g.id,
      year: g.year,
      targetUnits: g.targetUnits,
      targetAUM: num(g.targetAUM),
      targetEquity: num(g.targetEquity),
      phase: g.phase,
      status: g.status as any,
    })),
    kpis: kpis.map((k) => ({
      id: k.id,
      name: k.name,
      current: num(k.current),
      previous: num(k.previous),
      target: num(k.target),
      unit: k.unit || undefined,
      format: k.format as any || undefined,
      property: k.property || undefined,
      date: k.date || "",
    })),
    metrics: metrics.map((m) => ({
      id: m.id,
      label: m.label,
      value: num(m.value),
      unit: m.unit || undefined,
      trend: m.trend != null ? num(m.trend) : undefined,
      target: m.target != null ? num(m.target) : undefined,
      format: m.format as any || undefined,
    })),
    activity: activity
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 500)
      .map((a) => ({
        id: a.id,
        ts: a.ts.toISOString(),
        actor: a.actor,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        detail: a.detail,
      })),
    freshness: [],
    diagnostics: [],
  };
}

/* ── Table updates (used by PATCH /api/dashboard) ── */

type TableName = keyof DashboardData;

export async function updateTable(table: TableName, data: any) {
  await db.transaction(async (tx) => {
    if (table === "tasks") {
      await tx.delete(dashboardTasks);
      for (const t of data) {
        await tx.insert(dashboardTasks).values({
          id: t.id,
          title: t.title,
          dueDate: t.dueDate || null,
          cadence: t.cadence || null,
          status: t.status,
          property: t.property || null,
          module: t.module || "reminders",
          priority: t.priority || "medium",
          notes: t.notes || null,
        });
      }
    } else if (table === "rehab") {
      await tx.delete(dashboardRehab);
      for (const r of data) {
        await tx.insert(dashboardRehab).values({
          id: r.id,
          property: r.property,
          project: r.project,
          budget: String(r.budget),
          spent: String(r.spent),
          completionPct: r.completionPct,
          status: r.status,
          targetDate: r.targetDate || null,
          notes: r.notes || null,
        });
      }
    } else if (table === "growth") {
      await tx.delete(dashboardGrowth);
      for (const g of data) {
        await tx.insert(dashboardGrowth).values({
          id: g.id,
          year: g.year,
          targetUnits: g.targetUnits,
          targetAUM: String(g.targetAUM),
          targetEquity: String(g.targetEquity),
          phase: g.phase,
          status: g.status,
        });
      }
    } else if (table === "kpis") {
      await tx.delete(dashboardKpis);
      for (const k of data) {
        await tx.insert(dashboardKpis).values({
          id: k.id,
          name: k.name,
          current: String(k.current),
          previous: String(k.previous),
          target: String(k.target),
          unit: k.unit || null,
          format: k.format || null,
          property: k.property || null,
          date: k.date || null,
        });
      }
    } else if (table === "metrics") {
      await tx.delete(dashboardMetrics);
      for (const m of data) {
        await tx.insert(dashboardMetrics).values({
          id: m.id,
          label: m.label,
          value: String(m.value),
          unit: m.unit || null,
          trend: m.trend != null ? String(m.trend) : null,
          target: m.target != null ? String(m.target) : null,
          format: m.format || null,
        });
      }
    } else if (table === "activity") {
      await tx.delete(dashboardActivity);
      for (const a of (data as any[]).slice(0, 500)) {
        await tx.insert(dashboardActivity).values({
          id: a.id,
          ts: new Date(a.ts),
          actor: a.actor,
          action: a.action,
          entityType: a.entityType,
          entityId: a.entityId,
          detail: a.detail,
        });
      }
    }
  });
}

export async function appendActivity(entry: { actor: string; action: string; entityType: string; entityId: string; detail: string }) {
  await db.insert(dashboardActivity).values({
    id: `a_${crypto.randomUUID()}`,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detail: entry.detail,
  });
}
