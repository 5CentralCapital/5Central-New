import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";

export async function registerRoutes(app: Express): Promise<Server> {
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
