import 'dotenv/config';
import { registerTenantPaymentWebhook } from './rent-ops/payments/routes';
import type { TenantPaymentService } from './rent-ops/payments/service';
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "path";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { loadUser } from "./auth";
import { pool } from "./db";
import { ensureSchema } from "./ensureSchema";
import { publicRequestError } from "./request-errors";
import { sanitizeApiPathForLogging } from "./request-logging";
import { applicantPageSecurityHeaders } from "./applicant-page-security";
import {
  assertRentOpsProductionConfiguration,
  createRentOpsReadinessGate,
} from "./rent-ops/security/deployment-security";

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.RENT_OPS_SESSION_SECRET || process.env.SESSION_SECRET;
const readiness = createRentOpsReadinessGate();

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/readyz", (_req, res) => {
  const state = readiness.state();
  res.status(state === "ready" ? 200 : 503).json({
    status: state === "ready" ? "ready" : "not_ready",
  });
});

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be configured in production");
}
if (isProduction) {
  assertRentOpsProductionConfiguration(process.env);
}

// Trust proxy for Replit (behind reverse proxy)
app.set("trust proxy", 1);

let tenantPaymentService: TenantPaymentService | undefined;
// Signature verification must receive the original bytes before any JSON parser.
registerTenantPaymentWebhook(app, { getService: () => tenantPaymentService });
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// PostgreSQL session store
const PgStore = connectPgSimple(session);

// Session middleware with PostgreSQL storage
app.use(
  session({
    store: new PgStore({
      pool: pool,
      tableName: "user_sessions",
      // Session tables are provisioned by the reviewed host schema in
      // production; startup must not create or migrate them implicitly.
      createTableIfMissing: !isProduction,
    }),
    secret: sessionSecret || "development-only-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: "lax",
    },
  })
);

// Load user from session
app.use(loadUser);

// Serve attached_assets statically
app.use('/attached_assets', express.static(path.resolve(import.meta.dirname, '..', 'attached_assets')));
app.use(/^\/(?:apply|tenant)(?:\/|$)/, applicantPageSecurityHeaders);

app.use((req, res, next) => {
  const start = Date.now();
  const path = sanitizeApiPathForLogging(req.path);

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // API bodies can contain tenant, applicant, financial, or authentication
      // data. Operational logs intentionally retain request metadata only.
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  try {
    // Production migrations are reviewed and run out-of-band by the importer
    // role. Startup may prepare only the development schema.
    if (!isProduction) await ensureSchema();

    const server = await registerRoutes(app, { onTenantPaymentService: (service) => { tenantPaymentService = service; } });

    app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const { status, message: publicMessage } = publicRequestError(err);
      // Never echo stacks, bodies, tenant data, or provider diagnostics. The
      // process remains alive after a handled request error.
      log(`${req.method} ${sanitizeApiPathForLogging(req.path)} failed ${status}`);
      res.status(status).json({ message: publicMessage });
    });

    // importantly only setup vite in development and after
    // setting up all the other routes so the catch-all route
    // doesn't interfere with the other routes
    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
    }

    // Render supplies PORT. Bind the only externally reachable listener to
    // all interfaces, and do not report readiness until listen succeeds.
    const port = parseInt(process.env.PORT || '10000', 10);
    server.once("error", () => {
      readiness.markFailed();
      log("startup failed");
      process.exitCode = 1;
    });
    server.listen({
      port,
      host: "0.0.0.0",
    }, () => {
      readiness.markReady();
      log(`serving on port ${port}`);
    });
  } catch {
    readiness.markFailed();
    log("startup failed");
    process.exitCode = 1;
  }
})();
