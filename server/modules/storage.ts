/**
 * Storage layer for all new modules.
 * CRUD operations for: payroll, rehab engine, lease-up, PM, documents,
 * distributions, capital accounts, monthly data, deal pipeline, CRM, maintenance.
 */

import { db } from "../db";
import { eq, and, desc, asc, sql, inArray, gte, lte } from "drizzle-orm";
import {
  workers, payrollEntries, payrollPayments,
  rehabLineItems, rehabMaterialLog, rehabPhotos,
  unitRentRoll, vacancyPipeline, turnChecklist,
  pmNotes, pmEscalations, slaTimers,
  investorDocuments, distributions, waterfallTiers, capitalAccounts,
  propertyMonthlyData, dealPipeline, investorLeads, investorCommunications,
  maintenanceRequests,
} from "@shared/schema";
import type {
  InsertWorker, InsertPayrollEntry, InsertPayrollPayment,
  InsertRehabLineItem, InsertRehabMaterial, InsertRehabPhoto,
  InsertUnitRentRoll, InsertVacancyPipeline, InsertTurnChecklist,
  InsertPmNote, InsertPmEscalation, InsertSlaTimer,
  InsertInvestorDocument, InsertDistribution, InsertWaterfallTier,
  InsertCapitalAccount, InsertPropertyMonthlyData,
  InsertDealPipelineDeal, InsertInvestorLead, InsertInvestorCommunication,
  InsertMaintenanceRequest,
} from "@shared/schema";

// ============================================================
// WORKERS & PAYROLL
// ============================================================

export const workerStorage = {
  async getAll() {
    return db.select().from(workers).orderBy(asc(workers.name));
  },
  async getById(id: string) {
    const [w] = await db.select().from(workers).where(eq(workers.id, id));
    return w || undefined;
  },
  async create(data: InsertWorker) {
    const [w] = await db.insert(workers).values(data).returning();
    return w;
  },
  async update(id: string, data: Partial<InsertWorker>) {
    const [w] = await db.update(workers).set(data).where(eq(workers.id, id)).returning();
    return w;
  },
  async delete(id: string) {
    await db.delete(workers).where(eq(workers.id, id));
  },
};

export const payrollStorage = {
  async getEntries(filters?: { workerId?: string; propertyId?: string; weekEnding?: string }) {
    let query = db.select().from(payrollEntries).orderBy(desc(payrollEntries.date));
    // Apply filters in caller if needed - return all for now
    return query;
  },
  async getEntriesByWorker(workerId: string) {
    return db.select().from(payrollEntries).where(eq(payrollEntries.workerId, workerId)).orderBy(desc(payrollEntries.date));
  },
  async getEntriesByProperty(propertyId: string) {
    return db.select().from(payrollEntries).where(eq(payrollEntries.propertyId, propertyId)).orderBy(desc(payrollEntries.date));
  },
  async getEntriesByWeek(weekEnding: string) {
    return db.select().from(payrollEntries).where(eq(payrollEntries.weekEnding, weekEnding)).orderBy(asc(payrollEntries.workerId));
  },
  async createEntry(data: InsertPayrollEntry) {
    const [e] = await db.insert(payrollEntries).values(data).returning();
    return e;
  },
  async createBatch(entries: InsertPayrollEntry[]) {
    if (entries.length === 0) return [];
    return db.insert(payrollEntries).values(entries).returning();
  },
  async updateEntry(id: string, data: Partial<InsertPayrollEntry>) {
    const [e] = await db.update(payrollEntries).set(data).where(eq(payrollEntries.id, id)).returning();
    return e;
  },
  async deleteEntry(id: string) {
    await db.delete(payrollEntries).where(eq(payrollEntries.id, id));
  },

  // Payments
  async getPayments(workerId?: string) {
    if (workerId) {
      return db.select().from(payrollPayments).where(eq(payrollPayments.workerId, workerId)).orderBy(desc(payrollPayments.paidAt));
    }
    return db.select().from(payrollPayments).orderBy(desc(payrollPayments.paidAt));
  },
  async createPayment(data: InsertPayrollPayment) {
    const [p] = await db.insert(payrollPayments).values(data).returning();
    return p;
  },
  async updatePayment(id: string, data: Partial<InsertPayrollPayment>) {
    const [p] = await db.update(payrollPayments).set(data).where(eq(payrollPayments.id, id)).returning();
    return p;
  },

  // Aggregates
  async getPayrollSummary(weekEnding: string) {
    const entries = await db.select().from(payrollEntries).where(eq(payrollEntries.weekEnding, weekEnding));
    const workerTotals = new Map<string, number>();
    let grandTotal = 0;
    for (const e of entries) {
      const total = parseFloat(e.total || "0");
      grandTotal += total;
      workerTotals.set(e.workerId, (workerTotals.get(e.workerId) || 0) + total);
    }
    return { weekEnding, entries, workerTotals: Object.fromEntries(workerTotals), grandTotal };
  },
};

// ============================================================
// REHAB LINE ITEMS + MATERIALS + PHOTOS
// ============================================================

export const rehabStorage = {
  async getLineItemsByProperty(propertyId: string) {
    return db.select().from(rehabLineItems).where(eq(rehabLineItems.propertyId, propertyId)).orderBy(asc(rehabLineItems.unitNumber), asc(rehabLineItems.scopeItem));
  },
  async getLineItem(id: string) {
    const [item] = await db.select().from(rehabLineItems).where(eq(rehabLineItems.id, id));
    return item || undefined;
  },
  async createLineItem(data: InsertRehabLineItem) {
    const [item] = await db.insert(rehabLineItems).values(data).returning();
    return item;
  },
  async updateLineItem(id: string, data: Partial<InsertRehabLineItem>) {
    const [item] = await db.update(rehabLineItems).set({ ...data, updatedAt: new Date() }).where(eq(rehabLineItems.id, id)).returning();
    return item;
  },
  async deleteLineItem(id: string) {
    await db.delete(rehabLineItems).where(eq(rehabLineItems.id, id));
  },
  async createBatchLineItems(items: InsertRehabLineItem[]) {
    if (items.length === 0) return [];
    return db.insert(rehabLineItems).values(items).returning();
  },

  // Property rehab summary
  async getRehabSummary(propertyId: string) {
    const items = await db.select().from(rehabLineItems).where(eq(rehabLineItems.propertyId, propertyId));
    let totalBudget = 0, totalSpent = 0, totalContractorBaseline = 0, totalSavings = 0;
    let completedCount = 0, inProgressCount = 0, blockedCount = 0;
    for (const item of items) {
      const contractorCost = parseFloat(item.contractorBaselineCost || "0");
      const inHouseCost = parseFloat(item.totalInHouseCost || "0");
      totalContractorBaseline += contractorCost;
      totalSpent += inHouseCost;
      totalBudget += contractorCost; // budget = what contractor would charge
      totalSavings += contractorCost - inHouseCost;
      if (item.status === "complete") completedCount++;
      else if (item.status === "in_progress") inProgressCount++;
      else if (item.status === "blocked") blockedCount++;
    }
    return {
      totalItems: items.length,
      completedCount, inProgressCount, blockedCount,
      totalContractorBaseline, totalSpent, totalSavings,
      savingsPercent: totalContractorBaseline > 0 ? (totalSavings / totalContractorBaseline) * 100 : 0,
      items,
    };
  },

  // Materials
  async getMaterialsByProperty(propertyId: string) {
    return db.select().from(rehabMaterialLog).where(eq(rehabMaterialLog.propertyId, propertyId)).orderBy(desc(rehabMaterialLog.purchaseDate));
  },
  async createMaterial(data: InsertRehabMaterial) {
    const [m] = await db.insert(rehabMaterialLog).values(data).returning();
    return m;
  },
  async deleteMaterial(id: string) {
    await db.delete(rehabMaterialLog).where(eq(rehabMaterialLog.id, id));
  },

  // Photos
  async getPhotosByProperty(propertyId: string) {
    return db.select().from(rehabPhotos).where(eq(rehabPhotos.propertyId, propertyId)).orderBy(desc(rehabPhotos.takenAt));
  },
  async createPhoto(data: InsertRehabPhoto) {
    const [p] = await db.insert(rehabPhotos).values(data).returning();
    return p;
  },
  async deletePhoto(id: string) {
    await db.delete(rehabPhotos).where(eq(rehabPhotos.id, id));
  },
};

// ============================================================
// LEASE-UP: RENT ROLL + VACANCY PIPELINE + TURN CHECKLIST
// ============================================================

export const leaseUpStorage = {
  // Rent Roll
  async getUnitsByProperty(propertyId: string) {
    return db.select().from(unitRentRoll).where(eq(unitRentRoll.propertyId, propertyId)).orderBy(asc(unitRentRoll.unitNumber));
  },
  async getUnit(id: string) {
    const [u] = await db.select().from(unitRentRoll).where(eq(unitRentRoll.id, id));
    return u || undefined;
  },
  async createUnit(data: InsertUnitRentRoll) {
    const [u] = await db.insert(unitRentRoll).values(data).returning();
    return u;
  },
  async updateUnit(id: string, data: Partial<InsertUnitRentRoll>) {
    const [u] = await db.update(unitRentRoll).set({ ...data, updatedAt: new Date() }).where(eq(unitRentRoll.id, id)).returning();
    return u;
  },
  async deleteUnit(id: string) {
    await db.delete(unitRentRoll).where(eq(unitRentRoll.id, id));
  },
  async createBatchUnits(units: InsertUnitRentRoll[]) {
    if (units.length === 0) return [];
    return db.insert(unitRentRoll).values(units).returning();
  },

  // Vacancy Pipeline
  async getVacancies(propertyId?: string) {
    if (propertyId) {
      return db.select().from(vacancyPipeline).where(eq(vacancyPipeline.propertyId, propertyId)).orderBy(asc(vacancyPipeline.vacancyStartDate));
    }
    return db.select().from(vacancyPipeline).orderBy(asc(vacancyPipeline.vacancyStartDate));
  },
  async getVacancy(id: string) {
    const [v] = await db.select().from(vacancyPipeline).where(eq(vacancyPipeline.id, id));
    return v || undefined;
  },
  async createVacancy(data: InsertVacancyPipeline) {
    const [v] = await db.insert(vacancyPipeline).values(data).returning();
    // Auto-create turn checklist
    const defaultSteps = [
      { step: "move_out_inspection", sortOrder: 1 },
      { step: "scope_approved", sortOrder: 2 },
      { step: "rehab_complete", sortOrder: 3 },
      { step: "punch_clean", sortOrder: 4 },
      { step: "photos_complete", sortOrder: 5 },
      { step: "listing_live", sortOrder: 6 },
      { step: "showings_scheduled", sortOrder: 7 },
      { step: "application_screening", sortOrder: 8 },
      { step: "lease_sent", sortOrder: 9 },
      { step: "lease_signed", sortOrder: 10 },
      { step: "move_in_scheduled", sortOrder: 11 },
    ];
    await db.insert(turnChecklist).values(
      defaultSteps.map(s => ({ vacancyId: v.id, ...s }))
    );
    return v;
  },
  async updateVacancy(id: string, data: Partial<InsertVacancyPipeline>) {
    // Auto-calculate days vacant
    const existing = await this.getVacancy(id);
    if (existing) {
      const startDate = new Date(data.vacancyStartDate || existing.vacancyStartDate);
      const daysVacant = Math.floor((Date.now() - startDate.getTime()) / 86400000);
      let urgency = "normal";
      if (daysVacant > 14) urgency = "red";
      else if (daysVacant > 7) urgency = "yellow";
      data = { ...data, daysVacant, urgency };
    }
    const [v] = await db.update(vacancyPipeline).set({ ...data, updatedAt: new Date() }).where(eq(vacancyPipeline.id, id)).returning();
    return v;
  },
  async deleteVacancy(id: string) {
    await db.delete(turnChecklist).where(eq(turnChecklist.vacancyId, id));
    await db.delete(vacancyPipeline).where(eq(vacancyPipeline.id, id));
  },

  // Turn Checklist
  async getChecklist(vacancyId: string) {
    return db.select().from(turnChecklist).where(eq(turnChecklist.vacancyId, vacancyId)).orderBy(asc(turnChecklist.sortOrder));
  },
  async updateChecklistItem(id: string, data: { isComplete?: boolean; completedBy?: string; notes?: string }) {
    const updates: any = { ...data };
    if (data.isComplete) updates.completedAt = new Date();
    const [item] = await db.update(turnChecklist).set(updates).where(eq(turnChecklist.id, id)).returning();
    return item;
  },

  // Aggregates
  async getLeaseUpSummary(propertyId: string) {
    const units = await this.getUnitsByProperty(propertyId);
    const vacancies = await this.getVacancies(propertyId);
    const occupied = units.filter(u => u.status === "occupied").length;
    const vacant = units.filter(u => u.status === "vacant" || u.status === "renovation").length;
    const totalRent = units.filter(u => u.status === "occupied").reduce((s, u) => s + parseFloat(u.monthlyRent || "0"), 0);
    const totalMarketRent = units.reduce((s, u) => s + parseFloat(u.marketRent || "0"), 0);
    const avgDaysVacant = vacancies.length > 0
      ? vacancies.reduce((s, v) => s + (v.daysVacant || 0), 0) / vacancies.length
      : 0;
    return {
      totalUnits: units.length, occupied, vacant,
      occupancyRate: units.length > 0 ? (occupied / units.length) * 100 : 0,
      totalRent, totalMarketRent,
      rentGap: totalMarketRent - totalRent,
      activeVacancies: vacancies.length,
      avgDaysVacant,
      units, vacancies,
    };
  },
};

// ============================================================
// PM NOTES, ESCALATIONS, SLA TIMERS
// ============================================================

export const pmStorage = {
  // Notes
  async getNotes(propertyId: string) {
    return db.select().from(pmNotes).where(eq(pmNotes.propertyId, propertyId)).orderBy(desc(pmNotes.date));
  },
  async getAllNotes() {
    return db.select().from(pmNotes).orderBy(desc(pmNotes.date));
  },
  async createNote(data: InsertPmNote) {
    const [n] = await db.insert(pmNotes).values(data).returning();
    return n;
  },

  // Escalations
  async getEscalations(status?: string) {
    if (status) {
      return db.select().from(pmEscalations).where(eq(pmEscalations.status, status)).orderBy(desc(pmEscalations.createdAt));
    }
    return db.select().from(pmEscalations).orderBy(desc(pmEscalations.createdAt));
  },
  async createEscalation(data: InsertPmEscalation) {
    const [e] = await db.insert(pmEscalations).values(data).returning();
    return e;
  },
  async updateEscalation(id: string, data: Partial<InsertPmEscalation & { resolvedAt?: Date }>) {
    const [e] = await db.update(pmEscalations).set(data).where(eq(pmEscalations.id, id)).returning();
    return e;
  },

  // SLA Timers
  async getActiveTimers() {
    return db.select().from(slaTimers).where(eq(slaTimers.isBreached, false)).orderBy(asc(slaTimers.startedAt));
  },
  async createTimer(data: InsertSlaTimer) {
    const [t] = await db.insert(slaTimers).values(data).returning();
    return t;
  },
  async completeTimer(id: string) {
    const [t] = await db.update(slaTimers).set({ completedAt: new Date() }).where(eq(slaTimers.id, id)).returning();
    return t;
  },
  async breachTimer(id: string) {
    const [t] = await db.update(slaTimers).set({ isBreached: true }).where(eq(slaTimers.id, id)).returning();
    return t;
  },

  // Maintenance
  async getMaintenanceRequests(propertyId?: string) {
    if (propertyId) {
      return db.select().from(maintenanceRequests).where(eq(maintenanceRequests.propertyId, propertyId)).orderBy(desc(maintenanceRequests.reportedAt));
    }
    return db.select().from(maintenanceRequests).orderBy(desc(maintenanceRequests.reportedAt));
  },
  async createMaintenanceRequest(data: InsertMaintenanceRequest) {
    const [r] = await db.insert(maintenanceRequests).values(data).returning();
    return r;
  },
  async updateMaintenanceRequest(id: string, data: Partial<InsertMaintenanceRequest>) {
    const [r] = await db.update(maintenanceRequests).set(data).where(eq(maintenanceRequests.id, id)).returning();
    return r;
  },
};

// ============================================================
// INVESTOR DOCUMENTS
// ============================================================

export const documentStorage = {
  async getByInvestor(investorId: string) {
    return db.select().from(investorDocuments).where(eq(investorDocuments.investorId, investorId)).orderBy(desc(investorDocuments.createdAt));
  },
  async getAll() {
    return db.select().from(investorDocuments).orderBy(desc(investorDocuments.createdAt));
  },
  async getByType(docType: string) {
    return db.select().from(investorDocuments).where(eq(investorDocuments.docType, docType)).orderBy(desc(investorDocuments.createdAt));
  },
  async create(data: InsertInvestorDocument) {
    const [d] = await db.insert(investorDocuments).values(data).returning();
    return d;
  },
  async update(id: string, data: Partial<InsertInvestorDocument>) {
    const [d] = await db.update(investorDocuments).set(data).where(eq(investorDocuments.id, id)).returning();
    return d;
  },
  async incrementDownload(id: string) {
    await db.update(investorDocuments).set({
      downloadCount: sql`${investorDocuments.downloadCount} + 1`,
    }).where(eq(investorDocuments.id, id));
  },
  async delete(id: string) {
    await db.delete(investorDocuments).where(eq(investorDocuments.id, id));
  },
};

// ============================================================
// DISTRIBUTIONS & WATERFALL
// ============================================================

export const distributionStorage = {
  async getByInvestor(investorId: string) {
    return db.select().from(distributions).where(eq(distributions.investorId, investorId)).orderBy(desc(distributions.createdAt));
  },
  async getAll() {
    return db.select().from(distributions).orderBy(desc(distributions.createdAt));
  },
  async create(data: InsertDistribution) {
    const [d] = await db.insert(distributions).values(data).returning();
    return d;
  },
  async update(id: string, data: Partial<InsertDistribution>) {
    const [d] = await db.update(distributions).set(data).where(eq(distributions.id, id)).returning();
    return d;
  },

  // Waterfall tiers
  async getWaterfallTiers(investmentId?: string, propertyId?: string) {
    if (investmentId) {
      return db.select().from(waterfallTiers).where(eq(waterfallTiers.investmentId, investmentId)).orderBy(asc(waterfallTiers.tierOrder));
    }
    if (propertyId) {
      return db.select().from(waterfallTiers).where(eq(waterfallTiers.propertyId, propertyId)).orderBy(asc(waterfallTiers.tierOrder));
    }
    return db.select().from(waterfallTiers).orderBy(asc(waterfallTiers.tierOrder));
  },
  async createWaterfallTier(data: InsertWaterfallTier) {
    const [t] = await db.insert(waterfallTiers).values(data).returning();
    return t;
  },
  async deleteWaterfallTiers(investmentId: string) {
    await db.delete(waterfallTiers).where(eq(waterfallTiers.investmentId, investmentId));
  },
};

// ============================================================
// CAPITAL ACCOUNTS
// ============================================================

export const capitalAccountStorage = {
  async getByInvestor(investorId: string) {
    return db.select().from(capitalAccounts).where(eq(capitalAccounts.investorId, investorId)).orderBy(desc(capitalAccounts.period));
  },
  async getAll() {
    return db.select().from(capitalAccounts).orderBy(desc(capitalAccounts.period));
  },
  async create(data: InsertCapitalAccount) {
    const [c] = await db.insert(capitalAccounts).values(data).returning();
    return c;
  },
  async update(id: string, data: Partial<InsertCapitalAccount>) {
    const [c] = await db.update(capitalAccounts).set(data).where(eq(capitalAccounts.id, id)).returning();
    return c;
  },
};

// ============================================================
// MONTHLY TIME-SERIES
// ============================================================

export const monthlyDataStorage = {
  async getByProperty(propertyId: string) {
    return db.select().from(propertyMonthlyData).where(eq(propertyMonthlyData.propertyId, propertyId)).orderBy(desc(propertyMonthlyData.month));
  },
  async getAll() {
    return db.select().from(propertyMonthlyData).orderBy(desc(propertyMonthlyData.month));
  },
  async create(data: InsertPropertyMonthlyData) {
    const [m] = await db.insert(propertyMonthlyData).values(data).returning();
    return m;
  },
  async update(id: string, data: Partial<InsertPropertyMonthlyData>) {
    const [m] = await db.update(propertyMonthlyData).set(data).where(eq(propertyMonthlyData.id, id)).returning();
    return m;
  },
};

// ============================================================
// DEAL PIPELINE
// ============================================================

export const dealPipelineStorage = {
  async getAll() {
    return db.select().from(dealPipeline).orderBy(desc(dealPipeline.updatedAt));
  },
  async getByStage(stage: string) {
    return db.select().from(dealPipeline).where(eq(dealPipeline.stage, stage)).orderBy(desc(dealPipeline.updatedAt));
  },
  async getById(id: string) {
    const [d] = await db.select().from(dealPipeline).where(eq(dealPipeline.id, id));
    return d || undefined;
  },
  async create(data: InsertDealPipelineDeal) {
    const [d] = await db.insert(dealPipeline).values(data).returning();
    return d;
  },
  async update(id: string, data: Partial<InsertDealPipelineDeal>) {
    const [d] = await db.update(dealPipeline).set({ ...data, updatedAt: new Date() }).where(eq(dealPipeline.id, id)).returning();
    return d;
  },
  async delete(id: string) {
    await db.delete(dealPipeline).where(eq(dealPipeline.id, id));
  },
  async getSummary() {
    const deals = await this.getAll();
    const stages = new Map<string, number>();
    let totalEquityNeeded = 0;
    for (const d of deals) {
      stages.set(d.stage, (stages.get(d.stage) || 0) + 1);
      if (d.stage !== "dead" && d.stage !== "closed") {
        totalEquityNeeded += parseFloat(d.equityNeeded || "0");
      }
    }
    return { totalDeals: deals.length, byStage: Object.fromEntries(stages), totalEquityNeeded, deals };
  },
};

// ============================================================
// INVESTOR CRM & COMMUNICATIONS
// ============================================================

export const crmStorage = {
  // Leads
  async getLeads() {
    return db.select().from(investorLeads).orderBy(desc(investorLeads.updatedAt));
  },
  async getLeadsByStage(stage: string) {
    return db.select().from(investorLeads).where(eq(investorLeads.stage, stage)).orderBy(desc(investorLeads.updatedAt));
  },
  async getLead(id: string) {
    const [l] = await db.select().from(investorLeads).where(eq(investorLeads.id, id));
    return l || undefined;
  },
  async createLead(data: InsertInvestorLead) {
    const [l] = await db.insert(investorLeads).values(data).returning();
    return l;
  },
  async updateLead(id: string, data: Partial<InsertInvestorLead>) {
    const [l] = await db.update(investorLeads).set({ ...data, updatedAt: new Date() }).where(eq(investorLeads.id, id)).returning();
    return l;
  },
  async deleteLead(id: string) {
    await db.delete(investorLeads).where(eq(investorLeads.id, id));
  },

  // Communications
  async getCommunications(investorId?: string, leadId?: string) {
    if (investorId) {
      return db.select().from(investorCommunications).where(eq(investorCommunications.investorId, investorId)).orderBy(desc(investorCommunications.sentAt));
    }
    if (leadId) {
      return db.select().from(investorCommunications).where(eq(investorCommunications.leadId, leadId)).orderBy(desc(investorCommunications.sentAt));
    }
    return db.select().from(investorCommunications).orderBy(desc(investorCommunications.sentAt));
  },
  async createCommunication(data: InsertInvestorCommunication) {
    const [c] = await db.insert(investorCommunications).values(data).returning();
    return c;
  },
};
