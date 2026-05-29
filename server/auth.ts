import type { Express, Request, Response, NextFunction } from "express";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const scryptAsync = promisify(scrypt);

// Extend Express session to include user
declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  const [hashedPassword, salt] = stored.split(".");
  const buf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(hashedPassword, "hex"), buf);
}

function extractApiKey(req: Request): string | undefined {
  const directHeader = req.headers["x-api-key"];
  if (typeof directHeader === "string" && directHeader.trim()) {
    return directHeader.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]) {
      return bearerMatch[1].trim();
    }
  }

  return undefined;
}

function getExternalApiKeys(): string[] {
  return Array.from(
    new Set(
      [
        process.env.DASHBOARD_API_KEY,
        process.env.FIVECENTRAL_API_KEY,
        process.env.ADMIN_API_KEY,
      ]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

function matchesApiKey(supplied: string, expected: string): boolean {
  try {
    return supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Check if request has a valid API key (for external agents like OpenClaw)
function hasValidApiKey(req: Request): boolean {
  const apiKey = extractApiKey(req);
  if (!apiKey) return false;
  return getExternalApiKeys().some((expectedKey) => matchesApiKey(apiKey, expectedKey));
}

// Middleware to load user from session (or API key)
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    // First check session-based auth
    if (req.session?.userId) {
      const user = await storage.getUser(req.session.userId);
      if (user) {
        req.user = user;
      }
    }
    // If no session user, check for API key → treat as admin
    if (!req.user && hasValidApiKey(req)) {
      // Find the admin user to attach to the request
      const adminUser = await storage.getUserByEmail("michael@5central.capital");
      if (adminUser) {
        req.user = adminUser;
      }
    }
  } catch (error) {
    console.error("Error loading user from session:", error);
  }
  next();
}

// Middleware to require authentication
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}

// Middleware to require admin role
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

// Middleware: accept admin session OR X-API-Key header (for OpenClaw / external agents)
export function requireAdminOrApiKey(req: Request, res: Response, next: NextFunction) {
  // Path 1: already authenticated via session
  if (req.user && req.user.role === "admin") {
    return next();
  }

  // Path 2: API key in header
  if (hasValidApiKey(req)) {
    // Mark request as API-key-authenticated (no user object, but authorized)
    (req as any).apiKeyAuth = true;
    return next();
  }

  return res.status(401).json({ message: "Authentication required (session or X-API-Key)" });
}

// Middleware to require investor role
export function requireInvestor(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (req.user.role !== "investor" && req.user.role !== "admin") {
    return res.status(403).json({ message: "Investor access required" });
  }
  next();
}

export function registerAuthRoutes(app: Express) {
  // Login route
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const isValidPassword = await comparePasswords(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Set session
      req.session.userId = user.id;

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Logout route
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  // Get current user
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const { password: _, ...userWithoutPassword } = req.user;
    res.json({ user: userWithoutPassword });
  });
}

// Helper function to create hashed password (for seed data)
export { hashPassword };
