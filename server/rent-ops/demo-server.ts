import express, { type Express } from "express";
import path from "node:path";
import { createSyntheticRentOpsRepository } from "./fixtures/synthetic";
import { registerRentOpsRoutes } from "./routes";
import { applicantPageSecurityHeaders } from "../applicant-page-security";

export interface RentOpsDemoServerOptions {
  publicDir?: string;
  port?: number;
}

/**
 * Local/browser-smoke server only. It has no dotenv, database, session store,
 * Rent Manager client, credentials, or production fallback. The explicit
 * demo guard and synthetic repository make accidental production enablement a
 * startup error.
 */
export function createRentOpsDemoApp(options: RentOpsDemoServerOptions = {}): Express {
  if (process.env.NODE_ENV === "production") throw new Error("Rent Operations demo server cannot run in production");
  const app = express();
  const repository = createSyntheticRentOpsRepository();
  const demoAdmin = {
    id: "demo-admin",
    email: "demo-admin@example.test",
    role: "admin" as const,
    firstName: "Demo",
    lastName: "Admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const demoCsrfToken = "rent-ops-demo-csrf-token-local-only-20260817";
  app.use(express.json({ limit: "1mb" }));
  app.use(/^\/apply(?:\/|$)/, applicantPageSecurityHeaders);
  // Obvious synthetic identity so the existing ProtectedRoute can render
  // `/ops` during local browser smoke without sessions or credentials.
  app.get("/api/auth/me", (_req, res) => res.json({ user: demoAdmin }));
  // The production workspace now uses its own session and CSRF endpoints.
  // Mirror only their response shape here so the local synthetic build can be
  // inspected without adding a real session store, password, or auth fallback.
  app.get("/api/rent-ops/auth/session", (_req, res) => res.json({ user: demoAdmin, csrfToken: demoCsrfToken }));
  app.get("/api/rent-ops/auth/csrf", (_req, res) => res.json({ csrfToken: demoCsrfToken }));
  app.post("/api/rent-ops/auth/login", (_req, res) => res.json({ user: demoAdmin, csrfToken: demoCsrfToken }));
  app.post("/api/rent-ops/auth/logout", (_req, res) => res.status(204).end());
  registerRentOpsRoutes(app, {
    repository,
    requireAdmin: (_req, _res, next) => next(),
    enableDemoGuard: true,
    exposeResumeToken: true,
  });
  const publicDir = options.publicDir ?? path.resolve(process.cwd(), "dist/public");
  app.use(express.static(publicDir));
  // Serve the built SPA shell for the two Rent Operations entry points so the
  // explicit synthetic runtime can exercise real routing and visual states.
  app.get(/^\/(?:ops|apply)(?:\/.*)?$/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  return app;
}

export function startRentOpsDemoServer(options: RentOpsDemoServerOptions = {}): ReturnType<Express["listen"]> {
  const app = createRentOpsDemoApp(options);
  return app.listen(options.port ?? 4175);
}
