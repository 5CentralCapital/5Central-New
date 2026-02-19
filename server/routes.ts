import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { registerAuthRoutes, requireAdmin, requireAuth } from "./auth";
import { registerDashboardRoutes } from "./dashboard/routes";

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth routes
  registerAuthRoutes(app);

  // Admin dashboard API routes
  registerDashboardRoutes(app);

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

  // Property routes
  app.get("/api/properties", async (req, res) => {
    try {
      const properties = await storage.getAllProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch properties" });
    }
  });

  app.get("/api/properties/current", async (req, res) => {
    try {
      const properties = await storage.getCurrentProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch current properties" });
    }
  });

  app.get("/api/properties/sold", async (req, res) => {
    try {
      const properties = await storage.getSoldProperties();
      res.json(properties);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch sold properties" });
    }
  });

  app.get("/api/properties/:id", async (req, res) => {
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
