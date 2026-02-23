/**
 * API routes for all new modules.
 * All routes require admin auth unless noted.
 */

import type { Express, Request, Response } from "express";
import { requireAdmin, requireAuth } from "../auth";
import {
  workerStorage, payrollStorage, rehabStorage, leaseUpStorage,
  pmStorage, documentStorage, distributionStorage, capitalAccountStorage,
  monthlyDataStorage, dealPipelineStorage, crmStorage,
} from "./storage";

function ok(res: Response, data: any) { res.json(data); }
function err(res: Response, error: any, status = 500) {
  console.error(error);
  res.status(status).json({ error: error?.message || "Internal error" });
}

export function registerModuleRoutes(app: Express) {

  // ============================================================
  // WORKERS & PAYROLL
  // ============================================================

  app.get("/api/workers", requireAdmin, async (_req, res) => {
    try { ok(res, await workerStorage.getAll()); } catch (e) { err(res, e); }
  });
  app.get("/api/workers/:id", requireAdmin, async (req, res) => {
    try {
      const w = await workerStorage.getById(req.params.id);
      if (!w) return res.status(404).json({ error: "Worker not found" });
      ok(res, w);
    } catch (e) { err(res, e); }
  });
  app.post("/api/workers", requireAdmin, async (req, res) => {
    try { ok(res, await workerStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/workers/:id", requireAdmin, async (req, res) => {
    try { ok(res, await workerStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/workers/:id", requireAdmin, async (req, res) => {
    try { await workerStorage.delete(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Payroll entries
  app.get("/api/payroll/entries", requireAdmin, async (req, res) => {
    try {
      const { workerId, propertyId, weekEnding } = req.query;
      if (weekEnding) return ok(res, await payrollStorage.getEntriesByWeek(weekEnding as string));
      if (workerId) return ok(res, await payrollStorage.getEntriesByWorker(workerId as string));
      if (propertyId) return ok(res, await payrollStorage.getEntriesByProperty(propertyId as string));
      ok(res, await payrollStorage.getEntries());
    } catch (e) { err(res, e); }
  });
  app.post("/api/payroll/entries", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.createEntry(req.body)); } catch (e) { err(res, e); }
  });
  app.post("/api/payroll/entries/batch", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.createBatch(req.body.entries)); } catch (e) { err(res, e); }
  });
  app.patch("/api/payroll/entries/:id", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.updateEntry(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/payroll/entries/:id", requireAdmin, async (req, res) => {
    try { await payrollStorage.deleteEntry(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });
  app.get("/api/payroll/summary/:weekEnding", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.getPayrollSummary(req.params.weekEnding)); } catch (e) { err(res, e); }
  });

  // Payroll payments
  app.get("/api/payroll/payments", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.getPayments(req.query.workerId as string)); } catch (e) { err(res, e); }
  });
  app.post("/api/payroll/payments", requireAdmin, async (req, res) => {
    try { ok(res, await payrollStorage.createPayment(req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // REHAB LINE ITEMS + MATERIALS + PHOTOS
  // ============================================================

  app.get("/api/rehab/:propertyId/items", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.getLineItemsByProperty(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.get("/api/rehab/:propertyId/summary", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.getRehabSummary(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.post("/api/rehab/items", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.createLineItem(req.body)); } catch (e) { err(res, e); }
  });
  app.post("/api/rehab/items/batch", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.createBatchLineItems(req.body.items)); } catch (e) { err(res, e); }
  });
  app.patch("/api/rehab/items/:id", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.updateLineItem(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/rehab/items/:id", requireAdmin, async (req, res) => {
    try { await rehabStorage.deleteLineItem(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Materials
  app.get("/api/rehab/:propertyId/materials", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.getMaterialsByProperty(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.post("/api/rehab/materials", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.createMaterial(req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/rehab/materials/:id", requireAdmin, async (req, res) => {
    try { await rehabStorage.deleteMaterial(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Photos
  app.get("/api/rehab/:propertyId/photos", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.getPhotosByProperty(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.post("/api/rehab/photos", requireAdmin, async (req, res) => {
    try { ok(res, await rehabStorage.createPhoto(req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/rehab/photos/:id", requireAdmin, async (req, res) => {
    try { await rehabStorage.deletePhoto(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // ============================================================
  // LEASE-UP: RENT ROLL + VACANCY + TURN CHECKLIST
  // ============================================================

  app.get("/api/lease-up/:propertyId/units", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.getUnitsByProperty(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.get("/api/lease-up/:propertyId/summary", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.getLeaseUpSummary(req.params.propertyId)); } catch (e) { err(res, e); }
  });
  app.post("/api/lease-up/units", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.createUnit(req.body)); } catch (e) { err(res, e); }
  });
  app.post("/api/lease-up/units/batch", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.createBatchUnits(req.body.units)); } catch (e) { err(res, e); }
  });
  app.patch("/api/lease-up/units/:id", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.updateUnit(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/lease-up/units/:id", requireAdmin, async (req, res) => {
    try { await leaseUpStorage.deleteUnit(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Vacancy pipeline
  app.get("/api/lease-up/vacancies", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.getVacancies(req.query.propertyId as string)); } catch (e) { err(res, e); }
  });
  app.post("/api/lease-up/vacancies", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.createVacancy(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/lease-up/vacancies/:id", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.updateVacancy(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/lease-up/vacancies/:id", requireAdmin, async (req, res) => {
    try { await leaseUpStorage.deleteVacancy(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Turn checklist
  app.get("/api/lease-up/vacancies/:vacancyId/checklist", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.getChecklist(req.params.vacancyId)); } catch (e) { err(res, e); }
  });
  app.patch("/api/lease-up/checklist/:id", requireAdmin, async (req, res) => {
    try { ok(res, await leaseUpStorage.updateChecklistItem(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // PM: NOTES, ESCALATIONS, SLA, MAINTENANCE
  // ============================================================

  app.get("/api/pm/notes", requireAdmin, async (req, res) => {
    try {
      if (req.query.propertyId) return ok(res, await pmStorage.getNotes(req.query.propertyId as string));
      ok(res, await pmStorage.getAllNotes());
    } catch (e) { err(res, e); }
  });
  app.post("/api/pm/notes", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.createNote(req.body)); } catch (e) { err(res, e); }
  });

  app.get("/api/pm/escalations", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.getEscalations(req.query.status as string)); } catch (e) { err(res, e); }
  });
  app.post("/api/pm/escalations", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.createEscalation(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/pm/escalations/:id", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.updateEscalation(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  app.get("/api/pm/sla-timers", requireAdmin, async (_req, res) => {
    try { ok(res, await pmStorage.getActiveTimers()); } catch (e) { err(res, e); }
  });
  app.post("/api/pm/sla-timers", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.createTimer(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/pm/sla-timers/:id/complete", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.completeTimer(req.params.id)); } catch (e) { err(res, e); }
  });

  app.get("/api/maintenance", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.getMaintenanceRequests(req.query.propertyId as string)); } catch (e) { err(res, e); }
  });
  app.post("/api/maintenance", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.createMaintenanceRequest(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/maintenance/:id", requireAdmin, async (req, res) => {
    try { ok(res, await pmStorage.updateMaintenanceRequest(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // INVESTOR DOCUMENTS (admin upload + investor download)
  // ============================================================

  app.get("/api/documents", requireAdmin, async (_req, res) => {
    try { ok(res, await documentStorage.getAll()); } catch (e) { err(res, e); }
  });
  app.post("/api/documents", requireAdmin, async (req, res) => {
    try { ok(res, await documentStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/documents/:id", requireAdmin, async (req, res) => {
    try { ok(res, await documentStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/documents/:id", requireAdmin, async (req, res) => {
    try { await documentStorage.delete(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Investor-facing document routes (auth required, not admin)
  app.get("/api/investor/documents", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { storage: mainStorage } = await import("../storage");
      const investor = await mainStorage.getInvestorByUserId(req.user.id);
      if (!investor) return res.status(404).json({ error: "Investor not found" });
      const docs = await documentStorage.getByInvestor(investor.id);
      ok(res, docs);
    } catch (e) { err(res, e); }
  });
  app.post("/api/investor/documents/:id/download", requireAuth, async (req, res) => {
    try {
      await documentStorage.incrementDownload(req.params.id);
      ok(res, { ok: true });
    } catch (e) { err(res, e); }
  });

  // ============================================================
  // DISTRIBUTIONS & WATERFALL
  // ============================================================

  app.get("/api/distributions", requireAdmin, async (_req, res) => {
    try { ok(res, await distributionStorage.getAll()); } catch (e) { err(res, e); }
  });
  app.post("/api/distributions", requireAdmin, async (req, res) => {
    try { ok(res, await distributionStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/distributions/:id", requireAdmin, async (req, res) => {
    try { ok(res, await distributionStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  // Investor-facing distributions
  app.get("/api/investor/distributions", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { storage: mainStorage } = await import("../storage");
      const investor = await mainStorage.getInvestorByUserId(req.user.id);
      if (!investor) return res.status(404).json({ error: "Investor not found" });
      ok(res, await distributionStorage.getByInvestor(investor.id));
    } catch (e) { err(res, e); }
  });

  // Waterfall tiers
  app.get("/api/waterfall", requireAdmin, async (req, res) => {
    try { ok(res, await distributionStorage.getWaterfallTiers(req.query.investmentId as string, req.query.propertyId as string)); } catch (e) { err(res, e); }
  });
  app.post("/api/waterfall", requireAdmin, async (req, res) => {
    try { ok(res, await distributionStorage.createWaterfallTier(req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // CAPITAL ACCOUNTS
  // ============================================================

  app.get("/api/capital-accounts", requireAdmin, async (_req, res) => {
    try { ok(res, await capitalAccountStorage.getAll()); } catch (e) { err(res, e); }
  });
  app.post("/api/capital-accounts", requireAdmin, async (req, res) => {
    try { ok(res, await capitalAccountStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/capital-accounts/:id", requireAdmin, async (req, res) => {
    try { ok(res, await capitalAccountStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  // Investor-facing capital accounts
  app.get("/api/investor/capital-accounts", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { storage: mainStorage } = await import("../storage");
      const investor = await mainStorage.getInvestorByUserId(req.user.id);
      if (!investor) return res.status(404).json({ error: "Investor not found" });
      ok(res, await capitalAccountStorage.getByInvestor(investor.id));
    } catch (e) { err(res, e); }
  });

  // ============================================================
  // MONTHLY TIME-SERIES
  // ============================================================

  app.get("/api/monthly-data", requireAdmin, async (req, res) => {
    try {
      if (req.query.propertyId) return ok(res, await monthlyDataStorage.getByProperty(req.query.propertyId as string));
      ok(res, await monthlyDataStorage.getAll());
    } catch (e) { err(res, e); }
  });
  app.post("/api/monthly-data", requireAdmin, async (req, res) => {
    try { ok(res, await monthlyDataStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/monthly-data/:id", requireAdmin, async (req, res) => {
    try { ok(res, await monthlyDataStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // DEAL PIPELINE
  // ============================================================

  app.get("/api/deals", requireAdmin, async (req, res) => {
    try {
      if (req.query.stage) return ok(res, await dealPipelineStorage.getByStage(req.query.stage as string));
      ok(res, await dealPipelineStorage.getAll());
    } catch (e) { err(res, e); }
  });
  app.get("/api/deals/summary", requireAdmin, async (_req, res) => {
    try { ok(res, await dealPipelineStorage.getSummary()); } catch (e) { err(res, e); }
  });
  app.get("/api/deals/:id", requireAdmin, async (req, res) => {
    try {
      const d = await dealPipelineStorage.getById(req.params.id);
      if (!d) return res.status(404).json({ error: "Deal not found" });
      ok(res, d);
    } catch (e) { err(res, e); }
  });
  app.post("/api/deals", requireAdmin, async (req, res) => {
    try { ok(res, await dealPipelineStorage.create(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/deals/:id", requireAdmin, async (req, res) => {
    try { ok(res, await dealPipelineStorage.update(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/deals/:id", requireAdmin, async (req, res) => {
    try { await dealPipelineStorage.delete(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // ============================================================
  // INVESTOR CRM & COMMUNICATIONS
  // ============================================================

  app.get("/api/crm/leads", requireAdmin, async (req, res) => {
    try {
      if (req.query.stage) return ok(res, await crmStorage.getLeadsByStage(req.query.stage as string));
      ok(res, await crmStorage.getLeads());
    } catch (e) { err(res, e); }
  });
  app.get("/api/crm/leads/:id", requireAdmin, async (req, res) => {
    try {
      const l = await crmStorage.getLead(req.params.id);
      if (!l) return res.status(404).json({ error: "Lead not found" });
      ok(res, l);
    } catch (e) { err(res, e); }
  });
  app.post("/api/crm/leads", requireAdmin, async (req, res) => {
    try { ok(res, await crmStorage.createLead(req.body)); } catch (e) { err(res, e); }
  });
  app.patch("/api/crm/leads/:id", requireAdmin, async (req, res) => {
    try { ok(res, await crmStorage.updateLead(req.params.id, req.body)); } catch (e) { err(res, e); }
  });
  app.delete("/api/crm/leads/:id", requireAdmin, async (req, res) => {
    try { await crmStorage.deleteLead(req.params.id); ok(res, { ok: true }); } catch (e) { err(res, e); }
  });

  // Communications
  app.get("/api/crm/communications", requireAdmin, async (req, res) => {
    try {
      ok(res, await crmStorage.getCommunications(req.query.investorId as string, req.query.leadId as string));
    } catch (e) { err(res, e); }
  });
  app.post("/api/crm/communications", requireAdmin, async (req, res) => {
    try { ok(res, await crmStorage.createCommunication(req.body)); } catch (e) { err(res, e); }
  });

  // ============================================================
  // PUBLIC: INVESTOR SIGNUP (replaces fake form)
  // ============================================================

  app.post("/api/investor-signup", async (req: Request, res: Response) => {
    try {
      const { firstName, lastName, email, phone, company, investableCapital, source } = req.body;
      if (!firstName || !lastName || !email) {
        return res.status(400).json({ error: "Name and email are required" });
      }
      const lead = await crmStorage.createLead({
        firstName,
        lastName,
        email,
        phone: phone || null,
        company: company || null,
        investableCapital: investableCapital || null,
        source: source || "website",
        stage: "new",
        interestLevel: "warm",
      });
      ok(res, { message: "Thank you for your interest. We'll be in touch shortly.", leadId: lead.id });
    } catch (e) { err(res, e); }
  });
}
