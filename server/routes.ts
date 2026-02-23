import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { registerAuthRoutes, requireAdmin, requireAuth } from "./auth";
import { registerDashboardRoutes } from "./dashboard/routes";
import { registerModuleRoutes } from "./modules/routes";
import { db } from "./db";
import { investments, loans, properties, investors, insertLoanSchema, insertInvestmentSchema, insertPropertySchema, insertInvestorSchema } from "@shared/schema";
import { eq } from "drizzle-orm";

// Helper: coerce ISO date strings to Date objects for Drizzle timestamp fields
function coerceDates(body: Record<string, any>): Record<string, any> {
  const dateFields = ["acquisitionDate", "saleDate", "refiDate", "projectedSaleDate", "effectiveDate", "maturityDate", "hireDate", "reportedAt", "acknowledgedAt", "completedAt", "paidAt", "sentAt", "startedAt", "takenAt"];
  const result = { ...body };
  for (const field of dateFields) {
    if (typeof result[field] === "string" && result[field]) {
      const d = new Date(result[field]);
      if (!isNaN(d.getTime())) result[field] = d;
    }
  }
  return result;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth routes
  registerAuthRoutes(app);

  // Admin dashboard API routes
  registerDashboardRoutes(app);

  // New feature module routes (payroll, rehab, lease-up, PM, documents, distributions, deals, CRM)
  registerModuleRoutes(app);

  // Investor routes
  app.get("/api/investor/profile", requireAuth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const investor = await storage.getInvestorByUserId(req.user.id);
      if (!investor) {
        return res.status(404).json({ message: "Investor profile not found" });
      }
      res.json(investor);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch investor profile" });
    }
  });

  app.get("/api/investor/investments", requireAuth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const investor = await storage.getInvestorByUserId(req.user.id);
      if (!investor) {
        return res.status(404).json({ message: "Investor profile not found" });
      }
      const investments = await storage.getInvestmentsByInvestorId(investor.id);
      res.json(investments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch investments" });
    }
  });

  // Enriched investments endpoint with property data
  app.get("/api/investor/investments/enriched", requireAuth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const investor = await storage.getInvestorByUserId(req.user.id);
      if (!investor) {
        return res.status(404).json({ message: "Investor profile not found" });
      }
      const investments = await storage.getInvestmentsByInvestorId(investor.id);

      // Get unique property names from investments
      const propertyNames = Array.from(new Set(investments.map(inv => inv.propertyName)));
      const properties = await storage.getPropertiesByNames(propertyNames);
      const propertyMap = new Map(properties.map(p => [p.name, p]));

      // Enrich investments with property data
      const enrichedInvestments = investments.map(inv => {
        const property = propertyMap.get(inv.propertyName);
        return {
          ...inv,
          property: property || null,
        };
      });

      res.json(enrichedInvestments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch enriched investments" });
    }
  });

  // Get investor properties (properties the investor has invested in)
  // Company partners see ALL current properties
  app.get("/api/investor/properties", requireAuth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const investor = await storage.getInvestorByUserId(req.user.id);
      if (!investor) {
        return res.status(404).json({ message: "Investor profile not found" });
      }

      // Company partners see all current properties
      if (investor.investorType === 'company-partner') {
        const properties = await storage.getCurrentProperties();
        res.json(properties);
        return;
      }

      // Regular investors see only properties they've invested in
      const investments = await storage.getInvestmentsByInvestorId(investor.id);

      // Get unique property names from investments
      const propertyNames = Array.from(new Set(investments.map(inv => inv.propertyName)));
      const properties = await storage.getPropertiesByNames(propertyNames);

      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch investor properties" });
    }
  });

  // Get portfolio metrics for company partners
  app.get("/api/investor/portfolio-metrics", requireAuth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const investor = await storage.getInvestorByUserId(req.user.id);
      if (!investor) {
        return res.status(404).json({ message: "Investor profile not found" });
      }

      // Only allow company partners to access portfolio-wide metrics
      if (investor.investorType !== 'company-partner') {
        return res.status(403).json({ message: "Access denied" });
      }

      const metrics = await storage.getPortfolioMetrics();
      const partnerEquityPercentage = parseFloat(investor.companyEquityPercentage || "0");

      res.json({
        ...metrics,
        partnerEquityPercentage,
        partnerEquityValue: metrics.totalEquity * partnerEquityPercentage,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch portfolio metrics" });
    }
  });

  // Admin: All investors with their investments + user info
  app.get("/api/admin/investors", requireAdmin, async (req, res) => {
    try {
      const allInvestors = await storage.getAllInvestors();
      const allInvestments = await storage.getAllInvestments();
      const allUsers = await Promise.all(
        allInvestors.map(inv => storage.getUser(inv.userId))
      );

      const investorProfiles = allInvestors.map((inv, idx) => {
        const user = allUsers[idx];
        const investorInvestments = allInvestments.filter(i => i.investorId === inv.id);
        return {
          ...inv,
          firstName: user?.firstName || "",
          lastName: user?.lastName || "",
          email: user?.email || "",
          investments: investorInvestments,
        };
      });
      res.json(investorProfiles);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch investors" });
    }
  });

  // Admin: Update an investment
  app.patch("/api/admin/investments/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Whitelist updatable fields — prevent overwriting id, createdAt
      const { investorId, propertyName, propertyAddress, principal, balloonAmount, monthlyPayment, returnMultiple, interestRate, effectiveDate, maturityDate, term, status, investmentType, notes, equityPercentage, propertyId, initialInvestment, currentEquityValue, cashOutAtRefi, projectedExitValue, equityMultiple } = req.body;
      const updates: Record<string, any> = { investorId, propertyName, propertyAddress, principal, balloonAmount, monthlyPayment, returnMultiple, interestRate, effectiveDate, maturityDate, term, status, investmentType, notes, equityPercentage, propertyId, initialInvestment, currentEquityValue, cashOutAtRefi, projectedExitValue, equityMultiple };
      Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
      const [updated] = await db.update(investments).set(updates).where(eq(investments.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Investment not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update investment", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // Admin: Create a new investment
  app.post("/api/admin/investments", requireAdmin, async (req, res) => {
    try {
      const parsed = insertInvestmentSchema.safeParse(coerceDates(req.body));
      if (!parsed.success) return res.status(400).json({ message: "Invalid investment data", errors: parsed.error.flatten() });
      const [created] = await db.insert(investments).values(parsed.data).returning();
      res.json(created);
    } catch (error) {
      res.status(500).json({ message: "Failed to create investment", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LOANS / MORTGAGE OBLIGATIONS CRUD
  // ═══════════════════════════════════════════════════════════

  // Get all loans
  app.get("/api/admin/loans", requireAdmin, async (req, res) => {
    try {
      const allLoans = await db.select().from(loans);
      res.json(allLoans);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch loans" });
    }
  });

  // Get loans by property name (query param: ?property=Sun%20Cove)
  app.get("/api/admin/loans/by-property", requireAdmin, async (req, res) => {
    try {
      const { property } = req.query;
      if (!property || typeof property !== "string") {
        const allLoans = await db.select().from(loans);
        return res.json(allLoans);
      }
      const result = await db.select().from(loans).where(eq(loans.propertyName, property));
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch loans" });
    }
  });

  // Create a loan
  app.post("/api/admin/loans", requireAdmin, async (req, res) => {
    try {
      const parsed = insertLoanSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid loan data", errors: parsed.error.flatten() });
      const [created] = await db.insert(loans).values(parsed.data).returning();
      res.json(created);
    } catch (error) {
      res.status(500).json({ message: "Failed to create loan", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // Update a loan
  app.patch("/api/admin/loans/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Whitelist updatable fields — prevent overwriting id, createdAt
      const { propertyName, lender, loanType, balance, interestRate, monthlyPayment, maturityDate, term, interestOnly, originationFee, exitFee, loanToValue, status, notes, propertyId } = req.body;
      const updates = { propertyName, lender, loanType, balance, interestRate, monthlyPayment, maturityDate, term, interestOnly, originationFee, exitFee, loanToValue, status, notes, propertyId, updatedAt: new Date() };
      // Remove undefined keys
      Object.keys(updates).forEach(k => (updates as any)[k] === undefined && delete (updates as any)[k]);
      const [updated] = await db.update(loans).set(updates).where(eq(loans.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Loan not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update loan", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // Delete a loan
  app.delete("/api/admin/loans/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const [deleted] = await db.delete(loans).where(eq(loans.id, id)).returning();
      if (!deleted) return res.status(404).json({ message: "Loan not found" });
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete loan" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PROPERTY UPDATE (was read-only before)
  // ═══════════════════════════════════════════════════════════

  app.patch("/api/admin/properties/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Whitelist updatable fields — prevent overwriting id
      const { name, address, city, state, zipCode, units, acquisitionDate, acquisitionPrice, rehabCosts, currentValue, salePrice, saleDate, totalCashflow, status, ownershipStructure, ownershipName, yearsHeld, irr, equityMultiple, noi, debtService, cashflow, currentDebt, refiDate, projectedSaleDate, imageUrl, phase, lender, refiTarget, monthlyRent, occupancyStatus, yearBuilt, buildingSF, closingDate, investmentThesis, inPlaceNOI, stabilizedNOI, noiUpside, capRateInPlace, capRateStabilized, entryCapRate, exitCapRate, capRateSpread, valueCreation, entryPerUnit, exitPerUnit, arvPerUnit, arvTotal, bridgeLoan, ltvPurchase, ltc, interestRate, rehabHoldback, totalCommitment, monthlyPI, annualDebtService, maturityDate, loanType, irrLevered, moic, yieldOnCost, cashYieldStabilized, paybackPeriod, holdPeriod, refiMonth, sponsorEquity, breakevenOccupancy, dscrStabilized, debtYield, cashOutAtRefi, netCashFromSale, totalProfit, totalUnits, occupiedUnits, occupancyRate, inPlaceRent, proformaRent, rentUpside, refiLTV, refiLoanAmount, refiCashOut, newMonthlyPI, equityAfterRefi, refiTargetMonth, projectedSalePrice, projectedNetProceeds, projectedTotalProfit, holdPeriodMonths, beforePhotos, afterPhotos, initialCapitalRequired, totalCashflowCollected, saleProceeds, cashOnCash, totalReturnPercent, appreciationPercent, pricePerUnit, totalBasis, grossProfit, roc, avgAnnualReturn, profitPerUnit } = req.body;
      const updates: Record<string, any> = { name, address, city, state, zipCode, units, acquisitionDate, acquisitionPrice, rehabCosts, currentValue, salePrice, saleDate, totalCashflow, status, ownershipStructure, ownershipName, yearsHeld, irr, equityMultiple, noi, debtService, cashflow, currentDebt, refiDate, projectedSaleDate, imageUrl, phase, lender, refiTarget, monthlyRent, occupancyStatus, yearBuilt, buildingSF, closingDate, investmentThesis, inPlaceNOI, stabilizedNOI, noiUpside, capRateInPlace, capRateStabilized, entryCapRate, exitCapRate, capRateSpread, valueCreation, entryPerUnit, exitPerUnit, arvPerUnit, arvTotal, bridgeLoan, ltvPurchase, ltc, interestRate, rehabHoldback, totalCommitment, monthlyPI, annualDebtService, maturityDate, loanType, irrLevered, moic, yieldOnCost, cashYieldStabilized, paybackPeriod, holdPeriod, refiMonth, sponsorEquity, breakevenOccupancy, dscrStabilized, debtYield, cashOutAtRefi, netCashFromSale, totalProfit, totalUnits, occupiedUnits, occupancyRate, inPlaceRent, proformaRent, rentUpside, refiLTV, refiLoanAmount, refiCashOut, newMonthlyPI, equityAfterRefi, refiTargetMonth, projectedSalePrice, projectedNetProceeds, projectedTotalProfit, holdPeriodMonths, beforePhotos, afterPhotos, initialCapitalRequired, totalCashflowCollected, saleProceeds, cashOnCash, totalReturnPercent, appreciationPercent, pricePerUnit, totalBasis, grossProfit, roc, avgAnnualReturn, profitPerUnit };
      Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
      const [updated] = await db.update(properties).set(updates).where(eq(properties.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Property not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update property", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // Create a property
  app.post("/api/admin/properties", requireAdmin, async (req, res) => {
    try {
      const parsed = insertPropertySchema.safeParse(coerceDates(req.body));
      if (!parsed.success) return res.status(400).json({ message: "Invalid property data", errors: parsed.error.flatten() });
      const [created] = await db.insert(properties).values(parsed.data).returning();
      res.json(created);
    } catch (error) {
      res.status(500).json({ message: "Failed to create property", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // INVESTOR PROFILE UPDATE (was read-only before)
  // ═══════════════════════════════════════════════════════════

  app.patch("/api/admin/investors/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Whitelist updatable fields — prevent overwriting id, userId
      const { accreditedStatus, investedAmount, phone, investorType, companyEquityPercentage } = req.body;
      const updates: Record<string, any> = { accreditedStatus, investedAmount, phone, investorType, companyEquityPercentage };
      Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
      const [updated] = await db.update(investors).set(updates).where(eq(investors.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Investor not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update investor", error: process.env.NODE_ENV === "development" ? String(error) : undefined });
    }
  });

  // Delete an investment
  app.delete("/api/admin/investments/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const [deleted] = await db.delete(investments).where(eq(investments.id, id)).returning();
      if (!deleted) return res.status(404).json({ message: "Investment not found" });
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete investment" });
    }
  });

  // Property routes (require authentication to protect financial data)
  app.get("/api/properties", requireAuth, async (req, res) => {
    try {
      const properties = await storage.getAllProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch properties" });
    }
  });

  app.get("/api/properties/current", requireAuth, async (req, res) => {
    try {
      const properties = await storage.getCurrentProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch current properties" });
    }
  });

  app.get("/api/properties/sold", requireAuth, async (req, res) => {
    try {
      const properties = await storage.getSoldProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch sold properties" });
    }
  });

  app.get("/api/properties/:id", requireAuth, async (req, res) => {
    try {
      const property = await storage.getProperty(req.params.id);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      res.json(property);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch property" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
