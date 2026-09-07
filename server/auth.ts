import type { Express, Request, Response, NextFunction } from "express";
import { scrypt, randomBytes, timingSafeEqual, createHash } from "crypto";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const MAX_PASSWORD_BYTES = 1024;
const MAX_PASSWORD_CHECKS = 4;
const DUMMY_PASSWORD_HASH = `${"0".repeat(128)}.${"0".repeat(32)}`;
let activePasswordChecks = 0;

class PasswordVerificationBusyError extends Error {}

function passwordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

// Extend Express session to include user
declare module "express-session" {
  interface SessionData {
    userId?: string;
    /** Dedicated Rent Ops admin identity; never treated as a generic user session. */
    rentOpsAdminUserId?: string;
    rentOpsCsrfToken?: string;
  }
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      rentOpsAdminUser?: User;
    }
  }
}

async function hashPassword(password: string): Promise<string> {
  if (!password || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error("Password length is invalid");
  const salt = randomBytes(16).toString("hex");
  const buf = await passwordKey(password, salt);
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string" || !/^[a-f0-9]{128}\.[a-f0-9]{32}$/i.test(stored)) return false;
  if (activePasswordChecks >= MAX_PASSWORD_CHECKS) throw new PasswordVerificationBusyError();
  const [hashedPassword, salt] = stored.split(".");
  activePasswordChecks += 1;
  try {
    const buf = await passwordKey(supplied, salt);
    return timingSafeEqual(Buffer.from(hashedPassword, "hex"), buf);
  } finally {
    activePasswordChecks -= 1;
  }
}

/** Bounded per-process defense shared by both host logins; deploy one instance. */
export function createLoginAttemptLimiter(now: () => number = Date.now) {
  const windowMs = 15 * 60 * 1000;
  const maximumEntries = 10000;
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  return (ip: string, email?: string): number => {
    const currentTime = now();
    for (const [key, value] of Array.from(attempts.entries())) {
      if (value.expiresAt <= currentTime) attempts.delete(key);
    }
    const keys = [{ key: `ip:${ip}`, maximum: 30 }];
    if (email) keys.push({ key: `account:${createHash("sha256").update(email).digest("hex")}`, maximum: 10 });
    const missing = keys.filter(({ key }) => !attempts.has(key)).length;
    if (attempts.size + missing > maximumEntries) return Math.ceil(windowMs / 1000);
    let retryAfter = 0;
    for (const { key, maximum } of keys) {
      const entry = attempts.get(key) ?? { count: 0, expiresAt: currentTime + windowMs };
      entry.count = Math.min(entry.count + 1, maximum + 1);
      attempts.set(key, entry);
      if (entry.count > maximum) retryAfter = Math.max(retryAfter, Math.ceil((entry.expiresAt - currentTime) / 1000));
    }
    return retryAfter;
  };
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

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 240 ? normalized : undefined;
}

function loginCredentials(body: unknown): { email: string; password: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const input = body as Record<string, unknown>;
  const email = normalizedEmail(input.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  if (typeof input.password !== "string" || !input.password || Buffer.byteLength(input.password, "utf8") > MAX_PASSWORD_BYTES) return undefined;
  return { email, password: input.password };
}

async function saveAuthenticatedSession(req: Request): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  } catch (error) {
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    throw error;
  }
}

function csrfHeader(req: Request): string | undefined {
  const value = req.get("x-rent-ops-csrf") ?? req.get("x-csrf-token");
  return value && value.trim() ? value.trim() : undefined;
}

function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

export function createRentOpsCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function rentOpsSessionHasCsrf(req: Request): boolean {
  return sameSecret(req.session?.rentOpsCsrfToken, csrfHeader(req));
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

/**
 * Rent Ops deliberately does not accept the generic userId session, investor
 * sessions, or any legacy API-key header. The dedicated marker is set only by
 * the Rent Ops admin login and every mutating request also needs its CSRF
 * token. This middleware is injected into the Rent Ops router only.
 */
export async function requireRentOpsAdmin(req: Request, res: Response, next: NextFunction) {
  if (extractApiKey(req) || !req.session?.rentOpsAdminUserId) {
    res.status(401).json({ message: "Rent Ops administrator authentication required" });
    return;
  }
  try {
    const user = await storage.getUser(req.session.rentOpsAdminUserId);
    const configuredEmail = normalizedEmail(process.env.RENT_OPS_ADMIN_EMAIL);
    if (!user || user.role !== "admin" || (configuredEmail && normalizedEmail(user.email) !== configuredEmail)) {
      res.status(403).json({ message: "Rent Ops administrator access required" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !rentOpsSessionHasCsrf(req)) {
      res.status(403).json({ code: "csrf_required" });
      return;
    }
    req.rentOpsAdminUser = user;
    next();
  } catch {
    res.status(503).json({ message: "Rent Ops administrator authentication unavailable" });
  }
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
  const limitLoginAttempt = createLoginAttemptLimiter();
  const loginRateLimit = (req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "no-store");
    const retryAfter = limitLoginAttempt(req.ip || req.socket.remoteAddress || "unknown", normalizedEmail(req.body?.email));
    if (retryAfter > 0) {
      res.set("Retry-After", String(retryAfter)).status(429).json({ message: "Too many login attempts. Try again later." });
      return;
    }
    next();
  };
  // Dedicated Rent Ops admin login. It never populates the generic userId
  // session, so investor/user logins cannot access Rent Ops admin routes.
  app.post("/api/rent-ops/auth/login", loginRateLimit, async (req: Request, res: Response) => {
    try {
      const credentials = loginCredentials(req.body);
      const configuredEmail = normalizedEmail(process.env.RENT_OPS_ADMIN_EMAIL);
      if (!credentials) {
        res.status(401).json({ message: "Invalid administrator credentials" });
        return;
      }
      const { email, password } = credentials;
      const user = await storage.getUserByEmail(email);
      const passwordMatches = await comparePasswords(password, user?.password ?? DUMMY_PASSWORD_HASH);
      if (!user || user.role !== "admin" || (configuredEmail && email !== configuredEmail) || !passwordMatches) {
        res.status(401).json({ message: "Invalid administrator credentials" });
        return;
      }
      await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.rentOpsAdminUserId = user.id;
      req.session.rentOpsCsrfToken = createRentOpsCsrfToken();
      await saveAuthenticatedSession(req);
      const { password: _, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword, csrfToken: req.session.rentOpsCsrfToken });
    } catch (error) {
      if (error instanceof PasswordVerificationBusyError) res.set("Retry-After", "1").status(503).json({ message: "Authentication temporarily unavailable" });
      else res.status(500).json({ message: "Administrator login failed" });
    }
  });

  app.get("/api/rent-ops/auth/csrf", requireRentOpsAdmin, (req: Request, res: Response) => {
    // A valid dedicated session always receives a token at login. Regenerate
    // only if an old session was restored without one.
    if (!req.session.rentOpsCsrfToken) req.session.rentOpsCsrfToken = createRentOpsCsrfToken();
    res.set("Cache-Control", "no-store").json({ csrfToken: req.session.rentOpsCsrfToken });
  });

  app.get("/api/rent-ops/auth/session", requireRentOpsAdmin, (req: Request, res: Response) => {
    // The browser may restore a dedicated session after a reload. Return only
    // the safe user shape and an in-memory CSRF token; the session cookie
    // remains the only persisted credential.
    if (!req.rentOpsAdminUser) {
      res.status(401).json({ message: "Rent Ops administrator authentication required" });
      return;
    }
    if (!req.session.rentOpsCsrfToken) req.session.rentOpsCsrfToken = createRentOpsCsrfToken();
    const { password: _, ...userWithoutPassword } = req.rentOpsAdminUser;
    res.set("Cache-Control", "no-store").json({ user: userWithoutPassword, csrfToken: req.session.rentOpsCsrfToken });
  });

  app.post("/api/rent-ops/auth/logout", requireRentOpsAdmin, (req: Request, res: Response) => {
    req.session.destroy((error) => {
      if (error) {
        res.status(500).json({ message: "Logout failed" });
        return;
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  // Login route
  app.post("/api/auth/login", loginRateLimit, async (req: Request, res: Response) => {
    try {
      const credentials = loginCredentials(req.body);
      if (!credentials) {
        return res.status(401).json({ message: "Invalid email or password" });
      }
      const { email, password } = credentials;
      const user = await storage.getUserByEmail(email);
      const isValidPassword = await comparePasswords(password, user?.password ?? DUMMY_PASSWORD_HASH);
      if (!user || !isValidPassword) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Rotate the session ID and discard any previous administrator or tenant
      // identity before establishing the generic investor/user session.
      await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.userId = user.id;
      await saveAuthenticatedSession(req);

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword });
    } catch (error) {
      if (error instanceof PasswordVerificationBusyError) res.set("Retry-After", "1").status(503).json({ message: "Authentication temporarily unavailable" });
      else res.status(500).json({ message: "Login failed" });
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
